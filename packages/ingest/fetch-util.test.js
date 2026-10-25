// fetch-util.js is the policy layer every source parser sits behind: identify
// ourselves, rate-limit per host, bound every request, checksum the payload,
// and record where the response actually came from after redirects. Every
// sibling parser has tests; this gate they all share had none.
//
// THE TIMESTAMP CONTRACT (this file is the specification of it):
//
//   retrieved_at is the local UTC wall-clock instant sampled when a successful
//   response body has FINISHED being read and is being packaged for return.
//
// It is not the request start, not the header arrival, not the source's
// publication time, not a breach date, not the workflow's completion time, and
// not the deploy time. It is the moment the bytes of that body were in hand.
//
// The value is an ISO-8601 UTC string with millisecond precision.
//
// WHY THIS FILE USES A CONTROLLED CLOCK
//
// The obvious way to assert "the stamp is now" is to compare it with another
// reading of now:
//
//     assert.equal(out.retrieved_at, new Date().toISOString());   // WRONG
//
// That compares two independent readings of a moving clock. The production
// stamp is taken when the body read completes; the assertion's reading is
// taken later, after the promise has resolved and the test has resumed. The
// two readings can straddle a millisecond boundary and differ by 1ms with no
// production defect whatsoever. Observed on the live workflow: run
// 40185682174 (attempt 1) failed with actual ".251Z" against expected
// ".252Z" -- the same instant, one millisecond apart.
//
// The fix is not to loosen the assertion and not to make production return a
// test-specific constant or stamp at request start. It is to remove the
// moving target: the expectation must be a LITERAL fixed instant, chosen by
// the test and independent of the implementation, and the production clock
// must be under the test's control at the moment it is sampled.
//
// The controlled clock is node:test's own per-test-context Date-only mock:
//
//     t.mock.timers.enable({ apis: ['Date'], now: FIXED_EPOCH_MS });
//
// apis: ['Date'] mocks ONLY Date. setTimeout, setInterval and AbortSignal
// timeouts keep running on the real clock, so retry delays and request
// timeouts are not frozen. The mock is scoped to the test that enabled it and
// is restored in a finally block, so a throwing test cannot leak it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const { politeFetch, sha256, USER_AGENT, MIN_INTERVAL_MS } = require('./fetch-util');

// --- The controlled clock's fixed instants ---------------------------------
//
// Written as literals, not computed from "now". FIXED_EPOCH_MS is the epoch
// the Date mock starts at; the ISO strings are the instants the test asserts
// against. The equality check below keeps the number and the strings from
// drifting apart, so an edit to one that misses the other fails loudly.

const FIXED_EPOCH_MS = 1792929600000;            // 2026-10-25T12:00:00.000Z
const T_REQUEST_START = '2026-10-25T12:00:00.000Z';
const T_RESPONSE      = '2026-10-25T12:00:00.250Z';
const T_BODY_DONE     = '2026-10-25T12:00:00.750Z';

assert.equal(Date.parse(T_REQUEST_START), FIXED_EPOCH_MS,
  'the fixed epoch and the request-start literal must be the same instant');

// A second trio that crosses a UTC date boundary, to prove the stamp follows
// the clock across midnight rather than being pinned to a day.
const DAY_EDGE_EPOCH_MS = Date.parse('2026-10-25T23:59:59.900Z');
const T_EDGE_START    = '2026-10-25T23:59:59.900Z';
const T_EDGE_RESPONSE = '2026-10-25T23:59:59.950Z';
const T_EDGE_BODY     = '2026-10-26T00:00:00.100Z';

/**
 * Stand up a fake global fetch and hand back the call log.
 *
 * `respond` receives (url, options) and returns a response-like object, so a
 * test can script redirects, cookies, and failures without a network.
 *
 * A response may also supply `text` as a function, so a test can make the
 * body read itself fail.
 */
function mockFetch(respond) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, opts, headers: opts.headers || {} });
    const res = (await respond(url, opts)) || {};
    return {
      ok: res.ok !== false,
      status: res.status || 200,
      statusText: res.statusText || 'OK',
      url: res.url === undefined ? url : res.url,
      redirected: res.redirected === true,
      headers: { getSetCookie: () => res.setCookie || [] },
      text: typeof res.text === 'function' ? res.text : async () => (res.body === undefined ? '' : res.body),
    };
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** A promise the test resolves by hand. No sleeps, no polling. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * A fake fetch whose response resolution and body resolution the test gates.
 *
 * `responseGate` holds the fetch promise pending; `bodyGate` holds the
 * `res.text()` promise pending. The test advances the controlled clock to a
 * chosen instant and only then releases a gate, so the instant at which the
 * body finished is known exactly instead of hoped for. `bodyStarted` resolves
 * the moment the body read actually begins, which is how a test knows the
 * code has reached the point where it will sample the clock.
 */
