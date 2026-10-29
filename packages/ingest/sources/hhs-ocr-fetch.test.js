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
  '<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="1">' +
  '<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom">' +
  '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt500\':\'x\'},\'\')">' +
  '<img alt="CSV" src="/i/csv.png"></a></div></div>]]></update>' +
  '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-ARCHIVE]]></update>' +
  '</changes></partial-response>';

// The same switch, but the server's response does NOT say the Archive tab was
// selected: the activeIndex still reads 0 and the Archive panel is still
// hidden. A switch that did not take. The row data alone cannot tell this
// apart from an archive that is genuinely empty, which is exactly why the
// server's own answer is consulted.
const UNCONFIRMED_PARTIAL =
  '<?xml version="1.0"?><partial-response><changes>' +
  '<update id="ocrForm:j_idt31"><![CDATA[<div>' +
  '<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="0">' +
  '<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom ui-helper-hidden">' +
  '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt500\':\'x\'},\'\')">' +
  '<img alt="CSV" src="/i/csv.png"></a></div></div>]]></update>' +
  '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-ARCHIVE]]></update>' +
  '</changes></partial-response>';

const ARCHIVE_CSV = 'Name of Covered Entity,State\nOld Clinic,NY\n';

/**
 * Two-view portal. `archiveWorks` controls whether the tabChange actually
 * switches views; when false the archive export returns the SAME rows as the
 * recent view, which is the silent failure the implementation must catch.
 */
