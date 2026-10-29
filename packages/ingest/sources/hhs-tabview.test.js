const test = require('node:test');
const assert = require('node:assert');
const tv = require('./hhs-tabview');

// Markup mirroring what the live portal actually returns.
const GRID = `<html><form id="ocrForm">
<ul class="ui-tabs-nav">
  <li><a href="#ocrForm:j_idt31:underInvTab" tabindex="-1">Under Investigation</a></li>
  <li><a href="#ocrForm:j_idt31:archiveTab" tabindex="-1">Archive</a></li>
</ul>
<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom ui-helper-hidden" role="tabpanel"></div>
<script>function doArchiveButtonClicked() { setTimeout( "PF('archiveRptButton').jq.click()", 100); }</script>
<input type="hidden" name="headerNavigation" value="">
<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="0">
<input type="hidden" name="ocrForm:reportResultTable_rowExpansionState" value="">
<input type="hidden" name="javax.faces.ViewState" value="VS-ORIGINAL">
</form></html>`;

const HIDDEN = {
  headerNavigation: '',
  'ocrForm:j_idt31_activeIndex': '0',
  'ocrForm:reportResultTable_rowExpansionState': '',
  'javax.faces.ViewState': 'VS-ORIGINAL',
};

test('locates the TabView from its activeIndex hidden field', () => {
  const tab = tv.findTabView(HIDDEN);
  assert.equal(tab.id, 'ocrForm:j_idt31');
  assert.equal(tab.field, 'ocrForm:j_idt31_activeIndex');
  assert.equal(tab.activeIndex, '0');
});

test('returns null when the page has no TabView', () => {
  assert.equal(tv.findTabView({ 'javax.faces.ViewState': 'x' }), null);
});

test('finds the archive tab id by its anchor label', () => {
  assert.equal(tv.findTabId(GRID, /archive/i), 'ocrForm:j_idt31:archiveTab');
  assert.equal(tv.findTabId(GRID, /under investigation/i), 'ocrForm:j_idt31:underInvTab');
  assert.equal(tv.findTabId(GRID, /nonexistent/i), null);
});

test('tabChange body carries the new index and the PrimeFaces ajax params', () => {
  const fields = tv.buildTabChangeFields(HIDDEN, tv.findTabView(HIDDEN), 1, 'ocrForm:j_idt31:archiveTab');
  assert.equal(fields['ocrForm:j_idt31_activeIndex'], '1');
  assert.equal(fields['ocrForm:j_idt31_tabindex'], '1');
  assert.equal(fields['ocrForm:j_idt31_newTab'], 'ocrForm:j_idt31:archiveTab');
  assert.equal(fields['javax.faces.source'], 'ocrForm:j_idt31');
  assert.equal(fields['javax.faces.behavior.event'], 'tabChange');
  assert.equal(fields['javax.faces.partial.ajax'], 'true');
  // The original ViewState must still travel with it.
  assert.equal(fields['javax.faces.ViewState'], 'VS-ORIGINAL');
});

test('plain postback variant sets the index without the ajax params', () => {
  const fields = tv.buildTabPostbackFields(HIDDEN, tv.findTabView(HIDDEN), 1);
  assert.equal(fields['ocrForm:j_idt31_activeIndex'], '1');
  assert.equal(fields.ocrForm, 'ocrForm');
  assert.ok(!('javax.faces.partial.ajax' in fields));
});

test('extracts HTML and a fresh ViewState from a partial-response', () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<partial-response><changes>' +
    '<update id="ocrForm:j_idt31"><![CDATA[<div><a onclick="mojarra.jsfcljs(x,{\'ocrForm:j_idt500\':\'1\'},\'\')">' +
    '<img alt="CSV" src="/i/csv.png"></a></div>]]></update>' +
    '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-AFTER-TAB-CHANGE]]></update>' +
    '</changes></partial-response>';
  const { html, viewState, isPartial } = tv.extractPartialResponse(xml);
  assert.equal(isPartial, true);
  assert.equal(viewState, 'VS-AFTER-TAB-CHANGE');
  assert.match(html, /alt="CSV"/);
  // The ViewState update must NOT be concatenated into the renderable html.
  assert.ok(!html.includes('VS-AFTER-TAB-CHANGE'));
});

test('a plain HTML response passes through untouched', () => {
  const { html, viewState, isPartial } = tv.extractPartialResponse(GRID);
  assert.equal(isPartial, false);
  assert.equal(viewState, null);
  assert.equal(html, GRID);
});

test('merged ViewState replaces the stale token', () => {
  const merged = tv.mergeViewState(HIDDEN, 'VS-NEW');
  assert.equal(merged['javax.faces.ViewState'], 'VS-NEW');
  assert.equal(merged.headerNavigation, '');
  // Jakarta spelling is honoured when that is what the page used.
  const jakarta = tv.mergeViewState({ 'jakarta.faces.ViewState': 'old' }, 'VS-NEW');
  assert.equal(jakarta['jakarta.faces.ViewState'], 'VS-NEW');
  assert.ok(!('javax.faces.ViewState' in jakarta));
});

test('missing ViewState leaves the field set unchanged', () => {
  assert.deepEqual(tv.mergeViewState(HIDDEN, null), HIDDEN);
});

// --- Reading the tab state the server reported back ------------------------
//
// This is what lets an archive switch be confirmed independently of how many
// rows came back. Two empty exports are identical whichever tab was selected,
// so the row comparison cannot settle the question; the server's own answer
// can.

