// Fixture tests for the offline refresh-receipt checker.
//
// The checker is the part of this work that is supposed to REFUSE to believe
// a refresh that did not happen. So most of what is tested here is a refusal:
// a green cleanup step must not prove a refresh, a missing artifact must not
// become "zero rejected records", a skipped stage must not become a
// successful one, and evidence from another revision or another run must not
// be allowed to stand in.
//
// Every fixture is either a real run (sanitized) or a clearly labelled
// synthetic one. A synthetic green case exercises the checker only: it is
// never an operational success, and the receipt says so in its own output.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  evaluateReceipt,
  renderAssessment,
  RECEIPT_SCHEMA,
} = require('./refresh-receipt');

const FIXTURES = path.join(__dirname, 'fixtures', 'refresh-receipt');

function loadCase(file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
}

const FAILED_RUN = loadCase('failed-run-40185682174.json');
const HISTORICAL_RUN = loadCase('historical-run-40085137740.json');
const SYNTHETIC = loadCase('synthetic-cases.json');
const PROVENANCE = loadCase('synthetic-provenance-cases.json');
const ALL_SYNTHETIC = [...SYNTHETIC, ...PROVENANCE];

function syntheticByPrefix(prefix) {
  const found = ALL_SYNTHETIC.find((c) => c.label.startsWith(prefix));
  assert.ok(found, `no synthetic case labelled "${prefix}"`);
  return found;
}

function stageOf(receipt, id) {
  const stage = receipt.stages.find((s) => s.id === id);
  assert.ok(stage, `no stage "${id}" in the receipt`);
  return stage;
}

// --- The recorded failure -------------------------------------------------

test('the recorded failure is classified as blocked before ingestion', () => {
  const receipt = evaluateReceipt(FAILED_RUN);

  assert.equal(receipt.schema, RECEIPT_SCHEMA);
  assert.equal(receipt.run.runId, '40185682174');
  assert.equal(receipt.run.attempt, 1);
  assert.equal(receipt.run.startedAt, '2026-10-25T10:39:38Z');
  assert.equal(receipt.run.headSha, '3f51cbc4e7df9083cb055244335847fe9c2365c5');

  // The headline: this run did not refresh anything.
  assert.equal(receipt.refreshVerdict, 'failed');
  assert.equal(receipt.blockage, 'before_ingestion');
  assert.equal(receipt.failingStage, 'tests');

  // NOT a deployment failure: the deploy step was never reached.
  assert.equal(stageOf(receipt, 'deploy').verdict, 'skipped');
  assert.equal(receipt.publication.verdict, 'not_published');

  // NOT an invalid credential: the credential guard passed.
  assert.equal(stageOf(receipt, 'credentials').verdict, 'success');
  assert.notEqual(receipt.failingStage, 'credentials');

  // NOT a portal outage: the portal was never contacted.
  assert.equal(stageOf(receipt, 'ingest').verdict, 'skipped');
  assert.equal(receipt.retrievals.length, 0);

  // NOT a successful refresh, however green the cleanup steps were.
  assert.equal(stageOf(receipt, 'summary').verdict, 'success');
  assert.equal(stageOf(receipt, 'artifact').verdict, 'success');
  assert.notEqual(receipt.refreshVerdict, 'success');
});

test('the recorded failure reports the test totals it actually had', () => {
  const receipt = evaluateReceipt(FAILED_RUN);
  assert.equal(receipt.tests.verdict, 'failed');
  assert.equal(receipt.tests.total, 420);
  assert.equal(receipt.tests.passed, 419);
  assert.equal(receipt.tests.failed, 1);
  assert.equal(receipt.tests.skipped, 0);
});

test('the recorded failure does not turn a missing rejection artifact into "zero rejected records"', () => {
  const receipt = evaluateReceipt(FAILED_RUN);
  // The upload step succeeded, but no file was uploaded.
  assert.equal(stageOf(receipt, 'artifact').verdict, 'success');
  assert.equal(receipt.artifacts.length, 1);
  assert.equal(receipt.artifacts[0].verdict, 'missing');
  assert.match(receipt.artifacts[0].reason, /no file was uploaded/);

  // And the rejected count is therefore unknown, not zero.
  assert.equal(receipt.rejectedRecords.known, false);
  assert.equal(receipt.rejectedRecords.value, null);
  assert.match(receipt.rejectedRecords.reason, /not established by this run/);
});

test('the recorded failure leaves freshness unknown rather than borrowing it from elsewhere', () => {
  const receipt = evaluateReceipt(FAILED_RUN);
  assert.equal(receipt.freshness.verdict, 'unknown');
  assert.equal(receipt.freshness.asOf, '2026-10-25T12:00:00Z');
  assert.equal(receipt.freshness.bySource.length, 0);
  // Naming the earlier successful run must NOT smuggle its retrieval evidence,
  // its counts or its freshness into this run. The failed run observed nothing,
  // so it reports nothing.
  assert.equal(receipt.lastSuccessfulRefresh.verdict, 'reported');
  assert.equal(receipt.lastSuccessfulRefresh.runId, '40085137740');
  assert.equal(receipt.retrievals.length, 0);
  assert.equal(receipt.ingest.written, null);
  assert.equal(receipt.ingest.unchanged, null);
  assert.equal(receipt.export.breaches, null);
  assert.equal(receipt.build.pages, null);
  assert.equal(receipt.deployment.verdict, 'skipped');
});

test('the recorded failure names the missing proof instead of implying a refresh', () => {
  const receipt = evaluateReceipt(FAILED_RUN);
  assert.ok(receipt.missingProof.length > 0);
  const text = receipt.missingProof.join(' | ');
  assert.match(text, /Unit tests stage did not succeed/);
});

test('the recorded failure carries evidence references to the run it describes', () => {
  const receipt = evaluateReceipt(FAILED_RUN);
  assert.ok(receipt.evidenceReferences.length > 0);
  assert.ok(receipt.evidenceReferences.some((r) => r.field === 'evidence.runId' && r.value === '40185682174'));
  assert.ok(receipt.evidenceReferences.some((r) => r.field.startsWith('jobs[].steps[')));
});

test('the readable assessment says the run was blocked, and says what is unknown', () => {
  const text = renderAssessment(evaluateReceipt(FAILED_RUN));
  assert.match(text, /VERDICT: failed \(stopped before_ingestion\)/);
  assert.match(text, /PUBLICATION: not_published/);
  assert.match(text, /40185682174/);
  assert.match(text, /419/);
  assert.match(text, /rejected records: unknown/);
  assert.match(text, /not a live observation/i);
});

// --- The historical comparison ---------------------------------------------

test('the historical run is labelled as a comparison, never as a current receipt', () => {
  const receipt = evaluateReceipt(HISTORICAL_RUN);
  assert.equal(receipt.evidenceKind, 'historical');
  assert.equal(receipt.synthetic, false);
  const text = renderAssessment(receipt);
  assert.match(text, /HISTORICAL COMPARISON -- not a current receipt/);
  assert.match(text, /40085137740/);
});

test('the historical run records what it actually did', () => {
  const receipt = evaluateReceipt(HISTORICAL_RUN);
  // Every required stage succeeded, and the retrieval evidence validates. But
  // the run never recorded which revision it ran, so it cannot be reported as
  // a VERIFIED refresh: the stage outcome is a fact, the verified claim is
  // not.
  assert.equal(receipt.verification.stageOutcome, 'all_succeeded');
  assert.equal(receipt.verification.verdict, 'unverified');
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.ok(receipt.verification.problems.some((p) => /not bound to a single revision/.test(p)));
  // The deployment reference is the site origin, which is live whether or not
  // this run deployed anything. That is a REPORT, not identity proof.
  assert.equal(receipt.publication.verdict, 'published_reported');
  assert.equal(receipt.publication.identity, 'unproven');
  assert.equal(receipt.deployment.reference, 'https://breachbook.org');
  assert.equal(receipt.deployment.completedAt, '2026-10-24T10:16:24.744Z');
  assert.equal(receipt.ingest.parsed, 7964);
  assert.equal(receipt.ingest.valid, 7964);
  assert.equal(receipt.ingest.rejected, 0);
  // Every record was unchanged: a successful OBSERVATION, not evidence that
  // new breaches were published.
  assert.equal(receipt.ingest.unchanged, 7964);
  // The export covers the whole database and is not required to match the
  // ingest count.
  assert.equal(receipt.export.breaches, 7966);
  assert.notEqual(receipt.export.breaches, receipt.ingest.valid);
});

test('the historical run reports its age at an explicit as-of instant', () => {
  const receipt = evaluateReceipt(HISTORICAL_RUN);
  assert.equal(receipt.freshness.asOf, '2026-10-24T12:00:00Z');
  assert.equal(receipt.freshness.cadenceHours, 24);
  assert.equal(receipt.freshness.verdict, 'within_cadence');
  const ocr = receipt.freshness.bySource.find((r) => r.source === 'hhs_ocr' && r.view === 'under_investigation');
  assert.equal(ocr.ageMs, Date.parse('2026-10-24T12:00:00Z') - Date.parse('2026-10-24T10:14:31.402Z'));
  assert.equal(ocr.withinOneCadence, true);
});

