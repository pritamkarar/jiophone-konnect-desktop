'use strict';
const { normaliseIndian } = require('../../shared/phone');

const PEOPLE_ENDPOINT = 'https://people.googleapis.com/v1/people/me/connections';
// names and phoneNumbers only. Asking for more would be reading data we have
// no use for, from an address book we promised only to read narrowly.
const PERSON_FIELDS = 'names,phoneNumbers';
const PAGE_SIZE = 1000;

// One Google person -> the shape store.upsertContacts() already accepts, or
// null when there is nothing dialable. numbers[i] and raw[i] are positional
// partners: the store binds raw[i] as number_raw for numbers[i].
function mapPerson(person) {
  const numbers = [];
  const raw = [];
  for (const entry of person.phoneNumbers || []) {
    const normalised = normaliseIndian(entry.value);
    if (!normalised) continue;
    // Google allows one number under two labels; both normalise identically
    // and the second would collide on UNIQUE (uid, number_e164).
    if (numbers.includes(normalised)) continue;
    numbers.push(normalised);
    raw.push(entry.value);
  }
  // A contact with no number can never match a call. This is a dialer.
  if (numbers.length === 0) return null;
  return {
    uid: `google:${person.resourceName}`,
    // contacts.name is NOT NULL, and a blank name renders as an empty row.
    name: person.names?.[0]?.displayName?.trim() || raw[0],
    numbers,
    raw,
    type: person.phoneNumbers?.[0]?.type || null,
  };
}

async function syncContacts({ auth, store, now = () => new Date() }) {
  const people = [];
  let pageToken = null;
  do {
    const url = new URL(PEOPLE_ENDPOINT);
    url.search = new URLSearchParams({
      personFields: PERSON_FIELDS,
      pageSize: String(PAGE_SIZE),
      ...(pageToken ? { pageToken } : {}),
    }).toString();
    const res = await auth.authedFetch(url.toString());
    if (!res.ok) {
      throw new Error(`Google Contacts returned ${res.status}: ${await res.text()}`);
    }
    const page = await res.json();
    for (const person of page.connections || []) {
      const mapped = mapPerson(person);
      if (mapped) people.push(mapped);
    }
    const nextToken = page.nextPageToken || null;
    // A paginator that repeats a token would spin this do/while forever,
    // hammering the API from a path reachable at app startup. `pageToken`
    // here is still the token that fetched the page just read, so this
    // catches the repeat before issuing the request that never ends.
    if (nextToken && nextToken === pageToken) {
      throw new Error(`Google Contacts repeated pageToken ${nextToken}; aborting pagination`);
    }
    pageToken = nextToken;
  } while (pageToken);

  // Written only after EVERY page succeeded. A partial pull that recorded a
  // timestamp would look like a healthy sync.
  const { added, updated } = store.upsertContacts(people, 'google');
  store.setSetting('google_contacts_synced_at', now().toISOString());
  auth.clearError?.();
  return { added, updated, people: people.length };
}

module.exports = { PEOPLE_ENDPOINT, PERSON_FIELDS, mapPerson, syncContacts };
