#!/usr/bin/env node
/**
 * Offline refresh-receipt checker for the BreachLedger ingest workflow.
 *
 * WHAT THIS IS
 *
 * A receipt says: "this workflow run, at this revision, actually did these
 * things, and here is the evidence". It answers one question -- did a refresh
 * happen, and how do we know? -- and it answers it from SAVED EVIDENCE only.
 *
 * WHAT THIS IS NOT
 *
 * This tool never touches the network. It does not call a provider, does not
 * authenticate to D1, does not trigger or re-run an Actions workflow, and does
 * not deploy. It reads JSON files and writes a receipt. Every fact it reports
 * is either present in the evidence or is reported as `unknown`; nothing is
 * inferred, and no missing provenance is invented.
 *
 * WHY A RECEIPT CHECKER EXISTS
 *
 * A green step proves the step ran. It does not prove what the step did. The
 * traps this tool is built to refuse:
 *
 *   - A green summary or cleanup step does not prove a refresh happened.
 *   - An artifact-upload step can succeed while uploading no file, so a
 *     missing rejection artifact does NOT establish "zero rejected records".
 *   - A skipped stage is not a successful stage, and a stage that was never
 *     reached is not evidence of anything.
 *   - A successful BUILD may have used stale input; a successful EXPORT may
 *     have exported rows written by an earlier run.
 *   - A previous deployment, a mismatched checkout, or an artifact copied in
 *     from another run cannot satisfy the receipt for THIS run.
 *   - A workflow can succeed while fetching unchanged source bytes. That is a
 *     successful OBSERVATION, not evidence that new breaches were published.
 *
 * The rules for separating those live in `evaluateReceipt`, and each one has
 * a fixture test in `refresh-receipt.test.js`.
 *
 * USAGE
 *
 *   node scripts/refresh-receipt.js --case <case.json> [--json] [--out <file>]
 *   node scripts/refresh-receipt.js --evidence <e.json> --expect <x.json> [--json]
 *
 * A "case" file is `{ label, kind, evidence, expectations }` where `kind` is
 * one of "recorded" (a real run), "historical" (a real run kept for
 * comparison) or "synthetic" (a fixture that tests this checker only).
 *
 * Importing this file does NOT run the checker; `main` is invoked explicitly.
 */

const fs = require('fs');
const path = require('path');

const RECEIPT_SCHEMA = 'breachledger.refresh-receipt/1';

// --- The workflow's stages -------------------------------------------------
//
// These are the stages of .github/workflows/ingest.yml at the revision this
// checker was written against. `pattern` matches the step name GitHub
// reports, which differs between workflows (ci.yml calls it "Unit tests",
// ingest.yml leaves it as "Run npm test"). An evidence step may also name its
// stage explicitly, which always wins.

const STAGE_DEFINITIONS = [
  { id: 'credentials', label: 'Verify credentials are present', pattern: /credential/i },
  { id: 'tests', label: 'Unit tests', pattern: /\btest/i },
  { id: 'summary', label: 'Publish ingest summary', pattern: /summary/i },
  { id: 'artifact', label: 'Upload rejected records for review', pattern: /artifact|upload/i },
  { id: 'ingest', label: 'Ingest HHS OCR breach portal', pattern: /ingest/i },
  { id: 'export', label: 'Export build input from D1', pattern: /export/i },
  { id: 'build', label: 'Build', pattern: /build/i },
  { id: 'deploy', label: 'Deploy to Pages', pattern: /deploy/i },
];

const STAGE_IDS = new Set(STAGE_DEFINITIONS.map((s) => s.id));

// The stages a PUBLICATION run must complete, in workflow order. A dry run
// legitimately stops after the ingest step: the workflow's own `if:` guards
// skip export, build and deploy, and that is expected, not a failure.
const PUBLICATION_STAGES = ['credentials', 'tests', 'ingest', 'export', 'build', 'deploy'];
const DRY_RUN_STAGES = ['credentials', 'tests', 'ingest'];

// Where a run stopped, relative to the ingestion step.
const BLOCKAGE = {
  BEFORE_INGESTION: 'before_ingestion',
  AT_INGESTION: 'at_ingestion',
  AFTER_INGESTION: 'after_ingestion',
};

function classifyStep(step) {
  if (step && typeof step.stage === 'string' && STAGE_IDS.has(step.stage)) return step.stage;
  const name = (step && step.name) || '';
  for (const def of STAGE_DEFINITIONS) {
    if (def.pattern.test(name)) return def.id;
  }
  return 'other';
}

/**
 * The verdict for one step.
 *
 * completed/success, completed/failure, completed/skipped, cancelled, pending
 * and "not present" are five different things and are kept apart here.
 */
function stepVerdict(step) {
  if (!step) return 'missing';
  const status = step.status;
  const conclusion = step.conclusion;
  if (status === 'skipped' || conclusion === 'skipped') return 'skipped';
  if (status === 'completed') {
    if (conclusion === 'success') return 'success';
    if (conclusion === 'failure') return 'failed';
    if (conclusion === 'cancelled') return 'cancelled';
    return 'unknown';
  }
  if (status === 'pending' || status === 'queued' || status === 'in_progress') return 'pending';
  return 'unknown';
}

