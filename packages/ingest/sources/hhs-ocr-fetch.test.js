const test = require('node:test');
const assert = require('node:assert');
const { fetchBreachCsv, fetchAllViews, dataRowsOf, CookieJar, GRID_PAGE, PART2_GRID_PAGE } = require('./hhs-ocr-fetch');

const FRONT = `<html><form id="ocrForm" action="/ocr/breach/breach_report.jsf;jsessionid=ABC" enctype="multipart/form-data">
<a href="#" onclick="mojarra.jsfcljs(document.getElementById('ocrForm'),{'ocrForm:j_idt39':'ocrForm:j_idt39'},'');return false">View HIPAA Breach Reports</a>
<input type="hidden" name="javax.faces.ViewState" value="VS1"></form></html>`;

// The grid carries its own column headings, which is how the page identifies
// which report it is. The real HIPAA grid renders "Name of Covered Entity";
// the real Part 2 grid renders "Name of Part 2 Program" and never mentions a
// covered entity at all. The fetcher checks for exactly that, so the fixtures
// have to carry it too.
const GRID = `<html><form id="ocrForm" action="/ocr/breach/breach_report_hip.jsf" enctype="multipart/form-data">
<span class="ui-column-title">Name of Covered Entity</span>
<a href="#" onclick="mojarra.jsfcljs(document.getElementById('ocrForm'),{'ocrForm:j_idt384':'ocrForm:j_idt384'},'');return false"><img alt="CSV" src="/i/csv.png"></a>
<input type="hidden" name="javax.faces.ViewState" value="VS2"></form></html>`;

const PART2_GRID = `<html><form id="ocrForm" action="/ocr/breach/breach_report_part2.jsf" enctype="multipart/form-data">
<h2>Part 2 Cases Currently Under Investigation</h2>
<span class="ui-column-title">Name of Part 2 Program</span>
<a href="#" onclick="mojarra.jsfcljs(document.getElementById('ocrForm'),{'ocrForm:j_idt384':'ocrForm:j_idt384'},'');return false"><img alt="CSV" src="/i/csv.png"></a>
<input type="hidden" name="javax.faces.ViewState" value="VS2"></form></html>`;

const CSV = 'Name of Covered Entity,State\nAcme Clinic,CA\n';
// What JSF returns when a postback is encoded in a way it does not decode:
// HTTP 200, re-rendered view, no error.
const RERENDER = '<html><body><p>re-rendered view, no commands</p></body></html>';

/**
 * Mock portal. `acceptEncoding` names the ONE encoding the server decodes;
 * every other encoding gets the silent 200-with-HTML re-render, which is the
 * real failure mode this fetcher exists to survive.
 */
function mockPortal({
  acceptEncoding = 'multipart',
  directGrid = GRID,
  frontBody = FRONT,
  navGrid = GRID,
  csvBody = CSV,
  // Optional per-response provenance, keyed by the kind of response:
  //   grid | front | nav | export | rerender
  // Each carries its own {checksum, retrieved_at}. The defaults below keep the
  // original single 'T' placeholder for every response, so tests that do not
  // care about provenance are unaffected.
  stamps = null,
} = {}) {
  const calls = [];
  const stamp = (kind, fallback) => (stamps && stamps[kind]) || fallback;
  const impl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const ct = (opts.headers && opts.headers['Content-Type']) || '';
    const enc = ct.startsWith('multipart/') ? 'multipart' : String(opts.body || '').includes('javax.faces.partial.ajax') ? 'ajax' : 'urlencoded';
    calls.push({ url, method, enc, body: opts.body });

    if (method === 'GET') {
      // Either report's grid address serves `directGrid`; anything else is the
      // front page. Both listings are the same application at two addresses.
      const isGrid = url.includes('breach_report_hip.jsf') || url.includes('breach_report_part2.jsf');
      return {
        body: isGrid ? directGrid : frontBody,
        ...stamp(isGrid ? 'grid' : 'front', { checksum: 'c0', retrieved_at: 'T' }),
      };
    }
    if (enc !== acceptEncoding) {
      return { body: RERENDER, ...stamp('rerender', { checksum: 'x', retrieved_at: 'T' }) };
    }
    // A navigation postback returns the grid; an export postback returns CSV.
    const isExport = String(opts.body || '').includes('j_idt384');
    return {
      body: isExport ? csvBody : navGrid,
      ...stamp(isExport ? 'export' : 'nav', { checksum: 'c9', retrieved_at: 'T' }),
    };
  };
  return { impl, calls };
}

