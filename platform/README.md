# platform — the API and the web client

The WeChat mini program needs a WeChat account. Most badminton groups outside
mainland China do not have one: they run on WhatsApp, LINE, Telegram or plain SMS,
and they coordinate by pasting a numbered list into the chat and re-pasting it with
their name appended. That list is the sign-up sheet, and it breaks whenever two
people paste at once.

This directory replaces that list with a link. One message in the group chat,
which unfurls into the session's time, place and seats remaining, and which opens
a page that is always current: who is coming, who is waiting, what the court cost
and who still owes it.

```
platform/
  server/          Hono + PostgreSQL. The action API, identity, the invite page.
  web/             Vue 3 + Vite. Invite links, player dashboard, organizer tools.
  docker-compose.yml   PostgreSQL 16 for local development
  .env.example     copy to server/.env
```

## The important design decision

**The business rules are not reimplemented here.** `cloudfunctions/api/lib/` holds
the authoritative implementation of seat allocation, waitlists, gender buckets,
all-or-nothing party seating, club permissions and the money split. Those modules
talk to storage through one small seam (`lib/db.js`), so this server injects a
PostgreSQL-backed document store and runs the very same code the WeChat cloud
function runs.

```
                       cloudfunctions/api/lib/   (events, signups, clubs, bills…)
                                  │
                          lib/db.js  (the seam)
                          ╱                  ╲
        wx-server-sdk (Cloud DB)      platform/server/src/db/store.js (PostgreSQL)
```

A second implementation would drift, and a drifting roster is a corrupted roster.
So: **do not reimplement a rule.** If one needs changing, change it in
`cloudfunctions/api/lib/` and in the mini program's copy, then run
`node tests/rules.test.js` from the repo root, which asserts the two copies agree.
Four files are deliberately duplicated because a cloud function only packages files
inside its own directory; those tests are what keep them honest.

The same reasoning is why the web client reuses `rules.js`, `formats.js`,
`naming.js`, `i18n.js` and `format.js` rather than rewriting them in TypeScript —
see the CommonJS transform in `web/vite.config.ts`.

## Run it

Requires Node 22 (`mise install` in this directory) and Docker. The repo root pins
Node 18 for the mini program and the cloud function; this directory pins 22 through
its own `mise.toml`, so run these commands from inside `platform/`.

```bash
cd platform
npm install
npm run db:up            # PostgreSQL 16 on 5432
npm run db:test-create   # the database the server suites truncate
cp .env.example server/.env   # where the server scripts read it from

npm run migrate
npm run seed             # demo club, venue and five sessions
```

Then either serve the built client from the API, which is how production runs:

```bash
npm run build
npm run dev              # http://127.0.0.1:4174 serves both
```

or run Vite separately, which gives hot reload and proxies `/v1` to the API:

```bash
npm run dev              # terminal 1: API on :4174
npm run dev:web          # terminal 2: Vite on :5173
```

The seed script prints the invite links it created, and the browser device id of the
demo organizer.

> `npm run db:up` needs Docker's compose plugin, which is not installed everywhere.
> Without it, start Postgres directly — the other scripts assume this container name:
>
> ```bash
> docker run -d --name yueqiu-pg \
>   -e POSTGRES_USER=yueqiu -e POSTGRES_PASSWORD=yueqiu -e POSTGRES_DB=yueqiu \
>   -p 5432:5432 postgres:16-alpine
> # created it before? just: docker start yueqiu-pg
> ```

## Verify

```bash
npm run verify           # tests + typecheck + build + lint. The bar for a change.

npm run test:server      # 137 — against a real PostgreSQL
npm run test:web         #  57 — helpers, invite page in jsdom, labels, contrast
```

`verify` does **not** cover the four suites at the repo root, which are the only
thing checking that the two copies of the shared rules still agree. Run those too:

```bash
cd ..
node tests/rules.test.js       # 296  pure logic, against BOTH copies
node tests/bills.test.js       # 118  settlement flow and money maths
node tests/organizer.test.js   #  61  a live session's rules and club money
node tests/i18n.test.js        # 398  every label exists, and is rendered
```

