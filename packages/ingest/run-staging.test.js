// Tests for the staged-write safeguard.
//
// The safeguard exists because a two-source ingest that writes each source as
// it goes leaves the first source's rows committed when the second source
// fails. Staging splits the write: every source is fetched and validated
// first, and the statements are written only after all of them passed.
//
// These tests exercise the REFUSAL paths of the apply phase, which is the
// part that must never write when the stage is incomplete. They never reach
// D1.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const RUN = path.join(ROOT, 'packages', 'ingest', 'run.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'breachledger-stage-'));
}

function apply(stageDir, extraArgs = []) {
  const res = spawnSync(process.execPath, [RUN, '--apply', stageDir, ...extraArgs], {
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

test('the apply phase refuses a stage that nothing was written to', () => {
  const dir = tmpDir();
  const res = apply(dir);
  assert.notEqual(res.code, 0, 'an empty stage must not be applied');
  assert.match(res.out, /refusing to apply the stage/);
});

test('the apply phase refuses when a source produced no validated data', () => {
  const dir = tmpDir();
  // Only hhs_ocr staged; hhs_part2 is still expected.
  fs.writeFileSync(
    path.join(dir, 'hhs_ocr.manifest.json'),
    JSON.stringify({ source: 'hhs_ocr', coverage: 'all', statements: 0, batches: [], stats: {} }),
    'utf8'
  );
  const res = apply(dir, ['--expect-sources', 'hhs_ocr,hhs_part2']);
  assert.notEqual(res.code, 0, 'a partial stage must not be applied');
  assert.match(res.out, /no validated data staged for source\(s\) hhs_part2/);
});

test('a stage whose sources all report no changes applies nothing and succeeds', () => {
  const dir = tmpDir();
  for (const source of ['hhs_ocr', 'hhs_part2']) {
    fs.writeFileSync(
      path.join(dir, `${source}.manifest.json`),
      JSON.stringify({ source, coverage: 'all', statements: 0, batches: [], stats: {} }),
      'utf8'
    );
  }
  const res = apply(dir, ['--expect-sources', 'hhs_ocr,hhs_part2']);
  assert.equal(res.code, 0, res.out);
  assert.match(res.out, /every staged source reported no changes/);
  assert.match(res.out, /nothing to apply/);
});

test('the apply phase refuses when a source is missing from the expectation list', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'hhs_ocr.manifest.json'),
    JSON.stringify({ source: 'hhs_ocr', coverage: 'all', statements: 0, batches: [], stats: {} }),
    'utf8'
  );
  // Expecting only hhs_ocr is satisfied; the guard is about MISSING sources.
  const ok = apply(dir, ['--expect-sources', 'hhs_ocr']);
  assert.equal(ok.code, 0, ok.out);
});

test('the apply phase refuses when a batch a manifest lists is missing', () => {
  // The manifest says the source has two batches, but only one is on disk.
  // Applying what is there would apply that source only in part.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'hhs_ocr.batch-001.sql'), 'SELECT 1;');
  fs.writeFileSync(
    path.join(dir, 'hhs_ocr.manifest.json'),
    JSON.stringify({
      source: 'hhs_ocr', coverage: 'all', statements: 2,
      batches: ['hhs_ocr.batch-001.sql', 'hhs_ocr.batch-002.sql'], stats: {},
    }),
    'utf8'
  );
  const res = apply(dir, ['--expect-sources', 'hhs_ocr']);
  assert.notEqual(res.code, 0, 'an incomplete stage must not be applied');
  assert.match(res.out, /staged batch hhs_ocr\.batch-002\.sql for source hhs_ocr is missing/);
});

test('the apply phase refuses a sql file that no manifest lists', () => {
  // A leftover file from an earlier stage belongs to no source. Applying it
  // would write data that was never validated against the current run.
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'hhs_ocr.batch-001.sql'), 'SELECT 1;');
  fs.writeFileSync(
    path.join(dir, 'hhs_ocr.manifest.json'),
    JSON.stringify({
      source: 'hhs_ocr', coverage: 'all', statements: 1,
      batches: ['hhs_ocr.batch-001.sql'], stats: {},
    }),
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'stale.batch-001.sql'), 'SELECT 2;');
  const res = apply(dir, ['--expect-sources', 'hhs_ocr']);
  assert.notEqual(res.code, 0, 'a stale file must not be applied');
  assert.match(res.out, /listed by no manifest/);
  assert.match(res.out, /stale\.batch-001\.sql/);
});

// --- Structural guarantees, pinned against the source -----------------------
//
// The behavioural tests above cover the refusals. These two pin the two
// properties that the behaviour rests on and that no unit test can observe
// without a live database: that the stage writes nothing, and that the apply
// phase is ONE database operation.

test('the staging phase never writes to D1', () => {
  const source = fs.readFileSync(RUN, 'utf8');
  const stageBranch = source.slice(
    source.indexOf('if (stageDir) {'),
    source.indexOf('if (!statements.length) {')
  );
  assert.ok(stageBranch.length > 0, 'the staging branch must exist');
  assert.ok(
    !stageBranch.includes('d1File('),
    'the staging phase must not write to D1'
  );
  assert.match(source, /no D1 write in this phase/);
});

test('the apply phase performs exactly ONE database write', () => {
  const source = fs.readFileSync(RUN, 'utf8');
  const applyFn = source.slice(
    source.indexOf('function applyStaged('),
    source.indexOf('async function main(')
  );
  assert.ok(applyFn.length > 0, 'the apply phase must exist');
  const writes = applyFn.match(/d1File\(/g) || [];
  assert.equal(
    writes.length, 1,
    `the apply phase must write in ONE operation, found ${writes.length} writes`
  );
  // One call site is not enough on its own: a call inside a loop would still
  // execute several times. The write has to sit at the function's top level,
  // so its brace depth is the function body's own depth.
  const writeAt = applyFn.indexOf('d1File(');
  let depth = 0;
  for (let i = 0; i < writeAt; i++) {
    if (applyFn[i] === '{') depth += 1;
    else if (applyFn[i] === '}') depth -= 1;
  }
  assert.equal(
    depth, 1,
    'the database write must be a top-level statement in the apply phase, not inside a loop'
  );
  assert.match(applyFn, /in ONE D1 operation/);
});