function mockGatedFetch({ body = 'x', responseGate = null, bodyGate = null } = {}) {
  const real = globalThis.fetch;
  const state = {
    calls: [],
    bodyStarted: deferred(),
    restore: () => { globalThis.fetch = real; },
  };

  globalThis.fetch = async (url, opts = {}) => {
    state.calls.push({ url, opts, headers: opts.headers || {} });
    if (responseGate) await responseGate.promise;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      redirected: false,
      headers: { getSetCookie: () => [] },
      text: async () => {
        state.bodyStarted.resolve();
        if (bodyGate) await bodyGate.promise;
        return body;
      },
    };
  };
  return state;
}

// Canonical ISO-8601 UTC instant, millisecond precision, always 'Z'.
const CANONICAL_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Assert that `actual` is the retrieval instant `expected`.
 *
 * Four separate properties, each of which can fail on its own:
 *   1. it is present and is a string;
 *   2. it is a canonical ISO-8601 UTC instant with millisecond precision;
 *   3. it is a real calendar instant (it round-trips unchanged -- note that
 *      2026-02-30 does NOT become an Invalid Date, it silently rolls over to
 *      2026-03-01, so only the round-trip catches it);
 *   4. it is EXACTLY the expected instant -- no tolerance, no truncation to
 *      the second, no "close enough".
 */
function assertRetrievalInstant(actual, expected, label = 'retrieved_at') {
  assert.equal(typeof actual, 'string', `${label} must be an ISO-8601 string`);
  assert.match(actual, CANONICAL_ISO_UTC,
    `${label} must be a canonical ISO-8601 UTC instant with millisecond precision`);
  const parsed = new Date(actual).getTime();
  assert.ok(Number.isFinite(parsed), `${label} must be a parseable instant`);
  assert.equal(new Date(parsed).toISOString(), actual,
    `${label} must be a real calendar instant`);
  assert.equal(actual, expected,
    `${label} must be exactly the expected retrieval instant`);
}

// Each test uses a distinct host. The rate limiter is module-level state keyed
// by host and never reset, so sharing a host would make tests order-dependent.
let seq = 0;
const uniqHost = () => `host-${process.pid}-${seq++}.example`;
// Clock-mocked cases get their own namespace. The rate limiter's nextSlotAt
// map is module-level and keyed by host and is never reset, so a slot reserved
// while the clock was frozen in the fake era must never be visible to a
// real-clock case. Distinct hosts keep the two eras apart without resetting
// unrelated module state.
const mockHost = () => `mockhost-${process.pid}-${seq++}.example`;

test('identifies itself with a descriptive User-Agent carrying a contact URL', async () => {
  // Required by SEC EDGAR policy and basic courtesy to the state portals.
  const { calls, restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await politeFetch(`https://${uniqHost()}/data`);
  } finally {
    restore();
  }
  assert.equal(calls[0].headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /https:\/\/breachbook\.org\//);
});

test('a caller-supplied header is kept, and can override the default User-Agent', async () => {
  const { calls, restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await politeFetch(`https://${uniqHost()}/data`, {
      headers: { 'Accept': 'text/csv', 'User-Agent': 'custom/9' },
    });
  } finally {
    restore();
  }
  assert.equal(calls[0].headers.Accept, 'text/csv');
  assert.equal(calls[0].headers['User-Agent'], 'custom/9');
});

test('checksums the body so an unchanged export is recognizable', async () => {
  const body = 'Name of Covered Entity,State\nAcme Clinic,CA\n';
  const { restore } = mockFetch(async () => ({ body }));
  let out;
  try {
    out = await politeFetch(`https://${uniqHost()}/data`);
  } finally {
    restore();
  }
  assert.equal(out.checksum, crypto.createHash('sha256').update(body).digest('hex'));
  assert.equal(out.body, body);
});

// --- The retrieval instant -------------------------------------------------

test('an immediate success is stamped at the instant its body resolved', async (t) => {
  // Nothing is gated, so the body resolves as soon as the response does, and
  // the controlled clock has not moved since the request started. The stamp
  // must therefore be exactly that instant -- not "roughly now".
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_EPOCH_MS });
  const { restore } = mockFetch(async () => ({ body: 'x' }));
  try {
    const out = await politeFetch(`https://${mockHost()}/data`);
    assertRetrievalInstant(out.retrieved_at, T_REQUEST_START);
  } finally {
    restore();
    t.mock.timers.reset();
  }
});