test('primary path: direct grid, multipart export, two requests', async () => {
  const { impl, calls } = mockPortal();
  const { csv, steps } = await fetchBreachCsv({ fetchImpl: impl });
  assert.equal(csv, CSV);
  assert.equal(steps.path, 'direct-grid');
  assert.equal(steps.encoding, 'multipart');
  assert.equal(steps.csvCommand, 'ocrForm:j_idt384');
  assert.equal(calls.length, 2);
});

test('falls through to urlencoded when the server rejects multipart', async () => {
  const { impl, calls } = mockPortal({ acceptEncoding: 'urlencoded' });
  const { csv, steps } = await fetchBreachCsv({ fetchImpl: impl });
  assert.equal(csv, CSV);
  assert.equal(steps.encoding, 'urlencoded');
  // multipart attempted first, then urlencoded succeeded
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.enc).slice(0, 2), ['multipart', 'urlencoded']);
});

test('falls through to the AJAX variant when only that is decoded', async () => {
  const { impl } = mockPortal({ acceptEncoding: 'ajax' });
  const { csv, steps } = await fetchBreachCsv({ fetchImpl: impl });
  assert.equal(csv, CSV);
  assert.equal(steps.encoding, 'ajax');
});

test('a 200-with-HTML re-render is treated as failure, never as success', async () => {
  // No encoding is accepted: every POST returns HTTP 200 with markup.
  const { impl } = mockPortal({ acceptEncoding: 'none-of-them' });
  await assert.rejects(
    () => fetchBreachCsv({ fetchImpl: impl }),
    (err) => {
      assert.match(err.message, /could not obtain the CSV export by any path or encoding/);
      assert.match(err.message, /not CSV/);
      return true;
    }
  );
});

test('falls back to front-page navigation when the direct grid has no exporter', async () => {
  const { impl, calls } = mockPortal({ directGrid: '<html><body>Covered Entity chrome only, no exporter</body></html>' });
  const { csv, steps } = await fetchBreachCsv({ fetchImpl: impl });
  assert.equal(csv, CSV);
  assert.match(steps.path, /^front-nav/);
  assert.ok(calls.some((c) => c.url.includes('breach_report.jsf')));
});

test('refuses to click a non-CSV exporter rather than downloading the wrong format', async () => {
  const xlsOnly = GRID.replace('alt="CSV" src="/i/csv.png"', 'alt="XLS" src="/i/excel.png"');
  const { impl } = mockPortal({ directGrid: xlsOnly, navGrid: xlsOnly, frontBody: '<html><body>none</body></html>' });
  await assert.rejects(() => fetchBreachCsv({ fetchImpl: impl }), /csvCommand=none/);
});

test('identifies the CSV icon by filename when alt is absent', async () => {
  const noAlt = GRID.replace('alt="CSV" ', '');
  const { impl } = mockPortal({ directGrid: noAlt });
  const { steps } = await fetchBreachCsv({ fetchImpl: impl });
  assert.equal(steps.csvCommand, 'ocrForm:j_idt384');
});

test('multipart body carries the ViewState and the command id', async () => {
  const { impl, calls } = mockPortal();
  await fetchBreachCsv({ fetchImpl: impl });
  const post = calls.find((c) => c.method === 'POST');
  assert.match(post.body, /name="javax\.faces\.ViewState"[\s\S]*VS2/);
  assert.match(post.body, /name="ocrForm:j_idt384"/);
});