function mockTabbedPortal({ archiveWorks = true, tabbed = TABBED_GRID, stamps = null, archivePartial = ARCHIVE_PARTIAL } = {}) {
  const calls = [];
  const stamp = (kind, fallback) => (stamps && stamps[kind]) || fallback;
  const impl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const body = String(opts.body || '');
    calls.push({ url, method, body });
    if (method === 'GET') return { body: tabbed, ...stamp('grid', { checksum: 'g', retrieved_at: 'T' }) };
    if (body.includes('tabChange') || body.includes('_activeIndex=1')) {
      return { body: archivePartial, ...stamp('partial', { checksum: 'p', retrieved_at: 'T' }) };
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

/**
 * A portal whose BOTH views are empty -- the live Part 2 listing.
 * `switchPartial` decides what the server says about the tab switch.
 */
function emptyViewsPortal({ switchPartial = ARCHIVE_PARTIAL } = {}) {
  const EMPTY = '"javax.faces.component.UIPanel@aaa","State"\n';
  const EMPTY2 = '"javax.faces.component.UIPanel@bbb","State"\n';
  const grid = TABBED_GRID.replace(
    '<ul class="ui-tabs-nav">',
    '<tr class="ui-datatable-empty-message"><td>No records found.</td></tr><ul class="ui-tabs-nav">'
  );
  let exports = 0;
  return async (url, opts = {}) => {
    const body = String(opts.body || '');
    if ((opts.method || 'GET') === 'GET') return { body: grid, checksum: 'g', retrieved_at: 'T' };
    if (body.includes('tabChange') || body.includes('_activeIndex=1')) {
      return { body: switchPartial.replace('<img alt="CSV"', '<span class="ui-datatable-empty-message">No records found.</span><img alt="CSV"'), checksum: 'p', retrieved_at: 'T' };
    }
    return { body: exports++ === 0 ? EMPTY : EMPTY2, checksum: `c${exports}`, retrieved_at: 'T' };
  };
}

test('does not mistake two legitimately empty views for a failed tab switch', async () => {
  // The live Part 2 listing: no records in either view. Identical data rows is
  // the correct outcome here, not evidence the tab failed to change.
  const impl = emptyViewsPortal();
  const views = await fetchAllViews({ fetchImpl: impl, gridPage: GRID_PAGE });
  assert.equal(views.length, 2, 'the archive view should be accepted, not rejected');
  assert.equal(views[1].view, 'archive');
});

test('a legitimately empty archive is VERIFIED when the server confirms the switch', async () => {
  // Two empty exports are identical whichever tab was selected, so the row
  // comparison cannot settle it. The server can: its response says which tab
  // it selected. That makes an empty archive a VERIFIED empty archive rather
  // than an unverified selection.
  const impl = emptyViewsPortal();
  const views = await fetchAllViews({ fetchImpl: impl, gridPage: GRID_PAGE });
  assert.equal(views.length, 2);
  assert.equal(views[1].view, 'archive');
  assert.equal(views[1].archiveVerification, 'verified');
  assert.equal(views[1].archiveVerificationBasis, 'server-tab-state');
  assert.equal(views[1].archiveSwitchEvidence.serverConfirmed, true);
  assert.equal(views[1].archiveSwitchEvidence.activeIndex, '1');
  assert.equal(views[1].archiveSwitchEvidence.panelVisible, true);
});

test('an empty listing is REFUSED when the server does not confirm the switch', async () => {
  // The rows are identical and empty, and the server did not report the
  // Archive tab as selected. Nothing distinguishes this from a switch that
  // never happened, so it must not be published as an archive.
  const impl = emptyViewsPortal({ switchPartial: UNCONFIRMED_PARTIAL });
  await assert.rejects(
    () => fetchAllViews({ fetchImpl: impl, gridPage: GRID_PAGE }),
    /did not confirm the archive tab switch/
  );
});

test('coverage=current does not publish an unconfirmed archive view', async () => {
  // An unverified response must never be relabelled as an archive, even when
  // the archive is not required.
  const impl = emptyViewsPortal({ switchPartial: UNCONFIRMED_PARTIAL });
  const views = await fetchAllViews({ fetchImpl: impl, gridPage: GRID_PAGE, requireArchive: false });
  assert.equal(views.length, 1, 'only the recent view may be published');
  assert.equal(views[0].view, 'under_investigation');
  assert.equal(views.some((v) => v.view === 'archive'), false);
});

test('an archive whose rows differ from the recent view is verified by the rows themselves', async () => {
  const { impl } = mockTabbedPortal({ archiveWorks: true });
  const views = await fetchAllViews({ fetchImpl: impl });
  assert.equal(views[1].view, 'archive');
  assert.equal(views[1].archiveVerification, 'verified');
  assert.equal(views[1].archiveVerificationBasis, 'distinct-data-rows');
});

test('a differing export is refused when the server did not confirm the switch', async () => {
  // The panel is hidden, so the server did not select the Archive tab. The
  // rows differ, but a different PAGE of the recent table also differs: no
  // row comparison can stand in for the server's own answer.
  const hiddenPanel =
    '<?xml version="1.0"?><partial-response><changes>' +
    '<update id="ocrForm:j_idt31"><![CDATA[<div>' +
    '<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="1">' +
    '<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom ui-helper-hidden">' +
    '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt500\':\'x\'},\'\')">' +
    '<img alt="CSV" src="/i/csv.png"></a></div></div>]]></update>' +
    '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-ARCHIVE]]></update>' +
    '</changes></partial-response>';
  const { impl } = mockTabbedPortal({ archiveWorks: true, archivePartial: hiddenPanel });
  await assert.rejects(
    () => fetchAllViews({ fetchImpl: impl }),
    /the server did not confirm the archive tab switch|the server's own signals contradict each other/
  );
});

test('the switch request posts the index the archive actually occupies', async () => {
  // The archive is found by its label, so the index posted with the switch has
  // to come from the navigation order. A hardcoded 1 would select the wrong
  // tab on a reordered TabView.
  const reordered = TABBED_GRID.replace(
    '<ul class="ui-tabs-nav">\n  <li><a href="#ocrForm:j_idt31:underInvTab" tabindex="-1">Under Investigation</a></li>\n  <li><a href="#ocrForm:j_idt31:archiveTab" tabindex="-1">Archive</a></li>\n</ul>',
    '<ul class="ui-tabs-nav">\n  <li><a href="#ocrForm:j_idt31:archiveTab" tabindex="-1">Archive</a></li>\n  <li><a href="#ocrForm:j_idt31:underInvTab" tabindex="-1">Under Investigation</a></li>\n</ul>'
  );
  assert.notEqual(reordered, TABBED_GRID, 'the reordered grid fixture must differ');
  const bodies = [];
  const { impl } = mockTabbedPortal({ archiveWorks: true, tabbed: reordered });
  const wrapped = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'POST') bodies.push(String(opts.body || ''));
    return impl(url, opts);
  };
  await fetchAllViews({ fetchImpl: wrapped }).catch(() => {});
  assert.ok(bodies.length > 0, 'a switch must have been posted');
  assert.ok(
    bodies.some((b) => b.includes('activeIndex=0')),
    `the switch must post the archive's real index (0), bodies: ${bodies.join(' | ')}`
  );
  assert.ok(
    !bodies.some((b) => b.includes('activeIndex=1')),
    `the switch must not post a hardcoded index of 1, bodies: ${bodies.join(' | ')}`
  );
});

// --- The signals and the data both have to agree ---------------------------

