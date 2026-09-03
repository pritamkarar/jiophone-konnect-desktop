# Konnect — Google Account: Contacts Sync and Drive Backup

**Date:** 2026-09-02
**Status:** Design approved by user; implementation plan not yet written
**Builds on:** `2026-09-01-jiophone-konnect-design.md`, `2026-09-01-konnect-settings-wizard-design.md`
**Target platform:** Ubuntu 24.04 (Linux backend only; Windows remains stubbed)

---

## 1. Summary

Add an optional Google account to Konnect. Signing in buys three things:

| Capability | Direction | Default |
| --- | --- | --- |
| Google Contacts sync | Google → Konnect, read-only | On when signed in |
| Call-log backup | Konnect → Drive | On when signed in |
| Recording backup | Konnect → Drive | **Off** — explicit opt-in |

Sign-in is optional and reversible. Nothing in the app gates on it.

### 1.1 The load-bearing constraints

Four decisions taken at design time that the implementation is not free to revisit:

1. **Read-only contacts.** Konnect never writes to the user's Google address book.
   No write scope is requested, so a bug cannot corrupt real contact data.
2. **No new npm dependency.** Electron 44.1.0 runs Node 24.19.0 with global `fetch`.
   Three HTTPS endpoints do not justify `googleapis`. This matches a codebase that
   already hand-rolls D-Bus, vCard parsing, CSV escaping and HTTP range handling.
3. **Credentials never enter the repo.** Read from the environment or a gitignored
   config file; absent credentials disable the feature rather than failing at runtime.
4. **Google is best-effort, telephony is not.** No Google operation may delay, block
   or fail a call. This is an architectural invariant, not a quality goal — see §8.

---

## 2. Verified facts

Read from the developer machine and this repository on 2026-09-02, not assumed:

| Fact | Value | Source |
| --- | --- | --- |
| Electron | 44.1.0 | `electron --version` |
| Node inside Electron | 24.19.0 | `ELECTRON_RUN_AS_NODE=1 electron -e ...` |
| `fetch` | global, present | same |
| `node:sqlite` | present | same |
| Recording attach ordering | `attachRecording()` is awaited **before** `persist()` writes the row | `src/main/callsession.js:64-65` |
| Persist hook | `onPersisted: () => broadcast('calls:changed')` | `src/main/index.js:307` |
| Contact identity | `UNIQUE (uid, number_e164)`, `uid` from the handset vCard | `src/main/store.js` |
| Number normaliser | `normaliseIndian(input)`, plus `UNKNOWN_NUMBER` sentinel | `src/shared/phone.js:50` |
| Recordings dir | `~/Konnect/recordings` | `src/main/recordings.js` |
| `listCalls()` row cap | default `limit=200` truncates; `limit:-1` returns all (measured: 250 rows in, 200 vs 250 out) | `store.js` + live probe |
| Existing setting keys | `audio_mode`, `audio_sink`, `audio_source`, `device_mac`, `record_calls`, `ring_enabled`, `ring_sink`, `ring_tone` | grep over `src/` |

The ordering fact in row 5 is what makes §7 possible: by the time `onPersisted` fires,
the row's `recording_path` is already written, so one hook covers both the log and the
recording. A trigger placed anywhere else would race the encoder.

---

## 3. Non-goals

Deliberately excluded. Each is a decision, not an oversight:

- **No writes to Google Contacts.** No create, update, delete, photo or group support.
- **No restore from Drive.** Backup is one-way. Restore is a separate feature with its
  own conflict semantics and deserves its own spec.
- **No multi-account.** One Google account at a time.
- **No scheduler or timers.** Every sync is triggered by an event the app already emits.
- **No onboarding sign-in step.** Google lives in Settings only. Adding a skippable
  step to the 1a–1e wizard is a later, independent change.
- **No sync of contacts without phone numbers.** This is a dialer; a numberless
  contact is a row that can never match a call.

---

## 4. Credentials and configuration

### 4.1 Sources, in order

1. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from the environment.
2. `~/.config/konnect/google.json` — `{ "client_id": "...", "client_secret": "..." }`.

If neither yields a client id, the feature is **unconfigured**: the Settings section
renders a single disabled line, and every Google IPC handler returns
`{ configured: false }` without touching the network.

`client_secret` is optional. Google issues one for Desktop-app clients, but PKCE is what
actually secures the exchange; the code sends the secret only when present.

### 4.2 Why the secret is not a secret

A desktop OAuth client cannot hold a confidential credential — anything shipped in the
binary is extractable. This is Google's documented position for the Desktop app client
type, and the reason PKCE exists. The config-file approach here is about keeping
credentials out of version control, not about protecting them from the user running
the app.

---

## 5. Authentication

### 5.1 Flow: PKCE + loopback

```
signIn()
  ├─ generate code_verifier (43-128 chars, unreserved) and state (128 bits)
  ├─ code_challenge = base64url(sha256(code_verifier))          [S256]
  ├─ http.createServer on 127.0.0.1:0        → ephemeral port P
  ├─ shell.openExternal(authUrl with redirect_uri=http://127.0.0.1:P)
  ├─ await callback  (2-minute timeout)
  │    ├─ state mismatch     → reject, respond 400, close
  │    ├─ error= in query    → reject with that error, close
  │    └─ code=              → resolve
  ├─ POST /token  { code, code_verifier, redirect_uri, client_id[, client_secret] }
  ├─ persist tokens (§5.3), fetch account email
  └─ close server  (in a finally — always, on every path)
```

**The system browser, never an embedded `BrowserWindow`.** Google blocks embedded
webviews for OAuth, and an in-app login window would mean Konnect renders someone's
Google password field — a phishing shape we should not teach users to accept.

The loopback server binds `127.0.0.1` explicitly (not `0.0.0.0`), serves exactly one
request, and is closed on every exit path including timeout and rejection.

### 5.2 Scopes

| Scope | Why | Sensitivity |
| --- | --- | --- |
| `openid email` | Label the signed-in account in Settings | Non-sensitive |
| `.../auth/contacts.readonly` | Read contacts | **Sensitive** — see §5.5 |
| `.../auth/drive.file` | Create and update only files this app created | Non-sensitive |

`drive.file` is deliberate over `drive`: Konnect can touch its own folder and nothing
else, so no bug in this code can reach the user's other Drive files.

### 5.3 Token storage

The token set (`refresh_token`, `access_token`, `expiry`) is JSON, encrypted with
Electron `safeStorage.encryptString()`, base64'd, stored as the `google_token` row of
the existing `settings` table. No new table, no new file.

**The keyring caveat is surfaced, not hidden.** On Linux with no keyring available,
`safeStorage` falls back to a hardcoded key and `isEncryptionAvailable()` still returns
true — the token is obfuscated, not protected. The implementation reads
`safeStorage.getSelectedStorageBackend()`; when it reports `basic_text`, Settings shows
a plain one-line warning. Silently accepting a downgraded guarantee would be worse than
not encrypting at all, because it lies about the protection.

### 5.4 Refresh and revocation

`authedFetch()` attaches the bearer token and, on `401`, refreshes once and retries the
request exactly once. Two failure modes are distinguished:

- **Transient** (network, 5xx, timeout) — surfaced as `google_last_error`, token kept,
  next trigger retries.
- **`invalid_grant`** (user revoked access in their Google account, or the refresh token
  expired) — the stored token is cleared and the section flips to signed-out with
  "Access was revoked — sign in again". Retrying a token that can never work again
  would produce a permanent error banner with no user-actionable cause.

### 5.5 External dependency: OAuth consent verification

`contacts.readonly` is a **sensitive** scope. An unverified OAuth client is capped at
100 test users and shows an "unverified app" interstitial at sign-in. This is a Google
Cloud console concern, not a code concern, and it does not block development — but it
is a real precondition for distributing the app, and is recorded here so it is not
discovered late. `drive.file` alone would need no review.

