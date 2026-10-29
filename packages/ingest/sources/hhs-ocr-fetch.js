// Drives the HHS OCR portal's JSF form sequence to obtain the breach CSV.
//
// There is no static CSV URL. The export lives behind a cookie-bound JSF
// postback whose ViewState changes at every step and whose element ids are
// Mojarra-generated, so nothing here may be hardcoded.
//
// The single most important rule in this file: SUCCESS IS JUDGED BY WHETHER
// THE BODY IS CSV, NEVER BY STATUS CODE. If a JSF postback is encoded in a way
// the server's filter does not decode, JSF does not error — it re-renders the
// view and returns HTTP 200 with HTML. A status-code check would read that as
// success and hand a page of markup to the CSV parser.
//
// Encodings are therefore attempted in order of evidential support
// (multipart first: the only genuine capture of this form declares
// enctype="multipart/form-data"), and each attempt is accepted only if what
// comes back actually looks like CSV.

const { politeFetch, USER_AGENT } = require('../fetch-util');
const jsf = require('./hhs-jsf');
const { safeUrl } = require('../manifest');
const tv = require('./hhs-tabview');

const BASE = 'https://ocrportal.hhs.gov/ocr/breach/';
const FRONT_PAGE = `${BASE}breach_report.jsf`;
const GRID_PAGE = `${BASE}breach_report_hip.jsf`;
// The 42 CFR Part 2 report is a structurally identical grid at its own address:
// same PrimeFaces datatable, same four exporters, same TabView archive.
//
// Found by probing candidate addresses directly: a plain GET returns the grid
// on the first try, and the seven sibling spellings all 404, so the name is
// confirmed uniquely. It was NOT confirmed via the front page's navigation --
// that command was observed landing on wizard_breach_hip.jsf, a HIPAA page, on
// one run and on the Part 2 grid on another. Its destination is not
// deterministic, which is exactly why the front-page fallback below is gated to
// the HIPAA grid and why this file now checks what it actually received.
const PART2_GRID_PAGE = `${BASE}breach_report_part2.jsf`;
const GRID_LABEL = 'View HIPAA Breach Reports';

// Text that must appear on each grid for it to be the grid we asked for.
// A non-deterministic postback or a future redirect could hand us the other
// regime's page; without a positive check, a Part 2 run that landed on the
// HIPAA grid would export ~7,760 HIPAA breaches and publish every one of them
// as a substance use disorder treatment record.
const GRID_IDENTITY = {
  [GRID_PAGE]: /Covered Entity|HIPAA/i,
  [PART2_GRID_PAGE]: /42 CFR Part 2|Part 2 Program|Part 2 Cases/i,
};

/**
 * Assert that a fetched page is the page we asked for.
 *
 * politeFetch reports final_url and redirected precisely so callers can catch
 * URL rot, and until now no caller read either. A 404 already throws; this
 * catches the quieter failures -- a redirect to another report, or a server
 * that renders a different view at the same address.
 */
function assertGridIdentity(gridPage, res, label) {
  const wantPath = new URL(gridPage).pathname;
  const gotPath = new URL(res.final_url || gridPage).pathname;
  if (gotPath !== wantPath) {
    throw new Error(
      `${label}: requested ${gridPage} but the response came from ${res.final_url} ` +
        `(redirected=${res.redirected}). Refusing to ingest one report's data as another's.`
    );
  }
  const expect = GRID_IDENTITY[gridPage];
  if (expect && !expect.test(res.body)) {
    throw new Error(
      `${label}: the page at ${gridPage} does not identify itself as the expected report ` +
        `(no match for ${expect}). Refusing to ingest a report we cannot confirm the identity of.`
    );
  }
}

/**
 * Does the grid itself say it holds no records?
 *
 * A zero-row export is ambiguous on its face: it is either a listing that is
 * genuinely empty, or a retrieval that broke. The portal distinguishes them --
 * an empty datatable renders "No records found." and a paginator reading
 * "(Displaying 0 - 0 of 0)" -- so the distinction is read off the page rather
 * than assumed from the row count.
 */
