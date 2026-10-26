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

function syntheticByPrefix(prefix) {
  const found = SYNTHETIC.find((c) => c.label.startsWith(prefix));
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
  assert.equal(receipt.refreshVerdict, 'success');
  assert.equal(receipt.publication.verdict, 'published');
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

  // The historical run succeeded, so it is the most recent successful refresh
  // this evidence covers.
  const ok = evaluateReceipt(HISTORICAL_RUN);
  assert.equal(ok.refreshVerdict, 'success');
  assert.equal(ok.lastSuccessfulRefresh.verdict, 'this_run');
  assert.equal(ok.lastSuccessfulRefresh.runId, '40085137740');
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
  assert.ok(SYNTHETIC.length >= 10, `expected a full set of synthetic cases, found ${SYNTHETIC.length}`);
  for (const c of SYNTHETIC) {
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
  assert.equal(receipt.publication.verdict, 'published');
  assert.equal(receipt.mode, 'publication');
  assert.equal(receipt.freshness.verdict, 'within_cadence');
  assert.equal(receipt.tests.passed, 430);
  assert.equal(receipt.sourceSelection.missing.length, 0);
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
  assert.equal(receipt.publication.verdict, 'published');
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
  assert.equal(receipt.publication.verdict, 'published');
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
