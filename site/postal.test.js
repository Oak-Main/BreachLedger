'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { legalPostalAddress, parseUsAddress, fillPostalAddress } = require('./postal.js');
const config = require('../ue.config.js');

test('the publisher address comes from legal/legal.config.json', () => {
  const address = legalPostalAddress();
  const p = config.site?.publisher ?? config.publisher;
  assert.equal(`${p.streetAddress}, ${p.addressLocality}, ${p.addressRegion} ${p.postalCode}`, address);
});

test('parses a US address with a suite', () => {
  assert.deepEqual(parseUsAddress('1223 Cleveland Ave, Suite 200, San Diego, CA 92103'), {
    streetAddress: '1223 Cleveland Ave, Suite 200', addressLocality: 'San Diego', addressRegion: 'CA', postalCode: '92103',
  });
});

test('docs carry the token, never a written-out address', () => {
  for (const f of ['about.md', 'privacy.md', 'SOURCES.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'docs', f), 'utf8');
    assert.ok(text.includes('{{POSTAL_ADDRESS}}'), `${f} lost its token`);
    assert.ok(!/Sacramento|2108 N St/.test(text), `${f} still prints the old address`);
    assert.ok(!fillPostalAddress(text).includes('{{POSTAL_ADDRESS}}'));
  }
});

test('refuses an unresolved token in the legal config', () => {
  const tmp = path.join(require('os').tmpdir(), `legal-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ postal_address: '{{POSTAL_ADDRESS}}' }));
  assert.throws(() => legalPostalAddress(tmp), /not set/);
  fs.unlinkSync(tmp);
});