function gridReportsEmpty(html) {
  return /ui-datatable-empty-message/i.test(html) || /Displaying\s*0\s*-\s*0\s*of\s*0/i.test(html);
}

/** The export minus its header row. The header carries volatile JSF object
 *  identity ("UIPanel@3c159259"), which differs between two responses even
 *  when the data is identical -- so only the data may be compared. */
function dataRowsOf(csv) {
  const nl = String(csv).indexOf('\n');
  return nl === -1 ? '' : String(csv).slice(nl + 1);
}

class CookieJar {
  constructor() { this.cookies = new Map(); }
  absorb(response) {
    const raw = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of raw) {
      const pair = String(line).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/**
 * POST the export command, trying each encoding until one returns something
 * that is actually CSV. Returns the CSV response, or null with the attempts
 * recorded for diagnosis.
 */
async function postExport({ fetchImpl, jar, action, hidden, commandId, attempts, label = '' }) {
  const tag = label ? ` ${label}` : '';
  for (const enc of jsf.commandEncodings(hidden, commandId)) {
    let res;
    try {
      res = await fetchImpl(action, {
        raw: true,
        jar,
        method: 'POST',
        body: enc.body,
        headers: { 'Content-Type': enc.contentType },
      });
    } catch (err) {
      attempts.push(`export[${enc.name}]${tag}: request failed: ${err.message}`);
      continue;
    }
    if (jsf.looksLikeCsv(res.body)) {
      return { res, encoding: enc.name };
    }
    attempts.push(
      `export[${enc.name}]${tag}: ${res.body.length} bytes, not CSV (${jsf.excerpt(res.body, 120)})`
    );
  }
  return null;
}

/** Try to obtain the export from a page that already contains the exporter. */
async function exportFromPage({ fetchImpl, jar, pageUrl, pageBody, attempts, pathName }) {
  const hidden = jsf.extractHiddenInputs(pageBody);
  const viewState = jsf.extractViewState(hidden);
  const commandId = jsf.findCsvExportCommand(pageBody);
  if (!viewState || !commandId) {
    attempts.push(
      `${pathName}: ${pageBody.length} bytes, viewState=${Boolean(viewState)}, ` +
        `csvCommand=${commandId || 'none'}, commands=${jsf.listCommandCandidates(pageBody).length}`
    );
    return null;
  }
  const action = new URL(jsf.extractFormAction(pageBody) || pageUrl, pageUrl).toString();
  const got = await postExport({ fetchImpl, jar, action, hidden, commandId, attempts });
  if (!got) return null;
  return { csv: got.res, commandId, encoding: got.encoding, path: pathName };
}

async function fetchBreachCsv({ fetchImpl = politeFetch, gridPage = GRID_PAGE, label = 'hhs_ocr' } = {}) {
  const jar = new CookieJar();
  const attempts = [];

  // --- Primary: the data grid, fetched directly --------------------------
  const direct = await fetchImpl(gridPage, { raw: true, jar });
  assertGridIdentity(gridPage, direct, label);
  let result = await exportFromPage({
    fetchImpl, jar, pageUrl: gridPage, pageBody: direct.body, attempts, pathName: 'direct-grid',
  });

  // --- Fallback: navigate from the front page ----------------------------
  // Only meaningful for the HIPAA grid; the Part 2 grid is reached directly.
  if (!result && gridPage === GRID_PAGE) {
    const front = await fetchImpl(FRONT_PAGE, { raw: true, jar });
    const frontHidden = jsf.extractHiddenInputs(front.body);
    const gridCommand = jsf.findCommandByLabel(front.body, GRID_LABEL);
    if (jsf.extractViewState(frontHidden) && gridCommand) {
      const frontAction = new URL(jsf.extractFormAction(front.body) || FRONT_PAGE, FRONT_PAGE).toString();
      // The navigation postback needs a decodable encoding too, for exactly the
      // same reason the export does.
      for (const enc of jsf.commandEncodings(frontHidden, gridCommand)) {
        const grid = await fetchImpl(frontAction, {
          raw: true,
          jar,
          method: 'POST',
          body: enc.body,
          headers: { 'Content-Type': enc.contentType },
        });
        const candidate = await exportFromPage({
          fetchImpl,
          jar,
          pageUrl: frontAction,
          pageBody: grid.body,
          attempts,
          pathName: `front-nav[${enc.name}]`,
        });
        if (candidate) { result = candidate; break; }
      }
    } else {
      attempts.push(
        `front-page: viewState=${Boolean(jsf.extractViewState(frontHidden))}, ` +
          `gridCommand=${gridCommand || 'none'}, commands=${jsf.listCommandCandidates(front.body).length}`
      );
    }
  }

  if (!result) {
    const diag = jsf.exportDiagnostics(direct.body);
    throw new Error(
      `${label}: could not obtain the CSV export by any path or encoding. Refusing to publish a ` +
        'partial or wrong-format record set.\n' +
        attempts.map((a) => `  - ${a}`).join('\n') +
        `\n  markup mentioning csv/export on the direct grid (${diag.length}):\n` +
        diag.slice(0, 15).map((d) => `    - ${d}`).join('\n')
    );
  }

  return {
    csv: result.csv.body,
    // Whether the GRID said it was empty, recorded from the page we exported
    // from. A caller can then tell an empty listing from a broken fetch.
    gridReportsEmpty: gridReportsEmpty(direct.body),
    steps: {
      path: result.path,
      encoding: result.encoding,
      csvCommand: result.commandId,
      bytes: result.csv.body.length,
      checksum: result.csv.checksum,
      retrieved_at: result.csv.retrieved_at,
      // The export response's final URL, so the manifest can record which
      // document was actually fetched.
      final_url: result.csv.final_url,
      attemptsBeforeSuccess: attempts.length,
    },
  };
}

// The grid shows one of two views at a time. "Under Investigation" holds only
// the last ~24 months; everything older lives in "Archive". Both are required
// for the complete record — publishing only the recent view would present a
// two-year slice as though it were the full government record.
const ARCHIVE_PATTERN = /archive/i;

// The Archive tab is the SECOND tab of the TabView (index 0 is Under
// Investigation). The server mirrors the selected index into the TabView's
// activeIndex hidden field, so the response to a switch says which tab it
// actually selected.
const ARCHIVE_TAB_INDEX = 1;

/** Describe the server-reported tab state for a diagnostic line. */
function describeTabState(state) {
  const idx = state.activeIndex === null ? 'absent' : state.activeIndex;
  const vis = state.panelVisible === null ? 'absent' : state.panelVisible;
  return `activeIndex=${idx}, archivePanelVisible=${vis}`;
}



/**
 * Fetch every view of the breach report.
 *
 * Each view is fetched from a FRESH grid page rather than by reusing the
 * previous page's ViewState: a JSF ViewState is tied to the view it was
 * rendered for, and reusing one across a toggle is how these scrapers
 * silently end up exporting the same view twice.
 *
 * @returns {Array<{view, csv, checksum, retrieved_at, steps}>}
 */
async function fetchAllViews({ fetchImpl = politeFetch, requireArchive = true, gridPage = GRID_PAGE, label = 'hhs_ocr' } = {}) {
  const views = [];

  // View 1: whatever the grid shows by default (Under Investigation).
  const current = await fetchBreachCsv({ fetchImpl, gridPage, label });
  views.push({
    view: 'under_investigation',
    csv: current.csv,
    checksum: current.steps.checksum,
    retrieved_at: current.steps.retrieved_at,
    requested_url: gridPage,
    final_url_safe: safeUrl(current.steps.final_url),
    gridReportsEmpty: current.gridReportsEmpty,
    steps: current.steps,
  });

  // View 2: Archive. It is the second tab of a PrimeFaces TabView, loaded on
  // demand, so it needs a real tabChange postback rather than a command click.
  const jar = new CookieJar();
  const attempts = [];
  const grid = await fetchImpl(gridPage, { raw: true, jar });
  assertGridIdentity(gridPage, grid, label);
  // Discovery aid: what other portal pages exist, for locating the archive.
  const linked = jsf.linkedPages(grid.body);
  if (linked.length) console.error(`${label}: .jsf pages linked from the grid: ${linked.join(' | ')}`);

  const gridHidden = jsf.extractHiddenInputs(grid.body);
  const gridAction = new URL(jsf.extractFormAction(grid.body) || gridPage, gridPage).toString();
  const tabView = tv.findTabView(gridHidden);
  const archiveTabId = tv.findTabId(grid.body, ARCHIVE_PATTERN);
  // The archive's index in the navigation order, read from the grid page.
  const archiveTabIndex = tv.findTabIndex(grid.body, archiveTabId);

  if (!tabView || !archiveTabId) {
    const err = new Error(
      `${label}: could not locate the Archive tab on the report grid. Refusing to publish only ` +
        'the last ~24 months as though it were the complete record.\n' +
        `  tabView=${tabView ? tabView.id : 'none'} archiveTab=${archiveTabId || 'none'}\n` +
        '  JSF commands on the grid:\n' +
        jsf.listCommandCandidates(grid.body).map((c) => `    - ${c.commandId} label="${c.label}"`).join('\n') +
        '\n  .jsf pages linked from the grid:\n' +
        jsf.linkedPages(grid.body).map((l) => `    - ${l}`).join('\n')
    );
    err.archiveNotFound = true;
    if (requireArchive) throw err;
    console.error(`${label}: WARNING archive view not captured.\n${err.message}`);
    return views;
  }

  console.error(`${label}: switching to archive tab ${archiveTabId} on tabview ${tabView.id}`);

  // Two shapes of tab switch, because which one the server accepts is a
  // configuration detail: a PrimeFaces AJAX tabChange, and a plain postback.
  // The index posted is the archive's index in the navigation order, read
  // from the grid page -- not an assumed 1 -- so a reordered TabView selects
  // the tab that was actually found.
  const switchIndex = archiveTabIndex === null ? 0 : archiveTabIndex;
  const switchVariants = [
    { name: 'ajax-tabchange', fields: tv.buildTabChangeFields(gridHidden, tabView, switchIndex, archiveTabId) },
    { name: 'plain-postback', fields: tv.buildTabPostbackFields(gridHidden, tabView, switchIndex) },
  ];

  let archived = null;
  let switchEvidence = null;
  for (const variant of switchVariants) {
    const body = new URLSearchParams(variant.fields).toString();
    const res = await fetchImpl(gridAction, {
      raw: true,
      jar,
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    // The response may be a PrimeFaces partial-response XML document; unwrap it
    // so the ordinary exporter scanners work on the rendered fragment.
    const { html, viewState, isPartial } = tv.extractPartialResponse(res.body);
    const responseHidden = jsf.extractHiddenInputs(html);
    // The server reports which tab it selected. That answer does not depend on
    // how many rows came back, so it can settle a switch that the row
    // comparison cannot.
    const tabState = tv.readTabState(html, tabView, responseHidden, archiveTabId);
    // The index is the archive tab's position in the navigation order, taken
    // from the GRID page (which carries the navigation) rather than assumed,
    // so a reordered TabView cannot make the two signals contradict each
    // other forever.
    const indexSaysArchive = (tabState.activeIndex !== null && archiveTabIndex !== null)
      ? tabState.activeIndex === String(archiveTabIndex)
      : null;
    const panelSaysArchive = tabState.panelVisible === true;
    // The server renders the SELECTED tab's panel without ui-helper-hidden.
    // That is the independent signal: the activeIndex field can echo back the
    // value that was POSTED, but which panel the server chose to render
    // visible is the server's own rendering. The panel is therefore required,
    // and the index must agree with it whenever it is present.
    const signalsContradict =
      indexSaysArchive !== null && panelSaysArchive !== indexSaysArchive;
    const serverConfirmed = !signalsContradict && panelSaysArchive && indexSaysArchive !== false;
    if (tabState.panelVisible === null) {
      attempts.push(
        `archive[${variant.name}]: the response does not show the archive panel at all ` +
          `(${describeTabState(tabState)}) — a tab switch cannot be confirmed from that`
      );
      continue;
    }
    if (signalsContradict) {
      attempts.push(
        `archive[${variant.name}]: the server's own signals contradict each other ` +
          `(${describeTabState(tabState)}) — refusing to treat that as a confirmed switch`
      );
      continue;
    }
    const merged = tv.mergeViewState(responseHidden, viewState)
    const pageHidden = Object.keys(merged).length > 1 ? merged : tv.mergeViewState(gridHidden, viewState);
    // Which command is the CSV exporter is a per-render detail: the JSF client
    // ids are regenerated every time the grid is rendered, and a render can
    // carry an exporter for more than one panel. Every candidate is tried,
    // and EVERY candidate's export has to pass the DATA check below before it
    // can be accepted -- so a wrong-panel exporter cannot contribute the
    // archive.
    const csvCommands = jsf.listCommandCandidates(html)
      .filter((c) => c.isCsv)
      .map((c) => c.commandId);

    if (!csvCommands.length) {
      attempts.push(
        `archive[${variant.name}]: ${res.body.length} bytes, partial=${isPartial}, ` +
          `csvCommand=none, commands=${jsf.listCommandCandidates(html).length}, ` +
          `serverTabState=${describeTabState(tabState)}`
      );
      continue;
    }

    const exports = [];
    for (const candidate of csvCommands) {
      const attempt = await postExport({
        fetchImpl, jar, action: gridAction, hidden: pageHidden,
        commandId: candidate, attempts, label: ` ${variant.name}:${candidate}`,
      });
      if (attempt) exports.push({ commandId: candidate, ...attempt });
    }
    if (!exports.length) continue;

    // CRITICAL: prove we actually changed views. If the tab switch silently
    // failed, the export returns the under-investigation table again, and
    // publishing it labelled 'archive' would double-count the recent window
    // and still leave the history missing.
    //
    // Compare the DATA, not the raw bytes. The header row carries volatile JSF
    // object identity, so two exports of identical data are never byte-equal --
    // a raw comparison here passes on content it should reject. Observed on the
    // Part 2 report, where both views are currently empty: 208 bytes each,
    // different hashes, same (zero) rows.
    // Rows are compared by their CONTENT, with whitespace runs collapsed, so
    // that two renderings of the same record which differ only in spacing are
    // not read as two different records.
    const normaliseRow = (l) => l.trim().replace(/\s+/g, ' ');
    const recentData = dataRowsOf(views[0].csv);
    const recentRows = recentData.split('\n').map(normaliseRow).filter(Boolean);
    const recentRowSet = new Set(recentRows);

    let got = null;
    let csvCommand = null;
    let verificationBasis = null;

    for (const candidate of exports) {
      const archiveData = dataRowsOf(candidate.res.body);
      const archiveRows = archiveData.split('\n').map(normaliseRow).filter(Boolean);
      const archiveRowSet = new Set(archiveRows);
      const bothEmpty = !archiveData.trim() && !recentData.trim();
      const distinct = archiveData !== recentData;

      // The server's confirmation is required on EVERY path. A differing
      // export is not proof of the archive on its own: a different PAGE of the
      // recent table also differs, and the server's own answer about which tab
      // it selected is what rules that out.
      if (!serverConfirmed) {
        attempts.push(
          `archive[${variant.name}]: the server did not confirm the archive tab switch ` +
            `(${describeTabState(tabState)}) — a differing export is not proof of the archive`
        );
        continue;
      }

      if (bothEmpty) {
        // Two empty exports are identical whichever tab was selected, so the
        // row comparison cannot tell a genuinely empty archive from a switch
        // that never happened. The server can: it says which tab it selected
        // and which panel it left visible.
        got = candidate;
        csvCommand = candidate.commandId;
        verificationBasis = 'server-tab-state';
        break;
      }

      if (!distinct) {
        attempts.push(
          `archive[${variant.name}]: export from ${candidate.commandId} returned the same data rows ` +
            'as the under-investigation view — the tab did not actually change'
        );
        continue;
      }

      // The archive must be a genuinely different dataset from the recent
      // view, not a copy of it and not a superset of it. An export that
      // repeats the recent rows -- or the recent rows plus a breach published
      // between the two fetches -- is the RECENT table again, and publishing it
      // under the 'archive' label would double-count the recent window.
      const addsHistory = archiveRows.some((r) => !recentRowSet.has(r));
      const recentHasRowsArchiveLacks = recentRows.some((r) => !archiveRowSet.has(r));
      if (!addsHistory || !recentHasRowsArchiveLacks) {
        attempts.push(
          `archive[${variant.name}]: export from ${candidate.commandId} is not a distinct older ` +
            `dataset (addsHistory=${addsHistory}, recentHasRowsTheArchiveLacks=` +
            `${recentHasRowsArchiveLacks}) — refusing to publish the recent table as the archive`
        );
        continue;
      }

      got = candidate;
      csvCommand = candidate.commandId;
      verificationBasis = 'distinct-data-rows';
      break;
    }

    if (!got) continue;

    switchEvidence = {
      variant: variant.name,
      activeIndex: tabState.activeIndex,
      panelVisible: tabState.panelVisible,
      serverConfirmed,
      basis: verificationBasis,
    };

    archived = {
      csv: got.res,
      commandId: csvCommand,
      encoding: got.encoding,
      path: `archive[${variant.name}]`,
      gridReportsEmpty: gridReportsEmpty(html),
    };
    break;
  }

  if (!archived) {
    const err = new Error(
      `${label}: found the Archive tab but could not export distinct archived data from it. ` +
        'Refusing to publish the recent view twice under two labels. An archive view that the ' +
        'server did not confirm as selected cannot be treated as a verified archive.\n' +
        attempts.map((a) => `  - ${a}`).join('\n')
    );
    err.archiveNotFound = true;
    if (requireArchive) throw err;
    console.error(`${label}: WARNING archive view not captured.\n${err.message}`);
    return views;
  }

  views.push({
    view: 'archive',
    csv: archived.csv.body,
    checksum: archived.csv.checksum,
    retrieved_at: archived.csv.retrieved_at,
    requested_url: gridPage,
    final_url_safe: safeUrl(archived.csv.final_url),
    gridReportsEmpty: archived.gridReportsEmpty,
    // How the archive view was proven to BE the archive: distinct rows, or the
    // server's own report of the selected tab. Recorded so the distinction
    // survives into the ingest record instead of living only in a log line.
    archiveVerification: 'verified',
    archiveVerificationBasis: switchEvidence.basis,
    archiveSwitchEvidence: {
      variant: switchEvidence.variant,
      activeIndex: switchEvidence.activeIndex,
      panelVisible: switchEvidence.panelVisible,
      serverConfirmed: switchEvidence.serverConfirmed,
    },
    steps: { path: archived.path, encoding: archived.encoding, csvCommand: archived.commandId, tabId: archiveTabId, bytes: archived.csv.body.length },
  });

  return views;
}

module.exports = { fetchBreachCsv, fetchAllViews, assertGridIdentity, dataRowsOf, gridReportsEmpty, GRID_IDENTITY, CookieJar, FRONT_PAGE, GRID_PAGE, PART2_GRID_PAGE, GRID_LABEL, ARCHIVE_PATTERN, USER_AGENT };