test('the historical run left its revision unknown rather than guessing one', () => {
  const receipt = evaluateReceipt(HISTORICAL_RUN);
  assert.equal(receipt.run.headSha, null);
  assert.equal(receipt.revision.revisionMatches, null);
});

test('the last successful refresh is kept separate from the last attempt', () => {
  // The recorded failure: attempted, but not successful. The last successful
  // refresh is the EARLIER run 40085137740, declared in the expectations from
  // the sanitized historical evidence in this same repository -- it is a
  // different run, and this failed run did not produce it.
  const failed = evaluateReceipt(FAILED_RUN);
  assert.equal(failed.refreshVerdict, 'failed');
  assert.equal(failed.publication.verdict, 'not_published');
  assert.equal(failed.lastSuccessfulRefresh.verdict, 'reported');
  assert.equal(failed.lastSuccessfulRefresh.runId, '40085137740');
  // That earlier run's attempt number was never recorded, so it stays unknown
  // rather than being guessed.
  assert.equal(failed.lastSuccessfulRefresh.attempt, null);
  assert.equal(failed.lastSuccessfulRefresh.completedAt, '2026-10-24T10:16:24.744Z');
  // The two are genuinely different runs, and the failed attempt does not
  // borrow the earlier run's verdict, counts or retrieval evidence.
  assert.notEqual(failed.run.runId, failed.lastSuccessfulRefresh.runId);
  assert.equal(failed.retrievals.length, 0);
  assert.equal(failed.freshness.verdict, 'unknown');
  assert.equal(failed.ingest.written, null);

  // With no declared prior success, the checker must NOT invent one: it
  // reports the last successful refresh as unknown.
  const undeclared = JSON.parse(JSON.stringify(FAILED_RUN));
  delete undeclared.expectations.lastSuccessful;
  const blind = evaluateReceipt(undeclared);
  assert.equal(blind.refreshVerdict, 'failed');
  assert.equal(blind.lastSuccessfulRefresh.verdict, 'unknown');
  assert.equal(blind.lastSuccessfulRefresh.runId, null);
  assert.equal(blind.lastSuccessfulRefresh.completedAt, null);

  // Successful stages without a recorded revision do not establish a
  // successful refresh to select. Keep the historical evidence visible.
  const ok = evaluateReceipt(HISTORICAL_RUN);
  assert.equal(ok.verification.stageOutcome, 'all_succeeded');
  assert.equal(ok.refreshVerdict, 'unknown');
  assert.equal(ok.lastSuccessfulRefresh.verdict, 'unknown');
  assert.equal(ok.lastSuccessfulRefresh.runId, null);
  assert.equal(ok.refreshSelection.candidates[0].runId, '40085137740');
  assert.equal(ok.refreshSelection.candidates[0].verified, false);
});

test('the readable assessment shows the last attempt and the last successful refresh as two different things', () => {
  const text = renderAssessment(evaluateReceipt(FAILED_RUN));
  // The attempt line reports this run's own outcome.
  assert.match(text, /Last attempt: run 40185682174 \(attempt 1\)\s+verdict=failed\s+publication=not_published/);
  // The successful-refresh line names the EARLIER run and its completion time,
  // so a reader cannot mistake one for the other.
  assert.match(text, /Last successful refresh: run 40085137740 \(attempt unknown\)\s+completedAt=2026-10-24T10:16:24\.744Z/);
  assert.match(text, /this run did not produce it/);
});

// --- The synthetic cases ---------------------------------------------------

test('every synthetic case is labelled as a fixture, never as operational evidence', () => {
  assert.ok(ALL_SYNTHETIC.length >= 10, `expected a full set of synthetic cases, found ${ALL_SYNTHETIC.length}`);
  for (const c of ALL_SYNTHETIC) {
    assert.equal(c.kind, 'synthetic');
    assert.match(c.label, /^SYNTHETIC:/);
    const receipt = evaluateReceipt(c);
    assert.equal(receipt.synthetic, true);
    assert.equal(receipt.evidenceKind, 'synthetic');
    assert.match(receipt.note, /SYNTHETIC FIXTURE/);
    assert.match(renderAssessment(receipt), /SYNTHETIC FIXTURE -- exercises the checker only/);
  }
});

test('SYNTHETIC: every required stage succeeds', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: every required stage succeeds'));
  assert.equal(receipt.refreshVerdict, 'success');
  assert.equal(receipt.verification.verdict, 'verified');
  assert.equal(receipt.verification.provenanceComplete, true);
  // The deploy step succeeded and a reference was recorded, but nothing names
  // the artifact that was published, so publication is REPORTED, not VERIFIED.
  assert.equal(receipt.publication.verdict, 'published_reported');
  assert.equal(receipt.publication.identity, 'unproven');
  assert.equal(receipt.mode, 'publication');
  assert.equal(receipt.freshness.verdict, 'within_cadence');
  assert.equal(receipt.tests.passed, 430);
  assert.equal(receipt.sourceSelection.missing.length, 0);
  assert.deepEqual(receipt.sourceSelection.verified, ['hhs_ocr', 'hhs_part2']);
});

test('SYNTHETIC: failed tests with green cleanup steps', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: failed tests with green cleanup steps'));
  // The cleanup steps are green, and they change nothing.
  assert.equal(stageOf(receipt, 'summary').verdict, 'success');
  assert.equal(stageOf(receipt, 'artifact').verdict, 'success');
  // The run still failed before ingestion.
  assert.equal(receipt.refreshVerdict, 'failed');
  assert.equal(receipt.blockage, 'before_ingestion');
  assert.equal(receipt.failingStage, 'tests');
  assert.equal(receipt.publication.verdict, 'not_published');
});

test('SYNTHETIC: ingestion skipped while every other stage is green', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: ingestion skipped while every other stage is green'));
  assert.equal(receipt.refreshVerdict, 'skipped');
  assert.equal(stageOf(receipt, 'ingest').verdict, 'skipped');
  // The site WAS published -- with whatever was already in D1. Publication and
  // refresh are different claims.
  assert.equal(receipt.publication.verdict, 'published_reported');
  assert.equal(receipt.publication.identity, 'unproven');
});

test('SYNTHETIC: the ingestion step is absent from the evidence', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the ingestion step is absent from the evidence'));
  assert.equal(receipt.refreshVerdict, 'missing');
  assert.equal(stageOf(receipt, 'ingest').verdict, 'missing');
  // 'missing' is not 'skipped': the two are told apart.
  assert.notEqual(receipt.refreshVerdict, 'skipped');
});

test('SYNTHETIC: dry run, no publication', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: dry run, no publication'));
  assert.equal(receipt.mode, 'dry_run');
  assert.equal(receipt.refreshVerdict, 'dry_run_only');
  assert.notEqual(receipt.refreshVerdict, 'success');
  assert.equal(receipt.publication.verdict, 'not_published');
  assert.equal(receipt.publication.reference, null);
  // The export, build and deploy steps are skipped by design, which is why a
  // dry run is not treated as a failure.
  assert.equal(stageOf(receipt, 'export').verdict, 'skipped');
  assert.equal(stageOf(receipt, 'deploy').verdict, 'skipped');
  assert.ok(receipt.missingProof.some((m) => /not part of a dry run/.test(m)));
});

test('SYNTHETIC: one required source has no retrieval evidence', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: one required source has no retrieval evidence'));
  // Every stage is green and the site was deployed, but one source was never
  // observed. That is not a refresh.
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.deepEqual(receipt.sourceSelection.missing, ['hhs_part2']);
  assert.ok(receipt.missingProof.some((m) => /hhs_part2/.test(m)));
  assert.equal(receipt.publication.verdict, 'published_reported');
  assert.equal(receipt.publication.identity, 'unproven');
});

test('SYNTHETIC: the export step fails', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the export step fails'));
  assert.equal(receipt.refreshVerdict, 'failed');
  assert.equal(receipt.blockage, 'after_ingestion');
  assert.equal(receipt.failingStage, 'export');
  assert.equal(receipt.publication.verdict, 'not_published');
  // The data WAS retrieved; it just never reached the build.
  assert.equal(receipt.retrievals.length, 2);
});

test('SYNTHETIC: the build step fails', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the build step fails'));
  assert.equal(receipt.refreshVerdict, 'failed');
  assert.equal(receipt.blockage, 'after_ingestion');
  assert.equal(receipt.failingStage, 'build');
  assert.equal(receipt.publication.verdict, 'not_published');
});

test('SYNTHETIC: the deploy step fails', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the deploy step fails'));
  assert.equal(receipt.refreshVerdict, 'failed');
  assert.equal(receipt.blockage, 'after_ingestion');
  assert.equal(receipt.failingStage, 'deploy');
  assert.equal(receipt.publication.verdict, 'not_published');
  assert.equal(receipt.deployment.reference, null);
});

test('SYNTHETIC: the run head SHA is not the expected revision', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the run head SHA is not the expected revision'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.equal(receipt.revision.revisionMatches, false);
  // The deployment happened in THAT run, but it cannot be attributed to the
  // revision this receipt is about.
  assert.equal(receipt.publication.verdict, 'unknown');
  assert.equal(receipt.publication.reference, null);
  assert.match(receipt.publication.note, /cannot be attributed/);
  assert.ok(receipt.missingProof.some((m) => /not the expected revision/.test(m)));
});