function allSteps(evidence) {
  const steps = [];
  for (const job of (evidence && evidence.jobs) || []) {
    for (const step of job.steps || []) {
      steps.push(Object.assign({ job: job.name }, step));
    }
  }
  return steps;
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// GitHub attempts start at 1 and increment on reruns. Receipt identities use
// numbers, with safe-integer precision required for exact binding comparisons.
function isAttempt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function formatAttempt(value) {
  if (value == null) return 'unknown';
  return isAttempt(value) ? String(value) : 'invalid';
}

function hasRunIdentity(value) {
  return (typeof value === 'string' && value.trim() !== '') ||
    (isNumber(value) && Number.isInteger(value) && value > 0);
}

function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// A production timestamp is `new Date().toISOString()`, which is always
// exactly YYYY-MM-DDTHH:mm:ss.sssZ. Anything else is not something this
// repository's code produced.
const CANONICAL_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// `sha256(body)` in packages/ingest/fetch-util.js produces 64 lowercase hex.
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Parse a canonical ISO-8601 UTC instant.
 *
 * `Date.parse` alone is not good enough: it accepts non-canonical shapes and
 * it silently rolls an impossible calendar date over into the next month
 * ("2026-02-30" becomes 2026-03-01). Both are ways for a receipt to look
 * valid while describing an instant that never existed, so the value is
 * round-tripped through `toISOString()` and compared with the input.
 */
function parseCanonicalInstant(value) {
  if (typeof value !== 'string' || value === '') {
    return { valid: false, ms: null, reason: 'is missing' };
  }
  if (!CANONICAL_ISO_UTC.test(value)) {
    return { valid: false, ms: null, reason: 'is not a canonical ISO-8601 UTC instant' };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return { valid: false, ms: null, reason: 'is not a canonical ISO-8601 UTC instant' };
  }
  if (new Date(ms).toISOString() !== value) {
    return { valid: false, ms: null, reason: 'is not a real calendar instant' };
  }
  return { valid: true, ms, reason: null };
}

/**
 * Parse a reference instant (an `asOf`, or a run's completion time).
 *
 * These are expectations about a run rather than values this repository's own
 * code stamped, so they are not held to the canonical millisecond shape -- but
 * an impossible calendar date is still rejected, because "2026-02-30" parsing
 * successfully into 2026-03-01 would silently change what a receipt means.
 */
function parseReferenceInstant(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { valid: false, ms: null, reason: 'is missing' };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    return { valid: false, ms: null, reason: 'is not a valid instant' };
  }
  const declared = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (declared) {
    const d = new Date(ms);
    const actual = `${String(d.getUTCFullYear()).padStart(4, '0')}-` +
      `${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
      `${String(d.getUTCDate()).padStart(2, '0')}`;
    if (actual !== `${declared[1]}-${declared[2]}-${declared[3]}`) {
      return { valid: false, ms: null, reason: 'is not a real calendar instant' };
    }
  }
  return { valid: true, ms, reason: null };
}

/**
 * Validate one retrieval row against the run that claims it.
 *
 * A source NAME is not provenance. A row only counts as evidence when it
 * carries a timestamp this repository could have produced, a checksum of the
 * shape the ingester produces, and no binding that contradicts the run the
 * receipt is about.
 */
function validateRetrievalRow(row, run) {
  const reasons = [];
  const instant = parseCanonicalInstant(row.retrieved_at);
  if (!instant.valid) reasons.push(`retrieved_at ${instant.reason}`);

  const checksum = typeof row.checksum === 'string' ? row.checksum : null;
  if (checksum === null) {
    reasons.push('checksum is missing');
  } else if (!SHA256_HEX.test(checksum)) {
    reasons.push('checksum is not a sha256 digest');
  }

  if (row.runId != null) {
    if (!hasRunIdentity(run.runId)) reasons.push('the retrieval run binding cannot be checked because the run identifier is not recorded');
    else if (row.runId !== run.runId) reasons.push('the retrieval belongs to a different run');
  }
  if (row.attempt != null) {
    if (!isAttempt(row.attempt)) reasons.push('the retrieval attempt must be a positive safe integer');
    else if (run.attempt === null) reasons.push('the retrieval attempt binding cannot be checked because the run attempt is not recorded');
    else if (!isAttempt(run.attempt)) reasons.push('the retrieval attempt binding cannot be checked because the run attempt must be a positive safe integer');
    else if (row.attempt !== run.attempt) reasons.push('the retrieval belongs to a different attempt');
  }
  if (row.sha != null) {
    if (!run.headSha) reasons.push('the retrieval revision binding cannot be checked because the run revision is not recorded');
    else if (row.sha !== run.headSha) reasons.push('the retrieval was produced from a different revision');
  }

  return { instant, checksum, reasons, valid: reasons.length === 0 };
}

/**
 * Evaluate one case and return a machine-readable receipt.
 *
 * `caseData` is `{ label, kind, evidence, expectations }`. Nothing is fetched
 * and nothing is inferred: a field that is absent from the evidence stays
 * `null`/`unknown` in the receipt.
 */
function evaluateReceipt(caseData) {
  const data = caseData || {};
  const evidence = data.evidence || {};
  const expectations = data.expectations || {};
  const notes = [];
  const missingProof = [];
  const evidenceRefs = [];

  const ref = (field, value) => { evidenceRefs.push({ field, value: value === undefined ? null : value }); };

  // --- Run identity -------------------------------------------------------
  const run = {
    repository: evidence.repository ?? null,
    workflowPath: evidence.workflowPath ?? null,
    runId: evidence.runId ?? null,
    attempt: evidence.attempt ?? null,
    event: evidence.event ?? null,
    branch: evidence.branch ?? null,
    headSha: evidence.headSha ?? null,
    checkedOutSha: evidence.checkedOutSha ?? null,
    startedAt: evidence.startedAt ?? null,
    completedAt: evidence.completedAt ?? null,
  };
  ref('evidence.runId', run.runId);
  ref('evidence.attempt', run.attempt);
  ref('evidence.headSha', run.headSha);
  ref('evidence.checkedOutSha', run.checkedOutSha);

  // A receipt that describes a different revision, or a different attempt of
  // the run, cannot satisfy a claim about this revision.
  const expectedSha = expectations.expectedHeadSha || null;
  const expectedAttempt = expectations.expectedAttempt ?? null;
  const revisionMatches = expectedSha ? run.headSha === expectedSha : null;
  const checkoutMatches = expectedSha ? run.checkedOutSha === expectedSha : null;
  const attemptMatches = expectedAttempt === null ? null :
    isAttempt(expectedAttempt) && isAttempt(run.attempt) && run.attempt === expectedAttempt;

  if (revisionMatches === false) {
    missingProof.push(`the run's head SHA (${run.headSha}) is not the expected revision (${expectedSha})`);
  }
  if (checkoutMatches === false) {
    missingProof.push(`the checkout SHA (${run.checkedOutSha}) does not match the expected revision (${expectedSha})`);
  }
  if (expectedAttempt !== null && !isAttempt(expectedAttempt)) {
    missingProof.push('the expected attempt must be a positive safe integer');
  } else if (attemptMatches === false) {
    if (run.attempt !== null && !isAttempt(run.attempt)) {
      missingProof.push('the run attempt must be a positive safe integer');
    } else {
      missingProof.push(`run attempt ${run.attempt} is not the expected attempt ${expectedAttempt}`);
    }
  }

  // --- Mode ---------------------------------------------------------------
  const dryRun = evidence.dryRun === true;
  const mode = dryRun ? 'dry_run' : 'publication';
  const requiredStages = dryRun ? DRY_RUN_STAGES : PUBLICATION_STAGES;

  // --- Stages -------------------------------------------------------------
  const steps = allSteps(evidence);
  const byStage = new Map();
  for (const step of steps) {
    const id = classifyStep(step);
    if (!byStage.has(id)) byStage.set(id, step);
  }

  const stageRows = STAGE_DEFINITIONS.map((def) => {
    const step = byStage.get(def.id) || null;
    const verdict = stepVerdict(step);
    const required = requiredStages.includes(def.id);
    if (step) ref(`jobs[].steps[${step.name}].conclusion`, step.conclusion ?? null);
    return {
      id: def.id,
      label: def.label,
      name: step ? step.name : null,
      status: step ? step.status ?? null : null,
      conclusion: step ? step.conclusion ?? null : null,
      verdict,
      required,
      reached: verdict !== 'skipped' && verdict !== 'missing',
    };
  });
  const stageById = new Map(stageRows.map((s) => [s.id, s]));

  // --- Tests --------------------------------------------------------------
  const testsStep = byStage.get('tests') || null;
  const rawTests = (evidence.tests && typeof evidence.tests === 'object')
    ? evidence.tests
    : (testsStep && testsStep.tests && typeof testsStep.tests === 'object' ? testsStep.tests : {});
  const tests = {
    verdict: stageById.get('tests') ? stageById.get('tests').verdict : 'missing',
    total: isNumber(rawTests.total) ? rawTests.total : null,
    passed: isNumber(rawTests.passed) ? rawTests.passed : null,
    failed: isNumber(rawTests.failed) ? rawTests.failed : null,
    skipped: isNumber(rawTests.skipped) ? rawTests.skipped : null,
  };
  if (tests.total !== null) ref('evidence.tests', rawTests);

  // --- Source selection ---------------------------------------------------
  const expectedSources = Array.isArray(expectations.expectedSources) ? expectations.expectedSources : [];
  const retrievals = Array.isArray(evidence.retrievals) ? evidence.retrievals : [];
  const observedSources = [...new Set(retrievals.map((r) => r.source).filter(Boolean))];
  const observedViews = [...new Set(retrievals.map((r) => r.view).filter(Boolean))];
  const coverage = expectations.expectedCoverage ?? evidence.coverage ?? null;

  // A source NAME is not provenance. A row counts only when it carries a
  // timestamp this repository could have produced, a checksum of the shape the
  // ingester produces, and no binding that contradicts this run.
  const retrievalRows = retrievals.map((r) => {
    const v = validateRetrievalRow(r, run);
    return {
      source: r.source ?? null,
      view: r.view ?? null,
      retrievedAt: r.retrieved_at ?? null,
      checksum: r.checksum ?? null,
      instant: v.instant,
      valid: v.valid,
      reasons: v.reasons,
    };
  });
  const verifiedSources = [...new Set(retrievalRows.filter((r) => r.valid).map((r) => r.source).filter(Boolean))];
  // Fail closed: a required source is covered only by VALIDATED evidence.
  const missingSources = expectedSources.filter((s) => !verifiedSources.includes(s));
  const unverifiedSources = expectedSources.filter((s) => observedSources.includes(s) && !verifiedSources.includes(s));
  const invalidEvidence = retrievalRows.filter((r) => !r.valid);

  const sourceSelection = {
    expected: expectedSources,
    observed: observedSources,
    verified: verifiedSources,
    missing: missingSources,
    unverified: unverifiedSources,
    views: observedViews,
    coverage,
    note: 'coverage=current permits partial coverage; it does not prove which views were fetched',
  };

  // --- Freshness ----------------------------------------------------------
  const asOf = expectations.asOf ?? null;
  const asOfParsed = parseReferenceInstant(asOf);
  const asOfMs = asOfParsed.valid ? asOfParsed.ms : null;
  // Whether the receipt has a usable observation time at all. Every
  // time-based comparison below is gated on this.
  const observationKnown = asOfMs !== null;
  // An absent or non-positive cadence is not a freshness SLA. Defaulting one
  // in would invent a threshold the repository does not define, so the verdict
  // stays unknown instead.
  const cadenceSupplied = expectations.cadenceHours;
  const cadenceValid = isNumber(cadenceSupplied) && cadenceSupplied > 0;
  const cadenceHours = cadenceValid ? cadenceSupplied : null;

  const freshnessRows = retrievalRows.map((r) => {
    let timing = 'invalid';
    if (r.instant.valid) timing = 'valid';
    else if (r.retrievedAt === null || r.retrievedAt === undefined) timing = 'missing';
    // A retrieval stamped in the future has not happened yet. It is not
    // "fresh" -- it is invalid evidence.
    if (timing === 'valid' && observationKnown && r.instant.ms > asOfMs) timing = 'future';
    // The age is only ever computed against a KNOWN observation time. An
    // invalid or missing asOf must not take part in the subtraction: `null -
    // instant` is a negative number, and a negative age compares as "within
    // the cadence" -- so the row would carry a fabricated age and a true
    // cadence flag while the aggregate verdict said "unknown".
    const ageMs = (timing === 'valid' && observationKnown) ? asOfMs - r.instant.ms : null;
    return {
      source: r.source,
      view: r.view,
      retrievedAt: r.retrievedAt,
      checksum: r.checksum,
      timing,
      valid: r.valid,
      reasons: r.reasons,
      ageMs,
      ageHours: ageMs === null ? null : Number((ageMs / 3600000).toFixed(3)),
      // A cadence flag needs an age to compare. Without one there is no
      // flag, not a false one.
      withinOneCadence: (ageMs !== null && cadenceValid) ? ageMs <= cadenceHours * 3600000 : null,
    };
  });

  let freshnessVerdict = 'unknown';
  const freshnessProblems = [];
  if (!asOfParsed.valid) freshnessProblems.push(`the as-of instant ${asOfParsed.reason}`);
  if (!cadenceValid) freshnessProblems.push('no positive cadence was supplied');
  if (freshnessRows.length === 0) freshnessProblems.push('no retrieval evidence to age');
  const provablyStale = freshnessRows.some((r) => r.timing === 'valid' && r.withinOneCadence === false);
  const badTiming = freshnessRows.filter((r) => r.timing !== 'valid');

  if (freshnessProblems.length === 0) {
    if (badTiming.length) {
      // Invalid timing is unknown, NOT stale. Claiming "exceeds_cadence" here
      // would assert a fact the evidence does not support.
      freshnessVerdict = 'unknown';
      freshnessProblems.push(`${badTiming.length} retrieval timestamp(s) are missing, malformed, impossible or in the future`);
    } else if (provablyStale) {
      freshnessVerdict = 'exceeds_cadence';
    } else {
      freshnessVerdict = 'within_cadence';
    }
  }

  const freshness = {
    asOf,
    cadenceHours,
    bySource: freshnessRows,
    verdict: freshnessVerdict,
    problems: freshnessProblems,
    // When WE fetched the source is not when the publisher published it. A
    // recent retrieval does not establish a recent source publication.
    sourcePublication: {
      established: false,
      note: 'retrieved_at records when THIS WORKFLOW fetched the source. It is not the publisher\'s publication time, so a recent retrieval does not establish that the underlying source was recently published.',
    },
    note: 'age is reported against the configured cadence; no freshness SLA is defined in this repository',
  };

  // --- Ingest / export / build / deployment --------------------------------
  const ingest = {
    parsed: isNumber(evidence.ingest && evidence.ingest.parsed) ? evidence.ingest.parsed : null,
    valid: isNumber(evidence.ingest && evidence.ingest.valid) ? evidence.ingest.valid : null,
    rejected: isNumber(evidence.ingest && evidence.ingest.rejected) ? evidence.ingest.rejected : null,
    written: isNumber(evidence.ingest && evidence.ingest.written) ? evidence.ingest.written : null,
    // How many records were byte-identical to the stored copy. A run can
    // succeed while every record is unchanged: that is a successful
    // OBSERVATION, not evidence that new breaches were published.
    unchanged: isNumber(evidence.ingest && evidence.ingest.unchanged) ? evidence.ingest.unchanged : null,
  };
  const exportInfo = {
    breaches: isNumber(evidence.export && evidence.export.breaches) ? evidence.export.breaches : null,
  };
  const buildInfo = {
    pages: isNumber(evidence.build && evidence.build.pages) ? evidence.build.pages : null,
  };

  const deployStage = stageById.get('deploy');
  const deploymentRef = evidence.deployment && typeof evidence.deployment === 'object' ? evidence.deployment : {};
  const deployment = {
    verdict: deployStage ? deployStage.verdict : 'missing',
    reference: deploymentRef.reference ?? null,
    completedAt: deploymentRef.completedAt ?? null,
  };
  if (deployStage && deployStage.verdict === 'success' && !deployment.reference) {
    deployment.verdict = 'unknown';
    notes.push('the deploy step succeeded but no deployment reference was recorded');
  }
  if (deployStage && deployStage.verdict !== 'success') {
    deployment.reference = null;
    deployment.completedAt = null;
  }

  // --- Deployed-artifact identity ------------------------------------------
  //
  // "The deploy step succeeded and there is a URL" is a REPORT that something
  // was published. It is not proof that the live artifact is the artifact this
  // run built. The site's own origin is live whether or not any deployment
  // ever ran, so a bare site URL is not identity proof at all.
  //
  // Identity is verified only when the evidence names the specific deployed
  // artifact AND binds it to this run's revision.
  const identityArtifactSha = typeof deploymentRef.artifactSha === 'string' ? deploymentRef.artifactSha : null;
  const invalidArtifactDigest = deploymentRef.artifactSha != null &&
    (identityArtifactSha === null || !SHA256_HEX.test(identityArtifactSha));
  const identityDeploymentId = typeof deploymentRef.deploymentId === 'string' ? deploymentRef.deploymentId : null;
  const identityBoundSha = typeof deploymentRef.sha === 'string' ? deploymentRef.sha : null;

  let referenceIsSiteOrigin = false;
  if (typeof deployment.reference === 'string') {
    try {
      const u = new URL(deployment.reference);
      referenceIsSiteOrigin = u.pathname === '' || u.pathname === '/';
    } catch {
      referenceIsSiteOrigin = false;
    }
  }

  const identity = {
    verdict: 'unknown',
    reason: null,
    artifactSha: identityArtifactSha,
    deploymentId: identityDeploymentId,
    boundSha: identityBoundSha,
    referenceIsSiteOrigin,
  };

  if (!deployStage || deployStage.verdict !== 'success') {
    identity.verdict = 'not_published';
    identity.reason = 'the deploy stage did not succeed';
  } else if (!deployment.reference) {
    identity.verdict = 'unknown';
    identity.reason = 'no deployment reference was recorded';
  } else if (invalidArtifactDigest) {
    // A separate deployment id cannot make a supplied malformed digest valid.
    identity.verdict = 'unproven';
    identity.reason = 'the supplied artifact digest is not a sha256 digest';
  } else if (!identityArtifactSha && !identityDeploymentId) {
    identity.verdict = 'unproven';
    identity.reason = 'the deployment evidence names no deployed artifact (no artifact digest and no deployment id), so the reference cannot identify what was published';
  } else if (!identityBoundSha) {
    identity.verdict = 'unproven';
    identity.reason = 'the deployed artifact is not bound to a revision, so it cannot be tied to this run';
  } else if (run.headSha && identityBoundSha !== run.headSha) {
    identity.verdict = 'unproven';
    identity.reason = 'the deployed artifact was bound to a different revision';
  } else if (!run.headSha) {
    identity.verdict = 'unproven';
    identity.reason = 'the run is not bound to a revision, so the deployed artifact cannot be tied to it';
  } else {
    identity.verdict = 'verified';
  }
  if (referenceIsSiteOrigin && identity.verdict !== 'verified') {
    identity.reason += '; the reference is the site origin, which is live whether or not this run deployed anything';
  }
  deployment.identity = identity;

  // --- Artifacts ----------------------------------------------------------
  const artifacts = (Array.isArray(evidence.artifacts) ? evidence.artifacts : []).map((a) => {
    const row = {
      name: a.name ?? null,
      runId: a.runId ?? null,
      attempt: a.attempt ?? null,
      sha: a.sha ?? null,
      uploaded: a.uploaded === true,
      files: Array.isArray(a.files) ? a.files : [],
      verdict: 'unknown',
      reason: null,
    };
    if (row.runId != null && !hasRunIdentity(run.runId)) {
      row.verdict = 'rejected';
      row.reason = 'the artifact run binding cannot be checked because the run identifier is not recorded';
    } else if (row.runId != null && row.runId !== run.runId) {
      row.verdict = 'rejected';
      row.reason = 'the artifact belongs to a different run';
    } else if (row.attempt !== null && !isAttempt(row.attempt)) {
      row.verdict = 'rejected';
      row.reason = 'the artifact attempt must be a positive safe integer';
    } else if (row.attempt !== null && run.attempt === null) {
      row.verdict = 'rejected';
      row.reason = 'the artifact attempt binding cannot be checked because the run attempt is not recorded';
    } else if (row.attempt !== null && !isAttempt(run.attempt)) {
      row.verdict = 'rejected';
      row.reason = 'the artifact attempt binding cannot be checked because the run attempt must be a positive safe integer';
    } else if (row.attempt !== null && row.attempt !== run.attempt) {
      row.verdict = 'rejected';
      row.reason = 'the artifact belongs to a different attempt';
    } else if (row.sha != null && !run.headSha) {
      row.verdict = 'rejected';
      row.reason = 'the artifact revision binding cannot be checked because the run revision is not recorded';
    } else if (row.sha != null && row.sha !== run.headSha) {
      row.verdict = 'rejected';
      row.reason = 'the artifact was produced from a different revision';
    } else if (!row.uploaded) {
      row.verdict = 'missing';
      row.reason = 'the upload step succeeded but no file was uploaded';
    } else {
      row.verdict = 'present';
    }
    return row;
  });
  const artifactStage = stageById.get('artifact');
  if (artifactStage && artifactStage.verdict === 'success' && artifacts.length === 0) {
    artifacts.push({
      name: null,
      runId: null, attempt: null, sha: null, uploaded: false, files: [],
      verdict: 'missing',
      reason: 'the upload step succeeded but no file was uploaded',
    });
  }

  // The rejected-record count. A missing rejection artifact does NOT establish
  // zero rejected records -- it establishes that the count is unknown.
  let rejectedRecords;
  if (ingest.rejected !== null) {
    rejectedRecords = { value: ingest.rejected, known: true, reason: null };
  } else {
    const rejectedArtifact = artifacts.find((a) => a.verdict === 'present');
    rejectedRecords = {
      value: null,
      known: false,
      reason: rejectedArtifact
        ? 'the rejection artifact was uploaded but no rejected count was recorded in the run'
        : 'no rejection artifact was uploaded, so the rejected count is not established by this run',
    };
  }

  // --- The verdict --------------------------------------------------------
  let refreshVerdict = 'unknown';
  let blockage = null;
  let failingStage = null;
  let stageOutcome = 'unknown';
  const provenanceProblems = [];

  if (revisionMatches === false || checkoutMatches === false || attemptMatches === false) {
    refreshVerdict = 'unknown';
    notes.push('this receipt does not describe the expected revision or attempt');
  } else {
    const ordered = requiredStages.map((id) => stageById.get(id)).filter(Boolean);
    const failed = ordered.find((s) => s.verdict === 'failed' || s.verdict === 'cancelled');
    if (failed) {
      failingStage = failed.id;
      stageOutcome = 'failed';
      refreshVerdict = 'failed';
      blockage = failed.id === 'credentials' || failed.id === 'tests'
        ? BLOCKAGE.BEFORE_INGESTION
        : (failed.id === 'ingest' ? BLOCKAGE.AT_INGESTION : BLOCKAGE.AFTER_INGESTION);
      missingProof.push(`the ${failed.label} stage did not succeed (${failed.verdict})`);
    } else {
      const notDone = ordered.find((s) => s.verdict !== 'success');
      if (notDone) {
        // 'skipped' (the step ran as skipped), 'missing' (the step is not in
        // the evidence at all) and 'pending'/'unknown' are kept apart.
        stageOutcome = 'incomplete';
        refreshVerdict = (notDone.verdict === 'pending' || notDone.verdict === 'unknown')
          ? 'unknown'
          : notDone.verdict;
        if (refreshVerdict === 'skipped' || refreshVerdict === 'missing') {
          missingProof.push(`the ${notDone.label} stage was ${notDone.verdict}, not successful`);
        }
      } else {
        // Every required stage succeeded. That alone is still not proof of a
        // refresh. Matching source NAMES is not enough either: the retrieval
        // evidence has to be there, it has to validate, and the run has to be
        // bound to a run identifier, a revision and an attempt.
        stageOutcome = 'all_succeeded';
        if (expectedSources.length === 0) {
          provenanceProblems.push('no expected source list was supplied, so the retrieved source set cannot be checked');
        } else if (missingSources.length) {
          provenanceProblems.push(`no validated retrieval evidence for required source(s): ${missingSources.join(', ')}`);
        }
        if (invalidEvidence.length) {
          provenanceProblems.push(
            `${invalidEvidence.length} retrieval row(s) failed validation: ` +
            invalidEvidence.map((r) => `${r.source ?? 'unknown source'} (${r.reasons.join('; ')})`).join(' | '),
          );
        }
        // A retrieval stamped in the future is internally contradictory
        // evidence: it describes a fetch that cannot have happened yet.
        const futureRows = freshnessRows.filter((r) => r.timing === 'future');
        if (futureRows.length) {
          provenanceProblems.push(
            `${futureRows.length} retrieval timestamp(s) are later than the as-of instant (${asOf}): ` +
            futureRows.map((r) => `${r.source ?? 'unknown source'} at ${r.retrievedAt}`).join(' | '),
          );
        }
        if (artifacts.some((a) => a.verdict === 'rejected')) {
          provenanceProblems.push('an artifact binding cannot be validated against this run, attempt or revision');
        }
        // A verified-success claim needs a run identifier, a revision and an
        // attempt. A run whose revision was never recorded cannot be quoted
        // as a verified refresh of that revision.
        const revisionBound = !!(run.headSha && run.checkedOutSha && run.headSha === run.checkedOutSha);
        if (!revisionBound) {
          provenanceProblems.push('the run is not bound to a single revision (its head SHA and checked-out SHA are not both recorded and equal)');
        }
        if (run.attempt === null) {
          provenanceProblems.push('the run attempt is not recorded');
        } else if (!isAttempt(run.attempt)) {
          provenanceProblems.push('the run attempt must be a positive safe integer');
        }
        if (!hasRunIdentity(run.runId)) {
          provenanceProblems.push('the run identifier is not recorded');
        }
        if (provenanceProblems.length) {
          // Fail closed. "Every stage was green" is a fact about the stages.
          // It is not a verified refresh, and missing or mismatched evidence
          // must not be reported as one.
          refreshVerdict = 'unknown';
          for (const p of provenanceProblems) missingProof.push(p);
        } else {
          refreshVerdict = 'success';
        }
      }
    }
  }

  // A dry run never publishes, whatever else it did.
  if (dryRun) {
    missingProof.push('publication (export, build and deploy) is not part of a dry run');
    // A dry run must never be quotable as "the refresh succeeded": it read
    // the sources, parsed them, and wrote nothing anywhere.
    if (refreshVerdict === 'success') refreshVerdict = 'dry_run_only';
  }

  // Publication is a separate claim from refresh. A dry run can refresh the
  // data and publish nothing; a run can refresh the data and fail to publish
  // it. Conflating the two is how "we ran the ingest" turns into "the site
  // was updated".
  let publicationVerdict;
  if (dryRun) {
    publicationVerdict = 'not_published';
  } else if (deployStage && deployStage.verdict === 'success' && deployment.reference) {
    // The deploy step succeeded and a reference was recorded. Whether that
    // reference identifies the artifact THIS RUN built is a separate claim.
    publicationVerdict = identity.verdict === 'verified' ? 'published_verified' : 'published_reported';
  } else if (deployStage && ['skipped', 'missing', 'failed', 'cancelled'].includes(deployStage.verdict)) {
    // The deploy step did not publish: it was skipped, never ran, or failed.
    publicationVerdict = 'not_published';
  } else {
    publicationVerdict = 'unknown';
  }
  const published = publicationVerdict === 'published_verified' || publicationVerdict === 'published_reported';
  const publication = {
    verdict: publicationVerdict,
    // 'verified' | 'unproven' | 'not_published' | 'unknown'
    identity: identity.verdict,
    reference: published ? deployment.reference : null,
    completedAt: published ? deployment.completedAt : null,
    note: dryRun
      ? 'a dry run is not a publication'
      : (identity.reason || null),
  };

  // A deployment cannot be attributed to a revision or an attempt that does
  // not match the one the receipt is about. Downgrade it rather than let it
  // be quoted next to a mismatched SHA.
  if ((revisionMatches === false || checkoutMatches === false || attemptMatches === false)
      && (publication.verdict === 'published_verified' || publication.verdict === 'published_reported')) {
    publication.verdict = 'unknown';
    publication.identity = 'unknown';
    publication.reference = null;
    publication.completedAt = null;
    publication.note = 'the deployment cannot be attributed to the expected revision or attempt';
  }

  // --- Which refresh is the most recent successful one? --------------------
  //
  // Candidates are the current run (when its stages all succeeded) and any
  // EARLIER successful refresh declared in the expectations. The newest
  // evidenced success wins -- but only when the ordering can be established.
  // When it cannot, the uncertainty is preserved rather than guessed away,
  // and an UNVERIFIED newer success never silently supersedes an earlier one.
  //
  // CONTRACT: a candidate whose completion time is LATER than the receipt's
  // observation time had not finished when the receipt was taken. It cannot
  // be an already evidenced success, so it is excluded from selection
  // deterministically -- it is not treated as merely uncertain, and it is
  // never ordered in as if it had happened. Its provenance stays in the
  // candidate list, so nothing is erased.
  const declaredSuccesses = Array.isArray(expectations.lastSuccessfulRefreshes)
    ? expectations.lastSuccessfulRefreshes
    : (expectations.lastSuccessful ? [expectations.lastSuccessful] : []);

  const buildSelectionCandidate = (source, runId, attempt, completedAt, verified) => {
    const t = parseReferenceInstant(completedAt);
    const orderMs = t.valid ? t.ms : null;
    const placeable = orderMs !== null;
    // `futureDated` is only knowable when the receipt has an observation
    // time. Without one it stays null -- unknown, not false.
    const futureDated = placeable && observationKnown ? orderMs > asOfMs : null;
    // Declared prior successes may omit an attempt, but a supplied malformed
    // attempt is evidence of an invalid identity, not optional missing data.
    const invalidAttempt = attempt != null && !isAttempt(attempt);
    const excluded = futureDated === true || invalidAttempt;
    return {
      source,
      runId,
      attempt,
      completedAt: completedAt ?? null,
      orderMs,
      placeable,
      futureDated,
      invalidAttempt,
      excluded,
      exclusionReason: futureDated === true
        ? 'the candidate completed after the receipt observation time, so it cannot be an already evidenced success'
        : (invalidAttempt ? 'the candidate attempt must be a positive safe integer' : null),
      verified,
    };
  };

  const selectionCandidates = [];
  if (stageOutcome === 'all_succeeded') {
    selectionCandidates.push(buildSelectionCandidate('this_run', run.runId, run.attempt, run.completedAt, refreshVerdict === 'success'));
  }
  for (const d of declaredSuccesses) {
    selectionCandidates.push(buildSelectionCandidate(
      'declared', d.runId ?? null, d.attempt ?? null, d.completedAt ?? null, false,
    ));
  }

  let selectionVerdict = 'unknown';
  let selected = null;
  const superseded = [];
  const futureCandidates = selectionCandidates.filter((c) => c.futureDated === true);
  const invalidAttemptCandidates = selectionCandidates.filter((c) => c.invalidAttempt);
  const selectable = selectionCandidates.filter((c) => !c.excluded);

  if (selectionCandidates.length === 0) {
    selectionVerdict = 'unknown';
  } else if (selectionCandidates.length === 1) {
    const only = selectionCandidates[0];
    if (only.excluded || (only.source === 'this_run' && !only.verified)) {
      // Being the only candidate does not supply missing provenance or make
      // a future completion an already evidenced success.
      selectionVerdict = 'unknown';
    } else {
      selected = only;
      selectionVerdict = only.source === 'this_run' ? 'this_run' : 'reported';
    }
  } else if (selectable.some((c) => !c.placeable)) {
    // An eligible candidate without a place on the timeline might be newest.
    // Excluded candidates remain visible but cannot participate in ordering.
    selectionVerdict = 'ambiguous';
  } else if (selectable.length === 0) {
    selectionVerdict = 'unknown';
  } else if (selectable.length === 1) {
    const only = selectable[0];
    if (only.source === 'this_run' && !only.verified) {
      // Excluding another candidate must not promote an unverified current
      // run. Declared prior evidence retains its separate reported meaning.
      selectionVerdict = 'unknown';
    } else {
      selected = only;
      selectionVerdict = selected.source === 'this_run' ? 'this_run' : 'reported';
    }
  } else {
    const sorted = [...selectable].sort((a, b) => b.orderMs - a.orderMs);
    if (sorted[0].orderMs === sorted[1].orderMs) {
      selectionVerdict = 'ambiguous';
    } else if (sorted[0].source === 'this_run' && !sorted[0].verified) {
      // A newer success that could not be verified must not silently
      // supersede an earlier one.
      selectionVerdict = 'ambiguous';
    } else {
      selected = sorted[0];
      selectionVerdict = selected.source === 'this_run' ? 'this_run' : 'reported';
      superseded.push(...sorted.slice(1));
    }
  }
  if (futureCandidates.length) {
    notes.push(
      `${futureCandidates.length} successful-refresh candidate(s) completed after the receipt observation time` +
      `${observationKnown ? ` (${asOf})` : ''} and cannot be an already evidenced success` +
      `: ${futureCandidates.map((c) => `${c.source} run ${c.runId ?? 'unknown'} at ${c.completedAt ?? 'unknown'}`).join(' | ')}`,
    );
  }
  if (invalidAttemptCandidates.length) {
    notes.push(`${invalidAttemptCandidates.length} successful-refresh candidate(s) have an invalid supplied attempt and were excluded`);
  }
  if (selectionVerdict === 'ambiguous') {
    notes.push('the successful refreshes in this evidence could not be ordered, so the most recent one is not established');
  }

  const refreshSelection = {
    verdict: selectionVerdict,
    observationTime: asOf,
    observationKnown,
    candidates: selectionCandidates.map((c) => ({
      source: c.source,
      runId: c.runId,
      attempt: c.attempt,
      completedAt: c.completedAt,
      orderable: c.placeable,
      futureDated: c.futureDated,
      excluded: c.excluded,
      reason: c.exclusionReason,
      verified: c.verified,
    })),
    selected: selected
      ? { source: selected.source, runId: selected.runId, attempt: selected.attempt, completedAt: selected.completedAt }
      : null,
    superseded: superseded.map((c) => ({ source: c.source, runId: c.runId, completedAt: c.completedAt })),
    note: 'the newest evidenced successful refresh wins; a run that had not finished by the receipt observation time is not an evidenced success, and a newer success that cannot be verified does not supersede an earlier one',
  };

  const verification = {
    stageOutcome,
    verdict: refreshVerdict === 'success' ? 'verified' : (stageOutcome === 'all_succeeded' ? 'unverified' : 'not_applicable'),
    // Provenance can only be complete for a run that actually got as far as
    // needing provenance.
    provenanceComplete: stageOutcome === 'all_succeeded' && provenanceProblems.length === 0,
    problems: provenanceProblems,
    note: 'a verified refresh requires every required stage to have succeeded AND validated retrieval evidence for every expected source AND a run identifier bound to a revision and an attempt',
  };

  const kind = data.kind || 'recorded';

  return {
    schema: RECEIPT_SCHEMA,
    label: data.label || null,
    evidenceKind: kind,
    synthetic: kind === 'synthetic',
    note: kind === 'synthetic'
      ? 'SYNTHETIC FIXTURE: this receipt exercises the checker only. It is not evidence of any operational success.'
      : null,
    run,
    mode,
    revision: {
      expectedHeadSha: expectedSha,
      headSha: run.headSha,
      checkedOutSha: run.checkedOutSha,
      revisionMatches,
      checkoutMatches,
      attemptMatches,
    },
    sourceSelection,
    stages: stageRows,
    tests,
    ingest,
    export: exportInfo,
    build: buildInfo,
    deployment,
    artifacts,
    rejectedRecords,
    retrievals: freshnessRows,
    freshness,
    refreshVerdict,
    blockage,
    failingStage,
    publication,
    lastSuccessfulRefresh: selected
      ? {
        runId: selected.runId,
        attempt: selected.attempt,
        completedAt: selected.completedAt,
        verdict: selectionVerdict,
        note: selected.source === 'this_run'
          ? 'this run is the most recent successful refresh this evidence covers; earlier runs are not covered by it'
          : 'declared in the receipt expectations as an EARLIER successful refresh; this run did not produce it and did not inherit anything from it',
      }
      : {
        runId: null,
        attempt: null,
        completedAt: null,
        verdict: selectionVerdict === 'ambiguous' ? 'ambiguous' : 'unknown',
        note: selectionVerdict === 'ambiguous'
          ? 'the successful refreshes in this evidence could not be ordered, so the most recent one is not established'
          : null,
      },
    refreshSelection,
    verification,
    missingProof,
    notes,
    evidenceReferences: evidenceRefs,
  };
}