Server tests need a database and will truncate it. They default to
`postgres://yueqiu:yueqiu@127.0.0.1:5432/yueqiu_test` — `npm run db:test-create`
makes it — or point `DATABASE_URL` somewhere else.

What the server suites protect:

- **store** — that the PostgreSQL document store behaves the way the shared domain
  code expects: `inc` on a nested dotted key, `push` onto a missing array,
  numeric (not lexical) ordering, an empty `in` list matching nothing, equality on
  an array field being equality and not subset containment, rollback, and that row
  locks stop a lost update.
- **domain** — the real rules on real PostgreSQL: waitlist overflow, party seating,
  promotion on withdrawal, and **eight players racing for one seat, of whom exactly
  one is seated**.
- **identity** — sessions are hashed and revocable, recovery codes rotate and are
  rate limited, and one provider identity cannot be moved between accounts.
- **http** — the boundary: an actor id in the payload is ignored, unknown actions
  are refused, a club-only session's details never reach a link preview, and a
  missing bundle 404s instead of serving the page in its place.
- **config** — the process refuses to start in production without a session
  secret, with a wildcard CORS origin, or with the dev-auth bypass enabled.

And the web suites:

- **present** — the display helpers, including the plain-text roster that gets
  pasted back into a group chat.
- **invite** — the invite page actually renders and joins, mounted in jsdom, and
  the shared dictionaries load through the CommonJS bridge rather than coming back
  empty.
- **labels** — every `t.someKey` the templates reference exists in both locales,
  no web-only string shadows a shared one, and no sentence template
  (`"{amount} per share"`) is used as a label. That last check exists because two
  such placeholders reached the screen during a redesign.
- **contrast** — every foreground/background pair in the palette clears WCAG AA,
  in both colour schemes, compositing translucent washes over their surface. Five
  pairs failed when it was introduced.

### Looking at the UI

A layout that typechecks and builds can still be wrong, and there is no display in
CI or in most dev sandboxes, so the UI is checked by driving a real browser:

```bash
npx playwright install firefox     # once
npm run dev                        # server must be running, with seed data
npm run shots -- /tmp/shots
SHOT_LOCALE=en-GB npm run shots -- /tmp/shots   # if the box has no CJK font
```

It signs in through the real API as the seeded organizer and captures every screen
at phone size, light and dark, as both a viewport shot and a full-page one. The
viewport shot is the one that shows a fixed action bar where it really sits. Do this
for any visual change: six real bugs were found this way that typecheck, build and
the test suites all passed over.

## Invariants

Load-bearing, each with a test. Wanting to change one is a design conversation, not
a refactor.

| Invariant                                                                      | Enforced by                                     |
| ------------------------------------------------------------------------------ | ----------------------------------------------- |
| The rules exist once, and both copies agree                                    | `tests/rules.test.js` (repo root)               |
| Seat allocation cannot oversell                                                | `server/test/domain.test.js` — eight racers     |
| The acting identity comes from the session, never a payload                    | `server/test/http.test.js`                      |
| Sessions are revocable and stored only as a hash                               | `server/test/identity.test.js`                  |
| One provider identity belongs to one account                                   | a unique constraint, plus `identity.test.js`    |
| A link preview never leaks a club-only session or a venue address              | `server/test/http.test.js`                      |
| Money is integer minor units plus an ISO 4217 code                             | `tests/bills.test.js` (repo root)               |
| Time is stored twice; display always reads the wall clock                      | `tests/rules.test.js`, and by review            |
| Errors are codes, never sentences                                              | `tests/i18n.test.js`, `web/test/labels.test.ts` |
| Every label key exists in both locales, and none is a template used as a label | `web/test/labels.test.ts`                       |
| Colour contrast clears WCAG AA in both schemes                                 | `web/test/contrast.test.ts`                     |
| Production refuses a default secret, wildcard CORS, or the dev-auth bypass     | `server/test/config.test.js`                    |

## Traps

Specifics that cost time to find, and that reading the code does not reveal.