test('error message enumerates every attempt for diagnosis', async () => {
  const { impl } = mockPortal({ acceptEncoding: 'none', directGrid: '<html>Covered Entity x</html>', frontBody: '<html>y</html>' });
  await assert.rejects(
    () => fetchBreachCsv({ fetchImpl: impl }),
    (err) => {
      assert.match(err.message, /direct-grid:/);
      assert.match(err.message, /front-page:/);
      return true;
    }
  );
});

test('cookie jar absorbs and replays Set-Cookie', () => {
  const jar = new CookieJar();
  jar.absorb({ headers: { getSetCookie: () => ['JSESSIONID=XYZ; Path=/; HttpOnly', 'other=1; Path=/'] } });
  const header = jar.header();
  assert.match(header, /JSESSIONID=XYZ/);
  assert.match(header, /other=1/);
  assert.ok(!header.includes('HttpOnly'));
});


// Grid as the live portal renders it: a PrimeFaces TabView whose second tab is
// the archive, plus the CSV exporter for the currently active tab.
const TABBED_GRID = `<html><form id="ocrForm" action="/ocr/breach/breach_report_hip.jsf" enctype="multipart/form-data">
<span class="ui-column-title">Name of Covered Entity</span>
<ul class="ui-tabs-nav">
  <li><a href="#ocrForm:j_idt31:underInvTab" tabindex="-1">Under Investigation</a></li>
  <li><a href="#ocrForm:j_idt31:archiveTab" tabindex="-1">Archive</a></li>
</ul>
<a href="#" onclick="mojarra.jsfcljs(document.getElementById('ocrForm'),{'ocrForm:j_idt400':'ocrForm:j_idt400'},'');return false"><img alt="CSV" src="/i/csv.png"></a>
<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="0">
<input type="hidden" name="javax.faces.ViewState" value="VS-GRID"></form></html>`;

// PrimeFaces partial-response returned by a successful tabChange, carrying the
// archive tab's own exporter and a fresh ViewState.
const ARCHIVE_PARTIAL =
  '<?xml version="1.0"?><partial-response><changes>' +
  '<update id="ocrForm:j_idt31"><![CDATA[<div>' +
  '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt500\':\'x\'},\'\')">' +
  '<img alt="CSV" src="/i/csv.png"></a></div>]]></update>' +
  '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-ARCHIVE]]></update>' +
  '</changes></partial-response>';

const ARCHIVE_CSV = 'Name of Covered Entity,State\nOld Clinic,NY\n';

/**
 * Two-view portal. `archiveWorks` controls whether the tabChange actually
 * switches views; when false the archive export returns the SAME rows as the
 * recent view, which is the silent failure the implementation must catch.
 */
function mockTabbedPortal({ archiveWorks = true, tabbed = TABBED_GRID, stamps = null } = {}) {
  const calls = [];
  const stamp = (kind, fallback) => (stamps && stamps[kind]) || fallback;
  const impl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = String(opts.body || '');
    calls.push({ url, method, body });
    if (method === 'GET') return { body: tabbed, ...stamp('grid', { checksum: 'g', retrieved_at: 'T' }) };
    if (body.includes('tabChange') || body.includes('_activeIndex=1')) {
      return { body: ARCHIVE_PARTIAL, ...stamp('partial', { checksum: 'p', retrieved_at: 'T' }) };
    }
    if (body.includes('j_idt500')) {
      return {
        body: archiveWorks ? ARCHIVE_CSV : CSV,
        ...stamp('archiveExport', { checksum: 'a', retrieved_at: 'T' }),
      };
    }
    if (body.includes('j_idt400')) {
      return { body: CSV, ...stamp('currentExport', { checksum: 'c', retrieved_at: 'T' }) };
    }
    return { body: '<html>unexpected</html>', ...stamp('other', { checksum: 'x', retrieved_at: 'T' }) };
  };
  return { impl, calls };
}

