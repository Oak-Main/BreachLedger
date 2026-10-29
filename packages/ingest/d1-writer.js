// D1 write stage (spec section 4, "Write").
//
// Two properties this module exists to guarantee:
//
// 1. updated_at is bumped ONLY when a field actually changed. The site
//    publishes dateModified from this column, and fake freshness is both
//    detectable and, on a YMYL-adjacent site, expensive. So the writer diffs
//    incoming records against what D1 already holds and emits nothing at all
//    for unchanged rows.
// 2. Source rows are never deleted. A breach accumulates sources across runs
//    and across sources; the merge rule is union, never replace.

const { sqlLiteral } = require('../schema/sql');

// Columns that constitute the published record. A change in any of these is a
// real change; first_seen_at/updated_at are excluded because they are
// bookkeeping, not content.
const CONTENT_COLUMNS = [
  'slug',
  'entity_name',
  'entity_name_normalized',
  'entity_aliases',
  'sector',
  'breach_start_date',
  'breach_end_date',
  'discovery_date',
  'notification_date',
  'records_affected',
  'records_affected_is_est',
  'data_classes',
  'states_notified',
  'remediation_offered',
  'breach_vector',
  'severity_score',
  'severity_rubric_version',
  'status',
];

const ALL_COLUMNS = ['id', ...CONTENT_COLUMNS, 'first_seen_at', 'updated_at'];

const SOURCE_COLUMNS = [
  'id',
  'breach_id',
  'source_type',
  'source_url',
  'document_url',
  'r2_archive_key',
  'retrieved_at',
  'checksum',
  'raw_payload',
];

function norm(v) {
  // Compare NULL and '' as distinct, but ignore numeric-vs-string drift that
  // comes back from the D1 JSON API.
  if (v === undefined) return null;
  if (typeof v === 'number') return String(v);
  return v;
}

function recordChanged(incoming, existing) {
  for (const col of CONTENT_COLUMNS) {
    if (norm(incoming[col]) !== norm(existing[col])) return col;
  }
  return null;
}

/**
 * Build the statements needed to bring D1 in line with `records`.
 *
 * @param {Array} records  normalized breach rows, each with a `sources` array
 * @param {Map}   existingBreaches  id -> existing breach row from D1
 * @param {Set}   existingSourceKeys  "breachId|sourceType|sourceUrl" already stored
 * @param {string} now  ISO timestamp for this run
 * @returns {{statements: string[], stats: object}}
 */
function buildStatements(records, existingBreaches, existingSourceKeys, now) {
  const statements = [];
  const stats = { inserted: 0, updated: 0, unchanged: 0, sourcesAdded: 0 };

  for (const rec of records) {
    const existing = existingBreaches.get(rec.id);

    if (!existing) {
      const row = { ...rec, first_seen_at: now, updated_at: now };
      statements.push(
        `INSERT INTO breaches (${ALL_COLUMNS.join(', ')}) VALUES (${ALL_COLUMNS.map((c) => sqlLiteral(row[c])).join(', ')})` +
        ` ON CONFLICT(id) DO UPDATE SET ${CONTENT_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}, ` +
        // first_seen_at is the row's original observation and is NOT
        // overwritten: a re-applied stage must not rewrite it.
        `updated_at = excluded.updated_at` +
        // A stage that is OLDER than what the database holds must not roll
        // the row back. A plain INSERT used to fail loudly here; the upsert
        // would have overwritten silently, so the conflict branch carries
        // its own staleness guard.
        ` WHERE excluded.updated_at >= breaches.updated_at;`
      );
      stats.inserted++;
    } else if (recordChanged(rec, existing)) {
      const sets = CONTENT_COLUMNS.map((c) => `${c} = ${sqlLiteral(rec[c])}`);
      sets.push(`updated_at = ${sqlLiteral(now)}`);
      statements.push(`UPDATE breaches SET ${sets.join(', ')} WHERE id = ${sqlLiteral(rec.id)};`);
      stats.updated++;
    } else {
      // Identical content: emit nothing, so updated_at stays truthful.
      stats.unchanged++;
    }

    for (const src of rec.sources || []) {
      const key = `${rec.id}|${src.source_type}|${src.source_url}`;
      if (existingSourceKeys.has(key)) continue;
      existingSourceKeys.add(key);
      const row = { ...src, breach_id: rec.id };
      statements.push(
        `INSERT INTO sources (${SOURCE_COLUMNS.join(', ')}) VALUES (${SOURCE_COLUMNS.map((c) => sqlLiteral(row[c])).join(', ')})` +
        ` ON CONFLICT(id) DO UPDATE SET ${SOURCE_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}` +
        ` WHERE excluded.retrieved_at >= sources.retrieved_at;`
      );
      stats.sourcesAdded++;
    }
  }

  return { statements, stats };
}

/** Split statements into files small enough for one wrangler d1 execute call. */
function batch(statements, size = 400) {
  const out = [];
  for (let i = 0; i < statements.length; i += size) {
    out.push(statements.slice(i, i + size).join('\n'));
  }
  return out;
}

module.exports = { buildStatements, batch, recordChanged, CONTENT_COLUMNS, ALL_COLUMNS, SOURCE_COLUMNS };