**`postgres` and jsonb.** `sql.unsafe()` does not apply type parsers, so jsonb comes
back as a string. Use tagged templates, with `sql(identifier)` for table names —
which also quotes them, so a malicious name fails as an undefined table rather than
injecting.

**Pooled reads inside a transaction deadlock.** `signups.js` reads a user profile
through the ordinary handle while holding a transaction. On Cloud DB that is a
second API call; on a connection pool it is a deadlock, and once every connection is
held by such a transaction, nothing proceeds. `db/store.js` solves it with
`AsyncLocalStorage`: a pooled operation joins the transaction in progress instead of
taking another connection. Do not "simplify" that away — remove it and the
concurrency tests stall until they time out, taking the rest of the suite with them.

**`where()` inside a transaction is refused on purpose.** Cloud DB cannot do it,
which is why waitlist promotion is optimistic (choose outside, re-verify inside).
Allowing it here would let the shared code drift into depending on something the
WeChat deployment cannot do.

**jsonb `@>` is subset containment, not equality.** Fine for scalars, wrong for
arrays and objects. `store.js` compiles non-scalar equality to `=` for that reason.

**Do not add web-only strings to `miniprogram/utils/i18n.js`.** `tests/i18n.test.js`
asserts every key there is rendered by a mini-program template, and rightly fails
otherwise. Web-only wording lives in `web/src/shared/web-strings.ts`.

**Some dictionary entries are sentence templates**, like `"{amount} per share"`. Use
them with `tf('key', { amount })`, never as `t.key`.

**`formats.js` has no display names.** Entries carry `per_court`, `mode` and
`ratio`; the names live in the dictionary as `fmt<KEY>`. Use `formats.ORDER`,
`formats.isBalanced()` and `formats.capacityFor()` rather than reading the table.

**Domain payload shapes are not guessable.** `event.updateRules` takes its fields
flat on the payload and returns `{ promoted }`; permission failures are `NOT_ADMIN`,
not `NOT_ORGANIZER`; `event.removeSignup` takes `targetOpenid`; `event.hosting`
returns an object, not an array. Read the handler before calling it.

**`openid` is a canonical actor id**, not a WeChat id, everywhere except its name.
Renaming it is its own migration and is deliberately not mixed into other work.

**Playwright's Firefox ignores `newContext({ colorScheme })`.** Dark mode responds
only to the OS-level pref, so the screenshot harness launches a second browser with
`firefoxUserPrefs: { 'ui.systemUsesDarkTheme': 1 }`.

**Tooling versions that fight.** `@eslint/js` must match ESLint's major (9 here).
ESLint needs `vue-eslint-parser` with `parserOptions.parser` set to the TypeScript
parser for `<script setup lang="ts">`. `vue-tsc --build` writes `vite.config.js`
next to the source unless `noEmit` is set in `tsconfig.node.json`.

## Conventions

- **Actions, not routes.** A feature is a named action (`event.join`) added in three
  places: `cloudfunctions/api/index.js`, `server/src/domain/index.js`, and
  `miniprogram/utils/mock.js`. The mock is not a stub — it enforces the same rules,
  which is what lets WeChat tourist mode exercise real flows.
- **Codes, not sentences.** The server throws `fail('FULL')`; the client renders it
  through i18n. One backend serves both locales.
- **Money** is integer minor units with a currency code. Never floats, never
  `minor / 100` — JPY and KRW have no fractional part. Use `fmt.toMajorInput`.
- **Time** is stored twice: `start_at` (UTC ms) for every comparison, `start_local`
  (`"2026-09-14T19:00"`) for every display. Never render from the timestamp.
- **Tests are named for what would go wrong**, not for the function under test. "A
  revoked session stops working" is the property worth protecting.
- **UI tests address controls by `data-testid`**, so restyling does not break them.

## The invite link

`GET /invite/:id` is server-rendered. WhatsApp, LINE, Telegram and iMessage build a
preview by fetching the URL and reading its meta tags; none of them run JavaScript.
So the title, time, venue and seats remaining are rendered into Open Graph tags on
the server, and the Vue app takes over afterwards.