test('SYNTHETIC: the run is a different attempt than the one expected', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the run is a different attempt than the one expected'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.equal(receipt.revision.attemptMatches, false);
  assert.equal(receipt.publication.verdict, 'unknown');
  assert.ok(receipt.missingProof.some((m) => /not the expected attempt/.test(m)));
});

test('SYNTHETIC: the checkout SHA differs from the run head SHA', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the checkout SHA differs from the run head SHA'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.equal(receipt.revision.revisionMatches, true);
  assert.equal(receipt.revision.checkoutMatches, false);
  assert.ok(receipt.missingProof.some((m) => /checkout SHA/.test(m)));
});

test('SYNTHETIC: the artifact belongs to a different run', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the artifact belongs to a different run'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.equal(receipt.artifacts[0].verdict, 'rejected');
  assert.match(receipt.artifacts[0].reason, /different run/);
});

test('SYNTHETIC: the retrieval evidence is absent', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the retrieval evidence is absent'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.equal(receipt.retrievals.length, 0);
  assert.equal(receipt.freshness.verdict, 'unknown');
});

// --- The checker's own rules ----------------------------------------------

test('the verdict vocabulary keeps failed, skipped, missing, pending and cancelled apart', () => {
  const base = JSON.parse(JSON.stringify(SYNTHETIC[0]));
  const stepFor = (c, name) => c.evidence.jobs[0].steps.find((s) => s.name === name);

  const failed = JSON.parse(JSON.stringify(base));
  stepFor(failed, 'Ingest HHS OCR breach portal').conclusion = 'failure';
  stepFor(failed, 'Ingest HHS OCR breach portal').status = 'completed';
  assert.equal(evaluateReceipt(failed).refreshVerdict, 'failed');

  const cancelled = JSON.parse(JSON.stringify(base));
  stepFor(cancelled, 'Ingest HHS OCR breach portal').conclusion = 'cancelled';
  assert.equal(evaluateReceipt(cancelled).refreshVerdict, 'failed');

  const skipped = JSON.parse(JSON.stringify(base));
  stepFor(skipped, 'Ingest HHS OCR breach portal').conclusion = 'skipped';
  stepFor(skipped, 'Ingest HHS OCR breach portal').status = 'skipped';
  assert.equal(evaluateReceipt(skipped).refreshVerdict, 'skipped');

  const pending = JSON.parse(JSON.stringify(base));
  stepFor(pending, 'Ingest HHS OCR breach portal').status = 'in_progress';
  stepFor(pending, 'Ingest HHS OCR breach portal').conclusion = null;
  assert.equal(evaluateReceipt(pending).refreshVerdict, 'unknown');
});

test('a stage conclusion of success with a status of skipped is not a success', () => {
  const c = JSON.parse(JSON.stringify(SYNTHETIC[0]));
  const step = c.evidence.jobs[0].steps.find((s) => s.name === 'Deploy to Pages');
  step.status = 'skipped';
  step.conclusion = 'skipped';
  const receipt = evaluateReceipt(c);
  assert.equal(stageOf(receipt, 'deploy').verdict, 'skipped');
  assert.equal(receipt.publication.verdict, 'not_published');
});

test('a successful deploy step with no deployment reference is not a publication', () => {
  const c = JSON.parse(JSON.stringify(SYNTHETIC[0]));
  c.evidence.deployment = null;
  const receipt = evaluateReceipt(c);
  assert.equal(stageOf(receipt, 'deploy').verdict, 'success');
  assert.equal(receipt.publication.verdict, 'unknown');
  assert.ok(receipt.notes.some((n) => /no deployment reference/.test(n)));
});

test('the checker reports what it does not know as unknown, never as zero or as a pass', () => {
  const c = JSON.parse(JSON.stringify(SYNTHETIC[0]));
  delete c.evidence.tests;
  delete c.evidence.ingest;
  delete c.evidence.export;
  delete c.evidence.build;
  // The counts are also carried on the test step itself, so remove them there
  // too -- a count that survives in one place is still known.
  const testStep = c.evidence.jobs[0].steps.find((s) => s.name === 'Run npm test');
  delete testStep.tests;
  const receipt = evaluateReceipt(c);
  assert.equal(receipt.tests.total, null);
  assert.equal(receipt.tests.passed, null);
  assert.equal(receipt.ingest.parsed, null);
  assert.equal(receipt.ingest.rejected, null);
  assert.equal(receipt.export.breaches, null);
  assert.equal(receipt.build.pages, null);
  assert.equal(receipt.rejectedRecords.known, false);
  assert.equal(receipt.rejectedRecords.value, null);
});

test('an empty expectation set makes the receipt unknown rather than vacuously successful', () => {
  const c = JSON.parse(JSON.stringify(SYNTHETIC[0]));
  c.expectations.expectedSources = [];
  const receipt = evaluateReceipt(c);
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.ok(receipt.missingProof.some((m) => /no expected source list/.test(m)));
});

test('the freshness age is computed against the explicit as-of instant', () => {
  const c = JSON.parse(JSON.stringify(SYNTHETIC[0]));
  c.expectations.asOf = '2026-10-26T07:00:00Z'; // just under 25 hours after the retrieval
  const receipt = evaluateReceipt(c);
  assert.equal(receipt.freshness.verdict, 'exceeds_cadence');
  const row = receipt.freshness.bySource[0];
  assert.equal(row.ageMs, Date.parse('2026-10-26T07:00:00Z') - Date.parse('2026-10-25T06:01:10.500Z'));
  assert.ok(row.ageMs > 24 * 3600 * 1000, 'the age should exceed one cadence');
  assert.equal(row.withinOneCadence, false);
});

test('a stale source is reported as exceeding the cadence, with no invented SLA', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: every required stage succeeds'));
  assert.match(receipt.freshness.note, /no freshness SLA is defined/);
  assert.equal(receipt.freshness.cadenceHours, 24);
});

// --- Provenance must be complete before a success is claimed ---------------
//
// These are the regressions for the fail-closed rules. Each one takes a
// synthetic run that would otherwise succeed, breaks exactly one piece of
// its provenance, and asserts the receipt refuses to call it a success.

test('a matching source name is not provenance on its own', () => {
  const c = JSON.parse(JSON.stringify(syntheticByPrefix('SYNTHETIC: every required stage succeeds')));
  c.evidence.retrievals[1].checksum = 'not-a-digest';
  const receipt = evaluateReceipt(c);
  // The name still matches. The evidence behind it does not validate.
  assert.ok(receipt.sourceSelection.observed.includes('hhs_part2'));
  assert.ok(receipt.sourceSelection.verified.includes('hhs_ocr'));
  assert.ok(!receipt.sourceSelection.verified.includes('hhs_part2'));
  assert.ok(receipt.sourceSelection.unverified.includes('hhs_part2'));
  // So the success claim fails closed.
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.equal(receipt.verification.verdict, 'unverified');
  assert.ok(receipt.missingProof.some((m) => /hhs_part2/.test(m)));
  assert.ok(receipt.missingProof.some((m) => /sha256/.test(m)));
});

test('a retrieval bound to a different run is not evidence for this run', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a retrieval bound to a different run is not evidence for this run'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.ok(receipt.missingProof.some((m) => /different run/.test(m)));
  assert.equal(receipt.sourceSelection.verified.length, 0);
});

test('a retrieval bound to a different revision is not evidence for this revision', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a retrieval bound to a different revision is not evidence for this revision'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.ok(receipt.missingProof.some((m) => /different revision/.test(m)));
  assert.equal(receipt.sourceSelection.verified.length, 0);
});

test('a missing retrieval timestamp is not evidence', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a missing retrieval timestamp is not evidence'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.ok(receipt.missingProof.some((m) => /retrieved_at is missing/.test(m)));
  assert.equal(receipt.freshness.verdict, 'unknown');
});

test('a malformed retrieval timestamp is not evidence', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a malformed retrieval timestamp is not evidence'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.ok(receipt.missingProof.some((m) => /canonical ISO-8601/.test(m)));
});

test('an impossible calendar date is not a real instant', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: an impossible calendar date is not a real instant'));
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.ok(receipt.missingProof.some((m) => /real calendar instant/.test(m)));
  // Date.parse would have rolled 2026-02-30 over into March without noticing.
  assert.equal(receipt.freshness.verdict, 'unknown');
});

test('a future retrieval timestamp is never within cadence', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a retrieval timestamp in the future is not a retrieval that happened'));
  assert.notEqual(receipt.freshness.verdict, 'within_cadence');
  assert.equal(receipt.freshness.verdict, 'unknown');
  assert.equal(receipt.freshness.bySource[0].timing, 'future');
  assert.equal(receipt.freshness.bySource[0].withinOneCadence, null);
  // And a retrieval that cannot have happened is not evidence of a refresh.
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.ok(receipt.missingProof.some((m) => /later than the as-of instant/.test(m)));
});

