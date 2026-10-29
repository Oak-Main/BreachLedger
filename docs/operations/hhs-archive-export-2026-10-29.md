# October 29 HHS archive-export repair

## Reconciled starting evidence

Inspected main: `8429694a0173be98172caf36e28c16941b7dfc4e` (PR #19).
No open corrective PR or repository instruction file existed at the start.
PR #17's server tab-state, distinct-data and staged-write protections remain
required. PR #18's durable manifests and applied receipts remain separate from
source-record timestamps. PR #19's path-suffix redaction finding is corrected
here; it was not the archive-export failure's cause.

- [Run 40900052070](https://github.com/Oak-Main/BreachLedger/actions/runs/40900052070)
  was **dry_run=true**, source=both, coverage=all. All 594 tests passed. Its
  archive multipart export exhausted the 30-second request budget. The next
  encoding returned HTML; the last returned a JSF redirect. D1 export, build
  and deploy were skipped. The artifact API returned an empty list; the upload
  log explicitly says no manifest/applied files existed. This run supplies no
  evidence of a production write.
- [Dry run 40901121594](https://github.com/Oak-Main/BreachLedger/actions/runs/40901121594)
  verified 760 current HIPAA rows and 7,305 archive rows, 7,984 distinct records,
  and two server-confirmed empty Part 2 views.
- [Run 40901470735](https://github.com/Oak-Main/BreachLedger/actions/runs/40901470735)
  reverified the same coverage. Its downloaded, digest-verified manifests and
  applied receipt report **zero SQL statements**, not new data. Its Cloudflare
  deployment failed with an unrelated internal function-publish error.
- [Deployment 40907770628](https://github.com/Oak-Main/BreachLedger/actions/runs/40907770628)
  subsequently exported 7,986 D1 records and deployed successfully. This was a
  deployment of existing D1 data, not a new source observation.

## Verified failure mechanisms

The immediate failure was an export timeout. The logs do not establish why HHS
failed to finish that particular response within 30 seconds. Later exports of
unchanged main succeeded; regenerated Mojarra ids differ between successful
sessions and are normal, not evidence of a fixed exporter-id regression.

The implementation nevertheless reused form state after uncertain exports and
reused the original grid's token after an AJAX switch. Both are unsafe recovery
assumptions for a cookie-bound JSF view.

A live read-only probe also confirmed that the portal's tabChange handler
renders `ocrForm:breachReports ocrForm:results`, outside the tab shell. Asking it
to render only the TabView yields a confirmed visible archive tab **without the
updated table/exporter**. A fresh plain postback by itself can display the
archive tab while still exporting recent rows; the existing data check correctly
refused that response. Requesting the handler's declared targets **and** the
TabView returned a server-confirmed archive and a 7,305-row CSV in the probe.
These target names are observations; the implementation discovers them from
each page's widget rather than hardcoding them.

## Correction and acceptance policy

- Bound each CSV export at 90 seconds and permit at most two complete source
  sessions. Session pages request no-cache so an intermediary cannot deliberately
  reuse a previously rendered token. A transport failure, JSF redirect/error or changed ViewState discards
  the uncertain session. Rediscover cookies, tokens and generated ids, and
  re-fetch both source views before considering success.
- Discover the actual tabChange render targets, including the results table,
  while retaining the independently rendered tab panel and active-index checks.
  Each alternative switch has a fresh context. Identical/superset recent data,
  contradictory or absent server state and unexplained emptiness remain refused.
- Require an unambiguous grid-empty observation for header-only archives,
  including an empty archive beside nonempty current data.
- Preserve URL suffixes when redacting path-form session ids; redact nested
  recovery diagnostics and logs as well. Canonical identity comparisons ignore
  only the legitimate session path parameter, and still check origin/report.
- Verify durable-manifest digests before no-op receipts too. A failed source
  writes a sanitised `ingest-failure@1` receipt, never an applied-data receipt.
- Retain the D1 build input in a `publication-data` artifact, enabling comparison
  of actual records with source observations and the production sitemap.

Regression coverage includes timeout recovery/exhaustion, rotated ids/tokens,
changed response state, redirects, failed archive selection after retry, declared
render-target changes, empty archives, redaction suffixes and tampered no-op
manifests. Full source coverage must pass before staging can be applied. No
production acceptance is inferred merely from tests or a green workflow badge.

## Corrective PR review and safe validation

[PR #20](https://github.com/Oak-Main/BreachLedger/pull/20) received independent
Copilot and CodeQL review. Follow-up corrections reject redirected CSV before
format acceptance, check the final export report/origin, retry transport failures
on grid/navigation requests too, accept whitespace in script closing tags, and
require every staged source to bind to a digest-verified durable manifest.
Source, coverage, dry-run status, statement counts and ordered batch digests must
agree with that durable manifest; unbound legacy stages are rejected. Failure
receipts use the same default/environment-selected directory as normal manifests.

Local verification after these corrections: **617 tests passed**, zero failed or
skipped; typecheck passed (18 files). The empty-data build smoke test also passed.

[Full-coverage dry run 40919381366](https://github.com/Oak-Main/BreachLedger/actions/runs/40919381366)
at the initial corrective revision independently verified 761 current HIPAA rows,
7,305 archive rows and 7,985 distinct valid records with zero rejected. It
calculated one insertion and one new source row, without writing either. Both
Part 2 views were verified empty from server state and the grid. Export, build
and deployment were correctly skipped. Final-revision dry-run and publication
acceptance remain separate release evidence.
