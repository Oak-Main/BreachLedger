// The durable ingest manifest.
//
// A manifest records what a run actually OBSERVED and VALIDATED, per source
// and per view, so that a later acceptance check can bind the evidence to the
// inputs that were validated and, in a production run, to the statements that
// were applied.
//
// Two rules shape it:
//
//   - An empty view is an OBSERVATION, not an absence. A view that produced
//     zero rows is recorded with its own byte count, digest and retrieval
//     instant, exactly like a view that produced rows.
//   - The digest recorded for a view is the SHA-256 of that view's exported
//     bytes. It is a SOURCE-VIEW digest. It is NOT a per-record content hash,
//     and a record row inherits it because the row came from that view. The
//     database's maximum retrieved_at therefore says "when the newest row was
//     written", not "every record and every view was freshly observed".
//
// Nothing here is a credential. Session ids in the portal's query strings are
// stripped before a URL is recorded.

const crypto = require('crypto');

const MANIFEST_SCHEMA = 'breachledger/ingest-manifest@1';
const APPLIED_SCHEMA = 'breachledger/ingest-applied@1';

/** A URL with its session id and query string removed. */
function safeUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const u = new URL(url);
    // The portal carries its session id as a PATH segment, after a semicolon
    // ("breach_report_hip.jsf;jsessionid=..."), not in the query string.
    const path = u.pathname.replace(/;jsessionid=[^/]*/gi, '');
    return `${u.origin}${path}`;
  } catch {
    return null;
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function runContext(env = process.env) {
  return {
    id: env.GITHUB_RUN_ID || null,
    attempt: env.GITHUB_RUN_ATTEMPT || null,
    workflow: env.GITHUB_WORKFLOW || null,
    ref: env.GITHUB_REF || null,
    sha: env.GITHUB_SHA || null,
    repository: env.GITHUB_REPOSITORY || null,
  };
}

/**
 * Build the manifest for one source of one run.
 *
 * @param {object} input
 * @param {string} input.sourceId
 * @param {object} input.source            the source descriptor (label, grid url)
 * @param {string} input.coverage           'all' | 'current'
 * @param {boolean} input.dryRun
 * @param {Array}  input.views              the fetched views
 * @param {Map}    input.viewStats          per-view row and column counts
 * @param {number} input.totalRows
 * @param {number} input.distinct
 * @param {number} input.valid
 * @param {number} input.rejected
 * @param {object} input.stats              the write stats
 * @param {number} input.statements
 * @param {object} input.staged             the staged batches, if any
 * @param {object} input.env                the environment to read run ids from
 */
function buildManifest(input) {
  const {
    sourceId, source, coverage, dryRun, views, viewStats,
    totalRows, distinct, valid, rejected, stats, statements, staged,
    env = process.env,
  } = input;

  return {
    schema: MANIFEST_SCHEMA,
    run: runContext(env),
    source: {
      id: sourceId,
      label: source && source.label ? source.label : null,
      grid_url: source && source.gridPage ? source.gridPage : null,
      coverage: coverage || null,
      dry_run: Boolean(dryRun),
    },
    views: (views || []).map((v) => {
      const st = (viewStats && viewStats.get(v.view)) || {};
      return {
        view: v.view,
        requested_url: v.requested_url || null,
        final_url: v.final_url_safe || safeUrl(v.final_url),
        retrieved_at: v.retrieved_at || null,
        // The exact-byte SHA-256 of the exported CSV: a digest of the SOURCE
        // VIEW, carried onto every record row that came from that view.
        sha256: v.checksum || null,
        // The digest's basis, stated so a reader does not have to guess:
        // it is the SHA-256 of this view's exported bytes as received.
        // The ingest hashes the decoded UTF-8 text, which for a well-formed
        // UTF-8 export is byte-identical to the received bytes.
        digest_basis: 'sha256 over the view\'s exported bytes (UTF-8 text as received)',
        bytes: v.csv === undefined ? null : Buffer.byteLength(v.csv, 'utf8'),
        rows: st.rows === undefined ? null : st.rows,
        columns: st.columns === undefined ? null : st.columns,
        grid_reports_empty: v.gridReportsEmpty === undefined ? null : v.gridReportsEmpty,
        archive_verification: v.archiveVerification || null,
        archive_verification_basis: v.archiveVerificationBasis || null,
        archive_switch_evidence: v.archiveSwitchEvidence || null,
        export: v.steps || null,
      };
    }),
    records: {
      rows_across_views: totalRows,
      distinct,
      valid,
      rejected,
    },
    write: { statements, stats },
    staged: staged || null,
  };
}

/**
 * Build the receipt for what was actually applied, bound to the manifests that
 * described the inputs.
 *
 * @param {object} input
 * @param {Array}  input.sources        the stage manifests that were applied
 * @param {string} input.writtenSql      the exact bytes that were written
 * @param {boolean} input.remote
 * @param {object} input.env
 */
function buildAppliedReceipt(input) {
  const { sources, writtenSql, remote, env = process.env } = input;
  return {
    schema: APPLIED_SCHEMA,
    applied_at: new Date().toISOString(),
    run: runContext(env),
    remote: remote === true,
    sources: (sources || []).map((m) => ({
      source: m.source,
      coverage: m.coverage,
      statements: m.statements,
      // The durable manifest that described this source's inputs.
      durable_manifest: m.durable_manifest || null,
      applied_batches: (m.applied_batches || []).map((b) => ({
        file: b.file,
        sha256: b.sha256 || null,
      })),
    })),
    written_sql_sha256: sha256(writtenSql),
  };
}

module.exports = {
  MANIFEST_SCHEMA,
  APPLIED_SCHEMA,
  buildManifest,
  buildAppliedReceipt,
  runContext,
  safeUrl,
  sha256,
};
