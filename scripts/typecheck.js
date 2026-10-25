#!/usr/bin/env node
// Syntax-check every source file the build and the workers depend on.
//
// Why this is a script and not a chain of `node --check file.js`: `node --check`
// parses a file as CommonJS unless the nearest package.json says "type": "module".
// This repo is mixed — the site, packages, and scripts are CommonJS, but
// workers/* are ES modules (Cloudflare Workers are always ESM) living under a
// root package.json that declares "type": "commonjs". A bare `node --check` on a
// worker file therefore fails on its `export default` even though the file is
// perfectly valid, so the check would report a false failure and could never
// pass. Each file is instead checked under the module system it actually uses:
// files with top-level import/export syntax are staged as a temporary .mjs copy,
// which Node always parses as a module.
//
// Reports every failure with its real path, then exits non-zero.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// The set the build, the tests, and the deploy pipeline actually load. Keeping
// the list explicit means a file added later is not silently unchecked: add it
// here with the file that pulls it in.
const FILES = [
  'site/build.js',
  'site/assets/scan.js',
  'packages/ingest/run.js',
  'packages/ingest/fetch-util.js',
  'packages/ingest/d1-writer.js',
  'packages/ingest/validate.js',
  'packages/ingest/csv.js',
  'packages/ingest/dedupe.js',
  'packages/ingest/entity-resolve.js',
  'packages/ingest/slug.js',
  'packages/schema/sql.js',
  'packages/schema/seed/load.js',
  'packages/severity/score.js',
  'scripts/refresh-receipt.js',
  'workers/api/src/index.js',
  'workers/alerts/src/index.js',
  'workers/ingest-cron/src/index.js',
  'ue.config.js',
];

// Top-level import/export syntax means the file can only be parsed as a module.
// This is the signal that matters here: the nearest package.json gets it wrong
// for the workers, and a workers/package.json would turn them into npm
// workspaces and change install behavior.
const USES_MODULE_SYNTAX = /^\s*(?:import[\s({'"*]|export[\s{*])/m;

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'breachledger-typecheck-'));

function check(displayPath, target) {
  const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
  if (result.status === 0) return null;
  // Point the reader at the real file, not the staged .mjs copy.
  return (result.stderr || `syntax error in ${displayPath}`).split(target).join(displayPath);
}

const failures = [];
for (const file of FILES) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    failures.push(`${file}: listed in scripts/typecheck.js but not found on disk`);
    continue;
  }
  const source = fs.readFileSync(abs, 'utf8');
  if (!USES_MODULE_SYNTAX.test(source)) {
    const error = check(file, abs);
    if (error) failures.push(error.trim());
    continue;
  }
  // Staged as .mjs so Node resolves it as ESM regardless of the root "type".
  const staged = path.join(tmpdir, `${file.replace(/[\\/]/g, '__')}.mjs`);
  fs.writeFileSync(staged, source);
  const error = check(file, staged);
  if (error) failures.push(error.trim());
}

fs.rmSync(tmpdir, { recursive: true, force: true });

if (failures.length) {
  process.stderr.write(`typecheck failed (${failures.length}):\n\n${failures.join('\n\n')}\n`);
  process.exit(1);
}

process.stdout.write(`typecheck ok: ${FILES.length} files\n`);