---

## 6. Contacts sync

### 6.1 Pull and map

`GET people/v1/people/me/connections` with
`personFields=names,phoneNumbers` and `pageSize=1000`, following `nextPageToken`.

Each person maps to the shape `store.upsertContacts()` already accepts:

```
{ uid: 'google:' + resourceName,
  name: names[0].displayName  (or the first phone number if unnamed),
  numbers: phoneNumbers.map(p => normaliseIndian(p.value)).filter(Boolean),
  raw: phoneNumbers.map(p => p.value),
  type: phoneNumbers[0].type,
  source: 'google' }
```

Numbers go through the **existing** `normaliseIndian()`, so Google contacts receive
identical E.164 treatment to handset ones and caller-ID matching works with no changes
to the lookup path. A person with no usable number after normalisation is skipped (§3).

The `google:` uid prefix means the existing `UNIQUE (uid, number_e164)` constraint keeps
the two sources apart with no schema gymnastics: a Google contact and a handset contact
holding the same number are two rows, not a conflict.

### 6.2 Schema change

```sql
ALTER TABLE contacts ADD COLUMN source TEXT NOT NULL DEFAULT 'handset';
```

Applied as a guarded migration — `PRAGMA table_info(contacts)` is checked for the column
before the `ALTER`, because databases already exist on the developer machine and a
second `ALTER` throws. `upsertContacts()` gains a `source` parameter defaulting to
`'handset'`, so every existing caller is unaffected.

### 6.3 Google wins on conflict

Expressed as ordering, never as deletion:

- `findContactByNumber` → `ORDER BY (source = 'google') DESC, id LIMIT 1`
- `listContacts` collapses rows sharing a `number_e164` **only when a Google row exists
  for that number**, and then prefers it

The narrowing in the second rule is load-bearing and was found during implementation.
An unconditional collapse also merges two *handset* contacts who share a number — a
family landline, a shared work line — silently dropping one from the contact list. That
shape is deliberate pre-existing behaviour with its own test (`test/store.test.js:117`,
"a different contact claiming a number already on file is added, not updated"). Google
outranking a handset row must not become "any row outranks any other row".

Handset rows are never deleted. Sign out, or remove a number from a Google contact, and
the handset name resurfaces by itself. Deletion would be irreversible — the handset
address book can only be re-obtained by the user pushing vCards from the phone again.

The existing tie-break comment in `store.js` ("first synced wins, every time") stays
true within a source; the source ordering is layered above it.

### 6.4 Removals

Contacts deleted in Google are **not** deleted locally on a plain re-sync. A full
`connections.list` is a snapshot, and reconciling deletions requires either sync tokens
or a delete-what-is-missing sweep — the latter is destructive if a page fetch fails
halfway. Stale Google contacts are cleared by signing out, which removes all
`source = 'google'` rows in one statement. This is the honest limitation of a snapshot
pull and is stated here rather than papered over.

### 6.5 Triggers

App start (if signed in), immediately after sign-in, and a manual "Sync now" button.

---

## 7. Backup

One Drive folder named `JioPhone Konnect`, created on first use, its file id cached in
the `google_folder_id` setting. The id is re-resolved (and recreated if needed) when a
request 404s, so a user deleting the folder does not permanently break backup.

### 7.1 Call log — always on, and stateless

The entire call log is serialised to one `call-log.json` and `PATCH`ed over the same
Drive file id every pass. The payload is
`{ exportedAt, account, calls: [ ...rows ] }`, where each row is exactly what
`store.listCalls()` returns (call fields plus the resolved contact `name`).

**`listCalls()` defaults to `limit = 200`.** Passing that default would silently back up
only the most recent 200 calls — a backup that looks successful and is wrong. The pass
calls `listCalls({ limit: -1 })`; SQLite treats a negative `LIMIT` as unbounded, so no
new store method is needed. A test asserts a 201-row log round-trips whole.

