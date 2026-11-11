// Utility Engine site configuration for BreachBook.
// The build (site/build.js) is static-first: it reads the build-time D1 export
// from site/data/, renders templates from site/templates/, and writes the full
// site to dist/ for Cloudflare Pages. Anything that must not trigger a rebuild
// (settlement countdowns, "added this week") is served from KV by workers/api.

const { legalPostalAddress, parseUsAddress } = require('./site/postal.js');
const publisherAddress = parseUsAddress(legalPostalAddress());

module.exports = {
  site: {
    name: 'BreachBook',
    tagline: 'A public record of disclosed U.S. data breaches',
    // Live origin. Override with SITE_ORIGIN at build time for preview
    // deployments so canonical URLs match the host actually serving them.
    origin: process.env.SITE_ORIGIN || 'https://breachbook.org',
    language: 'en-US',

    // Publisher of record. Named on /about, in the footer, and in the
    // Organization and Dataset structured data. This is YMYL content — breach
    // records, exposure of medical and Social Security data, statutory
    // deadlines — where an identifiable, contactable publisher is part of what
    // makes the record credible rather than merely available.
    publisher: {
      name: 'Oak and Main Developers LLC',
      // From legal/legal.config.json (site/postal.js): one address site-wide.
      ...publisherAddress,
      addressCountry: 'US',
      email: 'corrections@breachbook.org',
    },

    // Google Analytics 4 measurement ID for this site's own GA4 property.
    // Delivered in-page: templates/layout.js emits the gtag.js loader, and the
    // build writes the bootstrap as a same-origin file (assets/ga4.<hash>.js)
    // because the CSP allows no inline script. Disclosed on /privacy.
    ga4MeasurementId: 'G-6KG8DVBHJG',
  },

  paths: {
    templates: 'site/templates',
    content: 'site/content',
    data: 'site/data', // build-time D1 export (JSON); absent files render as empty sets
    assets: 'site/assets',
    docs: 'docs',
    out: 'dist',
  },

  // Route registry. `phase` gates generation: routes above the current build
  // phase render nothing and are excluded from sitemaps. This keeps
  // "empty-but-valid" honest — no thin placeholder pages for content that
  // does not exist yet (see spec sections 7 and 8, thin-content guard).
  buildPhase: 1,
  routes: [
    { path: '/', template: 'home', phase: 0 },
    { path: '/severity', template: 'severity', phase: 0 },
    { path: '/sources', template: 'sources', phase: 0 },
    { path: '/corrections', template: 'corrections', phase: 0 },
    { path: '/privacy', template: 'privacy', phase: 0 },
    { path: '/about', template: 'about', phase: 0 },
    { path: '/breach/[slug]', template: 'breach-detail', phase: 1 },
    // Interactive scanner: static shell + assets/scan.js against the TrueAPI
    // ingest worker's rate-limited /scan/* endpoints. noindex (tool page).
    { path: '/scan', template: 'scan', phase: 1, noindex: true, allowScript: true },
    // Remediation and state-rights pages are assembled from the seeded
    // reference tables (remediation_modules, state_rights), which are complete
    // and verified. Neither depends on the Phase 2 state-AG ingest, so holding
    // them back only kept written, sourced guidance off the site.
    { path: '/breach/[slug]/what-to-do', template: 'remediation', phase: 1 },
    { path: '/company/[slug]', template: 'entity-hub', phase: 2 },
    { path: '/sector/[sector]', template: 'sector-hub', phase: 1 },
    { path: '/breaches/[year]', template: 'year-archive', phase: 1 },
    { path: '/settlements', template: 'settlement-index', phase: 4 },
    { path: '/settlements/[slug]', template: 'settlement-detail', phase: 4 },
    { path: '/settlements/deadlines', template: 'deadline-calendar', phase: 4 },
    { path: '/rights', template: 'state-rights-index', phase: 1 },
    { path: '/rights/[state]', template: 'state-rights', phase: 1 },
    { path: '/guides/[slug]', template: 'guide', phase: 3 },
  ],
};