test('a delayed response is stamped when the body completes, not when the response arrived', async (t) => {
  // The response is held back; the body then reads immediately on arrival.
  // The stamp is the body-completion instant, which here equals the response
  // instant -- and is NOT the request-start instant.
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_EPOCH_MS });
  const responseGate = deferred();
  const { restore, bodyStarted } = mockGatedFetch({ body: 'x', responseGate });
  try {
    const pending = politeFetch(`https://${mockHost()}/data`);
    assert.equal(new Date().toISOString(), T_REQUEST_START);

    t.mock.timers.tick(250);
    responseGate.resolve();
    await bodyStarted.promise;

    const out = await pending;
    assertRetrievalInstant(out.retrieved_at, T_RESPONSE);
    assert.notEqual(out.retrieved_at, T_REQUEST_START);
  } finally {
    restore();
    t.mock.timers.reset();
  }
});

test('a delayed body completion is stamped at the instant the body finished being read', async (t) => {
  // The full three-boundary case. Request start, response resolution and body
  // completion each get their own fixed instant, and the clock is advanced to
  // each in turn. The expectation is the literal body-completion instant.
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_EPOCH_MS });
  const responseGate = deferred();
  const bodyGate = deferred();
  const { restore, bodyStarted } = mockGatedFetch({ body: 'x', responseGate, bodyGate });
  try {
    const pending = politeFetch(`https://${mockHost()}/data`);

    // Boundary 1: request start.
    assert.equal(new Date().toISOString(), T_REQUEST_START);

    // Boundary 2: the response arrives.
    t.mock.timers.tick(250);
    responseGate.resolve();
    await bodyStarted.promise;
    assert.equal(new Date().toISOString(), T_RESPONSE);

    // Boundary 3: the body finishes being read.
    t.mock.timers.tick(500);
    bodyGate.resolve();

    const out = await pending;
    assertRetrievalInstant(out.retrieved_at, T_BODY_DONE);
    assert.notEqual(out.retrieved_at, T_REQUEST_START, 'must not be the request-start instant');
    assert.notEqual(out.retrieved_at, T_RESPONSE, 'must not be the response-arrival instant');

    // Advancing the clock again must not disturb the stamp: the retrieval
    // instant is a past event, not a live reading.
    t.mock.timers.tick(5000);
    assertRetrievalInstant(out.retrieved_at, T_BODY_DONE);
  } finally {
    restore();
    t.mock.timers.reset();
  }
});

test('a clock tick across a UTC date boundary is stamped on the new UTC day', async (t) => {
  // The stamp follows the clock across midnight. A implementation that took
  // the date part from somewhere else, or that truncated to the day, would
  // land on 2026-10-25 instead of 2026-10-26.
  t.mock.timers.enable({ apis: ['Date'], now: DAY_EDGE_EPOCH_MS });
  const responseGate = deferred();
  const bodyGate = deferred();
  const { restore, bodyStarted } = mockGatedFetch({ body: 'x', responseGate, bodyGate });
  try {
    const pending = politeFetch(`https://${mockHost()}/data`);
    assert.equal(new Date().toISOString(), T_EDGE_START);

    t.mock.timers.tick(50);
    responseGate.resolve();
    await bodyStarted.promise;
    assert.equal(new Date().toISOString(), T_EDGE_RESPONSE);

    t.mock.timers.tick(150);
    bodyGate.resolve();

    const out = await pending;
    assertRetrievalInstant(out.retrieved_at, T_EDGE_BODY);
    assert.equal(out.retrieved_at.slice(0, 10), '2026-10-26', 'the stamp must carry the new UTC day');
    assert.equal(out.retrieved_at, '2026-10-26T00:00:00.100Z');
  } finally {
    restore();
    t.mock.timers.reset();
  }
});