test('a switch whose signals contradict each other is refused', async () => {
  // The activeIndex says the Archive tab is selected, but the server left the
  // Archive panel hidden. The response contradicts itself, so it confirms
  // nothing.
  const contradictory =
    '<?xml version="1.0"?><partial-response><changes>' +
    '<update id="ocrForm:j_idt31"><![CDATA[<div>' +
    '<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="1">' +
    '<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom ui-helper-hidden">' +
    '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt500\':\'x\'},\'\')">' +
    '<img alt="CSV" src="/i/csv.png"></a></div></div>]]></update>' +
    '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-ARCHIVE]]></update>' +
    '</changes></partial-response>';
  const impl = emptyViewsPortal({ switchPartial: contradictory });
  await assert.rejects(
    () => fetchAllViews({ fetchImpl: impl, gridPage: GRID_PAGE }),
    /contradict each other/
  );
});

test('a response that does not show the archive panel cannot confirm the switch', async () => {
  // The index field alone can be an echo of the value that was posted. The
  // panel's visibility is the server's own rendering, so without it there is
  // nothing independent to confirm on.
  const noPanel =
    '<?xml version="1.0"?><partial-response><changes>' +
    '<update id="ocrForm:j_idt31"><![CDATA[<div>' +
    '<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="1">' +
    '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt500\':\'x\'},\'\')">' +
    '<img alt="CSV" src="/i/csv.png"></a></div>]]></update>' +
    '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-ARCHIVE]]></update>' +
    '</changes></partial-response>';
  const impl = emptyViewsPortal({ switchPartial: noPanel });
  await assert.rejects(
    () => fetchAllViews({ fetchImpl: impl, gridPage: GRID_PAGE }),
    /does not show the archive panel/
  );
});

test('an archive that is a superset of the recent view is refused', async () => {
  // The export returned the recent rows PLUS a breach published between the
  // two fetches. The rows differ, so a difference check would pass it -- but
  // it is the RECENT table again, and publishing it as the archive would
  // double-count the recent window.
  const SUPERSET = 'Name of Covered Entity,State\nAcme Clinic,CA\nNew Clinic,NY\n';
  const { impl } = mockTabbedPortal({ archiveWorks: true });
  const wrapped = async (url, opts = {}) => {
    const res = await impl(url, opts);
    if (res.body === ARCHIVE_CSV) return { ...res, body: SUPERSET };
    return res;
  };
  await assert.rejects(
    () => fetchAllViews({ fetchImpl: wrapped }),
    /not a distinct older dataset/
  );
});

test('an ambiguous response with two exporters, neither of which passes, is refused', async () => {
  // Two CSV exporters, and NEITHER export is a distinct older dataset. There
  // is no basis for choosing between them, so the archive is refused rather
  // than one of them being picked.
  const twoExporters =
    '<?xml version="1.0"?><partial-response><changes>' +
    '<update id="ocrForm:j_idt31"><![CDATA[<div>' +
    '<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="1">' +
    '<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom">' +
    '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt500\':\'x\'},\'\')">' +
    '<img alt="CSV" src="/i/csv.png"></a>' +
    '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt501\':\'x\'},\'\')">' +
    '<img alt="CSV" src="/i/csv.png"></a></div></div>]]></update>' +
    '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-ARCHIVE]]></update>' +
    '</changes></partial-response>';
  const impl = async (url, opts = {}) => {
    const body = String(opts.body || '');
    if ((opts.method || 'GET') === 'GET') {
      return { body: TABBED_GRID, checksum: 'g', retrieved_at: 'T' };
    }
    if (body.includes('tabChange') || body.includes('_activeIndex=1')) {
      return { body: twoExporters, checksum: 'p', retrieved_at: 'T' };
    }
    // BOTH exporters return the recent view: neither is a distinct older dataset.
    return { body: CSV, checksum: 'c', retrieved_at: 'T' };
  };
  await assert.rejects(
    () => fetchAllViews({ fetchImpl: impl }),
    /not a distinct older dataset|same data rows/
  );
});