test('invalid timing is unknown, never stale', () => {
  // Stale is a claim about AGE. An unparseable timestamp is a claim about
  // VALIDITY. Reporting the first when only the second is known would assert
  // a fact the evidence does not support.
  for (const label of [
    'SYNTHETIC: a missing retrieval timestamp is not evidence',
    'SYNTHETIC: a malformed retrieval timestamp is not evidence',
    'SYNTHETIC: an impossible calendar date is not a real instant',
    'SYNTHETIC: a retrieval timestamp in the future is not a retrieval that happened',
  ]) {
    const receipt = evaluateReceipt(syntheticByPrefix(label));
    assert.equal(receipt.freshness.verdict, 'unknown', label);
    assert.notEqual(receipt.freshness.verdict, 'exceeds_cadence', label);
  }
});

test('an invalid as-of instant leaves freshness unknown', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: an impossible as-of instant leaves freshness unknown'));
  assert.equal(receipt.freshness.verdict, 'unknown');
  assert.ok(receipt.freshness.problems.some((p) => /as-of instant/.test(p)));
  // The refresh itself is unaffected: only the age cannot be computed.
  assert.equal(receipt.refreshVerdict, 'success');
});

test('a non-positive cadence leaves freshness unknown', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a non-positive cadence leaves freshness unknown'));
  assert.equal(receipt.freshness.verdict, 'unknown');
  assert.equal(receipt.freshness.cadenceHours, null);
  assert.ok(receipt.freshness.problems.some((p) => /positive cadence/.test(p)));
  for (const row of receipt.freshness.bySource) {
    assert.equal(row.withinOneCadence, null);
  }
});

test('a recent retrieval does not establish a recent source publication', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: every required stage succeeds'));
  assert.equal(receipt.freshness.verdict, 'within_cadence');
  assert.equal(receipt.freshness.sourcePublication.established, false);
  assert.match(receipt.freshness.sourcePublication.note, /not the publisher's publication time/);
  assert.match(renderAssessment(receipt), /source publication: not established/);
});

test('a generic site URL is not identity proof', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the deploy step succeeded but nothing identifies the published artifact'));
  // The deploy step succeeded and a reference was recorded -- so a
  // publication is REPORTED.
  assert.equal(receipt.publication.verdict, 'published_reported');
  // But the reference is the site origin, which is live whether or not this
  // run deployed anything, so the identity is not proven.
  assert.equal(receipt.publication.identity, 'unproven');
  assert.equal(receipt.deployment.identity.referenceIsSiteOrigin, true);
  assert.match(receipt.deployment.identity.reason, /names no deployed artifact/);
  assert.match(receipt.deployment.identity.reason, /site origin/);
});

test('the deployed artifact is identified when the evidence names it and binds it', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the deployment names the artifact and binds it to this revision'));
  assert.equal(receipt.publication.verdict, 'published_verified');
  assert.equal(receipt.publication.identity, 'verified');
  assert.equal(receipt.deployment.identity.artifactSha.length, 64);
  assert.equal(receipt.deployment.identity.boundSha, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
});

test('a deployment bound to another revision is not identity proof', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the deployment names an artifact built from a different revision'));
  assert.equal(receipt.publication.verdict, 'published_reported');
  assert.equal(receipt.publication.identity, 'unproven');
  assert.match(receipt.deployment.identity.reason, /different revision/);
});

test('a newer verified success supersedes the declared earlier success', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a newer verified success supersedes the declared earlier success'));
  assert.equal(receipt.refreshVerdict, 'success');
  assert.equal(receipt.verification.verdict, 'verified');
  assert.equal(receipt.refreshSelection.verdict, 'this_run');
  assert.equal(receipt.refreshSelection.selected.runId, receipt.run.runId);
  assert.equal(receipt.lastSuccessfulRefresh.verdict, 'this_run');
  assert.equal(receipt.lastSuccessfulRefresh.runId, receipt.run.runId);
  // The earlier declared success is recorded as superseded, not deleted.
  const sup = receipt.refreshSelection.superseded.find((s) => s.runId === '40085137740');
  assert.ok(sup, 'the declared earlier success should be recorded as superseded');
  assert.equal(sup.completedAt, '2026-10-24T10:16:24.744Z');
});

test('the successful refreshes are not ordered when the current run has no completion time', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the successful refreshes cannot be ordered, so the newest one is not established'));
  assert.equal(receipt.refreshSelection.verdict, 'ambiguous');
  assert.equal(receipt.refreshSelection.selected, null);
  assert.equal(receipt.lastSuccessfulRefresh.verdict, 'ambiguous');
  assert.equal(receipt.lastSuccessfulRefresh.runId, null);
  // The uncertainty is stated, not hidden.
  assert.ok(receipt.notes.some((n) => /could not be ordered/.test(n)));
});

test('a failed attempt keeps the earlier success without inheriting its state', () => {
  const c = JSON.parse(JSON.stringify(syntheticByPrefix('SYNTHETIC: failed tests with green cleanup steps')));
  c.expectations.lastSuccessful = {
    runId: '40085137740',
    attempt: null,
    completedAt: '2026-10-24T10:16:24.744Z',
  };
  const receipt = evaluateReceipt(c);
  // The earlier success is retained...
  assert.equal(receipt.lastSuccessfulRefresh.verdict, 'reported');
  assert.equal(receipt.lastSuccessfulRefresh.runId, '40085137740');
  // ...but this run keeps its own outcome and borrows nothing from it.
  assert.equal(receipt.refreshVerdict, 'failed');
  assert.equal(receipt.publication.verdict, 'not_published');
  // This run failed before ingestion, so it wrote nothing and retrieved
  // nothing of its own. The earlier success's counts and retrievals are not
  // imported to fill the gap.
  assert.equal(receipt.ingest.written, null);
  assert.equal(receipt.export.breaches, null);
  assert.equal(receipt.build.pages, null);
  assert.equal(receipt.retrievals.length, 0);
});

test('a run with no recorded revision is not a verified success', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a run with no recorded revision is not a verified success'));
  // Every stage succeeded, and that fact is preserved...
  assert.equal(receipt.verification.stageOutcome, 'all_succeeded');
  // ...but the refresh itself cannot be verified.
  assert.equal(receipt.refreshVerdict, 'unknown');
  assert.equal(receipt.verification.verdict, 'unverified');
  assert.ok(receipt.verification.problems.some((p) => /not bound to a single revision/.test(p)));
});

// --- The observation time is validated before any row-level arithmetic -----
//
// A missing, malformed or impossible asOf used to become null and take part
// in the per-row subtraction: `null - instant` is a negative number, and a
// negative age compares as "within the cadence". The aggregate verdict said
// "unknown" while every row carried a fabricated age and a true cadence flag.

test('an invalid observation time produces no fabricated age or cadence flag', () => {
  const variants = [
    ['missing', (c) => { delete c.expectations.asOf; }],
    ['malformed', (c) => { c.expectations.asOf = 'not-a-date'; }],
    ['an impossible calendar date', (c) => { c.expectations.asOf = '2026-02-30T00:00:00Z'; }],
  ];
  for (const [label, mutate] of variants) {
    const c = JSON.parse(JSON.stringify(syntheticByPrefix('SYNTHETIC: every required stage succeeds')));
    mutate(c);
    const receipt = evaluateReceipt(c);
    // The aggregate is unknown...
    assert.equal(receipt.freshness.verdict, 'unknown', label);
    assert.ok(receipt.freshness.problems.some((p) => /as-of instant/.test(p)), label);
    // ...and no individual row disagrees with it.
    assert.ok(receipt.freshness.bySource.length > 0, label);
    for (const row of receipt.freshness.bySource) {
      assert.equal(row.ageMs, null, `${label}: ageMs must not be fabricated`);
      assert.equal(row.ageHours, null, `${label}: ageHours must not be fabricated`);
      assert.equal(row.withinOneCadence, null, `${label}: withinOneCadence must not be true`);
      // The timestamp itself is well formed; only the observation time is not.
      assert.equal(row.timing, 'valid', label);
    }
  }
});

test('a retrieval in the past is aged against the observation time', () => {
  const c = JSON.parse(JSON.stringify(syntheticByPrefix('SYNTHETIC: every required stage succeeds')));
  c.expectations.asOf = '2026-10-25T12:00:00Z';
  const receipt = evaluateReceipt(c);
  assert.equal(receipt.freshness.verdict, 'within_cadence');
  const row = receipt.freshness.bySource[0];
  assert.equal(row.timing, 'valid');
  assert.equal(row.ageMs, Date.parse('2026-10-25T12:00:00Z') - Date.parse(row.retrievedAt));
  assert.ok(row.ageMs > 0, 'a retrieval in the past must have a positive age');
  assert.equal(row.withinOneCadence, true);
});

test('a retrieval at the observation time has no age and is within one cadence', () => {
  const c = JSON.parse(JSON.stringify(syntheticByPrefix('SYNTHETIC: every required stage succeeds')));
  c.expectations.asOf = '2026-10-25T06:01:10.500Z';   // exactly the first retrieval
  const receipt = evaluateReceipt(c);
  const row = receipt.freshness.bySource[0];
  assert.equal(row.timing, 'valid');
  assert.equal(row.ageMs, 0);
  assert.equal(row.withinOneCadence, true);
});