const TABVIEW = { id: 'ocrForm:j_idt31', field: 'ocrForm:j_idt31_activeIndex' };

test('reads the selected tab index out of the response', () => {
  const html = '<input type="hidden" name="ocrForm:j_idt31_activeIndex" value="1">';
  const state = tv.readTabState(html, TABVIEW, { 'ocrForm:j_idt31_activeIndex': '1' }, 'ocrForm:j_idt31:archiveTab');
  assert.equal(state.activeIndex, '1');
});

test('reports the archive panel as visible once it is no longer hidden', () => {
  const visible = '<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom">';
  const hidden = '<div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ui-widget-content ui-corner-bottom ui-helper-hidden">';
  assert.equal(tv.readTabState(visible, TABVIEW, {}, 'ocrForm:j_idt31:archiveTab').panelVisible, true);
  assert.equal(tv.readTabState(hidden, TABVIEW, {}, 'ocrForm:j_idt31:archiveTab').panelVisible, false);
});

test('reports absent rather than guessing when the response says nothing', () => {
  const state = tv.readTabState('<html><body>nothing here</body></html>', TABVIEW, {}, 'ocrForm:j_idt31:archiveTab');
  assert.equal(state.activeIndex, null);
  assert.equal(state.panelVisible, null);
});

test('a panel rendered without a class attribute counts as visible', () => {
  const html = '<div id="ocrForm:j_idt31:archiveTab">';
  assert.equal(tv.readTabState(html, TABVIEW, {}, 'ocrForm:j_idt31:archiveTab').panelVisible, true);
});

test('a client id containing regex metacharacters is matched literally', () => {
  const html = '<div id="ocrForm:j_idt31:archive.tab" class="ui-tabs-panel ui-helper-hidden">';
  const state = tv.readTabState(html, TABVIEW, {}, 'ocrForm:j_idt31:archive.tab');
  assert.equal(state.panelVisible, false);
});

// --- The tab's index comes from the markup, not from an assumption ---------

test('finds the index of a tab in the navigation order', () => {
  const html = '<ul class="ui-tabs-nav">' +
    '<li><a href="#ocrForm:j_idt31:underInvTab">Under Investigation</a></li>' +
    '<li><a href="#ocrForm:j_idt31:archiveTab">Archive</a></li>' +
    '<li><a href="#ocrForm:j_idt31:helpTab">Help</a></li>' +
    '</ul>';
  assert.equal(tv.findTabIndex(html, 'ocrForm:j_idt31:underInvTab'), 0);
  assert.equal(tv.findTabIndex(html, 'ocrForm:j_idt31:archiveTab'), 1);
  assert.equal(tv.findTabIndex(html, 'ocrForm:j_idt31:helpTab'), 2);
});

test('a tab that is not in the navigation has no index', () => {
  const html = '<ul class="ui-tabs-nav"><li><a href="#a">A</a></li></ul>';
  assert.equal(tv.findTabIndex(html, 'ocrForm:j_idt31:archiveTab'), null);
});

test('anchors outside the tab navigation do not shift the index', () => {
  const html = '<a href="#top">skip to top</a>' +
    '<ul class="ui-tabs-nav">' +
    '<li><a href="#ocrForm:j_idt31:underInvTab">Under Investigation</a></li>' +
    '<li><a href="#ocrForm:j_idt31:archiveTab">Archive</a></li>' +
    '</ul><a href="#footer">footer</a>';
  assert.equal(tv.findTabIndex(html, 'ocrForm:j_idt31:archiveTab'), 1);
});

test('a reordered TabView reports the archive at its new index', () => {
  // The archive is found by its label, so its index must follow the markup:
  // a hardcoded index would contradict the tab that was actually found.
  const html = '<ul class="ui-tabs-nav">' +
    '<li><a href="#ocrForm:j_idt31:archiveTab">Archive</a></li>' +
    '<li><a href="#ocrForm:j_idt31:underInvTab">Under Investigation</a></li>' +
    '</ul>';
  assert.equal(tv.findTabIndex(html, 'ocrForm:j_idt31:archiveTab'), 0);
});

test('discovers the live tabChange results render targets alongside the selected tab shell', () => {
  const { findTabChangeRenderTargets, buildTabChangeFields } = require('./hhs-tabview');
  const tab = { id: 'ocrForm:j_idt912', field: 'ocrForm:j_idt912_activeIndex' };
  const html = `<script>PrimeFaces.ab({s:"other:widget",e:"tabChange",u:"wrong:table"});</script>
    <script>PrimeFaces.cw("TabView","widget",{behaviors:{tabChange:function(){PrimeFaces.ab({s:"ocrForm:j_idt912",e:"tabChange",f:"ocrForm",p:"ocrForm:j_idt912",u:"ocrForm:breachReports ocrForm:results",onst:function(cfg){wait.show();}});}}});</script>`;
  const targets = findTabChangeRenderTargets(html, tab);
  assert.deepEqual(targets, ['ocrForm:breachReports', 'ocrForm:results']);
  const fields = buildTabChangeFields({}, tab, 1, `${tab.id}:archiveTab`, targets);
  assert.equal(fields['javax.faces.partial.render'], 'ocrForm:j_idt912 ocrForm:breachReports ocrForm:results');
  assert.deepEqual(findTabChangeRenderTargets('<script>PrimeFaces.ab({s:"other",e:"tabChange",u:"other:results"})</script>', tab), []);
});