test('a wrong-panel exporter is rejected while a correct one is accepted', async () => {  // Two CSV exporters in the switch response: the first exports the RECENT
  // table (a superset of it), the second exports the real archive. The wrong
  // one must not become the archive.
  const twoExporters =
    '<?xml version="1.0"?><partial-response><changes>' +
    '<update id="ocrForm:j_idt31"><![CDATA[<div>' +
    '<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="1">' +
    '<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom">' +
    '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt500\':\'x\'},\'\')">' +
    '<img alt="CSV" src="/i/csv.png"></a>' +
    '<a onclick="mojarra.jsfcljs(document.getElementById(\'ocrForm\'),{\'ocrForm:j_idt501\':\'x\'},\'\')">' +
    '<img alt="CSV" src="/i/csv.png"></a></div></div>]]></update>' +
    '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-ARCHIVE]]></update>' +
    '</changes></partial-response>';
  const SUPERSET = 'Name of Covered Entity,State\nAcme Clinic,CA\nNew Clinic,NY\n';
  const impl = async (url, opts = {}) => {
    const body = String(opts.body || '');
    const method = opts.method || 'GET';
    if (method === 'GET') return { body: TABBED_GRID, checksum: 'g', retrieved_at: 'T' };
    if (body.includes('tabChange') || body.includes('_activeIndex=1')) {
      return { body: twoExporters, checksum: 'p', retrieved_at: 'T' };
    }
    // j_idt500 is the wrong panel (a superset of the recent view);
    // j_idt501 is the real archive.
    if (body.includes('j_idt500')) {
      return { body: SUPERSET, checksum: 'w', retrieved_at: 'T' };
    }
    if (body.includes('j_idt501')) {
      return { body: ARCHIVE_CSV, checksum: 'a', retrieved_at: 'T' };
    }
    return { body: CSV, checksum: 'c', retrieved_at: 'T' };
  };
  const views = await fetchAllViews({ fetchImpl: impl });
  assert.equal(views.length, 2);
  assert.equal(views[1].view, 'archive');
  assert.equal(views[1].csv.includes('Old Clinic'), true, 'the real archive must be the one published');
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

// Stateful regression portal: every GET creates different generated ids and a
// new cookie-bound ViewState. A request on a consumed session is a test failure.
function recoveryPortal({ fail = 'timeout', alwaysFail = false, shellOnly = false, unconfirmedAfterRetry = false } = {}) {
  const sessions = new WeakMap();
  const calls = [];
  let serial = 0;
  let failures = 0;
  const reply = (body, n) => ({ body, checksum: `csv-${n}`, retrieved_at: `T-${n}`, final_url: GRID_PAGE });
  const impl = async (url, opts = {}) => {
    const body = String(opts.body || '');
    if ((opts.method || 'GET') === 'GET') {
      const n = ++serial;
      sessions.set(opts.jar, { n, token: `GRID-${n}`, archive: false, consumed: false });
      return reply(TABBED_GRID.replaceAll('j_idt31', `j_idt${100 + n}`).replaceAll('j_idt400', `j_idt${600 + n}`).replace('VS-GRID', `GRID-${n}`), n);
    }
    const state = sessions.get(opts.jar);
    assert.ok(state, 'a POST must belong to its grid session');
    assert.equal(state.consumed, false, 'never reuse the state after a timed-out or changed response');
    assert.ok(body.includes(state.token), `POST must use the latest token ${state.token}`);
    calls.push({ n: state.n, body, timeout: opts.timeoutMs });
    if (body.includes('tabChange') || body.includes('_activeIndex=1')) {
      state.archive = true;
      state.token = `ARCHIVE-${state.n}`;
      let html = unconfirmedAfterRetry && failures ? UNCONFIRMED_PARTIAL : ARCHIVE_PARTIAL;
      html = html.replaceAll('j_idt31', `j_idt${100 + state.n}`).replaceAll('j_idt500', `j_idt${700 + state.n}`).replace('VS-ARCHIVE', state.token);
      if (shellOnly && body.includes('tabChange')) {
        state.consumed = true;
        html = html.replace(/<a\b[\s\S]*?<\/a>/, '');
      }
      return reply(html, state.n);
    }
    const expectedId = `j_idt${(state.archive ? 700 : 600) + state.n}`;
    assert.ok(body.includes(expectedId), `POST must rediscover the exporter ${expectedId}`);
    if (state.archive && (alwaysFail || failures === 0)) {
      failures++;
      state.consumed = true;
      if (fail === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      if (fail === 'redirect') return reply('<partial-response><redirect url="/ocr/breach/breach_report_hip.jsf"/></partial-response>', state.n);
      return reply(TABBED_GRID.replace('VS-GRID', `CHANGED-${state.n}`), state.n);
    }
    return reply(state.archive ? ARCHIVE_CSV : CSV, state.n);
  };
  return { impl, calls, failures: () => failures };
}

test('archive export timeout restarts the full snapshot with fresh session, ViewState and exporter ids', async () => {
  const portal = recoveryPortal();
  const views = await fetchAllViews({ fetchImpl: portal.impl });
  assert.equal(views[1].csv, ARCHIVE_CSV);
  assert.equal(views[1].steps.sessionAttempt, 2);
  assert.equal(views[1].steps.recoveredSessions.length, 1);
  assert.equal(views[1].checksum, 'csv-4');
  const timedOut = portal.calls.filter(c => c.n === 2 && !c.body.includes('tabChange'));
  assert.equal(timedOut.length, 1, 'do not try alternate encodings after a transport failure');
  assert.equal(timedOut[0].timeout, 90_000, 'large CSV exports have a bounded 90-second budget');
});

test('persistent export timeouts exhaust two sessions and refuse full coverage', async () => {
  const portal = recoveryPortal({ alwaysFail: true });
  await assert.rejects(() => fetchAllViews({ fetchImpl: portal.impl }), /timeout/);
  assert.equal(portal.failures(), 2);
});

test('a successful retry still refuses an unconfirmed archive selection', async () => {
  const portal = recoveryPortal({ unconfirmedAfterRetry: true });
  await assert.rejects(() => fetchAllViews({ fetchImpl: portal.impl }), /did not confirm the archive tab switch/);
});

for (const fail of ['redirect', 'changed-view']) {
  test(`archive ${fail} response discards old form state before retry`, async () => {
    const portal = recoveryPortal({ fail });
    const views = await fetchAllViews({ fetchImpl: portal.impl });
    assert.equal(views[1].csv, ARCHIVE_CSV);
    assert.equal(views[1].steps.sessionAttempt, 2);
    assert.equal(portal.failures(), 1);
  });
}

test('plain-postback fallback rediscovers ids and ViewState after an AJAX shell-only response', async () => {
  const portal = recoveryPortal({ shellOnly: true });
  const views = await fetchAllViews({ fetchImpl: portal.impl });
  assert.equal(views[1].steps.path, 'archive[plain-postback]');
  assert.equal(views[1].steps.csvCommand, 'ocrForm:j_idt706');
});

test('an archive-only empty grid is accepted alongside nonempty recent data', async () => {
  const { impl } = mockTabbedPortal();
  const fetchImpl = async (url, opts) => {
    const res = await impl(url, opts);
    if (res.body === ARCHIVE_PARTIAL) res.body = res.body.replace('<img alt="CSV"', '<span class="ui-datatable-empty-message">No records found.</span><img alt="CSV"');
    if (res.body === ARCHIVE_CSV) res.body = 'Name of Covered Entity,State\n';
    return res;
  };
  const views = await fetchAllViews({ fetchImpl });
  assert.equal(views[1].gridReportsEmpty, true);
  assert.equal(views[1].archiveVerificationBasis, 'server-tab-state');
  assert.equal(dataRowsOf(views[1].csv), '');
});

test('a header-only export without an empty archive grid is refused even when selected', async () => {
  const { impl } = mockTabbedPortal();
  const fetchImpl = async (url, opts) => {
    const res = await impl(url, opts);
    return res.body === ARCHIVE_CSV ? { ...res, body: 'Name of Covered Entity,State\n' } : res;
  };
  await assert.rejects(() => fetchAllViews({ fetchImpl }), /empty export without an unambiguous empty archive grid/);
});

test('report identity permits the portal session path parameter while rejecting other reports and origins', () => {
  const { assertGridIdentity } = require('./hhs-ocr-fetch');
  assert.doesNotThrow(() => assertGridIdentity(GRID_PAGE, { body: GRID, final_url: `${GRID_PAGE};jsessionid=SECRET` }, 'hhs_ocr'));
  assert.throws(() => assertGridIdentity(GRID_PAGE, { body: GRID, final_url: `${PART2_GRID_PAGE};jsessionid=SECRET` }, 'hhs_ocr'), /Refusing to ingest/);
  assert.throws(() => assertGridIdentity(GRID_PAGE, { body: GRID, final_url: GRID_PAGE.replace('ocrportal.hhs.gov', 'example.org') }, 'hhs_ocr'), /Refusing to ingest/);
});

test('the tab-change request refreshes the portal-declared results table as well as server tab state', async () => {
  const grid = TABBED_GRID.replace('</html>', `<script>PrimeFaces.ab({s:"ocrForm:j_idt31",e:"tabChange",u:"ocrForm:rotatedResults ocrForm:rotatedSummary"});</script></html>`);
  const { impl } = mockTabbedPortal({ tabbed: grid });
  let observed = false;
  const wrapped = async (url, opts = {}) => {
    if (String(opts.body).includes('tabChange')) {
      const posted = new URLSearchParams(opts.body);
      assert.equal(posted.get('javax.faces.partial.render'), 'ocrForm:j_idt31 ocrForm:rotatedResults ocrForm:rotatedSummary');
      observed = true;
    }
    return impl(url, opts);
  };
  const views = await fetchAllViews({ fetchImpl: wrapped });
  assert.equal(observed, true);
  assert.equal(views[1].archiveVerification, 'verified');
});
