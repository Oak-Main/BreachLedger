#!/usr/bin/env node
// Utility Engine static build. Reads ue.config.js, the build-time D1 export in
// site/data/, and docs/, then writes the full static site to dist/ for
// Cloudflare Pages. Fails the build (exit 1) on guard violations rather than
// publishing a page that breaks the editorial constraints.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const config = require(path.join(ROOT, 'ue.config.js'));
const { fillPostalAddress } = require('./postal.js');
const { renderMarkdown } = require('./templates/markdown');
const { pageCount } = require('./templates/breach-table');
const { ga4Bootstrap } = require('./templates/layout');

const OUT = path.join(ROOT, config.paths.out);
const DATA = path.join(ROOT, config.paths.data);
const DOCS = path.join(ROOT, config.paths.docs);
const ASSETS = path.join(ROOT, config.paths.assets);
const TEMPLATES = path.join(ROOT, config.paths.templates);

// Human-readable attribution for each source type, shown in citation blocks.
const SOURCE_LABELS = {
  hhs_ocr: 'U.S. Department of Health and Human Services, Office for Civil Rights breach portal (HIPAA)',
  hhs_part2: 'U.S. Department of Health and Human Services, Office for Civil Rights breach portal (42 CFR Part 2)',
  maine_ag: 'Maine Attorney General breach notifications',
  ca_ag: 'California Attorney General breach list',
  wa_ag: 'Washington Attorney General breach notifications',
  tx_ag: 'Texas Attorney General data breach reports',
  sec_8k: 'SEC EDGAR Form 8-K, Item 1.05',
  courtlistener: 'CourtListener docket record',
};