test('a retrieval after the observation time is never within cadence', () => {
  const c = JSON.parse(JSON.stringify(syntheticByPrefix('SYNTHETIC: every required stage succeeds')));
  c.expectations.asOf = '2026-10-25T06:00:00Z';   // before both retrievals
  const receipt = evaluateReceipt(c);
  assert.notEqual(receipt.freshness.verdict, 'within_cadence');
  for (const row of receipt.freshness.bySource) {
    assert.equal(row.timing, 'future');
    assert.equal(row.ageMs, null);
    assert.equal(row.withinOneCadence, null);
  }
});

// --- A run that had not finished is not an evidenced success --------------
//
// The receipt's observation time is when the evidence was taken. A run that
// completed after it cannot be an already evidenced success, so it cannot be
// selected as the latest one. It is excluded deterministically, and its
// provenance is kept rather than erased.

test('a run that completed after the observation time is not an evidenced success', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the current run completed after the receipt observation time'));
  assert.equal(receipt.refreshSelection.verdict, 'unknown');
  assert.equal(receipt.refreshSelection.selected, null);
  assert.equal(receipt.lastSuccessfulRefresh.verdict, 'unknown');
  assert.equal(receipt.lastSuccessfulRefresh.runId, null);
  // The candidate is still listed, with the reason it was excluded.
  const cand = receipt.refreshSelection.candidates.find((c) => c.source === 'this_run');
  assert.ok(cand, 'the candidate must not be erased');
  assert.equal(cand.futureDated, true);
  assert.equal(cand.excluded, true);
  assert.match(cand.reason, /after the receipt observation time/);
  assert.ok(receipt.notes.some((n) => /after the receipt observation time/.test(n)));
  // The readable assessment has to say WHY it was excluded.
  const text = renderAssessment(receipt);
  assert.match(text, /observationKnown=true/);
  assert.match(text, /EXCLUDED: the candidate completed after the receipt observation time/);
});

test('a prior success that completed after the observation time is not selected, and the earlier legitimate success is retained', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the prior success completed after the receipt observation time'));
  // The legitimate, earlier success is retained and selected.
  assert.equal(receipt.refreshSelection.verdict, 'this_run');
  assert.equal(receipt.refreshSelection.selected.source, 'this_run');
  assert.equal(receipt.refreshSelection.selected.runId, receipt.run.runId);
  assert.equal(receipt.lastSuccessfulRefresh.verdict, 'this_run');
  // The future-dated candidate is excluded, not silently ordered in.
  const future = receipt.refreshSelection.candidates.find((c) => c.source === 'declared');
  assert.ok(future, 'the excluded candidate must not be erased');
  assert.equal(future.runId, '40085137740');
  assert.equal(future.futureDated, true);
  assert.equal(future.excluded, true);
  assert.ok(!receipt.refreshSelection.superseded.some((s) => s.runId === '40085137740'));
});

test('the newest evidenced success is the newest one that finished at or before the observation time', () => {
  // Normal ordering is unchanged: the current run finished after the declared
  // success, both before the observation time, so the current run wins.
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: a newer verified success supersedes the declared earlier success'));
  assert.equal(receipt.refreshSelection.verdict, 'this_run');
  assert.equal(receipt.refreshSelection.selected.runId, receipt.run.runId);
  assert.equal(receipt.refreshSelection.observationKnown, true);
  assert.equal(receipt.refreshSelection.observationTime, '2026-10-25T07:00:00Z');
  const superseded = receipt.refreshSelection.superseded.find((s) => s.runId === '40085137740');
  assert.ok(superseded, 'the earlier success should be recorded as superseded');
});

test('an unorderable candidate leaves the newest evidenced success unestablished', () => {
  const receipt = evaluateReceipt(syntheticByPrefix('SYNTHETIC: the successful refreshes cannot be ordered, so the newest one is not established'));
  assert.equal(receipt.refreshSelection.verdict, 'ambiguous');
  assert.equal(receipt.refreshSelection.selected, null);
  const cand = receipt.refreshSelection.candidates.find((c) => c.source === 'this_run');
  assert.equal(cand.orderable, false);
  assert.equal(cand.excluded, false);
  assert.equal(cand.futureDated, null);
});

// --- Post-merge provenance and selection regressions ----------------------

function greenCase() {
  return JSON.parse(JSON.stringify(syntheticByPrefix('SYNTHETIC: every required stage succeeds')));
}

test('a successful refresh requires a recorded nonempty run identity even without bound rows', () => {
  for (const runId of [undefined, null, '', '   ']) {
    const c = greenCase();
    c.evidence.runId = runId;
    c.evidence.artifacts = [];
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown', String(runId));
    assert.ok(r.verification.problems.some((p) => /run identifier is not recorded/.test(p)));
    assert.equal(r.lastSuccessfulRefresh.runId, null);
  }
});

const BINDINGS = [
  ['runId', 'runId', 'run'],
  ['attempt', 'attempt', 'attempt'],
  ['sha', 'headSha', 'revision'],
];

test('bound retrieval rows cannot validate when the matching run identity is absent', () => {
  for (const [rowField, runField, label] of BINDINGS) {
    const c = greenCase();
    for (const row of c.evidence.retrievals) row[rowField] = c.evidence[runField];
    delete c.evidence[runField];
    delete c.expectations.expectedHeadSha;
    delete c.expectations.expectedAttempt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown', label);
    assert.deepEqual(r.sourceSelection.verified, [], label);
    for (const row of r.retrievals) {
      assert.equal(row.valid, false, label);
      assert.ok(row.reasons.some((reason) => /not recorded/.test(reason)), label);
    }
  }
});

test('bound review artifacts are rejected when the matching run identity is absent', () => {
  for (const [, runField, label] of BINDINGS) {
    const c = greenCase();
    delete c.evidence[runField];
    delete c.expectations.expectedHeadSha;
    delete c.expectations.expectedAttempt;
    const r = evaluateReceipt(c);
    assert.equal(r.artifacts[0].verdict, 'rejected', label);
    assert.match(r.artifacts[0].reason, /not recorded/, label);
    assert.equal(r.refreshVerdict, 'unknown', label);
  }
});

test('matching retrieval and artifact bindings still establish this run', () => {
  const c = greenCase();
  for (const row of c.evidence.retrievals) {
    row.runId = c.evidence.runId;
    row.attempt = c.evidence.attempt;
    row.sha = c.evidence.headSha;
  }
  const r = evaluateReceipt(c);
  assert.equal(r.refreshVerdict, 'success');
  assert.ok(r.retrievals.every((row) => row.valid));
  assert.equal(r.artifacts[0].verdict, 'present');
  assert.equal(r.lastSuccessfulRefresh.verdict, 'this_run');
});

test('retrieval and artifact bindings from another attempt cannot stand in for this attempt', () => {
  const c = greenCase();
  for (const row of c.evidence.retrievals) row.attempt = 2;
  c.evidence.artifacts[0].attempt = 2;
  const r = evaluateReceipt(c);
  assert.equal(r.refreshVerdict, 'unknown');
  assert.deepEqual(r.sourceSelection.verified, []);
  assert.ok(r.retrievals.every((row) => !row.valid && row.reasons.some((reason) => /different attempt/.test(reason))));
  assert.equal(r.artifacts[0].verdict, 'rejected');
  assert.match(r.artifacts[0].reason, /different attempt/);
  assert.equal(r.lastSuccessfulRefresh.runId, null);
});

// GitHub attempts start at 1 and increment per rerun. Receipt evidence uses
// numeric attempts; context/environment strings must not be coerced here.
const INVALID_ATTEMPTS = ['1', '2', '', ' ', {}, [], true, false,
  NaN, Infinity, -Infinity, 0, -0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];

test('absent and null optional attempt bindings remain optional', () => {
  for (const attempt of [undefined, null]) {
    const c = greenCase();
    for (const row of c.evidence.retrievals) row.attempt = attempt;
    c.evidence.artifacts[0].attempt = attempt;
    c.expectations.expectedAttempt = attempt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'success');
    assert.equal(r.artifacts[0].verdict, 'present');
    assert.equal(r.artifacts[0].attempt, null);
    assert.ok(r.retrievals.every((row) => row.valid));
    assert.equal(r.revision.attemptMatches, null);
  }
});

test('matching positive safely represented numeric attempts retain success', () => {
  for (const attempt of [1, 2, Number.MAX_SAFE_INTEGER]) {
    const c = greenCase();
    c.evidence.attempt = attempt;
    c.expectations.expectedAttempt = attempt;
    c.evidence.artifacts[0].attempt = attempt;
    for (const row of c.evidence.retrievals) row.attempt = attempt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'success', String(attempt));
    assert.equal(r.revision.attemptMatches, true);
    assert.equal(r.artifacts[0].verdict, 'present');
    assert.ok(r.retrievals.every((row) => row.valid));
  }
});

test('present malformed artifact attempts are rejected without erasing their supplied value', () => {
  for (const attempt of INVALID_ATTEMPTS) {
    const c = greenCase();
    c.evidence.artifacts[0].attempt = attempt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown', String(attempt));
    assert.equal(r.artifacts[0].verdict, 'rejected');
    assert.match(r.artifacts[0].reason, /positive safe integer/);
    assert.ok(Object.is(r.artifacts[0].attempt, attempt), 'the invalid binding must not become null');
    assert.equal(r.lastSuccessfulRefresh.runId, null);
  }
});

