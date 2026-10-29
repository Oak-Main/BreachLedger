// PrimeFaces TabView handling for the HHS OCR breach portal.
//
// The archive is not a separate page and not a filter: it is the second tab of
// a PrimeFaces TabView. The portal's own markup gives this away —
//   <a href="#ocrForm:j_idt31:archiveTab">Archive</a>
//   <div id="ocrForm:j_idt31:archiveTab" class="ui-tabs-panel ... ui-helper-hidden">
//   <input type="hidden" name="ocrForm:j_idt31_activeIndex" ...>
//   function doArchiveButtonClicked() { PF('archiveRptButton')... }
//
// Only one set of four exporter commands is rendered at a time, so the archive
// tab's content (and its own CSV exporter) is loaded on demand rather than
// sitting hidden in the page. Switching tabs therefore requires a real
// postback, and the response may be a PrimeFaces partial-response XML document
// rather than a full HTML page.

/**
 * Locate the TabView from its activeIndex hidden field.
 * "ocrForm:j_idt31_activeIndex" -> { id: "ocrForm:j_idt31", field: "..." }
 * Returns null when the page has no TabView.
 */
function findTabView(hidden) {
  for (const name of Object.keys(hidden)) {
    const m = /^(.*)_activeIndex$/.exec(name);
    if (m) return { id: m[1], field: name, activeIndex: hidden[name] };
  }
  return null;
}

/**
 * Find a tab's client id by the visible label of the anchor that selects it.
 * The anchor is a plain in-page link (href="#<tabId>"), not a JSF command, so
 * the generic command scanner does not see it.
 */
function findTabId(html, labelPattern) {
  const re = /<a\b[^>]*\bhref\s*=\s*["']#([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const label = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (labelPattern.test(label) || labelPattern.test(m[1])) return m[1];
  }
  return null;
}

/**
 * Body for a PrimeFaces TabView tabChange, as an AJAX partial submit.
 * PrimeFaces sends the new index in <tabview>_newTab / _tabindex and mirrors it
 * into the activeIndex hidden field.
 */
function buildTabChangeFields(hidden, tabView, tabIndex, tabClientId, renderTargets = []) {
  return {
    ...hidden,
    ocrForm: 'ocrForm',
    [tabView.field]: String(tabIndex),
    [`${tabView.id}_newTab`]: tabClientId || '',
    [`${tabView.id}_tabindex`]: String(tabIndex),
    'javax.faces.source': tabView.id,
    'javax.faces.partial.event': 'tabChange',
    'javax.faces.behavior.event': 'tabChange',
    'javax.faces.partial.execute': tabView.id,
    'javax.faces.partial.render': [...new Set([tabView.id, ...renderTargets])].join(' '),
    'javax.faces.partial.ajax': 'true',
  };
}

/** Read the tabChange handler's render targets from this render's widget.
 * The live portal updates its results OUTSIDE the TabView. Rendering just the
 * tab shell confirms selection but supplies neither the refreshed table nor
 * its exporter. Do not hardcode HHS's component ids or evaluate its scripts.
 */
function findTabChangeRenderTargets(html, tabView) {
  if (!tabView) return [];
  for (const script of String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const match of script[1].matchAll(/PrimeFaces\.ab\(\{([^{}]+)/g)) {
      const field = (key) => new RegExp(`(?:^|,)\\s*${key}\\s*:\\s*(["'])(.*?)\\1`).exec(match[1])?.[2];
      if (field('s') === tabView.id && field('e') === 'tabChange') {
        return (field('u') || '').split(/\s+/).filter(Boolean);
      }
    }
  }
  return [];
}

/**
 * The same tab switch as an ordinary full postback: set activeIndex and submit.
 * Simpler, and sufficient when the TabView is not dynamic. Tried alongside the
 * AJAX form because which one works is a server-side configuration detail.
 */
function buildTabPostbackFields(hidden, tabView, tabIndex) {
  return {
    ...hidden,
    ocrForm: 'ocrForm',
    [tabView.field]: String(tabIndex),
    [`${tabView.id}_tabindex`]: String(tabIndex),
  };
}

/**
 * Extract renderable HTML from a PrimeFaces partial-response.
 *
 * An AJAX postback answers with XML:
 *   <partial-response><changes>
 *     <update id="..."><![CDATA[ ...html... ]]></update>
 *     <update id="javax.faces.ViewState"><![CDATA[token]]></update>
 *   </changes></partial-response>
 *
 * Returns { html, viewState } — html is the concatenated updates, so the
 * existing command/exporter scanners work on it unchanged. A non-XML body is
 * passed through untouched, so callers need not care which shape they got.
 */
function extractPartialResponse(body) {
  const text = String(body || '');
  if (!/<partial-response/i.test(text)) return { html: text, viewState: null, isPartial: false };

  let html = '';
  let viewState = null;
  const updateRe = /<update\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/update>/gi;
  let m;
  while ((m = updateRe.exec(text))) {
    const id = m[1];
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[2]);
    const content = cdata ? cdata[1] : m[2];
    if (/ViewState/i.test(id)) viewState = content.trim();
    else html += content;
  }
  return { html, viewState, isPartial: true };
}

