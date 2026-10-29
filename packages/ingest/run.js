#!/usr/bin/env node
// Ingestion orchestrator. Pipeline stages (spec section 4):
//   fetch -> normalize -> entity resolve -> dedupe -> validate -> score -> write
//
// Usage:
//   node packages/ingest/run.js --source hhs_ocr [--remote] [--dry-run]
//   node packages/ingest/run.js --source hhs_ocr --from-file export.csv
//   node packages/ingest/run.js --source hhs_ocr --remote --stage <dir>
//   node packages/ingest/run.js --apply <dir> [--remote]
//
// --from-file exists so the pipeline can be exercised against a saved export
// without touching the government portal. --dry-run does everything except
// write to D1.
//
// --stage and --apply split the write in two so that EVERY source is fetched
// and validated before ANY source is written. A run that ingests two sources
// sequentially and writes each one as it goes leaves the database holding the
// first source's new rows when the second source fails -- the step fails, but
// the earlier write is already committed and is not rolled back. Staging
// writes the exact statements that were validated to disk instead; --apply
// then writes them in the same batches, in the same order, once every source
// has passed its coverage checks.
//
// Failure policy (spec sections 4 and 11): any source that cannot be retrieved
// or parsed FAILS THE RUN. A partial ingest that silently drops a source would
// publish an incomplete record set as though it were the complete government
// record, which is the worst outcome this project can produce.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const hhsOcr = require('./sources/hhs-ocr');
const hhsPart2 = require('./sources/hhs-part2');
const { fetchAllViews, GRID_PAGE, PART2_GRID_PAGE } = require('./sources/hhs-ocr-fetch');

// Registered sources. Both are OCR portal grids sharing one application and one
// export mechanism; they differ in address, legal regime, and attribution.
const SOURCES = {
  hhs_ocr: { module: hhsOcr, gridPage: GRID_PAGE, label: 'HIPAA' },
  hhs_part2: { module: hhsPart2, gridPage: PART2_GRID_PAGE, label: '42 CFR Part 2' },
};
const { validate, logReject } = require('./validate');
const { assignSlugs } = require('./slug');
const { buildStatements, batch } = require('./d1-writer');
const { buildManifest, buildAppliedReceipt, redact, runContext } = require('./manifest');
const { score } = require('../severity/score');

const ROOT = path.join(__dirname, '..', '..');
const DB = 'breachledger';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['inherit', 'pipe', 'inherit'],
  });
}

function d1Query(sql, remote) {
  const out = wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '--json', '--command', sql]);
  const start = out.indexOf('[');
  if (start === -1) throw new Error(`unexpected wrangler output: ${out.slice(0, 400)}`);
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results || [];
}

