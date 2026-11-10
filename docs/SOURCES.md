# Sources and methodology

Every fact published on BreachBook traces to a citable government or court source. This page documents
each source, how it is retrieved, and when its endpoint was last verified. A breach record with zero
sources is never rendered.

## Source registry

| Source | Type code | Format | Retrieval method | Endpoint | Phase | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| HHS Office for Civil Rights breach portal | `hhs_ocr` | CSV export via JSF form postback | scheduled fetch, daily 06:00 UTC | [ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf](https://ocrportal.hhs.gov/ocr/breach/breach_report_hip.jsf) | 1 | **verified 2026-11-09** — portal answered with its CSV export form at 22:49 PT; the scheduled ingest run of 2026-11-09 15:05 UTC succeeded |
| Maine Attorney General breach notifications | `maine_ag` | HTML list + PDF letters | scheduled fetch, daily | [maine.gov/ag/consumer/identity_theft/](https://www.maine.gov/ag/consumer/identity_theft/) | 2 | pending — endpoint documented 2026-08-02, not yet fetch-verified |
| California Attorney General breach list | `ca_ag` | HTML table + sample notices | scheduled fetch, daily | [oag.ca.gov/privacy/databreach/list](https://oag.ca.gov/privacy/databreach/list) | 2 | pending — endpoint documented 2026-08-02, not yet fetch-verified |
| Washington Attorney General breach notifications | `wa_ag` | HTML/dashboard | scheduled fetch, daily | [atg.wa.gov/data-breach-notifications](https://www.atg.wa.gov/data-breach-notifications) | 2 | pending — endpoint documented 2026-08-02, not yet fetch-verified |
| Texas Attorney General data breach reports | `tx_ag` | HTML list | scheduled fetch, daily | [oag.texas.gov/consumer-protection/data-breach-reporting](https://oag.texas.gov/consumer-protection/data-breach-reporting) | 3 | pending — endpoint documented 2026-08-02, not yet fetch-verified |
| SEC EDGAR 8-K Item 1.05 filings | `sec_8k` | full-text search API (JSON) | scheduled fetch, daily | [efts.sec.gov/LATEST/search-index](https://efts.sec.gov/LATEST/search-index?q=%22Item%201.05%22&forms=8-K) via [sec.gov/edgar/search](https://www.sec.gov/edgar/search/) | 3 | pending — endpoint documented 2026-08-02, not yet fetch-verified |
| CourtListener REST API v4 | `courtlistener` | JSON API (token required) | scheduled fetch, hourly for tracked dockets | [courtlistener.com/api/rest/v4/](https://www.courtlistener.com/api/rest/v4/) | 4 | pending — endpoint documented 2026-08-02, not yet fetch-verified |
| HHS OCR 42 CFR Part 2 breach report | `hhs_part2` | CSV export via JSF form postback | scheduled fetch, daily 06:00 UTC | [ocrportal.hhs.gov/ocr/breach/breach_report_part2.jsf](https://ocrportal.hhs.gov/ocr/breach/breach_report_part2.jsf) | 1 | **verified 2026-11-09** — portal answered with its CSV export form at 22:49 PT; the scheduled ingest run of 2026-11-09 15:05 UTC succeeded (the listing held no records on 2026-08-07) |

Endpoint verification policy: government portals rotate paths without notice. Each ingest run re-verifies its
endpoint and **fails loudly on a 404** — a source is never silently skipped. When an endpoint moves, this table
is updated with the new URL and a fresh verification date.

## Current coverage, stated precisely

Being explicit about what this record does and does not yet contain matters more
than appearing complete.

- **HHS Office for Civil Rights** — the portal presents its data in two views: "Under
  Investigation", holding breaches reported in roughly the last 24 months, and an archive
  of older cases whose investigations have closed. **Both views are ingested**, so this
  record covers the portal's full published history rather than a recent slice. Each
  ingest retrieves both and merges them; a breach appearing in both views around the
  24-month boundary is stored once.
- The HHS portal covers breaches of protected health information affecting 500 or more
  individuals. Smaller breaches are reported to HHS annually and are not published in this
  dataset, so they cannot appear here. This is a limit of the government record itself,
  not of our ingestion.
- HHS does not publish a discovery date, a breach start or end date, remediation offered,
  or the set of states notified. Those fields are therefore empty on records sourced only
  from HHS, and the severity score's notification-lag and remediation components are
  reported as not assessable rather than assumed.
- **42 CFR Part 2 breaches are ingested.** In February 2026 the OCR portal added a second,
  separate report covering breaches of records held by federally assisted substance use
  disorder treatment programs — a different legal regime from HIPAA, with its own
  under-investigation and archived listings. Breaches of those records affecting 500 or
  more individuals are reported to HHS and posted publicly under the same breach
  notification rule that applies to HIPAA breaches, and this record carries them on the
  same terms as everything else. Every breach page drawn from that listing says which
  listing it came from. Like the HIPAA records, these entries name the reporting
  organization and no individual.
- **As of the last check, the Part 2 listing contained no records.** Both its
  under-investigation and archived views returned empty on 2026-08-07, and the portal's own
  grid reported "No records found." So there is currently nothing to show from it. That is
  a fact about the government record, not a gap in ingestion: the retrieval runs on the
  same schedule as the HIPAA report and records will appear here as OCR posts them. An
  empty export is only accepted when the portal grid itself reports the listing as empty;
  an unexplained empty export fails the run.
- A breach reported to both listings by the same organization is stored as two records with
  distinct identifiers and distinct URLs, because they are two filings under two rules.
  Merging them is deferred to cross-source reconciliation rather than guessed at here.
- State attorney general sources, SEC filings, and litigation records are not yet ingested.
  The sources above marked for later phases are documented, not live.

## Retrieval conduct

- Every request identifies this project with a descriptive User-Agent including a contact URL
  (required by SEC EDGAR access policy; extended to all sources as baseline conduct).
- Requests are rate-limited to at most 1 request/second per host, and robots.txt is respected.
- Raw payloads are stored with a SHA-256 checksum; unchanged payloads are not reprocessed.
- From Phase 4, source notification PDFs are archived to durable storage so the record survives
  if an agency rotates or removes its URLs.

## Seeded reference data

- **Data class weights** are editorial policy, published in full at [/severity](/severity/), versioned in
  `packages/severity/rubric.json`.
- **State notification-law reference** (`state_rights` table): seeded 2026-08-02 from statutory research with an
  independent cross-check pass; each row carries a `last_verified` date. Rows are re-verified against the official
  state legislature source before the corresponding `/rights/[state]` page ships in Phase 3, and any figure that
  could not be confirmed is stored as null rather than guessed. Statute URLs point to official state legislature
  sites or the state's contracted official code publisher. Where a state offers no stable per-section link
  (for example Mississippi, whose official code is a Lexis-hosted service), the URL is the official legislature
  gateway and the row's research notes say how to navigate to the section.
- **Remediation modules**: every module cites one authoritative federal source — consumer.ftc.gov,
  IdentityTheft.gov, IRS.gov, consumerfinance.gov (CFPB), or USA.gov — as the authority for its instructions,
  with a `last_verified` date.

## Contact and error reports

BreachBook is published by Oak and Main Developers LLC, 2108 N St., Sacramento, CA 95816. See
[about](/about/) for the publisher of record.

Corrections and source disputes go to **corrections@breachbook.org** — include the page URL and a citation to
the government or court document that supports the correction. Reports can also be filed in the open as an
issue at [github.com/kevynsgrin-a11y/BreachLedger](https://github.com/kevynsgrin-a11y/BreachLedger), which
requires a GitHub account. (The repository keeps its original name; the site is BreachBook.) Security reports
go to security@breachbook.org.

## What this site deliberately does not do

- No index, filter, or category page grouping breaches by type of treatment. Records from the
  42 CFR Part 2 listing are reachable exactly the way every other record is — by organization,
  by year, and by sector — and each states its listing on its face. A browsable page of
  substance use disorder program breaches would assemble something the government does not
  publish, which is not this site's role.
- No email-lookup or "was I breached" search. That function exists at
  [Have I Been Pwned](https://haveibeenpwned.com/), which we link to and never proxy or replicate.
- No legal advice, no claim processing. Settlement pages link only to the official settlement administrator.