The lookup behind it is deliberately narrow (`server/src/db/queries.js`): it is
unauthenticated, because a chat app fetching a link carries no session, so it
returns only a `PUBLIC` and still-active session, only whitelisted fields, and never
the venue address. A club-only session renders neutral tags instead of describing
itself to anyone holding the URL.

## The API

One endpoint, the same contract the mini program and the cloud function use:

```http
POST /v1/actions
Authorization: Bearer <session token>

{ "action": "event.join", "payload": { "eventId": "…", "guests": [] } }
```

`{ ok: true, data }` or `{ ok: false, code }`. Codes, never sentences: one backend
serves both locales and the client owns the wording.

| Route                              | Purpose                                             |
| ---------------------------------- | --------------------------------------------------- |
| `POST /v1/auth/guest`              | browser device key → account and session            |
| `POST /v1/auth/wechat`             | `wx.login()` code → verified openid → session       |
| `POST /v1/auth/recovery`           | recovery code → restore an account on a new browser |
| `POST /v1/auth/signout`            | revoke this session                                 |
| `POST /v1/account/status`          | which credentials reach this account                |
| `POST /v1/account/recovery-code`   | issue a code, revoking the previous one             |
| `POST /v1/account/revoke-sessions` | sign out everywhere                                 |
| `POST /v1/actions`                 | every domain action                                 |
| `GET /invite/:id`                  | the shareable page, with link-preview tags          |
| `GET /health`, `GET /ready`        | liveness, and readiness including the database      |

Identity comes from the session, resolved server-side. It is never read from a
payload — `server/test/http.test.js` pins that.

## Point the WeChat client at it

In `miniprogram/config.js` set `API_MODE: 'http'`. The client already speaks this
contract; `utils/auth.js` exchanges `wx.login()` through `POST /v1/auth/wechat`.

`HTTP_DEV_ACTOR_ID` sends `Bearer dev:<id>`, which the server honours only when
`ALLOW_DEV_AUTH` is on, and which configuration refuses to enable in production.
Clear it and set `WECHAT_APP_ID` / `WECHAT_APP_SECRET` for anything real.

---

# Identity

Read this before changing `server/src/identity/index.js`, HTTP authentication,
session handling, recovery codes, or any field named `openid`.

## The model

Every person has one canonical account id, and the domain tables key on it:

```text
accounts.id = u_8a90…
```

External credentials resolve to it:

```text
provider    subject                            account
guest       random browser device id           u_8a90
recovery    sha256(normalised recovery code)   u_8a90
wechat      verified openid                    u_8a90
line        verified LINE subject              u_8a90
whatsapp    verified webhook user id           u_8a90
phone       verified E.164 number              u_8a90
email       verified normalised address        u_8a90
```

A subject is an authentication credential or a verified identifier. It is **never**
the primary key for signups, memberships, bills or events. The mapping lives in
`provider_identities`, with a unique constraint on `(provider, subject)` — enforced
by the schema, not by code.

## Guest accounts and recovery

Guest data lives on the server. The first credential is a random device id in
browser local storage. Clear that storage, switch browsers, use private mode or lose
the device, and the data remains but nothing can prove it is yours.

The UI must say exactly that. Do not imply the server data was deleted; say access
will be lost unless the account is protected.

Recovery codes are the provider-independent fallback:

1. An authenticated guest requests a code.
2. The server generates 96 random bits and shows the code once.
3. Only a SHA-256 subject is stored.
4. Entering it on another browser attaches that browser's device identity to the
   same account.
5. Issuing a new code revokes the previous one immediately.

They are bearer credentials: never log them, never put them in a URL or analytics,
never store the plaintext. Attempts are rate limited per fingerprint (ten failures
in fifteen minutes) through the `auth_attempts` table.

## Binding a provider

Every provider integration follows one state machine.

**A new provider user.** Verify the assertion server-side, resolve
`(provider, subject)`; issue a session if it is known, otherwise create one account
and one identity row atomically.

**An existing guest binds a provider.** Require the current signed session, create a
short-lived single-use challenge bound to that account, complete provider
authentication, verify callback/state/nonce/token server-side, attach the identity
in one transaction, then invalidate the challenge.

