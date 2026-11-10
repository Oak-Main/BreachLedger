#!/usr/bin/env node
// legal-build.mjs — renders the site's missing legal pages from legal/templates and
// legal/legal.config.json, and FAILS CLOSED while any {{TOKEN}} in the config is
// unresolved, so nothing ships with a placeholder. Added 2026-11-09 (away run);
// owner review required before merge.
//
//   node scripts/legal-build.mjs --check-only        exit 1 if any token is unresolved
//   node scripts/legal-build.mjs --out dist          check, then write <out>/<page>/index.html
//                                                    for each page in config.pages that the
//                                                    site's own build did not already produce,
//                                                    and add the inline affiliate notice to
//                                                    pages that carry an affiliate link.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const args = process.argv.slice(2)
const checkOnly = args.includes('--check-only')
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? path.resolve(root, args[outIdx + 1]) : null

const cfg = JSON.parse(readFileSync(path.join(root, 'legal/legal.config.json'), 'utf8'))
const TOKEN = /\{\{[A-Z_]+\}\}/
const unresolved = Object.entries(cfg).filter(([, v]) => typeof v === 'string' && TOKEN.test(v)).map(([k, v]) => `${k}=${v}`)
if (unresolved.length) {
  console.error(`legal-build: FAIL CLOSED — unresolved legal token(s): ${unresolved.join(', ')}`)
  console.error('legal-build: set them in legal/legal.config.json (owner decision) before this site can build.')
  process.exit(1)
}
console.log('legal-build: all legal tokens resolved')
if (checkOnly || !out) process.exit(0)

const fill = (s) => s
  .replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
    const key = k.toLowerCase()
    if (key === 'analytics_list') return (cfg.analytics || []).map((a) => `<li>${a}</li>`).join('') || '<li>None</li>'
    if (key === 'amazon_sentence') return cfg.amazon ? '<p>As an Amazon Associate I earn from qualifying purchases.</p>' : ''
    const v = cfg[key]
    if (v === undefined) throw new Error(`legal-build: template token {{${k}}} has no config value`)
    return String(v)
  })
const shell = (title, body) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - ${cfg.site_name}</title>
<link rel="canonical" href="${cfg.site_url.replace(/\/$/, '')}/${cfg.slugs[title]}/">
</head>
<body>
<main style="max-width:44rem;margin:3rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.6">
<p><a href="/">${cfg.site_name}</a></p>
${body}
</main>
</body>
</html>
`
const titles = { privacy: 'Privacy Policy', terms: 'Terms of Use', 'affiliate-disclosure': 'Affiliate Disclosure' }
cfg.slugs = Object.fromEntries(Object.entries(titles).map(([k, t]) => [t, k]))
for (const page of cfg.pages) {
  const dest = path.join(out, page, 'index.html')
  if (existsSync(dest) || existsSync(path.join(out, `${page}.html`))) { console.log(`legal-build: ${page} already built by the site; left alone`); continue }
  const tpl = readFileSync(path.join(root, 'legal/templates', `${page}.html`), 'utf8')
  mkdirSync(path.dirname(dest), { recursive: true })
  writeFileSync(dest, shell(titles[page], fill(tpl)), 'utf8')
  console.log(`legal-build: wrote ${path.relative(root, dest)}`)
}

// Inline notice: only on pages that actually carry an affiliate link.
const AFF = /<a\b[^>]*(rel="[^"]*\bsponsored\b[^"]*"|href="[^"]*(amazon\.[a-z.]+\/[^"]*[?&]tag=|\/go\/)[^"]*")/i
const NOTICE = `<p class="affiliate-disclosure-inline" style="font-size:.9em;opacity:.85">This page contains affiliate links. ${cfg.site_name} may earn a commission if you buy through them, at no extra cost to you. <a href="${cfg.disclosure_url}">Affiliate disclosure</a>.</p>`
let tagged = 0
const walk = (d) => { for (const f of readdirSync(d)) { const p = path.join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.html')) {
  let h = readFileSync(p, 'utf8')
  if (!AFF.test(h) || h.includes('affiliate-disclosure-inline')) continue
  const m = h.match(/<main\b[^>]*>/i) || h.match(/<body\b[^>]*>/i)
  if (!m) continue
  h = h.replace(m[0], m[0] + NOTICE); writeFileSync(p, h, 'utf8'); tagged++ } } }
walk(out)
console.log(`legal-build: inline affiliate notice added to ${tagged} page(s) with affiliate links`)