This is the design's most deliberate simplification. Per-row upload state would need a
column, a cursor, partial-failure recovery and a retry queue. A whole-file overwrite has
none of that and is **idempotent**: the next pass is correct regardless of how many
previous passes failed, or how they failed. A few thousand calls is a few hundred KB.

`ponytail:` full-log re-upload each pass. Switch to incremental if the log ever reaches
a size where the upload is noticeable — the trigger is bandwidth, not row count.

### 7.2 Recordings — opt-in, per-file

```sql
ALTER TABLE calls ADD COLUMN recording_backup_id TEXT;
```

Guarded migration, as §6.2. A pass uploads every call matching:

```sql
recording_path IS NOT NULL AND recording_backup_id IS NULL
```

and writes back the Drive file id on success. **That NULL is the retry queue.** An
upload that fails while offline is simply selected again next pass. No queue table, no
scheduler, no backoff state.

Gated on the `google_backup_recordings` setting, default `'false'`. Call audio is the
most sensitive data this app holds; it does not leave the machine without a deliberate
toggle. Turning the toggle off does not delete what was already uploaded — the user
does that in Drive, where they can see it.

Upload is multipart (`uploadType=multipart`): one request carrying metadata plus bytes.
Resumable upload is not used; a failed upload is retried whole next pass, which for a
call recording is cheaper in code than resumable session bookkeeping.

### 7.3 Known gap, pre-existing

A call still live at app shutdown is persisted with `recording_path` null
(`callsession.js:114`), so its recording is never selected for backup. This gap exists
today for playback too and is not introduced here. Recorded so it is not mistaken for a
backup bug.

### 7.4 Triggers

- **`onPersisted`** — the existing call-end hook, debounced ~5s so a burst of calls is
  one pass. Verified safe by §2 row 5: `recording_path` is already written when it fires.
- App start (if signed in) — drains anything missed while the app was closed.
- Immediately after sign-in.
- Manual "Back up now" button.

---

## 8. Failure handling

**The invariant: no Google operation can affect telephony.** Concretely:

- The backup pass is invoked from a `.catch()`-terminated call off `onPersisted`. It is
  never awaited by the call path.
- Every Google operation records `google_last_error` and broadcasts `google:changed`,
  then returns. None throws into a caller that matters.
- A dead network, revoked token, full Drive or Google outage cannot delay a call, block
  a hangup, or lose a recording. The local SQLite row and the local audio file remain
  the source of truth throughout; Drive is a copy, never the record.

A pass already in flight is not started again concurrently — a single in-flight flag,
since two passes would race on `recording_backup_id` and double-upload.

---

## 9. IPC surface

Six additions, declared in `src/main/ipc.js` and mirrored in `src/main/preload.js` — the
existing rule that a channel exists in exactly those two places is preserved.

| Channel | Returns |
| --- | --- |
| `google:status` | `{ configured, signedIn, email, contactsSyncedAt, backupAt, backupRecordings, lastError, weakEncryption }` |
| `google:sign-in` | status after sign-in; rejects with a user-readable message |
| `google:sign-out` | status after clearing token and `source='google'` contacts |
| `google:sync-contacts` | `{ added, updated }` |
| `google:backup-now` | `{ logUploaded, recordingsUploaded }` |
| `google:changed` (broadcast) | fires on any state change so Settings re-renders |

`google:sign-in` is the only handler that opens a browser, and it is reachable only from
an explicit button press.

---

## 10. Settings UI

A `renderGoogle()` section in `src/renderer/settings.js` with a `#set-google` host in
`index.html`, following the existing `renderSection()` wrapper (which already guards
against a rejected section taking down the whole page).

**Unconfigured:** one disabled line — "Google integration is not configured."

**Signed out:** a short description of exactly what sign-in does, and a
"Sign in with Google" button.

**Signed in:** the account email; last contacts sync and last backup times; a
"Back up call recordings too" toggle (reusing the existing toggle-switch CSS); "Sync
contacts now" and "Back up now" buttons; "Sign out"; and, when applicable, the §5.3
weak-encryption warning and the last error.