test('present malformed retrieval attempts are invalid evidence rather than optional bindings', () => {
  for (const attempt of INVALID_ATTEMPTS) {
    const c = greenCase();
    for (const row of c.evidence.retrievals) row.attempt = attempt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown', String(attempt));
    assert.deepEqual(r.sourceSelection.verified, []);
    assert.ok(r.retrievals.every((row) => !row.valid && row.reasons.some((reason) => /positive safe integer/.test(reason))));
  }
});

test('a run needs a valid numeric attempt and retains malformed supplied identity for diagnosis', () => {
  for (const attempt of INVALID_ATTEMPTS) {
    const c = greenCase();
    c.evidence.attempt = attempt;
    c.expectations.expectedAttempt = null;
    c.evidence.artifacts = [];
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown', String(attempt));
    assert.ok(Object.is(r.run.attempt, attempt), 'the run attempt must not be silently erased');
    assert.ok(r.verification.problems.some((reason) => /positive safe integer/.test(reason)));
    assert.equal(r.lastSuccessfulRefresh.runId, null);
  }
});

test('a malformed expected attempt cannot silently disable the expected-attempt constraint', () => {
  for (const attempt of INVALID_ATTEMPTS) {
    const c = greenCase();
    c.expectations.expectedAttempt = attempt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown', String(attempt));
    assert.equal(r.revision.attemptMatches, false);
    assert.ok(r.missingProof.some((reason) => /expected attempt must be a positive safe integer/.test(reason)));
  }
});

test('declared prior successes with absent, null or valid numeric attempts remain reported', () => {
  for (const attempt of [undefined, null, 1, 2, Number.MAX_SAFE_INTEGER]) {
    const c = greenCase();
    c.evidence.completedAt = '2026-10-26T00:00:00Z';
    c.expectations.lastSuccessful = { runId: 'prior', attempt, completedAt: '2026-10-24T00:00:00Z' };
    const r = evaluateReceipt(c);
    assert.equal(r.lastSuccessfulRefresh.verdict, 'reported');
    assert.equal(r.lastSuccessfulRefresh.attempt, attempt ?? null);
    const prior = r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared');
    assert.equal(prior.verified, false);
    assert.equal(prior.excluded, false);
  }
});

test('a malformed declared attempt is retained and excluded without being mislabeled as a future completion', () => {
  for (const attempt of INVALID_ATTEMPTS) {
    const c = greenCase();
    c.evidence.completedAt = '2026-10-26T00:00:00Z';
    c.expectations.lastSuccessful = { runId: 'prior', attempt, completedAt: '2026-10-24T00:00:00Z' };
    const r = evaluateReceipt(c);
    assert.equal(r.lastSuccessfulRefresh.verdict, 'unknown', String(attempt));
    const prior = r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared');
    assert.ok(Object.is(prior.attempt, attempt));
    assert.equal(prior.verified, false);
    assert.equal(prior.futureDated, false);
    assert.equal(prior.excluded, true);
    assert.match(prior.reason, /positive safe integer/);
    assert.ok(r.notes.some((note) => /invalid supplied attempt/.test(note)));
    const futureNote = r.notes.find((note) => /completed after the receipt observation time/.test(note));
    assert.ok(futureNote);
    assert.ok(!futureNote.includes('prior'), 'invalid declared attempt must not be called a future completion');
  }
});

test('an excluded prior with unknown completion cannot block a verified current selection', () => {
  for (const completedAt of [undefined, null, 'not-a-date']) {
    const c = greenCase();
    c.expectations.lastSuccessful = { runId: 'bad-prior', attempt: '2', completedAt };
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'success');
    assert.equal(r.refreshSelection.verdict, 'this_run');
    assert.equal(r.refreshSelection.selected.runId, c.evidence.runId);
    const prior = r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared');
    assert.equal(prior.excluded, true);
    assert.equal(prior.orderable, false);
    assert.match(prior.reason, /positive safe integer/);
    assert.ok(!r.refreshSelection.superseded.some((candidate) => candidate.runId === 'bad-prior'));
  }
});

test('an excluded current run with unknown completion cannot block a legitimate reported prior', () => {
  for (const completedAt of [undefined, null, 'not-a-date']) {
    const c = greenCase();
    c.evidence.attempt = '1';
    c.evidence.completedAt = completedAt;
    c.expectations.expectedAttempt = null;
    c.expectations.lastSuccessful = { runId: 'prior', attempt: 1, completedAt: '2026-10-24T00:00:00Z' };
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown');
    assert.equal(r.refreshSelection.verdict, 'reported');
    assert.equal(r.lastSuccessfulRefresh.runId, 'prior');
    const current = r.refreshSelection.candidates.find((candidate) => candidate.source === 'this_run');
    assert.equal(current.excluded, true);
    assert.equal(current.orderable, false);
    assert.match(current.reason, /positive safe integer/);
    const prior = r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared');
    assert.equal(prior.excluded, false);
    assert.equal(prior.verified, false);
  }
});

test('an eligible prior with unknown completion still prevents an invented newest selection', () => {
  for (const completedAt of [undefined, null, 'not-a-date']) {
    const c = greenCase();
    c.expectations.lastSuccessful = { runId: 'prior', attempt: 1, completedAt };
    const r = evaluateReceipt(c);
    assert.equal(r.refreshSelection.verdict, 'ambiguous');
    assert.equal(r.refreshSelection.selected, null);
    const prior = r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared');
    assert.equal(prior.excluded, false);
    assert.equal(prior.orderable, false);
  }
});

const NONCOERCIBLE_ATTEMPTS = [{ toString: null }, { toString: null, valueOf: null },
  [{ toString: null }], Object.create(null), ...INVALID_ATTEMPTS];

test('malformed run attempts produce usable receipts and assessments without coercing objects', () => {
  for (const attempt of NONCOERCIBLE_ATTEMPTS) {
    for (const expectedAttempt of [1, null]) {
      const c = greenCase();
      c.evidence.attempt = attempt;
      c.expectations.expectedAttempt = expectedAttempt;
      let r;
      assert.doesNotThrow(() => { r = evaluateReceipt(c); });
      assert.equal(r.refreshVerdict, 'unknown');
      assert.ok(Object.is(r.run.attempt, attempt), 'retain the original malformed evidence');
      assert.ok(r.missingProof.some((reason) => /positive safe integer/.test(reason)));
      let text;
      assert.doesNotThrow(() => { text = renderAssessment(r); });
      assert.match(text, /attempt invalid/);
      assert.match(text, /VERDICT: unknown/);
    }
  }
});

test('readable assessments mark retained invalid prior attempts without coercing their values', () => {
  for (const attempt of NONCOERCIBLE_ATTEMPTS) {
    const c = greenCase();
    c.expectations.lastSuccessful = { runId: 'bad-prior', attempt, completedAt: '2026-10-24T00:00:00Z' };
    const r = evaluateReceipt(c);
    assert.equal(r.refreshSelection.verdict, 'this_run');
    const prior = r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared');
    assert.equal(prior.excluded, true);
    assert.ok(Object.is(prior.attempt, attempt));
    let text;
    assert.doesNotThrow(() => { text = renderAssessment(r); });
    assert.match(text, /attempt=invalid/);
    assert.match(text, /candidate attempt must be a positive safe integer/);
  }
});

test('a stale retrieval cannot mask another required source with invalid timing', () => {
  for (const invalid of [undefined, 'not-a-date', '2026-02-30T00:00:00.000Z', '2026-10-26T06:00:00.000Z']) {
    const c = greenCase();
    c.expectations.cadenceHours = 0.5;
    c.evidence.retrievals[1].retrieved_at = invalid;
    const r = evaluateReceipt(c);
    assert.equal(r.freshness.verdict, 'unknown', String(invalid));
    assert.equal(r.freshness.bySource[0].withinOneCadence, false);
    assert.equal(r.freshness.bySource[1].ageMs, null);
    assert.equal(r.freshness.bySource[1].withinOneCadence, null);
    assert.ok(r.freshness.problems.some((p) => /timestamp/.test(p)));
  }
});

test('valid stale-only and valid recent timing retain their distinct verdicts', () => {
  const c = greenCase();
  assert.equal(evaluateReceipt(c).freshness.verdict, 'within_cadence');
  c.expectations.asOf = '2026-10-26T07:00:00Z';
  const r = evaluateReceipt(c);
  assert.equal(r.freshness.verdict, 'exceeds_cadence');
  assert.deepEqual(r.freshness.problems, []);
});