test('switches the TabView to reach the archive and exports it', async () => {
  const { impl } = mockTabbedPortal();
  const views = await fetchAllViews({ fetchImpl: impl });
  assert.equal(views.length, 2);
  assert.equal(views[0].view, 'under_investigation');
  assert.equal(views[0].csv, CSV);
  assert.equal(views[1].view, 'archive');
  assert.equal(views[1].csv, ARCHIVE_CSV);
  assert.equal(views[1].steps.tabId, 'ocrForm:j_idt31:archiveTab');
});

test('uses the ViewState from the partial-response, not the stale grid token', async () => {
  const { impl, calls } = mockTabbedPortal();
  await fetchAllViews({ fetchImpl: impl });
  const exportPost = calls.find((c) => c.body && c.body.includes('j_idt500'));
  assert.ok(exportPost, 'archive export was never posted');
  assert.match(exportPost.body, /VS-ARCHIVE/);
  assert.ok(!exportPost.body.includes('VS-GRID'), 'stale ViewState was reused');
});

test('rejects an archive export that returns the same rows as the recent view', async () => {
  // The tab silently failed to change: the export succeeds but the content is
  // identical. Publishing that as 'archive' would double-count the recent
  // window and still leave the history missing.
  const { impl } = mockTabbedPortal({ archiveWorks: false });
  await assert.rejects(
    () => fetchAllViews({ fetchImpl: impl }),
    /byte-identical content to the under-investigation view|could not export distinct archived data/
  );
});