function d1File(sql, remote) {
  const tmp = path.join(ROOT, '.wrangler', `ingest-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, sql);
  try {
    wrangler(['d1', 'execute', DB, remote ? '--remote' : '--local', '--file', tmp]);
  } finally {
    fs.unlinkSync(tmp);
  }
}

/**
 * Write the statements that --stage validated.
 *
 * The staged files are the exact batches the direct write path would have
 * applied, in the same order, so applying them writes the same bytes in the
 * same sequence. Nothing is applied unless every source that was asked for
 * produced a manifest: a source that failed to stage leaves no manifest, and
 * the stage is refused rather than half-applied.
 */
function applyStaged(dir, remote, expectSources) {
  const manifests = fs.readdirSync(dir).filter((f) => f.endsWith('.manifest.json')).sort();
  const staged = manifests.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const stagedSources = staged.map((m) => m.source);

  if (expectSources && expectSources.length) {
    const missing = expectSources.filter((s) => !stagedSources.includes(s));
    if (missing.length) {
      throw new Error(
        `ingest: refusing to apply the stage: no validated data staged for source(s) ` +
          `${missing.join(', ')} (staged: ${stagedSources.join(', ') || 'none'})`
      );
    }
  }
  if (!manifests.length) {
    throw new Error(`ingest: refusing to apply the stage: no staged manifests found in ${dir}`);
  }

  // The apply list comes from the MANIFESTS, not from whatever happens to be
  // lying in the directory. A batch a manifest lists but that is missing means
  // the stage is incomplete, and applying the rest would apply that source
  // only in part. A .sql file that no manifest lists belongs to no source, and
  // must not be applied at all.
  const files = [];
  for (const m of staged) {
    for (const batch of m.batches || []) {
      const file = path.join(dir, batch);
      if (!fs.existsSync(file)) {
        throw new Error(
          `ingest: refusing to apply the stage: the staged batch ${batch} for source ` +
            `${m.source} is missing, so that source would be applied only in part`
        );
      }
      files.push({ source: m.source, file });
    }
  }
  const listed = new Set(files.map((f) => path.basename(f.file)));
  const stray = fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && !listed.has(f));
  if (stray.length) {
    throw new Error(
      `ingest: refusing to apply the stage: ${stray.length} file(s) in ${dir} are listed by no ` +
        `manifest (${stray.join(', ')}); they may belong to an earlier stage`
    );
  }

  // Verify every staged batch against the digest the manifest recorded when
  // it was staged. An edited or corrupted staged file must never be
  // applied, even though the receipt would merely report the difference
  // afterwards.
  for (const m of staged) {
    // The durable manifest is re-hashed here rather than trusted: the receipt
    // must not be able to name a manifest that has changed since it was
    // staged.
    const dm = m.durable_manifest;
    if (!dm || typeof dm.file !== 'string' || !dm.file || !/^[a-f0-9]{64}$/.test(dm.sha256 || '')) {
      throw new Error(`ingest: refusing to apply the stage: source ${m.source} has no valid durable-manifest reference`);
    }
    {
      const actualManifest = fs.existsSync(dm.file)
        ? require('crypto').createHash('sha256').update(fs.readFileSync(dm.file)).digest('hex')
        : null;
      if (actualManifest !== dm.sha256) {
        throw new Error(
          `ingest: refusing to apply the stage: the durable manifest ${dm.file} does not match ` +
            `the digest recorded at staging time (expected ${dm.sha256}, got ${actualManifest})`
        );
      }
    }
    const durable = JSON.parse(fs.readFileSync(dm.file, 'utf8'));
    const digests = m.batch_digests;
    const publishedBatches = durable.staged?.batches;
    const canonical = (items) => items.map(({ file, sha256, bytes }) => ({ file, sha256, bytes }));
    if (durable.schema !== 'breachledger/ingest-manifest@1' ||
        durable.source?.id !== m.source || durable.source?.coverage !== m.coverage ||
        durable.source?.dry_run !== false || durable.write?.statements !== m.statements ||
        !Array.isArray(digests) || !Array.isArray(publishedBatches) ||
        JSON.stringify(canonical(digests)) !== JSON.stringify(canonical(publishedBatches)) ||
        JSON.stringify(digests.map((d) => d.file)) !== JSON.stringify(m.batches) ||
        digests.some((d) => !/^[a-f0-9]{64}$/.test(d.sha256 || '') || !Number.isSafeInteger(d.bytes) || d.bytes < 0)) {
      throw new Error(`ingest: refusing to apply the stage: source ${m.source} does not match its validated durable manifest`);
    }
    for (const d of digests) {
      const full = path.join(dir, d.file);
      const actual = fs.existsSync(full)
        ? require('crypto').createHash('sha256').update(fs.readFileSync(full)).digest('hex')
        : null;
      if (actual !== d.sha256) {
        throw new Error(
          `ingest: refusing to apply the stage: the staged batch ${d.file} does not match the ` +
            `digest recorded in the manifest (expected ${d.sha256}, got ${actual})`
        );
      }
    }
  }

  if (!files.length) {
    console.error('ingest: every staged source reported no changes; nothing to apply');
    // A no-op is still an applied outcome: the receipt says that the staged
    // data was validated and nothing needed writing.
    const noop = buildAppliedReceipt({
      sources: staged.map((m) => ({
        source: m.source,
        coverage: m.coverage,
        statements: m.statements,
        durable_manifest: m.durable_manifest || null,
        applied_batches: [],
      })),
      writtenSql: '',
      remote,
    });
    fs.writeFileSync(path.join(dir, 'applied.json'), `${JSON.stringify(noop, null, 2)}\n`, 'utf8');
    console.error(`ingest: applied receipt written to ${path.join(dir, 'applied.json')}`);
    return;
  }

  // ONE D1 execution for the whole stage. Separate executions are separate
  // transactions: if the second one fails -- a transient remote error, a quota
  // error, a constraint error -- the first is already committed and the
  // database is left holding a partial ingest that no rollback undoes. One
  // execution is one operation, so the stage is applied or it is not.
  const combined = files.map((f) => fs.readFileSync(f.file, 'utf8')).join('\n');

  console.error(
    `ingest: applying ${files.length} staged batch(es) from ${dir} in ONE D1 operation ` +
      `(${files.map((f) => f.source).join(', ')})`
  );
  d1File(combined, remote);
  console.error('ingest: staged data applied');

  // The applied receipt: which manifest described the inputs, which
  // batches were applied, and the digest of the bytes that were actually
  // written. It is what binds an acceptance check to the data that
  // reached the database.
  const applied = buildAppliedReceipt({
    sources: staged.map((m) => ({
      source: m.source,
      coverage: m.coverage,
      statements: m.statements,
      durable_manifest: m.durable_manifest || null,
      applied_batches: (m.batches || []).map((b) => {
        const full = path.join(dir, b);
        return {
          file: b,
          sha256: fs.existsSync(full)
            ? require('crypto').createHash('sha256').update(fs.readFileSync(full)).digest('hex')
            : null,
        };
      }),
    })),
    writtenSql: combined,
    remote,
  });
  fs.writeFileSync(path.join(dir, 'applied.json'), `${JSON.stringify(applied, null, 2)}\n`, 'utf8');
  console.error(`ingest: applied receipt written to ${path.join(dir, 'applied.json')}`);
}

async function main() {
  const sourceId = arg('source', 'hhs_ocr');
  const remote = Boolean(arg('remote', false));
  const dryRun = Boolean(arg('dry-run', false));
  const fromFile = arg('from-file', null);
  // Staging: write the validated statements to disk instead of to D1, so that
  // a second source's failure cannot leave the first source already written.
  const stageDir = arg('stage', null);
  // Applying: write the staged statements that --stage produced.
  const applyDir = arg('apply', null);
  // Coverage policy. 'all' (default) requires the archive view and fails
  // otherwise; 'current' permits a documented partial ingest of the recent
  // view only. Partial is acceptable ONLY because /sources states the exact
  // coverage -- what is forbidden is presenting a slice AS the whole record.
  const coverage = arg('coverage', 'all');

  if (applyDir) {
    const expect = arg('expect-sources', null);
    applyStaged(
      applyDir,
      remote,
      typeof expect === 'string' ? expect.split(',').map((s) => s.trim()).filter(Boolean) : []
    );
    return;
  }

  const selected = SOURCES[sourceId];
  if (!selected) {
    throw new Error(
      `ingest: source '${sourceId}' is not implemented. Available: ${Object.keys(SOURCES).join(', ')}`
    );
  }
  const hhs = selected.module;
  console.error(`ingest: source ${sourceId} (${selected.label}) from ${selected.gridPage}`);

  // --- manifest -----------------------------------------------------------
  // A durable, per-run, per-source, per-view record of what was actually
  // observed and validated. It is written for EVERY run, including a dry run,
  // so an acceptance check can bind the evidence to the inputs that were
  // validated -- and, in a production run, to the statements that were
  // actually applied. A view that produced no rows is still recorded: an
  // empty view is an observation, not an absence.
  // The manifest is written on EVERY execution path, so the location has a
  // default rather than being optional. The workflow passes an explicit
  // --manifest-dir so the artifact can be uploaded from a known place.
  const manifestDir = arg('manifest-dir',
    process.env.INGEST_MANIFEST_DIR || path.join(require('os').tmpdir(), 'breachledger-ingest-manifest'));
  const viewStats = new Map();
  const writeManifest = (staged) => {

    fs.mkdirSync(manifestDir, { recursive: true });
    const manifest = buildManifest({
      sourceId,
      source: selected,
      coverage,
      dryRun,
      views,
      viewStats,
      totalRows,
      distinct: byId.size,
      valid: valid.length,
      rejected,
      stats,
      statements: statements.length,
      staged,
    });
    const file = path.join(manifestDir, `${sourceId}.manifest.json`);
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    // The manifest's own digest is what the apply phase records, so the
    // applied receipt names the exact manifest that described its inputs.
    const digest = require('crypto').createHash('sha256')
      .update(fs.readFileSync(file, 'utf8')).digest('hex');
    console.error(`ingest: manifest written to ${file} (sha256 ${digest})`);
    return { file, sha256: digest };
  };

  // --- fetch -------------------------------------------------------------
  // Both portal views are required. "Under Investigation" holds only the last
  // ~24 months; the rest of the history is in "Archive". Publishing one view
  // alone would present a slice as the complete government record.
  let views;

  if (fromFile) {
    const text = fs.readFileSync(fromFile, 'utf8');
    views = [{
      view: 'file',
      csv: text,
      retrieved_at: new Date().toISOString(),
      checksum: require('crypto').createHash('sha256').update(text).digest('hex'),
    }];
    console.error(`ingest: reading ${fromFile} (${text.length} bytes) instead of fetching`);
  } else {
    console.error('ingest: driving the HHS OCR portal export sequence (both views)...');
    views = await fetchAllViews({
      requireArchive: coverage !== 'current',
      gridPage: selected.gridPage,
      label: sourceId,
    });
    if (coverage === 'current') console.error('ingest: coverage=current (recent view only, documented on /sources)');
    for (const v of views) {
      const archive = v.archiveVerification
        ? `, archive verified by ${v.archiveVerificationBasis} ` +
          `(server activeIndex=${v.archiveSwitchEvidence.activeIndex}, ` +
          `archive panel visible=${v.archiveSwitchEvidence.panelVisible})`
        : '';
      console.error(
        `ingest: view ${v.view}: ${v.steps.bytes || v.csv.length} bytes via ${v.steps.path} path, ` +
          `${v.steps.encoding} encoding, command ${v.steps.csvCommand}${archive}`
      );
    }
  }

  // --- parse + normalize + entity resolve + dedupe -----------------------
  const unknownVectorTokens = new Set();
  const byId = new Map();
  let totalRows = 0;

  for (const v of views) {
    const { headers, rows } = hhs.parse(v.csv);
    totalRows += rows.length;
    viewStats.set(v.view, { rows: rows.length, columns: headers.length });
    console.error(`ingest: view ${v.view}: parsed ${rows.length} rows, ${headers.length} columns`);
    // A zero-row export is either a listing that is genuinely empty or a
    // retrieval that broke, and those must not be conflated. The portal itself
    // settles it: an empty datatable renders "No records found." So an empty
    // export is accepted ONLY when the grid we exported from said so, and is a
    // hard failure otherwise.
    //
    // This is not hypothetical. OCR's 42 CFR Part 2 listing carried no records
    // at all when it was first ingested -- a real state of the government
    // record, correctly published as an empty listing rather than as an error.
    if (!rows.length) {
      if (!v.gridReportsEmpty) {
        throw new Error(
          `ingest: view ${v.view} contained zero data rows and the grid did not report itself ` +
            'as empty — refusing to proceed on an unexplained empty export'
        );
      }
      console.error(`ingest: view ${v.view} is empty, and the portal grid confirms it holds no records`);
    }

    for (const row of rows) {
      const { record, source } = hhs.normalizeRow(row, {
        retrievedAt: v.retrieved_at,
        checksum: v.checksum,
        unknownVectorTokens,
      });
      // Dedupe within and across views: an identical id means the same entity
      // reported on the same date. A record can legitimately appear in both
      // views around the 24-month boundary.
      const existing = byId.get(record.id);
      if (existing) {
        existing.records_affected = Math.max(existing.records_affected || 0, record.records_affected || 0) || null;
        // Prefer whichever view supplied OCR's narrative; the archive has it.
        if (!existing._hhs.web_description && record._hhs.web_description) {
          existing._hhs.web_description = record._hhs.web_description;
        }
        // One source row per (breach, source_type, url) — the writer dedupes,
        // but avoid queuing an obvious duplicate here.
        continue;
      }
      record.sources = [source];
      byId.set(record.id, record);
    }
  }
  console.error(`ingest: ${totalRows} rows across ${views.length} view(s) -> ${byId.size} distinct records`);
  if (unknownVectorTokens.size) {
    console.error(
      `ingest: WARNING unrecognized "Type of Breach" values (vocabulary drift): ${[...unknownVectorTokens].join(' | ')}`
    );
  }

  // --- validate ----------------------------------------------------------
  const candidates = [...byId.values()];
  const valid = [];
  let rejected = 0;
  for (const rec of candidates) {
    const checkable = { ...rec, data_classes: JSON.parse(rec.data_classes) };
    const result = validate(checkable);
    if (result.ok) valid.push(rec);
    else {
      rejected++;
      logReject(checkable, result.reasons);
    }
  }
  console.error(`ingest: ${valid.length} valid, ${rejected} rejected (see docs/ingest-rejects.log)`);

  // --- score -------------------------------------------------------------
  for (const rec of valid) {
    const s = score({
      data_classes: JSON.parse(rec.data_classes),
      records_affected: rec.records_affected,
      remediation_offered: rec.remediation_offered ? JSON.parse(rec.remediation_offered) : null,
      discovery_date: rec.discovery_date,
      notification_date: rec.notification_date,
    });
    rec.severity_score = s.score;
    rec.severity_rubric_version = s.rubric_version;
  }

  // --- slugs -------------------------------------------------------------
  assignSlugs(valid, { stableKey: (r) => r.id });

  // --- write -------------------------------------------------------------
  // Always read current state, including on a dry run. A dry run whose
  // "would insert" count is computed against an empty table reports every
  // record as new and none as unchanged, which is exactly the reassurance a
  // preview must not give. This is a read; it is safe in every mode.
  const existingRows = d1Query('SELECT * FROM breaches', remote);
  const existingBreaches = new Map(existingRows.map((r) => [r.id, r]));
  const existingSources = new Set(
    d1Query('SELECT breach_id, source_type, source_url FROM sources', remote).map(
      (s) => `${s.breach_id}|${s.source_type}|${s.source_url}`
    )
  );

  const now = new Date().toISOString();
  for (const rec of valid) {
    for (const src of rec.sources) {
      src.id = require('crypto')
        .createHash('sha256')
        .update(`${rec.id}|${src.source_type}|${src.source_url}`)
        .digest('hex')
        .slice(0, 32);
    }
    delete rec._hhs; // provenance is preserved in sources.raw_payload
    delete rec.slug_namespace; // consumed by assignSlugs; not a column
  }

  // A slug is a permanent public URL and the column is UNIQUE. assignSlugs can
  // only disambiguate within one process, and sources are ingested by separate
  // processes, so a slug already owned by a DIFFERENT record in D1 has to be
  // caught here. Left to SQLite it would surface mid-write, after earlier
  // batches had already been committed, leaving a half-ingested source behind.
  const slugOwner = new Map();
  for (const [id, row] of existingBreaches) if (row.slug) slugOwner.set(row.slug, id);
  const stolen = valid.filter((r) => slugOwner.has(r.slug) && slugOwner.get(r.slug) !== r.id);
  if (stolen.length) {
    throw new Error(
      `ingest: ${stolen.length} record(s) would take a URL already belonging to a different record. ` +
        'Refusing to write, because a slug is a permanent public URL.\n' +
        stolen
          .slice(0, 10)
          .map((r) => `  - /breach/${r.slug} wanted by ${r.id} (${r.entity_name}), held by ${slugOwner.get(r.slug)}`)
          .join('\n')
    );
  }

  const { statements, stats } = buildStatements(valid, existingBreaches, existingSources, now);
  console.error(
    `ingest: ${stats.inserted} inserted, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.sourcesAdded} source rows added`
  );

  const files = batch(statements, 400);

  if (dryRun) {
    // A dry run must return BEFORE anything is staged: the staged batch files
    // are exactly what the apply phase would write, so a dry run that staged
    // them would leave a complete applicable stage behind.
    writeManifest({ batches: [], note: 'dry run: nothing was written' });
    console.error('ingest: --dry-run, no writes performed');
    return;
  }

  if (stageDir) {
    // Stage the validated statements instead of writing them, so that no
    // source is written until every source has passed its coverage checks.
    // A manifest is written even when a source has no changes, so that the
    // apply phase can tell "validated, nothing to do" from "never ran".
    fs.mkdirSync(stageDir, { recursive: true });
    const written = [];
    const batchDigests = [];
    files.forEach((sql, i) => {
      const file = path.join(stageDir, `${sourceId}.batch-${String(i + 1).padStart(3, '0')}.sql`);
      fs.writeFileSync(file, sql);
      written.push(path.basename(file));
      batchDigests.push({
        file: path.basename(file),
        sha256: require('crypto').createHash('sha256').update(sql, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(sql, 'utf8'),
      });
    });
    // The durable manifest is written AFTER the batches exist, so it carries
    // their digests and can be bound to what was actually applied.
    const durable = writeManifest({ batches: batchDigests });
    fs.writeFileSync(
      path.join(stageDir, `${sourceId}.manifest.json`),
      JSON.stringify({
        source: sourceId,
        coverage,
        statements: statements.length,
        batches: written,
        batch_digests: batchDigests,
        stats,
        stagedAt: now,
        durable_manifest: durable
          ? { file: durable.file, sha256: durable.sha256 }
          : null,
      }, null, 2),
      'utf8'
    );
    console.error(
      `ingest: staged ${statements.length} statement(s) in ${written.length} batch(es) -> ${stageDir} ` +
        '(no D1 write in this phase)'
    );
    return;
  }

  if (!statements.length) {
    console.error('ingest: nothing to write; database already matches the source');
    return;
  }

  writeManifest({ batches: [], note: 'direct write: the statements were applied from memory' });
  files.forEach((sql, i) => {
    console.error(`ingest: applying batch ${i + 1}/${files.length}`);
    d1File(sql, remote);
  });
  console.error('ingest: complete');
}

main().catch((err) => {
  // Fetch failures happen before a validated manifest exists. Retain a small,
  // sanitised failure receipt too; it is never an applied-data receipt.
  const sourceId = arg('source', 'hhs_ocr');
  if (!arg('apply') && SOURCES[sourceId]) {
    const dir = arg('manifest-dir',
      process.env.INGEST_MANIFEST_DIR || path.join(require('os').tmpdir(), 'breachledger-ingest-manifest'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sourceId}.failure.json`), JSON.stringify({
      schema: 'breachledger/ingest-failure@1',
      run: runContext(),
      source: sourceId,
      coverage: arg('coverage', 'all'),
      failed_at: new Date().toISOString(),
      error: redact(err.message),
    }, null, 2) + '\n');
  }
  console.error(`ingest FAILED: ${redact(err.message)}`);
  process.exit(1);
});