test('malformed supplied artifact digests never verify publication, even with a deployment ID', () => {
  for (const digest of ['x', '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64), 123, {}]) {
    for (const deploymentId of [undefined, 'named-deployment']) {
      const c = greenCase();
      c.evidence.deployment.artifactSha = digest;
      c.evidence.deployment.deploymentId = deploymentId;
      c.evidence.deployment.sha = c.evidence.headSha;
      const r = evaluateReceipt(c);
      assert.equal(r.publication.verdict, 'published_reported', JSON.stringify(digest));
      assert.equal(r.publication.identity, 'unproven');
      assert.match(r.deployment.identity.reason, /artifact digest is not a sha256 digest/);
    }
  }
});

test('a valid artifact digest or a deployment ID with no supplied digest can verify publication', () => {
  for (const identity of [{ artifactSha: 'a'.repeat(64) }, { deploymentId: 'named-deployment' }]) {
    const c = greenCase();
    Object.assign(c.evidence.deployment, identity, { sha: c.evidence.headSha });
    const r = evaluateReceipt(c);
    assert.equal(r.publication.verdict, 'published_verified');
    assert.equal(r.publication.identity, 'verified');
  }
});

test('an unverified current singleton is retained as evidence but never selected', () => {
  for (const flaw of ['revision', 'checksum']) {
    const c = greenCase();
    if (flaw === 'revision') {
      delete c.evidence.headSha;
      delete c.evidence.checkedOutSha;
      delete c.expectations.expectedHeadSha;
    } else {
      c.evidence.retrievals[0].checksum = 'invalid';
    }
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown', flaw);
    assert.equal(r.refreshSelection.verdict, 'unknown', flaw);
    assert.equal(r.refreshSelection.selected, null, flaw);
    assert.equal(r.lastSuccessfulRefresh.runId, null, flaw);
    assert.equal(r.refreshSelection.candidates.length, 1);
    assert.equal(r.refreshSelection.candidates[0].verified, false);
    assert.equal(r.refreshSelection.candidates[0].runId, c.evidence.runId);
    assert.match(renderAssessment(r), /Last successful refresh: unknown/);
  }
});

test('excluding a future prior candidate cannot promote an unverified current singleton', () => {
  const c = greenCase();
  c.evidence.retrievals[0].checksum = 'invalid';
  c.expectations.lastSuccessful = { runId: 'prior', completedAt: '2026-10-26T00:00:00Z' };
  const r = evaluateReceipt(c);
  assert.equal(r.refreshSelection.verdict, 'unknown');
  assert.equal(r.refreshSelection.selected, null);
  assert.equal(r.lastSuccessfulRefresh.runId, null);
  const prior = r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared');
  assert.equal(prior.excluded, true);
  assert.equal(prior.futureDated, true);
  assert.match(prior.reason, /after the receipt observation time/);
  assert.equal(r.refreshSelection.candidates.find((candidate) => candidate.source === 'this_run').verified, false);
});

test('a legitimate declared prior retains reported semantics when the current run is excluded', () => {
  const c = greenCase();
  c.evidence.completedAt = '2026-10-26T00:00:00Z';
  c.expectations.lastSuccessful = { runId: 'prior', completedAt: '2026-10-24T00:00:00Z' };
  const r = evaluateReceipt(c);
  assert.equal(r.refreshSelection.verdict, 'reported');
  assert.equal(r.lastSuccessfulRefresh.runId, 'prior');
  assert.equal(r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared').verified, false);
  assert.equal(r.refreshSelection.candidates.find((candidate) => candidate.source === 'this_run').excluded, true);
});

// --- Observation-time provenance stays consistent across receipt fields ---

test('a future-completed run is unverified as well as excluded from selection', () => {
  for (const completedAt of ['2026-10-25T07:00:00.001Z', '2026-10-26T07:00:00Z']) {
    for (const priorAttempt of [undefined, null, 1]) {
      const c = greenCase();
      c.evidence.completedAt = completedAt;
      c.expectations.lastSuccessful = { runId: 'prior', attempt: priorAttempt, completedAt: '2026-10-24T06:00:00Z' };
      const r = evaluateReceipt(c);
      assert.equal(r.verification.stageOutcome, 'all_succeeded');
      assert.equal(r.refreshVerdict, 'unknown');
      assert.equal(r.verification.verdict, 'unverified');
      assert.equal(r.verification.provenanceComplete, false);
      assert.ok(r.verification.problems.some((p) => /run completed after the as-of instant/.test(p)));
      const current = r.refreshSelection.candidates.find((candidate) => candidate.source === 'this_run');
      assert.equal(current.completedAt, completedAt);
      assert.equal(current.futureDated, true);
      assert.equal(current.excluded, true);
      assert.equal(current.verified, false);
      assert.equal(r.lastSuccessfulRefresh.verdict, 'reported');
      assert.equal(r.lastSuccessfulRefresh.runId, 'prior');
      assert.equal(r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared').verified, false);
      assert.match(renderAssessment(r), /verdict=unknown/);
    }
  }
});

test('a future-completed singleton retains evidence without a verified success claim', () => {
  const c = greenCase();
  c.evidence.completedAt = '2026-10-25T08:00:00Z';
  const r = evaluateReceipt(c);
  assert.equal(r.refreshVerdict, 'unknown');
  assert.equal(r.verification.provenanceComplete, false);
  assert.equal(r.refreshSelection.verdict, 'unknown');
  assert.equal(r.refreshSelection.selected, null);
  assert.equal(r.refreshSelection.candidates[0].verified, false);
  assert.equal(r.refreshSelection.candidates[0].excluded, true);
  assert.ok(r.missingProof.some((p) => /run completed after the as-of instant/.test(p)));
});

test('run completion at or before the observation time retains verified success', () => {
  for (const completedAt of ['2026-10-25T06:59:59.999Z', '2026-10-25T07:00:00.000Z']) {
    const c = greenCase();
    c.evidence.completedAt = completedAt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'success');
    assert.equal(r.verification.provenanceComplete, true);
    assert.deepEqual(r.verification.problems, []);
    assert.equal(r.refreshSelection.verdict, 'this_run');
    assert.equal(r.refreshSelection.candidates[0].verified, true);
    assert.equal(r.refreshSelection.candidates[0].excluded, false);
  }
});

test('a future retrieval cannot count as validated source coverage', () => {
  for (const retrievedAt of ['2026-10-25T07:00:00.001Z', '2026-10-25T09:00:00.000Z']) {
    const c = greenCase();
    c.evidence.retrievals[0].retrieved_at = retrievedAt;
    const r = evaluateReceipt(c);
    const row = r.retrievals[0];
    assert.equal(row.retrievedAt, retrievedAt);
    assert.equal(row.valid, false);
    assert.equal(row.timing, 'future');
    assert.ok(row.reasons.some((p) => /later than the as-of instant/.test(p)));
    assert.equal(row.ageMs, null);
    assert.equal(row.withinOneCadence, null);
    assert.deepEqual(r.sourceSelection.observed, ['hhs_ocr', 'hhs_part2']);
    assert.deepEqual(r.sourceSelection.verified, ['hhs_part2']);
    assert.deepEqual(r.sourceSelection.missing, ['hhs_ocr']);
    assert.deepEqual(r.sourceSelection.unverified, ['hhs_ocr']);
    assert.equal(r.refreshVerdict, 'unknown');
    assert.equal(r.freshness.verdict, 'unknown');
    assert.match(renderAssessment(r), /hhs_ocr[^\n]*timing=future[^\n]*evidence=INVALID/);
  }
});

test('retrievals at or before the observation time remain valid coverage', () => {
  for (const retrievedAt of ['2026-10-25T06:59:59.999Z', '2026-10-25T07:00:00.000Z']) {
    const c = greenCase();
    c.evidence.completedAt = c.expectations.asOf;
    for (const row of c.evidence.retrievals) row.retrieved_at = retrievedAt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'success');
    assert.equal(r.freshness.verdict, 'within_cadence');
    assert.deepEqual(r.sourceSelection.verified, ['hhs_ocr', 'hhs_part2']);
    assert.deepEqual(r.sourceSelection.missing, []);
    assert.ok(r.retrievals.every((row) => row.valid && row.timing === 'valid' && row.ageMs >= 0));
  }
});

test('a valid duplicate covers a source without validating its future row', () => {
  const c = greenCase();
  c.evidence.retrievals.push({ ...c.evidence.retrievals[0], retrieved_at: '2026-10-25T07:00:00.001Z' });
  const r = evaluateReceipt(c);
  assert.equal(r.retrievals[0].valid, true);
  assert.equal(r.retrievals[2].valid, false);
  assert.deepEqual(r.sourceSelection.verified, ['hhs_ocr', 'hhs_part2']);
  assert.equal(r.refreshVerdict, 'unknown');
  assert.equal(r.freshness.verdict, 'unknown');
  assert.equal(r.verification.provenanceComplete, false);
});

test('future retrieval validation preserves a failed stage verdict', () => {
  const c = greenCase();
  c.evidence.retrievals[0].retrieved_at = '2026-10-25T07:00:00.001Z';
  c.evidence.jobs[0].steps.find((step) => step.name === 'Run npm test').conclusion = 'failure';
  const r = evaluateReceipt(c);
  assert.equal(r.retrievals[0].valid, false);
  assert.deepEqual(r.sourceSelection.verified, ['hhs_part2']);
  assert.equal(r.refreshVerdict, 'failed');
  assert.equal(r.failingStage, 'tests');
  assert.equal(r.verification.verdict, 'not_applicable');
});

// --- Recorded run bounds constrain this run's retrieval evidence ----------

test('a recorded completion before the recorded start is inconsistent provenance', () => {
  for (const [completedAt, valid] of [
    ['2026-10-25T06:01:59.999Z', false],
    ['2026-10-25T06:02:00.000Z', true],
    ['2026-10-25T06:02:00.001Z', true],
  ]) {
    for (const asOf of ['2026-10-25T07:00:00Z', undefined, 'invalid-as-of']) {
      const c = greenCase();
      c.evidence.startedAt = '2026-10-25T06:02:00.000Z';
      c.evidence.completedAt = completedAt;
      c.expectations.asOf = asOf;
      for (const row of c.evidence.retrievals) row.retrieved_at = c.evidence.startedAt;
      const r = evaluateReceipt(c);
      assert.equal(r.refreshVerdict, valid ? 'success' : 'unknown');
      assert.equal(r.verification.provenanceComplete, valid);
      assert.equal(r.refreshSelection.candidates[0].verified, valid);
      if (!valid) assert.ok(r.verification.problems.some((p) => /completed before.*start/.test(p)));
    }
  }
});

test('retrievals outside known run bounds cannot count as this run evidence', () => {
  const boundaries = [
    ['2026-10-25T05:59:59.999Z', false, /before.*start/],
    ['2026-10-25T06:00:00.000Z', true],
    ['2026-10-25T06:00:00.001Z', true],
    ['2026-10-25T06:03:43.999Z', true],
    ['2026-10-25T06:03:44.000Z', true],
    ['2026-10-25T06:03:44.001Z', false, /after.*completion/],
  ];
  for (const [retrievedAt, valid, reason] of boundaries) {
    for (const asOf of ['2026-10-25T07:00:00Z', undefined, 'invalid-as-of']) {
      const c = greenCase();
      c.evidence.startedAt = '2026-10-25T06:00:00.000Z';
      c.evidence.retrievals[0].retrieved_at = retrievedAt;
      c.expectations.asOf = asOf;
      const r = evaluateReceipt(c);
      assert.equal(r.retrievals[0].valid, valid, retrievedAt);
      assert.equal(r.refreshVerdict, valid ? 'success' : 'unknown');
      assert.equal(r.sourceSelection.verified.includes('hhs_ocr'), valid);
      if (!valid) {
        assert.equal(r.retrievals[0].timing, 'invalid');
        assert.ok(r.retrievals[0].reasons.some((p) => reason.test(p)));
        assert.equal(r.retrievals[0].ageMs, null);
        assert.equal(r.freshness.verdict, 'unknown');
      }
    }
  }
});

test('an unknown start does not invent a lower retrieval bound or a new required field', () => {
  for (const startedAt of [undefined, null, '', 'not-a-date', '2026-02-30T00:00:00Z', { toString: null }]) {
    const c = greenCase();
    c.evidence.startedAt = startedAt;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'success');
    assert.ok(r.retrievals.every((row) => row.valid));
    assert.doesNotThrow(() => renderAssessment(r));
  }
});