test('fails loudly when the grid carries no Archive tab', async () => {
  const noTab = TABBED_GRID.replace(/<li><a href="#ocrForm:j_idt31:archiveTab[\s\S]*?<\/li>/, '');
  const { impl } = mockTabbedPortal({ tabbed: noTab });
  await assert.rejects(
    () => fetchAllViews({ fetchImpl: impl }),
    /could not locate the Archive tab[\s\S]*Refusing to publish/
  );
});

test('coverage=current downgrades a missing archive tab to a warning', async () => {
  const noTab = TABBED_GRID.replace(/<li><a href="#ocrForm:j_idt31:archiveTab[\s\S]*?<\/li>/, '');
  const { impl } = mockTabbedPortal({ tabbed: noTab });
  const views = await fetchAllViews({ fetchImpl: impl, requireArchive: false });
  assert.equal(views.length, 1);
  assert.equal(views[0].view, 'under_investigation');
});

// --- Report identity -------------------------------------------------------
// OCR runs two breach listings in one application. The failure that matters is
// not a 404 -- politeFetch already throws on those -- it is being handed the
// OTHER report's data and publishing it under this one's regime.

test('refuses a grid that does not identify itself as the report we asked for', async () => {
  const { impl } = mockPortal({ directGrid: PART2_GRID, navGrid: PART2_GRID, frontBody: '<html>x</html>' });
  await assert.rejects(
    () => fetchBreachCsv({ fetchImpl: impl, gridPage: GRID_PAGE }),
    /does not identify itself as the expected report/
  );
});

test('refuses the HIPAA grid served at the Part 2 address', async () => {
  // The exact contamination the front page was observed to cause: a Part 2
  // request answered with HIPAA content. Publishing that would label ~7,760
  // HIPAA breaches as substance use disorder treatment records.
  const impl = async () => ({ body: GRID, checksum: 'c', retrieved_at: 'T' });
  await assert.rejects(
    () => fetchBreachCsv({ fetchImpl: impl, gridPage: PART2_GRID_PAGE, label: 'hhs_part2' }),
    /hhs_part2:.*does not identify itself as the expected report/
  );
});

test('refuses a response that came from a different path than the one requested', async () => {
  const impl = async () => ({
    body: GRID,
    checksum: 'c',
    retrieved_at: 'T',
    final_url: 'https://ocrportal.hhs.gov/ocr/breach/wizard_breach_hip.jsf',
    redirected: true,
  });
  await assert.rejects(
    () => fetchBreachCsv({ fetchImpl: impl, gridPage: PART2_GRID_PAGE, label: 'hhs_part2' }),
    /requested .*breach_report_part2\.jsf but the response came from .*wizard_breach_hip\.jsf/
  );
});

test('accepts the Part 2 grid at the Part 2 address', async () => {
  const { impl } = mockPortal({ directGrid: PART2_GRID, csvBody: 'Name of Part 2 Program,State\nX,OR\n' });
  const { csv } = await fetchBreachCsv({ fetchImpl: impl, gridPage: PART2_GRID_PAGE, label: 'hhs_part2' });
  assert.match(csv, /Name of Part 2 Program/);
});

test('a Part 2 run never requests the HIPAA grid or the front page', async () => {
  const seen = [];
  const { impl } = mockPortal({ directGrid: PART2_GRID });
  const wrapped = async (url, opts) => { seen.push(url); return impl(url, opts); };
  await fetchBreachCsv({ fetchImpl: wrapped, gridPage: PART2_GRID_PAGE, label: 'hhs_part2' });
  assert.ok(!seen.some((u) => u.includes('breach_report_hip.jsf')), `requested the HIPAA grid: ${seen}`);
  assert.ok(!seen.some((u) => u.includes('breach_report.jsf')), `fell through to the front page: ${seen}`);
});

// --- The archive guard compares data, not bytes ----------------------------

test('dataRowsOf ignores the header, which carries volatile JSF object identity', () => {
  // Two exports of the same (empty) table, seconds apart, on the live Part 2
  // report. Byte-different, data-identical. A raw byte comparison passes here
  // and would wave through an archive export that never changed views.
  const a = '"javax.faces.component.UIPanel@3c159259","State"\n';
  const b = '"javax.faces.component.UIPanel@68d89e44","State"\n';
  assert.notEqual(a, b);
  assert.equal(dataRowsOf(a), dataRowsOf(b));
});

test('does not mistake two legitimately empty views for a failed tab switch', async () => {
  // The live Part 2 listing: no records in either view. Identical data rows is
  // the correct outcome here, not evidence the tab failed to change.
  const EMPTY = '"javax.faces.component.UIPanel@aaa","State"\n';
  const EMPTY2 = '"javax.faces.component.UIPanel@bbb","State"\n';
  const grid = TABBED_GRID.replace(
    '<ul class="ui-tabs-nav">',
    '<tr class="ui-datatable-empty-message"><td>No records found.</td></tr><ul class="ui-tabs-nav">'
  );
  let exports = 0;
  const impl = async (url, opts = {}) => {
    const body = String(opts.body || '');
    if ((opts.method || 'GET') === 'GET') return { body: grid, checksum: 'g', retrieved_at: 'T' };
    if (body.includes('tabChange') || body.includes('_activeIndex=1')) {
      return { body: ARCHIVE_PARTIAL, checksum: 'p', retrieved_at: 'T' };
    }
    return { body: exports++ === 0 ? EMPTY : EMPTY2, checksum: `c${exports}`, retrieved_at: 'T' };
  };
  const views = await fetchAllViews({ fetchImpl: impl, gridPage: GRID_PAGE });
  assert.equal(views.length, 2, 'the archive view should be accepted, not rejected');
  assert.equal(views[1].view, 'archive');
});

test('still rejects a failed tab switch when the views actually hold rows', async () => {
  const { impl } = mockTabbedPortal({ archiveWorks: false });
  await assert.rejects(() => fetchAllViews({ fetchImpl: impl }), /could not export distinct archived data/);
});

// --- Retrieval provenance through the HHS path -----------------------------
//
// The retrieval instant and the checksum are the evidence that a record set
// came from a particular export at a particular moment. The HHS path makes
// SEVERAL requests before it gets one: the grid page, sometimes the front
// page, sometimes a navigation postback, possibly several failed export
// encodings, and finally the export that actually returned CSV.
//
// The instant and checksum that reach the caller must come from that LAST
// request -- the one that produced the bytes being published -- and from
// nowhere else. A timestamp taken from the preliminary HTML request would
// describe a page, not the data; a timestamp taken from a FAILED export
// attempt would describe an encoding the server refused to decode.
//
// Before this section every mock portal returned the same placeholder for
// every response, so nothing checked which response the provenance came from.

const CANONICAL_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('records the CSV export\'s retrieved_at and checksum, not the grid page\'s', async () => {
  const { impl } = mockPortal({
    stamps: {
      grid:   { checksum: 'grid-checksum',   retrieved_at: '2026-10-25T12:00:00.000Z' },
      export: { checksum: 'export-checksum', retrieved_at: '2026-10-25T12:00:00.750Z' },
      front:  { checksum: 'front-checksum',  retrieved_at: '2026-10-25T12:00:01.000Z' },
    },
  });
  const { steps } = await fetchBreachCsv({ fetchImpl: impl });
  assert.equal(steps.retrieved_at, '2026-10-25T12:00:00.750Z');
  assert.equal(steps.checksum, 'export-checksum');
  assert.notEqual(steps.retrieved_at, '2026-10-25T12:00:00.000Z', 'must not be the grid page\'s instant');
  assert.match(steps.retrieved_at, CANONICAL_ISO_UTC);
});

test('a failed export attempt\'s instant is never the one recorded', async () => {
  // The multipart encoding is refused by the server (the silent 200-with-HTML
  // re-render), so the fetcher falls through to urlencoded. The refused
  // attempt has its own instant; the recorded one must be the successful
  // export's.
  const { impl } = mockPortal({
    acceptEncoding: 'urlencoded',
    stamps: {
      rerender: { checksum: 'rerender-checksum', retrieved_at: '2026-10-25T12:00:00.250Z' },
      export:   { checksum: 'export-checksum',   retrieved_at: '2026-10-25T12:00:00.750Z' },
    },
  });
  const { steps } = await fetchBreachCsv({ fetchImpl: impl });
  assert.equal(steps.encoding, 'urlencoded');
  assert.equal(steps.retrieved_at, '2026-10-25T12:00:00.750Z');
  assert.equal(steps.checksum, 'export-checksum');
  assert.notEqual(steps.retrieved_at, '2026-10-25T12:00:00.250Z', 'must not be the failed attempt\'s instant');
});

test('the front-page fallback records the CSV export\'s instant, not the front page\'s', async () => {
  // The direct grid has no exporter, so the fetcher navigates from the front
  // page and exports from there. Three different requests happen on the way;
  // the recorded provenance must be the export's.
  const { impl } = mockPortal({
    directGrid: '<html><body>Covered Entity chrome only, no exporter</body></html>',
    stamps: {
      grid:   { checksum: 'grid-checksum',   retrieved_at: '2026-10-25T12:00:00.000Z' },
      front:  { checksum: 'front-checksum',  retrieved_at: '2026-10-25T12:00:01.000Z' },
      nav:    { checksum: 'nav-checksum',    retrieved_at: '2026-10-25T12:00:02.000Z' },
      export: { checksum: 'export-checksum', retrieved_at: '2026-10-25T12:00:03.000Z' },
    },
  });
  const { steps } = await fetchBreachCsv({ fetchImpl: impl });
  assert.match(steps.path, /^front-nav/);
  assert.equal(steps.retrieved_at, '2026-10-25T12:00:03.000Z');
  assert.equal(steps.checksum, 'export-checksum');
});

test('each view carries its own export\'s retrieval instant and checksum', async () => {
  const { impl } = mockTabbedPortal({
    stamps: {
      grid:          { checksum: 'grid-c',          retrieved_at: '2026-10-25T12:00:00.000Z' },
      partial:       { checksum: 'partial-c',       retrieved_at: '2026-10-25T12:00:01.000Z' },
      currentExport: { checksum: 'current-export-c', retrieved_at: '2026-10-25T12:00:02.000Z' },
      archiveExport: { checksum: 'archive-export-c', retrieved_at: '2026-10-25T12:00:03.000Z' },
    },
  });
  const views = await fetchAllViews({ fetchImpl: impl });
  assert.equal(views.length, 2);

  assert.equal(views[0].view, 'under_investigation');
  assert.equal(views[0].retrieved_at, '2026-10-25T12:00:02.000Z');
  assert.equal(views[0].checksum, 'current-export-c');
  assert.match(views[0].retrieved_at, CANONICAL_ISO_UTC);

  assert.equal(views[1].view, 'archive');
  assert.equal(views[1].retrieved_at, '2026-10-25T12:00:03.000Z');
  assert.equal(views[1].checksum, 'archive-export-c');
  assert.match(views[1].retrieved_at, CANONICAL_ISO_UTC);

  // Neither view may be stamped with the grid page's instant.
  assert.notEqual(views[0].retrieved_at, '2026-10-25T12:00:00.000Z');
  assert.notEqual(views[1].retrieved_at, '2026-10-25T12:00:00.000Z');
});

test('a view that falls back to coverage=current keeps the export\'s instant', async () => {
  // coverage=current: the archive tab is absent, so only the recent view is
  // returned. The provenance of that one view still has to be the export's.
  const noTab = TABBED_GRID.replace(/<li><a href="#ocrForm:j_idt31:archiveTab[\s\S]*?<\/li>/, '');
  const { impl } = mockTabbedPortal({
    tabbed: noTab,
    stamps: {
      grid:          { checksum: 'grid-c',          retrieved_at: '2026-10-25T12:00:00.000Z' },
      currentExport: { checksum: 'current-export-c', retrieved_at: '2026-10-25T12:00:02.000Z' },
    },
  });
  const views = await fetchAllViews({ fetchImpl: impl, requireArchive: false });
  assert.equal(views.length, 1);
  assert.equal(views[0].view, 'under_investigation');
  assert.equal(views[0].retrieved_at, '2026-10-25T12:00:02.000Z');
  assert.equal(views[0].checksum, 'current-export-c');
});

test('an explained empty export still carries its retrieval instant', async () => {
  // The grid says it holds no records. That is an EXPLANATION for an empty
  // result, not a retrieval failure -- the export succeeded, so it has a
  // real instant and a real checksum, and the caller can tell the two cases
  // apart.
  const emptyGrid = TABBED_GRID.replace(
    '<ul class="ui-tabs-nav">',
    '<tr class="ui-datatable-empty-message"><td>No records found.</td></tr><ul class="ui-tabs-nav">'
  );
  const { impl } = mockTabbedPortal({
    tabbed: emptyGrid,
    stamps: {
      grid:          { checksum: 'grid-c',          retrieved_at: '2026-10-25T12:00:00.000Z' },
      currentExport: { checksum: 'current-export-c', retrieved_at: '2026-10-25T12:00:02.000Z' },
    },
  });
  const views = await fetchAllViews({ fetchImpl: impl });
  assert.equal(views[0].gridReportsEmpty, true);
  assert.equal(views[0].retrieved_at, '2026-10-25T12:00:02.000Z');
  assert.equal(views[0].checksum, 'current-export-c');
});

test('a retrieval failure produces no instant at all', async () => {
  // The contrast case: when no export could be obtained, there is nothing to
  // timestamp. The failure must not manufacture a provenance record.
  const { impl } = mockPortal({ acceptEncoding: 'none-of-them' });
  await assert.rejects(
    () => fetchBreachCsv({ fetchImpl: impl }),
    /could not obtain the CSV export by any path or encoding/,
  );
});
