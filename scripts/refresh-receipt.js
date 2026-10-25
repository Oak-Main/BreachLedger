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

function parseInstant(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
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
    attempt: isNumber(evidence.attempt) ? evidence.attempt : null,
    event: evidence.event ?? null,
    branch: evidence.branch ?? null,
    headSha: evidence.headSha ?? null,
    checkedOutSha: evidence.checkedOutSha ?? null,
    startedAt: evidence.startedAt ?? null,
    completedAt: evidence.completedAt ?? null,
  };
  ref('evidence.runId', run.runId);
  ref('evidence.headSha', run.headSha);
  ref('evidence.checkedOutSha', run.checkedOutSha);

  // A receipt that describes a different revision, or a different attempt of
  // the run, cannot satisfy a claim about this revision.
  const expectedSha = expectations.expectedHeadSha || null;
  const expectedAttempt = isNumber(expectations.expectedAttempt) ? expectations.expectedAttempt : null;
  const revisionMatches = expectedSha ? run.headSha === expectedSha : null;
  const checkoutMatches = expectedSha ? run.checkedOutSha === expectedSha : null;
  const attemptMatches = expectedAttempt ? run.attempt === expectedAttempt : null;

  if (revisionMatches === false) {
    missingProof.push(`the run's head SHA (${run.headSha}) is not the expected revision (${expectedSha})`);
  }
  if (checkoutMatches === false) {
    missingProof.push(`the checkout SHA (${run.checkedOutSha}) does not match the expected revision (${expectedSha})`);
  }
  if (attemptMatches === false) {
    missingProof.push(`run attempt ${run.attempt} is not the expected attempt ${expectedAttempt}`);
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
  const missingSources = expectedSources.filter((s) => !observedSources.includes(s));
  const coverage = expectations.expectedCoverage ?? evidence.coverage ?? null;

  const sourceSelection = {
    expected: expectedSources,
    observed: observedSources,
    missing: missingSources,
    views: observedViews,
    coverage,
    note: 'coverage=current permits partial coverage; it does not prove which views were fetched',
  };

  // --- Freshness ----------------------------------------------------------
  const asOf = expectations.asOf ?? null;
  const asOfMs = parseInstant(asOf);
  const cadenceHours = isNumber(expectations.cadenceHours) ? expectations.cadenceHours : 24;
  const freshnessRows = retrievals.map((r) => {
    const t = parseInstant(r.retrieved_at);
    const ageMs = t !== null && asOfMs !== null ? asOfMs - t : null;
    return {
      source: r.source ?? null,
      view: r.view ?? null,
      retrievedAt: r.retrieved_at ?? null,
      checksum: r.checksum ?? null,
      ageMs,
      ageHours: ageMs === null ? null : Number((ageMs / 3600000).toFixed(3)),
      withinOneCadence: ageMs === null ? null : ageMs <= cadenceHours * 3600000,
    };
  });
  const freshness = {
    asOf,
    cadenceHours,
    bySource: freshnessRows,
    verdict: asOfMs === null || freshnessRows.length === 0
      ? 'unknown'
      : (freshnessRows.every((r) => r.withinOneCadence === true) ? 'within_cadence' : 'exceeds_cadence'),
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

  // --- Artifacts ----------------------------------------------------------
  const artifacts = (Array.isArray(evidence.artifacts) ? evidence.artifacts : []).map((a) => {
    const row = {
      name: a.name ?? null,
      runId: a.runId ?? null,
      attempt: isNumber(a.attempt) ? a.attempt : null,
      sha: a.sha ?? null,
      uploaded: a.uploaded === true,
      files: Array.isArray(a.files) ? a.files : [],
      verdict: 'unknown',
      reason: null,
    };
    if (row.runId && run.runId && row.runId !== run.runId) {
      row.verdict = 'rejected';
      row.reason = 'the artifact belongs to a different run';
    } else if (row.attempt !== null && run.attempt !== null && row.attempt !== run.attempt) {
      row.verdict = 'rejected';
      row.reason = 'the artifact belongs to a different attempt';
    } else if (row.sha && run.headSha && row.sha !== run.headSha) {
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

  if (revisionMatches === false || checkoutMatches === false || attemptMatches === false) {
    refreshVerdict = 'unknown';
    notes.push('this receipt does not describe the expected revision or attempt');
  } else {
    const ordered = requiredStages.map((id) => stageById.get(id)).filter(Boolean);
    const failed = ordered.find((s) => s.verdict === 'failed' || s.verdict === 'cancelled');
    if (failed) {
      failingStage = failed.id;
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
        refreshVerdict = (notDone.verdict === 'pending' || notDone.verdict === 'unknown')
          ? 'unknown'
          : notDone.verdict;
        if (refreshVerdict === 'skipped' || refreshVerdict === 'missing') {
          missingProof.push(`the ${notDone.label} stage was ${notDone.verdict}, not successful`);
        }
      } else {
        // Every required stage succeeded. That alone is still not proof of a
        // refresh: the retrieval evidence has to be there, and it has to be
        // for every source the run was supposed to ingest.
        refreshVerdict = 'success';
        if (expectedSources.length === 0) {
          refreshVerdict = 'unknown';
          missingProof.push('no expected source list was supplied, so the retrieved source set cannot be checked');
        } else if (missingSources.length) {
          refreshVerdict = 'unknown';
          missingProof.push(`no retrieval evidence for required source(s): ${missingSources.join(', ')}`);
        }
        if (artifacts.some((a) => a.verdict === 'rejected')) {
          refreshVerdict = 'unknown';
          missingProof.push('an artifact belongs to a different run, attempt or revision');
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
    publicationVerdict = 'published';
  } else if (deployStage && ['skipped', 'missing', 'failed', 'cancelled'].includes(deployStage.verdict)) {
    // The deploy step did not publish: it was skipped, never ran, or failed.
    publicationVerdict = 'not_published';
  } else {
    publicationVerdict = 'unknown';
  }
  const publication = {
    verdict: publicationVerdict,
    reference: publicationVerdict === 'published' ? deployment.reference : null,
    completedAt: publicationVerdict === 'published' ? deployment.completedAt : null,
    note: dryRun
      ? 'a dry run is not a publication'
      : null,
  };

  // A deployment cannot be attributed to a revision or an attempt that does
  // not match the one the receipt is about. Downgrade it rather than let it
  // be quoted next to a mismatched SHA.
  if ((revisionMatches === false || checkoutMatches === false || attemptMatches === false)
      && publication.verdict === 'published') {
    publication.verdict = 'unknown';
    publication.reference = null;
    publication.completedAt = null;
    publication.note = 'the deployment cannot be attributed to the expected revision or attempt';
  }

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
    lastSuccessfulRefresh: expectations.lastSuccessful
      ? {
        runId: expectations.lastSuccessful.runId ?? null,
        attempt: isNumber(expectations.lastSuccessful.attempt) ? expectations.lastSuccessful.attempt : null,
        completedAt: expectations.lastSuccessful.completedAt ?? null,
        verdict: 'reported',
      }
      : (refreshVerdict === 'success'
        ? {
          runId: run.runId,
          attempt: run.attempt,
          completedAt: run.completedAt,
          verdict: 'this_run',
          note: 'this run is the most recent successful refresh this evidence covers; earlier runs are not covered by it',
        }
        : { runId: null, attempt: null, completedAt: null, verdict: 'unknown' }),
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
  lines.push(`Run:         ${r.run.runId || 'unknown'} (attempt ${r.run.attempt === null ? 'unknown' : r.run.attempt})` +
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
  lines.push(`VERDICT: ${r.refreshVerdict}` + (r.blockage ? ` (stopped ${r.blockage})` : ''));
  lines.push(`PUBLICATION: ${r.publication.verdict}` +
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
        `  age=${v.ageHours === null ? 'unknown' : v.ageHours + 'h'}`);
    }
  }
  lines.push(`  freshness verdict: ${r.freshness.verdict} (as of ${r.freshness.asOf || 'unknown'}, cadence ${r.freshness.cadenceHours}h)`);
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
    `  completedAt=${r.deployment.completedAt || 'unknown'}`);
  lines.push('');

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
  lines.push(`Last successful refresh: ${r.lastSuccessfulRefresh.verdict === 'unknown' ? 'unknown' : `run ${r.lastSuccessfulRefresh.runId} (attempt ${r.lastSuccessfulRefresh.attempt})`}` +
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