test('inconsistent run timing never promotes a singleton or a competing current candidate', () => {
  for (const prior of [undefined, { runId: 'prior', completedAt: '2026-10-24T00:00:00Z' }]) {
    const c = greenCase();
    c.evidence.completedAt = '2026-10-25T05:59:59.999Z';
    if (prior) c.expectations.lastSuccessful = prior;
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown');
    assert.equal(r.refreshSelection.candidates.find((candidate) => candidate.source === 'this_run').verified, false);
    assert.equal(r.refreshSelection.selected, null);
    assert.equal(r.refreshSelection.verdict, prior ? 'ambiguous' : 'unknown');
    if (prior) assert.equal(r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared').verified, false);
  }
});

// --- Completion evidence is required independently of freshness ----------

test('missing or malformed run completion cannot verify a successful refresh', () => {
  const completions = [undefined, null, '', '   ', 'not-a-date', '2026-02-30T00:00:00Z', 123, true, false, [], {}, { toString: null }];
  for (let i = 0; i < completions.length; i++) {
    for (const asOf of ['2026-10-25T07:00:00Z', undefined, 'invalid-as-of']) {
      const c = greenCase();
      c.evidence.completedAt = completions[i];
      c.expectations.asOf = asOf;
      const r = evaluateReceipt(c);
      assert.equal(r.verification.stageOutcome, 'all_succeeded', `completion case ${i}`);
      assert.equal(r.refreshVerdict, 'unknown', `completion case ${i}`);
      assert.equal(r.verification.verdict, 'unverified');
      assert.equal(r.verification.provenanceComplete, false);
      assert.ok(r.verification.problems.some((p) => /run completion instant/.test(p)));
      assert.ok(r.missingProof.some((p) => /run completion instant/.test(p)));
      assert.equal(r.refreshSelection.candidates[0].verified, false);
      assert.equal(r.refreshSelection.candidates[0].orderable, false);
      assert.equal(r.refreshSelection.selected, null);
      assert.equal(r.lastSuccessfulRefresh.verdict, 'unknown');
      assert.deepEqual(r.run.completedAt, completions[i] ?? null);
      assert.doesNotThrow(() => renderAssessment(r));
    }
  }
});

test('valid run completion preserves success even when freshness observation is unknown', () => {
  for (const completedAt of ['2026-10-25T06:03:44Z', '2026-10-25T06:03:44.000Z', '2026-10-25T06:03:44+00:00']) {
    for (const asOf of [undefined, null, 'invalid-as-of', '2026-02-30T00:00:00Z', 123, false, [], { toString: null }]) {
      const c = greenCase();
      c.evidence.completedAt = completedAt;
      c.expectations.asOf = asOf;
      const r = evaluateReceipt(c);
      assert.equal(r.refreshVerdict, 'success');
      assert.equal(r.verification.provenanceComplete, true);
      assert.equal(r.freshness.verdict, 'unknown');
      assert.equal(r.refreshSelection.observationKnown, false);
      assert.equal(r.refreshSelection.candidates[0].verified, true);
      assert.equal(r.refreshSelection.candidates[0].futureDated, null);
      assert.ok(r.retrievals.every((row) => row.ageMs === null && row.withinOneCadence === null));
      assert.doesNotThrow(() => renderAssessment(r));
    }
  }
});

test('unknown completion cannot promote the current run over a declared prior', () => {
  for (const completedAt of [undefined, null, 'not-a-date']) {
    const c = greenCase();
    c.evidence.completedAt = completedAt;
    c.expectations.lastSuccessful = { runId: 'prior', completedAt: '2026-10-24T00:00:00Z' };
    const r = evaluateReceipt(c);
    assert.equal(r.refreshVerdict, 'unknown');
    assert.equal(r.refreshSelection.verdict, 'ambiguous');
    assert.equal(r.refreshSelection.selected, null);
    assert.ok(r.refreshSelection.candidates.every((candidate) => candidate.verified === false));
    assert.equal(r.refreshSelection.candidates.find((candidate) => candidate.source === 'declared').runId, 'prior');
  }
});

test('missing completion preserves failed stages and refuses an unverified dry-run claim', () => {
  const failed = greenCase();
  delete failed.evidence.completedAt;
  failed.evidence.jobs[0].steps.find((step) => step.name === 'Run npm test').conclusion = 'failure';
  const failedReceipt = evaluateReceipt(failed);
  assert.equal(failedReceipt.refreshVerdict, 'failed');
  assert.equal(failedReceipt.failingStage, 'tests');
  assert.equal(failedReceipt.verification.verdict, 'not_applicable');
  const dry = greenCase();
  delete dry.evidence.completedAt;
  dry.evidence.dryRun = true;
  const dryReceipt = evaluateReceipt(dry);
  assert.equal(dryReceipt.refreshVerdict, 'unknown');
  assert.equal(dryReceipt.verification.verdict, 'unverified');
  assert.equal(dryReceipt.publication.verdict, 'not_published');
});

test('malformed completion display preserves raw evidence without coercing objects', () => {
  const c = greenCase();
  c.evidence.completedAt = { toString: null };
  const r = evaluateReceipt(c);
  assert.deepEqual(r.refreshSelection.candidates[0].completedAt, { toString: null });
  assert.match(renderAssessment(r), /completedAt=invalid/);
});

// --- The checker itself must stay offline and inert on import -------------

test('importing the checker does not execute it', () => {
  // The module was required at the top of this file, and nothing ran: no
  // output was written and no workflow was touched. Requiring the module
  // again must be equally inert.
  const source = fs.readFileSync(path.join(__dirname, 'refresh-receipt.js'), 'utf8');
  assert.match(source, /if \(require\.main === module\)/);
  assert.doesNotThrow(() => require('./refresh-receipt'));
});

test('the checker contains no network, credential or deployment capability', () => {
  const source = fs.readFileSync(path.join(__dirname, 'refresh-receipt.js'), 'utf8');
  for (const forbidden of [
    'fetch(', 'https://', 'http://', 'node:https', 'node:http', 'child_process',
    'wrangler', 'CLOUDFLARE_API_TOKEN', 'API_TOKEN', 'process.env',
  ]) {
    assert.ok(!source.includes(forbidden), `the checker must not contain ${forbidden}`);
  }
});