**The identity already belongs to someone else.** Do not merge silently: return
`IDENTITY_ALREADY_LINKED` and keep both accounts. A real merge has to
re-authenticate both sides, pick a survivor, and move signups, memberships, bills,
owned clubs and venue memberships transactionally while preserving
deterministic-id uniqueness. That is not implemented.

Never infer a match from nickname, avatar, display name or unverified phone input.

Per provider: LINE gives the client a token that the **backend** verifies with LINE
(never trust a subject supplied by client JavaScript); WhatsApp is a bot channel, so
either a verified webhook sender resolves to `provider=whatsapp` and the bot replies
with a signed single-use link, or an authenticated web user verifies an OTP sent
through an approved template; email and phone verify a magic link or OTP before
linking; OAuth/OIDC providers verify code, state, nonce, issuer, audience and PKCE
server-side; passkeys store WebAuthn credential ids against the account and are an
authentication method, not a second user table.

## Schema

As implemented, in `server/src/db/migrations/001_init.sql`:

```text
accounts
  id            text primary key      -- the canonical actor id
  created_at
  deleted_at

provider_identities
  id            bigserial
  account_id -> accounts.id  on delete cascade
  provider      text                  -- guest | recovery | wechat | line | …
  subject       text                  -- device key, hash, verified openid, …
  verified_at
  created_at
  revoked_at
  UNIQUE(provider, subject)

sessions
  token_hash    text primary key      -- sha256; the token itself is never stored
  account_id -> accounts.id  on delete cascade
  provider      text
  created_at
  last_seen_at
  expires_at
  revoked_at

auth_attempts                          -- so recovery guessing can be rate limited
  id            bigserial
  kind          text
  fingerprint   text
  succeeded     boolean
  created_at
```

Recovery codes are a `provider_identities` row with `provider = 'recovery'` and the
hashed code as the subject, rather than a table of their own: a recovery code is
exactly a credential that resolves to an account, so rotation is the same
revoke-and-insert as any other identity.

Profile data (`nickname`, `avatar_url`, `gender`, `locale`) stays in the `users`
document collection, because the shared domain code owns it.

Still to add: `link_challenges`, for binding a provider to an already-signed-in
account. Nothing issues a challenge yet, so the table does not exist yet.

Domain tables reference the account id under the name `openid`
(`creator_openid`, `owner_openid`). It is a canonical actor id everywhere except its
name; renaming it is a migration of its own.

## Security invariants

- The server chooses the account id; clients never submit their acting identity.
- Provider tokens and webhook signatures are verified server-side.
- One provider identity belongs to at most one account.
- Linking requires an authenticated current account plus a verified provider.
- Link challenges are short-lived, single-use, and bound to provider and account.
- Recovery secrets are hashed, rate limited, rotatable, and never logged.
- Sessions can be revoked; do not rely on a self-contained token alone.
- Account deletion revokes sessions and identities before deleting retained data.
- No account merging by matching profile fields.

---

## What is not built

- Real LINE, WhatsApp, email and phone verification. The provider mapping they will
  use exists; the verification does not.
- Binding an existing browser guest to a WeChat account. Somebody who joins by link
  and later opens the mini program becomes two accounts today. Needs
  `link_challenges`.
- Provider and device management UI, and the two-account merge flow.
- Club, venue and membership administration on the web — still WeChat-only.
- Notifications, and the overdue block that deliberately waits on them.

One caveat on rate limiting: the fingerprint trusts `x-forwarded-for` from whatever
proxy sits in front. Behind an untrusted proxy that is spoofable, so terminate TLS
somewhere that sets it honestly.

## Ordered next work

1. LINE Login/LIFF binding first, with `link_challenges`. It is the primary
   SE-Asia channel.
2. WhatsApp bot identity plus a signed single-use magic link.
3. WhatsApp OTP binding for users who start on the web.
4. Provider and device management UI: linked methods, devices, revoke, rotate.
5. Rename domain `openid` to `user_id`, in one migration.
6. Design the two-account merge flow before permitting any conflict override.
7. Club, venue and membership administration on the web.