Sign-out asks for confirmation and states plainly what it does: removes synced Google
contacts locally, keeps everything already uploaded to Drive.

---

## 11. Files

**New**

| File | Responsibility |
| --- | --- |
| `src/main/google/auth.js` | Credential loading, PKCE + loopback sign-in, token persistence, refresh, `authedFetch` |
| `src/main/google/contacts.js` | People API pull, mapping to store rows |
| `src/main/google/backup.js` | Drive folder resolution, call-log upload, recording upload |

Each takes its dependencies by parameter (`fetch`, `store`, `openExternal`, `safeStorage`,
`now`) in the style already used by `setup.js` (`exec`), `recorder.js` (`spawner`) and
`callsession.js` (`now`), so every unit is testable without network, browser or keyring.

**Modified**

| File | Change |
| --- | --- |
| `src/main/store.js` | Two guarded migrations; `source` on upsert; Google-first ordering; recording-backup queries |
| `src/main/ipc.js` | Six handlers (§9) |
| `src/main/preload.js` | Six mirrored bindings |
| `src/main/index.js` | Construct the Google modules; hook `onPersisted` and startup |
| `src/renderer/settings.js` | `renderGoogle()` |
| `src/renderer/index.html` | `#set-google` host |
| `.gitignore` | `google.json` if ever placed in-tree |

### 11.1 New `settings` rows

All Google state lives in the existing key/value `settings` table. No new table:

| Key | Value | Written by |
| --- | --- | --- |
| `google_token` | base64 of `safeStorage`-encrypted token JSON | §5.3 |
| `google_account` | signed-in email, for the Settings label | §5.1 |
| `google_folder_id` | Drive id of the `JioPhone Konnect` folder | §7 |
| `google_log_file_id` | Drive id of `call-log.json` | §7.1 |
| `google_backup_recordings` | `'true'` / `'false'`, **default `'false'`** | §7.2 |
| `google_contacts_synced_at` | ISO timestamp of the last successful pull | §6.5 |
| `google_backup_at` | ISO timestamp of the last successful backup pass | §7.4 |
| `google_last_error` | last error message, cleared on the next success | §8 |

Sign-out clears every row in this table except `google_backup_recordings`, which is a
user preference and should survive a re-sign-in.

---

## 12. Testing

`node --test`, injected dependencies, **no network in any test** — matching the existing
284-test suite.

**`test/google-auth.test.js`**
- `code_challenge` is `base64url(sha256(verifier))`, S256, no padding
- auth URL carries client_id, redirect_uri, scopes, state, challenge, method
- callback with mismatched `state` is rejected and the server still closes
- callback carrying `error=access_denied` rejects with that reason
- timeout closes the server and rejects
- `401` → refresh → retry once; a second `401` does not loop
- `invalid_grant` on refresh clears the token and reports signed-out
- unconfigured credentials → `{ configured: false }` with no fetch call

**`test/google-contacts.test.js`**
- multi-number person yields one row per normalised number
- numberless and unnamed people handled per §6.1
- pagination follows `nextPageToken` and stops
- `findContactByNumber` prefers the `google` row over the handset row
- `listContacts` shows one row per number, Google name winning
- sign-out removes only `source='google'` rows

**`test/google-backup.test.js`**
- recordings skipped entirely when the toggle is off
- only `recording_backup_id IS NULL` rows are selected
- the Drive id is written back on success
- a failed upload leaves NULL, and the next pass retries it
- the log file is created once, then updated by id
- a 404 on the cached folder id recreates the folder
- a concurrent second pass is refused while one is in flight

**`test/store.test.js` (extended)**
- a database created without `source` / `recording_backup_id` opens and migrates
- running the migration twice does not throw

---

## 13. Open questions

None. The two questions raised at design review — onboarding step versus Settings-only,
and whole-file versus incremental call-log upload — were resolved on approval in favour
of Settings-only (§3) and whole-file (§7.1).