test('REGRESSION: the original assertion form breaks by one millisecond -- captured here, not left red', async (t) => {
  // The bug, reproduced deterministically.
  //
  // The original test was:
  //
  //     assert.equal(out.retrieved_at, new Date().toISOString());
  //
  // The production stamp is taken when the body read completes. That
  // comparison reads the clock a SECOND time, after the promise resolved and
  // the test resumed. One millisecond later the two readings differ, and the
  // assertion fails on a perfectly correct result.
  //
  // Here the clock is advanced by exactly one millisecond between the stamp
  // and the comparison, so the failure is reproduced every time rather than
  // depending on how the scheduler happened to line up.
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_EPOCH_MS });
  const { restore } = mockFetch(async () => ({ body: 'x' }));
  try {
    const out = await politeFetch(`https://${mockHost()}/data`);

    // The stamp, taken when the body resolved.
    assertRetrievalInstant(out.retrieved_at, T_REQUEST_START);

    // The clock moves on by exactly one millisecond.
    t.mock.timers.tick(1);
    const laterNow = new Date().toISOString();
    assert.equal(laterNow, '2026-10-25T12:00:00.001Z');

    // The original comparison is now broken, and is shown to be broken inside
    // a passing test rather than left to fail the suite.
    assert.notEqual(out.retrieved_at, laterNow,
      'the original comparison must be demonstrably wrong at a 1ms offset');
    assert.throws(
      () => assert.equal(out.retrieved_at, laterNow),
      assert.AssertionError,
      'the original assertion must be shown to fail at a 1ms offset',
    );

    // And the corrected expectation -- a literal instant, independent of the
    // implementation -- holds.
    assertRetrievalInstant(out.retrieved_at, T_REQUEST_START);
  } finally {
    restore();
    t.mock.timers.reset();
  }
});

test('the retrieval-instant check rejects a wrong timestamp rather than merely finding a field', () => {
  // Negative controls. Each of these must be rejected by the same check the
  // positive cases use. If the check only asserted "a field is present",
  // every one of these would pass.
  const EXPECTED = T_BODY_DONE;

  // Missing entirely.
  assert.throws(() => assertRetrievalInstant(undefined, EXPECTED), /must be an ISO-8601 string/);
  assert.throws(() => assertRetrievalInstant(null, EXPECTED), /must be an ISO-8601 string/);

  // Malformed.
  assert.throws(() => assertRetrievalInstant('not-a-date', EXPECTED), /canonical ISO-8601 UTC instant/);
  assert.throws(() => assertRetrievalInstant('2026-10-25 12:00:00.000Z', EXPECTED), /canonical ISO-8601 UTC instant/);

  // Impossible calendar date: 2026-02-30 silently rolls over to 2026-03-01,
  // so only the round-trip catches it.
  assert.throws(() => assertRetrievalInstant('2026-02-30T00:00:00.000Z', EXPECTED), /must be a real calendar instant/);

  // Well-formed but stale: a hardcoded constant.
  assert.throws(() => assertRetrievalInstant('2020-01-01T00:00:00.000Z', EXPECTED), /exactly the expected retrieval instant/);

  // Well-formed but the WRONG moment: the request-start instant.
  assert.throws(() => assertRetrievalInstant(T_REQUEST_START, EXPECTED), /exactly the expected retrieval instant/);

  // Well-formed but one millisecond out. This is the exact shape of the
  // failure the original assertion suffered.
  assert.throws(() => assertRetrievalInstant('2026-10-25T12:00:00.751Z', EXPECTED), /exactly the expected retrieval instant/);

  // The correct value is accepted.
  assertRetrievalInstant(EXPECTED, EXPECTED);
});

test('the check catches an intentionally wrong result from the real retrieval path', async (t) => {
  // Mutation proof. Take a genuine result off the real path, corrupt exactly
  // one field, and show the check catches it. This demonstrates the assertion
  // detects a wrong retrieval instant rather than merely confirming a field
  // exists.
  t.mock.timers.enable({ apis: ['Date'], now: FIXED_EPOCH_MS });
  const { restore } = mockFetch(async () => ({ body: 'x' }));
  try {
    const out = await politeFetch(`https://${mockHost()}/data`);
    assertRetrievalInstant(out.retrieved_at, T_REQUEST_START);

    const oneMillisLate = new Date(Date.parse(T_REQUEST_START) + 1).toISOString();
    const corrupted = { ...out, retrieved_at: oneMillisLate };
    assert.throws(
      () => assertRetrievalInstant(corrupted.retrieved_at, T_REQUEST_START),
      /exactly the expected retrieval instant/,
    );

    // A body read that produced nothing must not look like a retrieval.
    const missing = { ...out, retrieved_at: undefined };
    assert.throws(
      () => assertRetrievalInstant(missing.retrieved_at, T_REQUEST_START),
      /must be an ISO-8601 string/,
    );
  } finally {
    restore();
    t.mock.timers.reset();
  }
});