/**
 * Merge a partial response's fresh ViewState back into the hidden field set,
 * so the following export postback carries a token the server still accepts.
 */
function mergeViewState(hidden, viewState) {
  if (!viewState) return hidden;
  const key = 'jakarta.faces.ViewState' in hidden ? 'jakarta.faces.ViewState' : 'javax.faces.ViewState';
  return { ...hidden, [key]: viewState };
}

/**
 * Read the tab state the SERVER reported back, so that a tab switch can be
 * confirmed independently of how many rows came back.
 *
 * Two server-side signals, both present in the switch response:
 *
 *   - the TabView mirrors the selected tab into an `<tabview>_activeIndex`
 *     hidden field, so the response says which tab is now selected;
 *   - PrimeFaces renders the inactive panels with `ui-helper-hidden`, so the
 *     panel of the selected tab is the one WITHOUT that class.
 *
 * This matters because the data comparison cannot settle the question when
 * both views are empty: two empty exports are identical no matter which tab
 * was actually selected, and their bytes differ for unrelated reasons (the
 * header row carries volatile JSF object identity). The server's own answer
 * does not depend on the row count.
 *
 * @param {string} html         the switch response (page or unwrapped partial)
 * @param {object} tabView      { id, field } as returned by findTabView
 * @param {object} hidden       the hidden inputs extracted from that response
 * @param {string} tabClientId  the client id of the tab that should now be active
 * @returns {{activeIndex: string|null, panelVisible: boolean|null}}
 */
function readTabState(html, tabView, hidden, tabClientId) {
  let activeIndex = null;
  if (tabView && hidden && hidden[tabView.field] !== undefined && hidden[tabView.field] !== null) {
    activeIndex = String(hidden[tabView.field]);
  }

  let panelVisible = null;
  if (tabClientId) {
    const escaped = String(tabClientId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const panelRe = new RegExp(`<div[^>]*\\bid\\s*=\\s*["']${escaped}["'][^>]*>`, 'i');
    const panel = panelRe.exec(String(html || ''));
    if (panel) {
      const classMatch = /class\s*=\s*["']([^"']*)["']/i.exec(panel[0]);
      // No class attribute at all means the panel was rendered as a plain
      // panel -- visible, not hidden.
      panelVisible = classMatch ? !/ui-helper-hidden/.test(classMatch[1]) : true;
    }
  }

  return { activeIndex, panelVisible };
}

/**
 * Find the index of a tab in the TabView's navigation order.
 *
 * The archive is located by its LABEL, so its index cannot be assumed: if the
 * portal ever reorders the tabs, a hardcoded index would contradict the tab
 * that was actually found, and the two signals would then disagree forever.
 */
function findTabIndex(html, tabClientId) {
  const text = String(html || '');
  const nav = /<ul[^>]*class="[^"]*ui-tabs-nav[^"]*"[^>]*>([\s\S]*?)<\/ul>/i.exec(text);
  const scope = nav ? nav[1] : text;
  const re = /<a\b[^>]*\bhref\s*=\s*["']#([^"']+)["'][^>]*>/gi;
  const ids = [];
  let m;
  while ((m = re.exec(scope))) ids.push(m[1]);
  const i = ids.indexOf(tabClientId);
  return i === -1 ? null : i;
}

module.exports = {
  findTabView,
  findTabId,
  findTabIndex,
  buildTabChangeFields,
  findTabChangeRenderTargets,
  buildTabPostbackFields,
  extractPartialResponse,
  mergeViewState,
  readTabState,
};
