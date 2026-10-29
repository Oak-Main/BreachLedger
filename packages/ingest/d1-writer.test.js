const test = require('node:test');
const assert = require('node:assert');
const { buildStatements, batch, recordChanged } = require('./d1-writer');
const { sqlLiteral } = require('../schema/sql');

const NOW = '2026-08-06T00:00:00.000Z';

function rec(overrides = {}) {
  return {
    id: 'b1',
    slug: 'acme-2025-01',
    entity_name: 'Acme Clinic',
    entity_name_normalized: 'acme clinic',
    entity_aliases: null,
    sector: 'healthcare',
    breach_start_date: null,
    breach_end_date: null,
    discovery_date: null,
    notification_date: '2025-01-15',
    records_affected: 1200,
    records_affected_is_est: 0,
    data_classes: '["medical"]',
    states_notified: '[]',
    remediation_offered: null,
    breach_vector: 'hacking',
    severity_score: 35,
    severity_rubric_version: '1.0',
    status: 'published',
    sources: [],
    ...overrides,
  };
}

test('new record produces an INSERT with first_seen_at and updated_at set', () => {
  const { statements, stats } = buildStatements([rec()], new Map(), new Set(), NOW);
  assert.equal(stats.inserted, 1);
  assert.match(statements[0], /^INSERT INTO breaches/);
  assert.ok(statements[0].includes(sqlLiteral(NOW)));
});

test('unchanged record emits NO statement, keeping updated_at honest', () => {
  const existing = new Map([['b1', { ...rec(), first_seen_at: '2025-01-01', updated_at: '2025-01-01' }]]);
  const { statements, stats } = buildStatements([rec()], existing, new Set(), NOW);
  assert.equal(stats.unchanged, 1);
  assert.equal(stats.updated, 0);
  assert.equal(statements.length, 0);
});

test('changed record produces an UPDATE that bumps updated_at', () => {
  const existing = new Map([['b1', { ...rec({ records_affected: 900 }), updated_at: '2025-01-01' }]]);
  const { statements, stats } = buildStatements([rec()], existing, new Set(), NOW);
  assert.equal(stats.updated, 1);
  assert.match(statements[0], /^UPDATE breaches SET/);
  assert.ok(statements[0].includes(`updated_at = ${sqlLiteral(NOW)}`));
});

test('numeric vs string drift from the D1 JSON API is not a change', () => {
  const existing = new Map([['b1', { ...rec({ records_affected: '1200' }) }]]);
  const { stats } = buildStatements([rec({ records_affected: 1200 })], existing, new Set(), NOW);
  assert.equal(stats.unchanged, 1);
});

test('recordChanged reports which column differs, and ignores bookkeeping columns', () => {
  assert.equal(recordChanged(rec(), rec()), null);
  assert.equal(recordChanged(rec({ sector: 'tech' }), rec()), 'sector');
  assert.equal(recordChanged(rec(), { ...rec(), updated_at: 'different', first_seen_at: 'different' }), null);
});

test('source rows are added once and never duplicated across runs', () => {
  const src = { id: 's1', source_type: 'hhs_ocr', source_url: 'https://x.gov/a', retrieved_at: NOW, checksum: 'c' };
  const seen = new Set();
  const first = buildStatements([rec({ sources: [src] })], new Map(), seen, NOW);
  assert.equal(first.stats.sourcesAdded, 1);
  // Second run: breach already present and unchanged, source already recorded.
  const existing = new Map([['b1', rec()]]);
  const second = buildStatements([rec({ sources: [src] })], existing, seen, NOW);
  assert.equal(second.stats.sourcesAdded, 0);
  assert.equal(second.statements.length, 0);
});

test('no DELETE is ever emitted for sources', () => {
  const src = { id: 's1', source_type: 'hhs_ocr', source_url: 'https://x.gov/a', retrieved_at: NOW, checksum: 'c' };
  const { statements } = buildStatements([rec({ sources: [src] })], new Map(), new Set(), NOW);
  assert.ok(!statements.some((s) => /DELETE/i.test(s)));
});

test('hostile entity names are escaped, not executed', () => {
  const evil = "Acme'); DROP TABLE breaches;--";
  const { statements } = buildStatements([rec({ entity_name: evil })], new Map(), new Set(), NOW);
  assert.ok(statements[0].includes("Acme''); DROP TABLE breaches;--"));
  assert.ok(!statements[0].includes("'Acme'); DROP"));
});

test('batching splits statements into chunks', () => {
  const stmts = Array.from({ length: 950 }, (_, i) => `SELECT ${i};`);
  const files = batch(stmts, 400);
  assert.equal(files.length, 3);
  assert.equal(files[0].split('\n').length, 400);
  assert.equal(files[2].split('\n').length, 150);
});

test('the insert statements are idempotent, so a partially applied stage can be re-applied', () => {
  // The remote import path's all-or-nothing behaviour is not established, so
  // the staged write must not DEPEND on it: re-applying the same stage has to
  // converge on the same state. An upsert does that; a plain INSERT would
  // fail on the primary key of a row the first attempt had already written.
  const { statements } = buildStatements(
    [rec({ sources: [{ id: 's1', source_type: 'hhs_ocr', source_url: 'https://x.gov/a', retrieved_at: NOW, checksum: 'c' }] })],
    new Map(), new Set(), NOW
  );
  const insert = statements.find((s) => s.startsWith('INSERT INTO breaches'));
  assert.ok(insert, 'a new breach must emit an insert');
  assert.match(insert, /ON CONFLICT\(id\) DO UPDATE SET/);
  const sourceInsert = statements.find((s) => s.startsWith('INSERT INTO sources'));
  assert.ok(sourceInsert, 'a new source row must emit an insert');
  assert.match(sourceInsert, /ON CONFLICT\(id\) DO UPDATE SET/);
});

test('the upsert never rewrites first_seen_at', () => {
  // first_seen_at is the row's original observation. Re-applying a stage
  // must not move it, or a recovery would silently restate history.
  const { statements } = buildStatements([rec()], new Map(), new Set(), NOW);
  const insert = statements.find((s) => s.startsWith('INSERT INTO breaches'));
  assert.ok(insert, 'a new breach must emit an insert');
  assert.ok(
    !/first_seen_at\s*=\s*excluded\.first_seen_at/.test(insert),
    'the conflict branch must not overwrite first_seen_at'
  );
  assert.match(insert, /updated_at = excluded\.updated_at/);
});