test('the mocked clock is restored: a later, independent case sees the real wall clock', () => {
  // Cleanup verification. If the Date mock leaked out of the cases above,
  // this case would see the frozen epoch instead of the real clock.
  const now = Date.now();
  assert.notEqual(now, FIXED_EPOCH_MS, 'the fixed mock epoch leaked into a later test');
  assert.notEqual(now, DAY_EDGE_EPOCH_MS, 'the day-edge mock epoch leaked into a later test');
  assert.ok(now > 1_700_000_000_000 && now < 4_000_000_000_000,
    `expected a real wall-clock reading, got ${now}`);
});

test('a failed request rejects; it never yields a timestamped result', async () => {
  const { restore } = mockFetch(async () => { throw new Error('ECONNREFUSED'); });
  try {
    await assert.rejects(
      () => politeFetch(`https://${uniqHost()}/data`),
      /ECONNREFUSED/,
    );
  } finally {
    restore();
  }
});

test('a failed body read rejects; it never yields a timestamped result', async () => {
  const { restore } = mockFetch(async () => ({
    text: async () => { throw new Error('socket hang up'); },
  }));
  try {
    await assert.rejects(
      () => politeFetch(`https://${uniqHost()}/data`),
      /socket hang up/,
    );
  } finally {
    restore();
  }
});

test('records the final URL and flags a redirect as a URL-rot signal', async () => {
  // Provenance: a 3xx-followed response comes from res.url, which may not be the
  // requested address. Callers must store the final URL, not the one they asked for.
  const { restore } = mockFetch(async (url) => ({
    body: 'x',
    url: `${url}/moved`,
    redirected: true,
  }));
  let out;
  try {
    out = await politeFetch('https://rot.example/a');
  } finally {
    restore();
  }
  assert.equal(out.final_url, 'https://rot.example/a/moved');
  assert.equal(out.redirected, true);
});

test('a non-redirected response is not flagged as one', async () => {
  const { restore } = mockFetch(async () => ({ body: 'x' }));
  let out;
  try {
    out = await politeFetch('https://plain.example/a');
  } finally {
    restore();
  }
  assert.equal(out.final_url, 'https://plain.example/a');
  assert.equal(out.redirected, false);
});

test('fails loudly on a non-2xx, naming the status and the URL', async () => {
  // Never skip a source silently: a rotated endpoint has to surface as a
  // failure of the whole run, not as a quietly shorter record set.
  const { restore } = mockFetch(async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
  }));
  try {
    await assert.rejects(
      () => politeFetch('https://gone.example/list'),
      (err) => {
        assert.match(err.message, /source fetch failed: 404 Not Found for https:\/\/gone\.example\/list/);
        return true;
      }
    );
  } finally {
    restore();
  }
});

