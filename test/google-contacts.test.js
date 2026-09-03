const test = require('node:test');
const assert = require('node:assert');
const { openStore } = require('../src/main/store');
const { mapPerson, syncContacts } = require('../src/main/google/contacts');

test('a person with several numbers becomes one row per normalised number', () => {
  const mapped = mapPerson({
    resourceName: 'people/c1',
    names: [{ displayName: 'Amma' }],
    phoneNumbers: [{ value: '098765 43210', type: 'mobile' }, { value: '+912212345678' }],
  });
  assert.strictEqual(mapped.uid, 'google:people/c1');
  assert.strictEqual(mapped.name, 'Amma');
  // The SAME normaliser the handset path uses, or caller-ID silently misses.
  assert.deepStrictEqual(mapped.numbers, ['+919876543210', '+912212345678']);
  // raw is positional: store binds c.raw[i] against numbers[i].
  assert.deepStrictEqual(mapped.raw, ['098765 43210', '+912212345678']);
  assert.strictEqual(mapped.type, 'mobile');
});

test('a person with no usable number is skipped entirely', () => {
  assert.strictEqual(mapPerson({ resourceName: 'people/c2', names: [{ displayName: 'No Phone' }] }), null);
  assert.strictEqual(mapPerson({ resourceName: 'people/c3', phoneNumbers: [{ value: '   ' }] }), null);
});

test('an unnamed person falls back to their number, never an empty name', () => {
  // contacts.name is NOT NULL; an empty string would also render as a blank
  // row in the contact list.
  const mapped = mapPerson({ resourceName: 'people/c4', phoneNumbers: [{ value: '9876543210' }] });
  assert.strictEqual(mapped.name, '9876543210');
});

test('a number repeated within one person is stored once', () => {
  // Google lets the same number sit under two labels (mobile and main).
  // Both normalise identically, and the second would collide on
  // UNIQUE(uid, number_e164) and be miscounted as an update.
  const mapped = mapPerson({
    resourceName: 'people/c5', names: [{ displayName: 'Dup' }],
    phoneNumbers: [{ value: '9876543210' }, { value: '+919876543210' }],
  });
  assert.deepStrictEqual(mapped.numbers, ['+919876543210']);
});

// Serves a paged People API response and records the URLs requested.
function fakeAuth(pages) {
  const urls = [];
  return {
    urls,
    errors: [],
    authedFetch: async (url) => {
      urls.push(String(url));
      const page = pages.shift();
      if (!page) throw new Error(`unexpected request to ${url}`);
      return { ok: true, status: 200, json: async () => page, text: async () => '' };
    },
    setError(m) { this.errors.push(m); },
    clearError() { this.errors.length = 0; },
  };
}

test('syncContacts follows nextPageToken and stops at the last page', async () => {
  const store = openStore(':memory:');
  const auth = fakeAuth([
    { connections: [{ resourceName: 'people/c1', names: [{ displayName: 'A' }],
      phoneNumbers: [{ value: '9000000001' }] }], nextPageToken: 'page2' },
    { connections: [{ resourceName: 'people/c2', names: [{ displayName: 'B' }],
      phoneNumbers: [{ value: '9000000002' }] }] },
  ]);
  const res = await syncContacts({ auth, store, now: () => new Date('2026-09-02T10:00:00Z') });
  assert.deepStrictEqual({ added: res.added, updated: res.updated }, { added: 2, updated: 0 });
  assert.strictEqual(auth.urls.length, 2);
  assert.ok(!auth.urls[0].includes('pageToken'));
  assert.ok(auth.urls[1].includes('pageToken=page2'));
  // Read-only: personFields never asks for anything we are not scoped to read.
  assert.ok(auth.urls[0].includes('personFields=names%2CphoneNumbers'));
  assert.strictEqual(store.listContacts().length, 2);
  store.close();
});

test('synced google contacts are tagged google and outrank handset rows', async () => {
  const store = openStore(':memory:');
  store.upsertContacts([{ uid: 'h1', name: 'Mom', numbers: ['+919876543210'] }]);
  const auth = fakeAuth([{ connections: [{ resourceName: 'people/c1',
    names: [{ displayName: 'Amma' }], phoneNumbers: [{ value: '9876543210' }] }] }]);
  await syncContacts({ auth, store, now: () => new Date('2026-09-02T10:00:00Z') });
  assert.strictEqual(store.findContactByNumber('+919876543210').name, 'Amma');
  assert.strictEqual(store.listContacts().length, 1);
  store.close();
});

test('a successful sync records its timestamp and clears any previous error', async () => {
  const store = openStore(':memory:');
  store.setSetting('google_last_error', 'an old failure');
  const auth = fakeAuth([{ connections: [] }]);
  await syncContacts({ auth, store, now: () => new Date('2026-09-02T10:00:00Z') });
  assert.strictEqual(store.getSetting('google_contacts_synced_at'), '2026-09-02T10:00:00.000Z');
  assert.deepStrictEqual(auth.errors, []);
  store.close();
});

test('a failed page leaves the timestamp untouched so the failure is visible', async () => {
  const store = openStore(':memory:');
  const auth = {
    errors: [],
    authedFetch: async () => ({ ok: false, status: 503, text: async () => 'backend error' }),
    setError(m) { this.errors.push(m); },
    clearError() {},
  };
  await assert.rejects(syncContacts({ auth, store, now: () => new Date() }), /503/);
  assert.strictEqual(store.getSetting('google_contacts_synced_at'), null);
  store.close();
});

test('a numberless person mixed into a real page is skipped, not just in isolation', async () => {
  // mapPerson returning null is covered directly above; this exercises the
  // `if (mapped) people.push(mapped)` guard in syncContacts itself, on a
  // page shaped like a real account: some people dialable, some not.
  const store = openStore(':memory:');
  const auth = fakeAuth([{ connections: [
    { resourceName: 'people/c1', names: [{ displayName: 'Valid' }],
      phoneNumbers: [{ value: '9000000001' }] },
    { resourceName: 'people/c2', names: [{ displayName: 'No Phone' }] },
    { resourceName: 'people/c3', names: [{ displayName: 'Blank' }],
      phoneNumbers: [{ value: '   ' }] },
  ] }]);
  const res = await syncContacts({ auth, store, now: () => new Date('2026-09-02T10:00:00Z') });
  assert.deepStrictEqual({ added: res.added, updated: res.updated }, { added: 1, updated: 0 });
  assert.strictEqual(store.listContacts().length, 1);
  store.close();
});

test('a repeated nextPageToken aborts instead of paginating forever', { timeout: 2000 }, async () => {
  // If Google ever hands back the same token twice, an unguarded do/while
  // loops forever issuing requests from a path reachable at app startup.
  const store = openStore(':memory:');
  const auth = fakeAuth([
    { connections: [], nextPageToken: 'stuck' },
    { connections: [], nextPageToken: 'stuck' },
  ]);
  await assert.rejects(syncContacts({ auth, store, now: () => new Date() }), /stuck/);
  assert.strictEqual(auth.urls.length, 2);
  store.close();
});