function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readData(name) {
  const p = path.join(DATA, `${name}.json`);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readDoc(name) {
  const p = path.join(DOCS, name);
  // Docs say {{POSTAL_ADDRESS}}; the address itself lives in legal/legal.config.json.
  return fs.existsSync(p) ? fillPostalAddress(fs.readFileSync(p, 'utf8')) : '';
}

function writePage(routePath, html) {
  // '/' -> dist/index.html, '/severity' -> dist/severity/index.html
  const rel = routePath === '/' ? 'index.html' : path.join(routePath.replace(/^\//, ''), 'index.html');
  const target = path.resolve(OUT, rel);
  // Containment: a slug-derived route must never escape dist/ (e.g. '../').
  if (!target.startsWith(path.resolve(OUT) + path.sep)) {
    throw new Error(`writePage: route '${routePath}' resolves outside the output directory`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
  return target;
}

// Build-blocking guards (spec sections 8-10).
// Emoji ranges: core emoji blocks, misc-symbols/dingbats, misc-technical
// (alarm clocks, hourglasses — countdown iconography), 2B00 block (stars,
// circles), doubled punctuation, and variation selector 16. Deliberately
// excludes text glyphs like section signs, arrows, daggers, (c)/(tm).
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{2934}\u{2935}\u{203C}\u{2049}\u{3030}\u{303D}\u{3297}\u{3299}\u{FE0F}]/u;

// The single permitted <script> element: a JSON-LD metadata block. It carries
// no executable code, and this pattern accepts it ONLY when its payload holds
// no angle bracket at all — jsonLd() in templates/layout.js unicode-escapes
// every '<' precisely so a string value can never close the element early. An
// unescaped payload therefore fails to match here, falls through to the check
// below, and fails the build. Anything else calling itself a script still
// fails outright. See site/build-guard.test.js.
const LD_JSON_BLOCK = /<script type="application\/ld\+json">[^<]*<\/script>/g;

// Google Analytics 4 (owner-approved): the only other scripts admitted, in the
// exact form templates/layout.js emits them: the gtag.js loader from Google's
// own origin with a well-formed measurement ID, and the same-origin,
// content-hashed bootstrap file. Neither pattern admits any free text, and a
// page may carry at most one of each, always as a pair. Inline script of any
// kind still fails the build (and is refused by the CSP besides).
const GA4_LOADER = /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-[A-Z0-9]{4,16}"><\/script>/g;
const GA4_BOOTSTRAP = /<script async src="\/assets\/ga4\.[a-f0-9]{10}\.js"><\/script>/g;

// The Content-Security-Policy served with every page (written to _headers).
// Same-origin assets, plus exactly the hosts Google Analytics 4 needs (gtag.js
// loader, collect endpoints, pixel fallback) and Cloudflare Web Analytics'
// beacon script and reporting endpoint. connect-src 'self' also covers
// Cloudflare's same-origin /cdn-cgi/rum beacon post. No 'unsafe-inline', no
// 'unsafe-eval', no scheme or bare wildcards.
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' https://www.googletagmanager.com https://static.cloudflareinsights.com",
  "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://cloudflareinsights.com",
  "img-src 'self' data: https://*.google-analytics.com https://*.googletagmanager.com",
  "style-src 'self'",
  // manifest-src is required explicitly: default-src 'none' otherwise
  // blocks the web app manifest fetch, and the failure is silent.
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function guardPage(routePath, html, { allowScript = false } = {}) {
  const problems = [];
  if (!html.startsWith('<!doctype html>')) problems.push('missing doctype');
  if (!/<title>[^<]+<\/title>/.test(html)) problems.push('missing <title>');
  if (EMOJI_RE.test(html)) problems.push('emoji found — emoji-as-iconography is banned (spec section 10)');
  const gaLoaders = (html.match(GA4_LOADER) || []).length;
  const gaBootstraps = (html.match(GA4_BOOTSTRAP) || []).length;
  if (gaLoaders > 1 || gaBootstraps > 1 || gaLoaders !== gaBootstraps) {
    problems.push('analytics: a page may carry one GA4 loader and one GA4 bootstrap, together, and no more');
  }
  const withoutAnalytics = html.replace(GA4_LOADER, '').replace(GA4_BOOTSTRAP, '');
  // Apart from the analytics tags above, this site ships zero executable
  // JavaScript. Any other <script> tag than a well-formed JSON-LD block means
  // data reached the page unescaped — fail the build rather than publish it.
  // One narrow exception: routes explicitly flagged allowScript (the /scan
  // interactive tool) may load exactly one fingerprinted script from /assets
  // — anything else still fails the build.
  if (/<script/i.test(withoutAnalytics.replace(LD_JSON_BLOCK, '')) && !allowScript) {
    problems.push('script tag in output — the site is zero-JS; this is unescaped data');
  }
  if (allowScript) {
    const scripts = [...withoutAnalytics.matchAll(/<script\b([^>]*)>/gi)].map((m) => m[1]);
    const offenders = scripts.filter((attrs) => !/src="\/assets\/[a-z0-9.-]+\.js"/i.test(attrs));
    if (scripts.length > 1 || offenders.length) {
      problems.push('allowScript pages may load exactly one fingerprinted /assets script');
    }
  }
  if (problems.length) {
    throw new Error(`build guard failed for ${routePath}: ${problems.join('; ')}`);
  }
}

// Thin-content guard (spec section 8): minimum viable breach page is
// entity + date + >=1 data class + >=1 source. Below that, it stays draft.
// Zero-source records must never render (spec section 3).
function publishableBreaches(breaches, sourcesByBreach) {
  return breaches.filter((b) => {
    if (b.status !== 'published' && b.status !== 'corrected') return false;
    const sources = sourcesByBreach.get(b.id) || [];
    const dataClasses = JSON.parse(b.data_classes || '[]');
    return Boolean(b.entity_name && b.notification_date && dataClasses.length >= 1 && sources.length >= 1);
  });
}

function main() {
  // A placeholder origin would publish canonical and og:url tags pointing at a
  // domain that does not serve this site. Fail rather than ship that.
  const origin = config.site.origin;
  if (!/^https:\/\//.test(origin) || /\.example($|\/)|localhost|example\.com/.test(origin)) {
    throw new Error(`build guard failed: site.origin '${origin}' is not a real https origin (set SITE_ORIGIN)`);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // Assets (text assets pass the emoji guard too — a CSS `content:` emoji
  // would otherwise ship unchecked). The stylesheet is content-hashed so it
  // can be cached immutably yet still update the instant it changes.
  const assetOut = path.join(OUT, 'assets');
  fs.mkdirSync(assetOut, { recursive: true });
  const assetNames = {};
  for (const f of fs.readdirSync(ASSETS)) {
    const raw = fs.readFileSync(path.join(ASSETS, f));
    if (/\.(css|js|svg|txt)$/.test(f) && EMOJI_RE.test(raw.toString('utf8'))) {
      throw new Error(`build guard failed for asset ${f}: emoji found (spec section 10)`);
    }
    let outName = f;
    let content = raw;
    if (f === 'styles.css') {
      // Severity bar widths as classes, not inline styles: the Content-Security
      // -Policy is style-src 'self', which blocks style attributes outright.
      const widths = Array.from({ length: 101 }, (_, n) => `.sev-${n}{width:${n}%}`).join('');
      content = Buffer.concat([raw, Buffer.from(`\n/* generated severity bar widths */\n${widths}\n`)]);
    }
    if (f.endsWith('.css')) {
      const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
      outName = f.replace(/\.css$/, `.${hash}.css`);
    }
    assetNames[f] = outName;
    fs.writeFileSync(path.join(assetOut, outName), content);
  }
  // GA4 bootstrap: generated from the configured measurement ID and written as
  // a content-hashed same-origin file, because the CSP forbids inline script.
  // templates/layout.js references it on every page via assets['ga4.js'].
  if (config.site.ga4MeasurementId) {
    const content = Buffer.from(ga4Bootstrap(config.site.ga4MeasurementId));
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 10);
    assetNames['ga4.js'] = `ga4.${hash}.js`;
    fs.writeFileSync(path.join(assetOut, assetNames['ga4.js']), content);
  }

  // Build-time D1 export (empty in Phase 0)
  const breaches = readData('breaches');
  // VirusTotal domain-reputation enrichment: generated at build time from the
  // TrueAPI ingest worker's warm cache (our own infrastructure, not an upstream
  // API call). Best-effort — if the worker is unreachable the pages simply
  // render without the reputation block.
  try {
    require('child_process').execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts/enrich-domain-reputation.mjs')],
      { stdio: 'inherit' },
    );
  } catch (e) {
    console.warn('domain-reputation enrichment skipped:', e.message);
  }
  const domainReputation = readData('domain-reputation');
  const sources = readData('sources');
  const litigation = readData('litigation');

  // UPL guard (spec sections 3 and 9): official_claim_url must be the
  // settlement administrator's domain, never ours. Build-blocking.
  const ourHost = new URL(config.site.origin).host;
  for (const l of litigation) {
    if (l.official_claim_url && new URL(l.official_claim_url).host === ourHost) {
      throw new Error(`build guard failed: litigation ${l.id} official_claim_url is on our own domain`);
    }
  }
  const sourcesByBreach = new Map();
  for (const s of sources) {
    if (!sourcesByBreach.has(s.breach_id)) sourcesByBreach.set(s.breach_id, []);
    sourcesByBreach.get(s.breach_id).push(s);
  }
  const published = publishableBreaches(breaches, sourcesByBreach);

  const dataClasses = require(path.join(ROOT, 'packages/schema/seed/data-classes.json')).classes;
  const dataClassMap = Object.fromEntries(dataClasses.map((c) => [c.code, c]));

  // Seeded reference content. Loaded from the seed files rather than the D1
  // export because it is static: it changes when a statute or a federal
  // guidance page changes, not when a breach is ingested.
  const MODULE_DIR = path.join(ROOT, 'packages/schema/seed/remediation-modules');
  const remediationModules = fs
    .readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(MODULE_DIR, f), 'utf8')))
    .sort((a, b) => a.priority - b.priority);

  const stateRights = require(path.join(ROOT, 'packages/schema/seed/state-rights.json')).rows
    .slice()
    .sort((a, b) => a.state_name.localeCompare(b.state_name));

  // Modules applicable to a set of exposed data classes, in priority order.
  // This is the inverse of remediation_modules.applies_to — the same derivation
  // packages/schema/seed/load.js uses to compute data_classes.remediation_ids,
  // so the rendered page and the database cannot disagree.
  const remediationModulesFor = (codes) =>
    remediationModules.filter((m) => m.applies_to.some((c) => codes.includes(c)));

  // Parse the JSON-encoded columns once, here, so no template has to.
  for (const b of published) {
    b.data_classes_parsed = safeJson(b.data_classes, []);
    b.states_notified_parsed = safeJson(b.states_notified, []);
    b.remediation_offered_parsed = safeJson(b.remediation_offered, null);
  }

  const ctx = {
    site: config.site,
    assets: assetNames,
    buildPhase: config.buildPhase,
    dataClassMap,
    sourceLabels: SOURCE_LABELS,
    breaches: published,
    litigation,
    rubric: require(path.join(ROOT, 'packages/severity/rubric.json')),
    dataClasses,
    remediationModules,
    stateRights,
    docs: {
      sources: readDoc('SOURCES.md'),
      corrections: readDoc('CORRECTIONS.md'),
      privacy: readDoc('privacy.md'),
      about: readDoc('about.md'),
    },
    renderMarkdown,
  };

  // Sitemap accumulator. Every route that is written and indexable is recorded
  // here as it is generated, so the sitemap cannot drift out of step with what
  // the build actually produced.
  const sitemap = [];
  const buildDate = new Date().toISOString().slice(0, 10);
  const addToSitemap = (routePath, lastmod) => {
    sitemap.push({
      loc: `${origin}${routePath === '/' ? '/' : routePath + '/'}`,
      lastmod: /^\d{4}-\d{2}-\d{2}$/.test(String(lastmod || '').slice(0, 10))
        ? String(lastmod).slice(0, 10)
        : buildDate,
    });
  };
  // Most recent update among a set of records, for hub-page lastmod.
  const latestUpdate = (list) =>
    list.reduce((acc, b) => {
      const d = String(b.updated_at || '').slice(0, 10);
      return /^\d{4}-\d{2}-\d{2}$/.test(d) && d > acc ? d : acc;
    }, '');

  const activeRoutes = config.routes.filter((r) => r.phase <= config.buildPhase && !r.path.includes('['));
  const written = [];
  for (const route of activeRoutes) {
    const template = require(path.join(TEMPLATES, `${route.template}.js`));
    const html = template.render(ctx);
    guardPage(route.path, html, { allowScript: Boolean(route.allowScript) });
    written.push(writePage(route.path, html));
    if (!route.noindex) addToSitemap(route.path, buildDate);
  }

  // Dynamic routes generated from the record set.
  const dynamic = (routePath, template) =>
    config.routes.some((r) => r.path === routePath && r.phase <= config.buildPhase)
      ? require(path.join(TEMPLATES, `${template}.js`))
      : null;

  // A slug is a permanent public URL, and writePage overwrites silently. Two
  // records sharing a slug would publish one and vanish the other with no
  // signal at all, so it fails the build instead.
  const slugSeen = new Map();
  for (const b of published) {
    if (slugSeen.has(b.slug)) {
      throw new Error(
        `build guard failed: two records claim /breach/${b.slug} — ${slugSeen.get(b.slug)} and ${b.id}. ` +
          'Publishing would silently overwrite one with the other.'
      );
    }
    slugSeen.set(b.slug, b.id);
  }

  // Coverage honesty (spec section 8). /sources is where this project states
  // what it does and does not hold, so it must never say a source is not
  // ingested while that source's records are being published beside it.
  const publishedSourceTypes = new Set();
  for (const list of sourcesByBreach.values()) for (const s of list) publishedSourceTypes.add(s.source_type);
  for (const type of publishedSourceTypes) {
    const row = ctx.docs.sources.split('\n').find((l) => l.includes(`\`${type}\``) && l.startsWith('|'));
    if (row && /not ingested|not yet implemented/i.test(row)) {
      throw new Error(
        `build guard failed: docs/SOURCES.md still lists '${type}' as not ingested, but ` +
          `${[...sourcesByBreach.values()].flat().filter((s) => s.source_type === type).length} published ` +
          'record(s) cite it. Update the source registry before shipping.'
      );
    }
  }

  const breachTpl = dynamic('/breach/[slug]', 'breach-detail');
  const remediationTpl = dynamic('/breach/[slug]/what-to-do', 'remediation');
  if (breachTpl) {
    for (const breach of published) {
      const breachSources = sourcesByBreach.get(breach.id) || [];
      // Remediation guidance is assembled from the exposed data classes, and
      // only rendered when a module actually applies: a page that promises what
      // to do and then lists nothing is worse than no page. The detail page is
      // told the outcome so its link and the page's existence cannot disagree.
      const modules = remediationTpl ? remediationModulesFor(breach.data_classes_parsed || []) : [];
      const html = breachTpl.render({ domainReputation,
        ...ctx,
        breach,
        sources: breachSources,
        hasRemediation: modules.length > 0,
      });
      guardPage(`/breach/${breach.slug}`, html);
      written.push(writePage(`/breach/${breach.slug}`, html));
      addToSitemap(`/breach/${breach.slug}`, breach.updated_at);

      if (modules.length) {
        const rHtml = remediationTpl.render({ ...ctx, breach, sources: breachSources, modules });
        guardPage(`/breach/${breach.slug}/what-to-do`, rHtml);
        written.push(writePage(`/breach/${breach.slug}/what-to-do`, rHtml));
        addToSitemap(`/breach/${breach.slug}/what-to-do`, breach.updated_at);
      }
    }
  }

  // Index views are sharded. Every page is a real file so a reader without
  // JavaScript — and a crawler — can reach every row by following links.
  const sectorTpl = dynamic('/sector/[sector]', 'sector-hub');
  if (sectorTpl) {
    const bySector = new Map();
    for (const b of published) {
      if (!b.sector) continue;
      if (!bySector.has(b.sector)) bySector.set(b.sector, []);
      bySector.get(b.sector).push(b);
    }
    for (const [sector, list] of bySector) {
      const totalPages = pageCount(list.length);
      const lastmod = latestUpdate(list);
      for (let p = 1; p <= totalPages; p++) {
        const html = sectorTpl.render({ ...ctx, sector, breaches: list, page: p });
        const route = p === 1 ? `/sector/${sector}` : `/sector/${sector}/${p}`;
        guardPage(route, html);
        written.push(writePage(route, html));
        addToSitemap(route, lastmod);
      }
    }
  }

  const yearTpl = dynamic('/breaches/[year]', 'year-archive');
  if (yearTpl) {
    const byYear = new Map();
    for (const b of published) {
      const y = (b.notification_date || '').slice(0, 4);
      if (!/^\d{4}$/.test(y)) continue;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(b);
    }
    const years = [...byYear.keys()];
    for (const [year, list] of byYear) {
      const totalPages = pageCount(list.length);
      const lastmod = latestUpdate(list);
      for (let p = 1; p <= totalPages; p++) {
        const html = yearTpl.render({ ...ctx, year, breaches: list, years, page: p });
        const route = p === 1 ? `/breaches/${year}` : `/breaches/${year}/${p}`;
        guardPage(route, html);
        written.push(writePage(route, html));
        addToSitemap(route, lastmod);
      }
    }
  }

  // State breach-notification rights. Static reference content: it depends on
  // the seeded statute table, not on any ingested breach, so it publishes as
  // soon as its route is active.
  // The /rights index itself is a static route, rendered by the loop above.
  const stateRightsTpl = dynamic('/rights/[state]', 'state-rights');
  if (stateRightsTpl) {
    for (const state of stateRights) {
      const html = stateRightsTpl.render({ ...ctx, state, states: stateRights });
      const route = `/rights/${state.state_code.toLowerCase()}`;
      guardPage(route, html);
      written.push(writePage(route, html));
      addToSitemap(route, state.last_verified);
    }
  }

  // Pages platform files
  //
  // Sitemap. Every indexable route recorded during generation above, so it
  // cannot list a page the build did not write or omit one it did. The 404 is
  // never included: it is served noindex.
  //
  // The sitemap protocol caps a single file at 50,000 URLs / 50 MB. Past that
  // the build shards and emits an index, because a sitemap over the cap is
  // rejected wholesale rather than truncated.
  const SITEMAP_MAX_URLS = 45000; // headroom under the 50,000 protocol cap
  const xmlEscape = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const urlsetXml = (entries) =>
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    entries
      .map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc><lastmod>${xmlEscape(u.lastmod)}</lastmod></url>`)
      .join('\n') +
    '\n</urlset>\n';

  // A duplicated <loc> is a build error, not something to publish: it means two
  // routes resolved to one URL and one of them is silently unreachable.
  const seenLoc = new Map();
  for (const entry of sitemap) {
    if (seenLoc.has(entry.loc)) {
      throw new Error(`build guard failed: two routes claim the sitemap URL ${entry.loc}`);
    }
    seenLoc.set(entry.loc, true);
  }

  const sitemapFiles = [];
  if (sitemap.length > SITEMAP_MAX_URLS) {
    const shards = [];
    for (let i = 0; i < sitemap.length; i += SITEMAP_MAX_URLS) {
      shards.push(sitemap.slice(i, i + SITEMAP_MAX_URLS));
    }
    shards.forEach((shard, i) => {
      const name = `sitemap-${i + 1}.xml`;
      fs.writeFileSync(path.join(OUT, name), urlsetXml(shard));
      sitemapFiles.push(name);
    });
    fs.writeFileSync(
      path.join(OUT, 'sitemap.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        sitemapFiles
          .map((n) => `  <sitemap><loc>${xmlEscape(`${origin}/${n}`)}</loc><lastmod>${buildDate}</lastmod></sitemap>`)
          .join('\n') +
        '\n</sitemapindex>\n'
    );
  } else {
    fs.writeFileSync(path.join(OUT, 'sitemap.xml'), urlsetXml(sitemap));
  }

  // robots.txt. The Sitemap: directive matters at this scale — without it a
  // crawler has to discover 15,000+ URLs by link-walking the hub pages alone.
  //
  // Every crawler is allowed, AI training crawlers included, and that is a
  // decision rather than an omission — so it is written down here rather than
  // left to be inferred from the absence of a Disallow. This site exists to be
  // a citable public record; being quoted, referenced and surfaced serves that
  // purpose, and the underlying facts are government filings the site does not
  // own. To reverse it, add per-agent Disallow blocks above the wildcard.
  fs.writeFileSync(path.join(OUT, 'd390aee0a606d453b3585684871efd3e.txt'), 'd390aee0a606d453b3585684871efd3e');
  fs.writeFileSync(
    path.join(OUT, 'robots.txt'),
    [
      '# BreachBook is a public record of government breach filings.',
      '# All crawlers, including AI training crawlers, are deliberately allowed:',
      '# see /about/ and /sources/ for what this record is and how it is compiled.',
      'User-agent: *',
      'Allow: /',
      '',
      `Sitemap: ${origin}/sitemap.xml`,
      '',
    ].join('\n')
  );
  // Security headers for Cloudflare Pages. The CSP is CONTENT_SECURITY_POLICY
  // above: one same-origin stylesheet, same-origin scripts (the GA4 bootstrap,
  // /scan), and only the analytics hosts. Revisit style-src if a template ever
  // needs an inline width (severity bars).
  fs.writeFileSync(
    path.join(OUT, '_headers'),
    [
      '/*',
      '  X-Content-Type-Options: nosniff',
      '  X-Frame-Options: DENY',
      '  Referrer-Policy: strict-origin-when-cross-origin',
      '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
      `  Content-Security-Policy: ${CONTENT_SECURITY_POLICY}`,
      '  Cross-Origin-Opener-Policy: same-origin',
      // 6 months, no preload: long enough to protect returning visitors,
      // short enough to back out of without a browser-list removal request.
      '  Strict-Transport-Security: max-age=15552000; includeSubDomains',
      '',
      // Content-hashed filenames, so a year of caching is safe and a restyle
      // still reaches returning visitors immediately under its new name.
      '/assets/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '',
    ].join('\n')
  );
  const notFound = require(path.join(TEMPLATES, '404.js')).render(ctx);
  guardPage('/404', notFound);
  fs.writeFileSync(path.join(OUT, '404.html'), notFound);

  console.log(
    `build complete: ${written.length + 1} pages, ${published.length} published breaches, ` +
      `${sitemap.length} sitemap URLs (phase ${config.buildPhase})`
  );
}

// Running the file builds; requiring it exposes the guards for testing. The
// zero-JS guard is security-critical, so it must be reachable by a test
// without also running a full build.
if (require.main === module) {
  main();
}

module.exports = { guardPage, publishableBreaches, EMOJI_RE, LD_JSON_BLOCK, CONTENT_SECURITY_POLICY };