/** Render a receipt as a readable assessment. */
function renderAssessment(receipt) {
  const lines = [];
  const r = receipt;
  const stageLabel = (s) => {
    const status = s.status || '-';
    const conclusion = s.conclusion || '-';
    return `${status}/${conclusion}`;
  };

  lines.push(`Refresh receipt${r.label ? ` -- ${r.label}` : ''}`);
  if (r.evidenceKind === 'synthetic') {
    lines.push('  *** SYNTHETIC FIXTURE -- exercises the checker only, not operational evidence ***');
  } else if (r.evidenceKind === 'historical') {
    lines.push('  *** HISTORICAL COMPARISON -- not a current receipt ***');
  }
  lines.push(`Repository:  ${r.run.repository || 'unknown'}`);
  lines.push(`Workflow:    ${r.run.workflowPath || 'unknown'}`);
  lines.push(`Run:         ${r.run.runId || 'unknown'} (attempt ${formatAttempt(r.run.attempt)})` +
    `  event=${r.run.event || 'unknown'}  branch=${r.run.branch || 'unknown'}`);
  lines.push(`Revision:    head=${r.run.headSha || 'unknown'}`);
  lines.push(`             checked out=${r.run.checkedOutSha || 'unknown'}` +
    `  matches expected: ${r.revision.revisionMatches === null ? 'unknown' : r.revision.revisionMatches}` +
    `  checkout matches: ${r.revision.checkoutMatches === null ? 'unknown' : r.revision.checkoutMatches}` +
    `  attempt matches: ${r.revision.attemptMatches === null ? 'unknown' : r.revision.attemptMatches}`);
  lines.push(`Started:     ${r.run.startedAt || 'unknown'}   Completed: ${r.run.completedAt || 'unknown'}`);
  lines.push(`Mode:        ${r.mode}`);
  lines.push(`Sources:     expected=${r.sourceSelection.expected.join(', ') || 'none'}` +
    `  observed=${r.sourceSelection.observed.join(', ') || 'none'}` +
    `  missing=${r.sourceSelection.missing.join(', ') || 'none'}` +
    `  coverage=${r.sourceSelection.coverage || 'unknown'}`);
  lines.push('');
  lines.push(`VERDICT: ${r.refreshVerdict}` + (r.blockage ? ` (stopped ${r.blockage})` : '') +
    (r.verification ? `  [${r.verification.verdict}; stages=${r.verification.stageOutcome}]` : ''));
  lines.push(`PUBLICATION: ${r.publication.verdict}` +
    (r.publication.identity ? `  identity=${r.publication.identity}` : '') +
    (r.publication.reference ? `  reference=${r.publication.reference}` : '') +
    (r.publication.completedAt ? `  completedAt=${r.publication.completedAt}` : '') +
    (r.publication.note ? `  (${r.publication.note})` : ''));
  lines.push('');

  lines.push('Stages');
  for (const s of r.stages) {
    const req = s.required ? 'required' : 'optional';
    const reached = s.reached ? '' : '  (not reached)';
    lines.push(`  ${s.id.padEnd(12)} ${String(s.verdict).padEnd(10)} ${stageLabel(s).padEnd(20)} ${req.padEnd(9)} ${s.name || '(absent)'}${reached}`);
  }
  lines.push('');

  lines.push('Tests');
  lines.push(`  verdict=${r.tests.verdict}  total=${r.tests.total ?? 'unknown'}` +
    `  passed=${r.tests.passed ?? 'unknown'}  failed=${r.tests.failed ?? 'unknown'}` +
    `  skipped=${r.tests.skipped ?? 'unknown'}`);
  lines.push('');

  lines.push('Retrieval evidence');
  if (r.retrievals.length === 0) {
    lines.push('  (none recorded)');
  } else {
    for (const v of r.retrievals) {
      lines.push(`  ${String(v.source).padEnd(12)} ${String(v.view || '-').padEnd(22)}` +
        ` retrieved_at=${v.retrievedAt || 'unknown'}` +
        `  checksum=${v.checksum || 'unknown'}` +
        `  age=${v.ageHours === null ? 'unknown' : v.ageHours + 'h'}` +
        `  timing=${v.timing || 'unknown'}` +
        `  evidence=${v.valid === true ? 'validated' : 'INVALID: ' + (v.reasons || []).join('; ')}`);
    }
  }
  lines.push(`  freshness verdict: ${r.freshness.verdict} (as of ${r.freshness.asOf || 'unknown'}, cadence ${r.freshness.cadenceHours === null ? 'unknown' : r.freshness.cadenceHours + 'h'})`);
  for (const p of r.freshness.problems || []) lines.push(`    - ${p}`);
  if (r.freshness.sourcePublication && r.freshness.sourcePublication.established === false) {
    lines.push(`    - source publication: not established -- ${r.freshness.sourcePublication.note}`);
  }
  lines.push('');

  lines.push('Counts');
  lines.push(`  ingest: parsed=${r.ingest.parsed ?? 'unknown'} valid=${r.ingest.valid ?? 'unknown'}` +
    ` rejected=${r.ingest.rejected ?? 'unknown'} written=${r.ingest.written ?? 'unknown'}` +
    ` unchanged=${r.ingest.unchanged ?? 'unknown'}`);
  lines.push(`  export breaches=${r.export.breaches ?? 'unknown'}   build pages=${r.build.pages ?? 'unknown'}`);
  lines.push(`  rejected records: ${r.rejectedRecords.known ? r.rejectedRecords.value : 'unknown'}` +
    (r.rejectedRecords.reason ? `  (${r.rejectedRecords.reason})` : ''));
  lines.push(`  deployment: verdict=${r.deployment.verdict}` +
    `  reference=${r.deployment.reference || 'none'}` +
    `  completedAt=${r.deployment.completedAt || 'unknown'}` +
    (r.deployment.identity ? `  identity=${r.deployment.identity.verdict}` : '') +
    (r.deployment.identity && r.deployment.identity.reason ? `  (${r.deployment.identity.reason})` : ''));
  lines.push('');

  if (r.refreshSelection) {
    lines.push('Refresh selection');
    lines.push(`  verdict=${r.refreshSelection.verdict}` +
      `  observation=${r.refreshSelection.observationTime || 'unknown'}` +
      `  observationKnown=${r.refreshSelection.observationKnown}`);
    for (const c of r.refreshSelection.candidates) {
      lines.push(`  candidate: ${String(c.source).padEnd(9)} run=${c.runId ?? 'unknown'}` +
        `  attempt=${formatAttempt(c.attempt)}` +
        `  completedAt=${c.completedAt || 'unknown'}` +
        `  orderable=${c.orderable}` +
        `  futureDated=${c.futureDated === null ? 'unknown' : c.futureDated}` +
        `  verified=${c.verified}` +
        (c.excluded ? `  EXCLUDED: ${c.reason}` : ''));
    }
    if (r.refreshSelection.superseded.length) {
      for (const s of r.refreshSelection.superseded) {
        lines.push(`  superseded: ${s.source} run=${s.runId ?? 'unknown'} completedAt=${s.completedAt || 'unknown'}`);
      }
    }
    lines.push(`  ${r.refreshSelection.note}`);
    lines.push('');
  }

  if (r.verification) {
    lines.push('Verification');
    lines.push(`  verdict=${r.verification.verdict}  stages=${r.verification.stageOutcome}` +
      `  provenanceComplete=${r.verification.provenanceComplete}`);
    for (const p of r.verification.problems) lines.push(`  - ${p}`);
    lines.push(`  ${r.verification.note}`);
    lines.push('');
  }

  lines.push('Artifacts');
  if (r.artifacts.length === 0) {
    lines.push('  (none recorded)');
  } else {
    for (const a of r.artifacts) {
      lines.push(`  ${String(a.name || '-').padEnd(20)} ${String(a.verdict).padEnd(10)} ${a.reason || ''}`);
    }
  }
  lines.push('');

  lines.push('Missing proof');
  if (r.missingProof.length === 0) {
    lines.push('  (none)');
  } else {
    for (const m of r.missingProof) lines.push(`  - ${m}`);
  }
  if (r.notes.length) {
    lines.push('');
    lines.push('Notes');
    for (const n of r.notes) lines.push(`  - ${n}`);
  }
  lines.push('');
  lines.push(`Last attempt: run ${r.run.runId} (attempt ${formatAttempt(r.run.attempt)})` +
    `  verdict=${r.refreshVerdict}  publication=${r.publication.verdict}` +
    `  startedAt=${r.run.startedAt || 'unknown'}`);
  lines.push(`Last successful refresh: ${r.lastSuccessfulRefresh.verdict === 'unknown' ? 'unknown' : `run ${r.lastSuccessfulRefresh.runId} (attempt ${formatAttempt(r.lastSuccessfulRefresh.attempt)})`}` +
    (r.lastSuccessfulRefresh.completedAt ? `  completedAt=${r.lastSuccessfulRefresh.completedAt}` : '') +
    (r.lastSuccessfulRefresh.note ? `  -- ${r.lastSuccessfulRefresh.note}` : ''));
  lines.push('This receipt evaluates LOCAL SAVED EVIDENCE ONLY. It is not a live observation of any provider,');
  lines.push('of D1, or of the deployed site, and it is not by itself operational acceptance.');

  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--case') args.case = argv[++i];
    else if (a === '--evidence') args.evidence = argv[++i];
    else if (a === '--expect') args.expect = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${err.message})`);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  let cases;
  if (args.case) {
    const loaded = readJson(path.resolve(args.case));
    // A file may hold one case or an array of them (the synthetic set).
    cases = Array.isArray(loaded) ? loaded : [loaded];
    if (cases.length === 0) throw new Error(`${args.case}: contains no cases`);
  } else if (args.evidence && args.expect) {
    cases = [{
      label: path.basename(args.evidence),
      kind: 'recorded',
      evidence: readJson(path.resolve(args.evidence)),
      expectations: readJson(path.resolve(args.expect)),
    }];
  } else {
    process.stderr.write('usage: node scripts/refresh-receipt.js --case <file.json> [--json] [--out <file>]\n');
    process.stderr.write('       node scripts/refresh-receipt.js --evidence <e.json> --expect <x.json> [--json]\n');
    return 2;
  }

  const receipts = cases.map((c) => evaluateReceipt(c));
  const text = args.json
    ? JSON.stringify(cases.length === 1 ? receipts[0] : receipts, null, 2)
    : receipts.map((r) => renderAssessment(r)).join('\n\n' + '='.repeat(78) + '\n\n');

  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), text + '\n', 'utf8');
  } else {
    process.stdout.write(text + '\n');
  }
  return 0;
}

module.exports = {
  evaluateReceipt,
  renderAssessment,
  main,
  STAGE_DEFINITIONS,
  PUBLICATION_STAGES,
  DRY_RUN_STAGES,
  RECEIPT_SCHEMA,
};

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`refresh-receipt: ${err.message}\n`);
    process.exitCode = 1;
  }
}
