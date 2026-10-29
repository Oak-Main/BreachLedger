// Tests for the durable ingest manifest.
//
// The manifest is what makes an ingest observation checkable later: which
// views were fetched, from where, with what exact bytes, how many rows, and
// which of them were empty. These tests pin that shape, because the whole
// point of the manifest is that it is written once and read much later.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { buildManifest, buildAppliedReceipt, safeUrl } = require('./manifest');

const CSV = 'Name of Covered Entity,State\nAcme Clinic,CA\n';

function views() {
  return [
    {
      view: 'under_investigation',
      csv: CSV,
      checksum: crypto.createHash('sha256').update(CSV).digest('hex'),
      retrieved_at: '2026-10-29T11:24:27.391Z',
      requested_url: 'https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf',
      final_url_safe: 'https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf',
      gridReportsEmpty: false,
      steps: { path: 'direct-grid', encoding: 'multipart', csvCommand: 'ocrForm:j_idt387' },
    },
    {
      // An EMPTY view. It is still an observation and must still be recorded.
      view: 'archive',
      csv: '',
      checksum: crypto.createHash('sha256').update('').digest('hex'),
      retrieved_at: '2026-10-29T11:24:31.002Z',
      requested_url: 'https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf',
      final_url_safe: 'https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf',
      gridReportsEmpty: true,
      archiveVerification: 'server-tab-state',
      archiveVerificationBasis: 'server-tab-state',
      archiveSwitchEvidence: { variant: 'plain-postback', activeIndex: '1', panelVisible: true, serverConfirmed: true },
      steps: { path: 'archive[plain-postback]', encoding: 'multipart', csvCommand: 'ocrForm:j_idt384' },
    },
  ];
}

function manifest(overrides = {}) {
  return buildManifest({
    sourceId: 'hhs_ocr',
    source: { label: 'HIPAA', gridPage: 'https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf' },
    coverage: 'all',
    dryRun: false,
    views: views(),
    viewStats: new Map([['under_investigation', { rows: 1, columns: 2 }], ['archive', { rows: 0, columns: 2 }]]),
    totalRows: 1,
    distinct: 1,
    valid: 1,
    rejected: 0,
    stats: { inserted: 1, updated: 0, unchanged: 0, sourcesAdded: 1 },
    statements: 2,
    staged: { batches: [{ file: 'hhs_ocr.batch-001.sql', sha256: 'b'.repeat(64), bytes: 10 }] },
    env: {
      GITHUB_RUN_ID: '40865099351',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKFLOW: 'Ingest HHS OCR breach records',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: '3dafda07bda60a142ee61baa1dc1f2892794dad7',
      GITHUB_REPOSITORY: 'Oak-Main/BreachLedger',
    },
    ...overrides,
  });
}

test('the manifest binds the run, the source and the coverage policy', () => {
  const m = manifest();
  assert.equal(m.schema, 'breachledger/ingest-manifest@1');
  assert.equal(m.run.id, '40865099351');
  assert.equal(m.run.attempt, '1');
  assert.equal(m.run.sha, '3dafda07bda60a142ee61baa1dc1f2892794dad7');
  assert.equal(m.source.id, 'hhs_ocr');
  assert.equal(m.source.coverage, 'all');
  assert.equal(m.source.dry_run, false);
});

test('an empty view is recorded as an observation, not as an absence', () => {
  const m = manifest();
  assert.equal(m.views.length, 2);
  const archive = m.views.find((v) => v.view === 'archive');
  assert.ok(archive, 'the empty archive view must be recorded');
  assert.equal(archive.rows, 0);
  assert.equal(archive.bytes, 0);
  assert.equal(archive.grid_reports_empty, true);
  assert.ok(archive.sha256, 'an empty view still has an exact-byte digest');
  assert.ok(archive.retrieved_at, 'an empty view still has a retrieval instant');
});

test('each view records its identity, digest, size and archive-selection evidence', () => {
  const m = manifest();
  const recent = m.views.find((v) => v.view === 'under_investigation');
  assert.equal(recent.requested_url, 'https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf');
  assert.equal(recent.sha256, crypto.createHash('sha256').update(CSV).digest('hex'));
  assert.equal(recent.bytes, Buffer.byteLength(CSV, 'utf8'));
  assert.equal(recent.rows, 1);
  assert.equal(recent.columns, 2);
  assert.equal(recent.export.path, 'direct-grid');

  const archive = m.views.find((v) => v.view === 'archive');
  assert.equal(archive.archive_verification, 'server-tab-state');
  assert.equal(archive.archive_switch_evidence.serverConfirmed, true);
  assert.equal(archive.archive_switch_evidence.activeIndex, '1');
});

test('the manifest records what was observed, not what was published', () => {
  const m = manifest();
  assert.equal(m.records.rows_across_views, 1);
  assert.equal(m.records.distinct, 1);
  assert.equal(m.records.valid, 1);
  assert.equal(m.records.rejected, 0);
  // The write plan is separate from the observation.
  assert.equal(m.write.statements, 2);
  assert.equal(m.write.stats.inserted, 1);
  assert.equal(m.staged.batches.length, 1);
});

test('a session id in the query string never reaches the manifest', () => {
  assert.equal(
    safeUrl('https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf;jsessionid=ABC123'),
    'https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf'
  );
  assert.equal(safeUrl('not a url'), null);
  assert.equal(safeUrl(null), null);
  const m = buildManifest({
    sourceId: 'hhs_ocr',
    source: {},
    coverage: 'all',
    dryRun: true,
    views: [{
      view: 'under_investigation',
      csv: CSV,
      checksum: 'x',
      retrieved_at: '2026-10-29T00:00:00.000Z',
      requested_url: 'https://ocrportal.hhs.gov/x.jsf',
      final_url: 'https://ocrportal.hhs.gov/x.jsf;jsessionid=SECRET',
    }],
    viewStats: new Map(),
    totalRows: 1, distinct: 1, valid: 1, rejected: 0,
    stats: {}, statements: 1, staged: null, env: {},
  });
  assert.ok(!JSON.stringify(m).includes('SECRET'), 'no session id may appear in the manifest');
});

test('the applied receipt binds the written bytes to the manifest that described them', () => {
  const applied = buildAppliedReceipt({
    sources: [{
      source: 'hhs_ocr',
      coverage: 'all',
      statements: 2,
      durable_manifest: { file: 'hhs_ocr.manifest.json', sha256: 'a'.repeat(64) },
      applied_batches: [{ file: 'hhs_ocr.batch-001.sql', sha256: 'b'.repeat(64) }],
    }],
    writtenSql: 'INSERT INTO breaches VALUES (1);',
    remote: true,
    env: { GITHUB_RUN_ID: '40865099351', GITHUB_SHA: '3dafda07' },
  });
  assert.equal(applied.schema, 'breachledger/ingest-applied@1');
  assert.equal(applied.remote, true);
  assert.equal(applied.run.id, '40865099351');
  assert.equal(applied.sources[0].durable_manifest.sha256, 'a'.repeat(64));
  assert.equal(applied.sources[0].applied_batches[0].sha256, 'b'.repeat(64));
  assert.equal(
    applied.written_sql_sha256,
    crypto.createHash('sha256').update('INSERT INTO breaches VALUES (1);').digest('hex')
  );
});