test('replays the session cookie on a jar-bound request and absorbs the response cookie', async () => {
  // The HHS OCR portal is a stateful JSF app: the JSESSIONID has to travel
  // with the request sequence or the postback is answered as a new session.
  let cookies = new Map();
  const jar = {
    absorb(res) {
      for (const line of res.headers.getSetCookie()) {
        const pair = String(line).split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
  const { calls, restore } = mockFetch(async () => ({
    body: 'ok',
    setCookie: ['JSESSIONID=XYZ; Path=/; HttpOnly'],
  }));
  const host = uniqHost();
  try {
    // Nothing in the jar yet, so the first request carries no Cookie.
    await politeFetch(`https://${host}/export`, { jar });
    assert.ok(!('Cookie' in calls[0].headers));
    // The server issued a session on that call; the jar must replay it forward,
    // or the next postback is answered as a different session.
    await politeFetch(`https://${host}/export`, { jar });
    assert.equal(calls[1].headers.Cookie, 'JSESSIONID=XYZ');
  } finally {
    restore();
  }
  assert.equal(jar.header(), 'JSESSIONID=XYZ');
});

test('sends no Cookie header when no jar is supplied', async () => {
  const { calls, restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await politeFetch(`https://${uniqHost()}/data`);
  } finally {
    restore();
  }
  assert.ok(!('Cookie' in calls[0].headers));
});

test('bounds every request with a timeout signal', async () => {
  const { calls, restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await politeFetch(`https://${uniqHost()}/data`);
  } finally {
    restore();
  }
  const sig = calls[0].opts.signal;
  assert.ok(sig, 'request carried no AbortSignal');
  assert.equal(sig.aborted, false);
});

test('honours a caller-supplied signal instead of overwriting it', async () => {
  const { calls, restore } = mockFetch(async () => ({ body: 'ok' }));
  const mine = AbortSignal.timeout(5000);
  try {
    await politeFetch(`https://${uniqHost()}/data`, { signal: mine });
  } finally {
    restore();
  }
  assert.equal(calls[0].opts.signal, mine);
});

// timeoutMs is consumed for the signal and must not leak into the fetch options
// as a stray body field.
test('timeoutMs configures the signal without leaking into the request', async () => {
  const { calls, restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await politeFetch(`https://${uniqHost()}/data`, { timeoutMs: 1234, raw: true });
  } finally {
    restore();
  }
  assert.ok(!('timeoutMs' in calls[0].opts));
});

test('passes the remaining options through to fetch', async () => {
  const { calls, restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await politeFetch(`https://${uniqHost()}/data`, { method: 'POST', body: 'a=1' });
  } finally {
    restore();
  }
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body, 'a=1');
});

// --- Rate limiting ---------------------------------------------------------
// The slot is reserved synchronously before awaiting. That is what stops N
// concurrent callers all reading the same stale timestamp and bursting at once.
//
// These are REAL scheduling measurements, so they use a MONOTONIC clock
// (performance.now) rather than Date.now(): a wall clock can step backwards,
// and a mocked Date is not a duration measure at all. No clock mock is enabled
// in this section -- the fake clock is reserved for the timestamp cases above.

test('serializes concurrent callers to the same host at one request per interval', async () => {
  const host = uniqHost();
  const start = performance.now();
  const { restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await Promise.all([
      politeFetch(`https://${host}/a`),
      politeFetch(`https://${host}/b`),
      politeFetch(`https://${host}/c`),
    ]);
  } finally {
    restore();
  }
  // Three requests at >=1/sec means at least two full intervals of waiting.
  const elapsed = performance.now() - start;
  assert.ok(
    elapsed >= 2 * MIN_INTERVAL_MS - 25,
    `expected >= ${2 * MIN_INTERVAL_MS}ms of spacing, took ${elapsed}ms`
  );
});

test('does not delay the first request to a host', async () => {
  const start = performance.now();
  const { restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await politeFetch(`https://${uniqHost()}/a`);
  } finally {
    restore();
  }
  assert.ok(performance.now() - start < MIN_INTERVAL_MS / 2, 'the first request should not wait');
});

test('different hosts do not delay each other', async () => {
  const start = performance.now();
  const { restore } = mockFetch(async () => ({ body: 'ok' }));
  try {
    await Promise.all([
      politeFetch(`https://${uniqHost()}/a`),
      politeFetch(`https://${uniqHost()}/b`),
      politeFetch(`https://${uniqHost()}/c`),
    ]);
  } finally {
    restore();
  }
  assert.ok(performance.now() - start < MIN_INTERVAL_MS / 2, 'distinct hosts must not serialize against each other');
});

test('MIN_INTERVAL_MS enforces the documented <=1 req/sec per-host policy', () => {
  // The policy is a MAXIMUM request rate, so the interval is a LOWER BOUND.
  // The previous assertion (MIN_INTERVAL_MS <= 1000) pointed the wrong way: it
  // passed for 500ms -- two requests per second, a policy violation -- and it
  // would have failed for a deliberately slower 2000ms interval, which
  // satisfies the policy.
  assert.ok(
    MIN_INTERVAL_MS >= 1000,
    `per-host interval must be at least 1000ms (no more than one request per second), got ${MIN_INTERVAL_MS}`
  );
  // The configured value is the documented 1000ms.
  assert.equal(MIN_INTERVAL_MS, 1000, 'the configured per-host interval is the documented 1000ms');
});

// --- sha256 ----------------------------------------------------------------

test('sha256 matches the platform digest for known input', () => {
  assert.equal(sha256(''), crypto.createHash('sha256').update('').digest('hex'));
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('sha256 handles non-ASCII text as UTF-8', () => {
  assert.equal(sha256('naïve — ünïcodé'), crypto.createHash('sha256').update('naïve — ünïcodé', 'utf8').digest('hex'));
});

test('sha256 is content-addressed, so a changed byte changes the digest', () => {
  assert.notEqual(sha256('Acme Clinic,CA'), sha256('Acme Clinic,CB'));
});
