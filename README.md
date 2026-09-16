# 约球 / Badminton Group Play

WeChat mini program for organizing badminton sessions. Post a session, people join, the
waitlist overflows automatically, the court fee gets split to the cent, and the organizer
tracks who has paid.

Groups that don't use WeChat get the same thing through a link. `platform/` is an API and
web client for players arriving from WhatsApp, LINE, Telegram, SMS, or an ordinary
browser — one message in the group chat instead of a numbered list pasted thirty times.
The organizer can run a whole session from there too, so a club with no WeChat account is
not a second-class user.

Chinese and English throughout, in light and dark. The mini program has no npm
dependencies, no component library, and no build step; the web client is Vue 3 and reuses
the mini program's rules and dictionaries rather than reimplementing them.

> Code comments cite section numbers — §3.9, §9.2, §10.3 — from a design document kept
> outside this repository. The rules those comments lean on are summarised under
> **[Rules the code assumes](#rules-the-code-assumes)**, so nothing here needs it to be
> read.

**Picking this up to work on it?** Start with
[`platform/README.md`](platform/README.md): setup, verification, the invariants that
must not break, the traps, and what to do next.

---

## Run it locally

1. WeChat DevTools → **Import project** → select this folder
2. Choose **游客模式 / tourist mode** (or leave the AppID as `touristappid`)
3. Compile

It runs on local demo data out of the box: two clubs (you own one, with a join request
waiting), two venues, and nine sessions chosen to cover the awkward states — full with a
waitlist, full with no waitlist, gender-balanced with one female slot left, one closing
inside the countdown window, plus three finished ones: a split waiting to be published, a
bill you are collecting on, and a share you owe. Reset under **我的 → 重置本地演示数据**.

**Why demo data and not cloud?** Cloud Development binds to a real mini program account,
so `touristappid` has no environment to call. `utils/mock.js` implements the _same action
surface_ as the cloud function and enforces the same rules — waitlists, gender buckets,
all-or-nothing party seating, club permissions, the money split all behave correctly
offline. It is not a stub of a few endpoints.

## Verify

```bash
node tests/rules.test.js       # 280 assertions, against both copies of the pure logic
node tests/bills.test.js       #  90 assertions, the settlement flow and money maths
node tests/organizer.test.js   #  39 assertions, a live session's rules and club money
node tests/i18n.test.js        # 391 checks, every label key exists and is rendered
```

No framework, no install. What each one protects:

- **rules** — the pure logic, run against **both** copies of the duplicated files, because
  drift between client and server is the real risk. Allocation, gender buckets, the
  leapfrog rule, LIFO capacity bumping, and the money split's conservation invariant.
- **bills** — the settlement flow, which the arithmetic can't express: republishing leaves
  paid shares alone, a player can't mark themselves paid, voiding waives what's
  outstanding. Plus money in and out of an input field, decimals included.
- **organizer** — what an organizer can change on a live session: raising the cap and
  draining the waitlist, reopening a closed deadline, and the club's currency.
- **i18n** — every label key referenced from a template or script exists in both locales,
  every error code has text, **and** no key is defined without being rendered. That last
  check exists because four written-and-never-shown form hints were found this way.

The API and web client have their own suites, which need Node 22 and PostgreSQL:

```bash
cd platform && npm install && npm run db:up
npm test                    # 131 tests, server, against a real database
npm --workspace web test    #  51 tests, web client: helpers, invite page, labels, contrast
npm run typecheck && npm run build
```

See [`platform/README.md`](platform/README.md) to run the invite page, switch the
WeChat client between `mock`, `cloud`, and `http` transports, and for the identity
model and provider-binding decisions.

---

## Layout

````
miniprogram/                  ~290 KB of source, no npm dependencies
  app.js / app.json           cloud init, locale resolution, 2 tabs + raised ＋
  app.wxss                    the palette and the type scale, both documented at the top
  config.js                   USE_MOCK, cloud env
  utils/
    rules.js        ◆         scheduling, seat allocation, capacity bump, money (pure)
    formats.js      ◆         play format templates (pure)
    naming.js       ◆         club roles, display names, booking maths (pure)
    i18n.js                   zh/en dictionaries, t(), error-code mapping
    format.js                 wall-clock time, money, picker plumbing
    present.js                shared session-card decoration
    todo.js                   what's waiting on you; sizes the tab-bar dot
    api.js                    single call() entry point; mock ⇄ cloud switch
    mock.js / mock-store.js   local backend + seed, same actions as the cloud one
  pages/
    games/                    tab — two segments: my signups | open to join
    me/                       tab — what needs you, then 球局管理 and 我的俱乐部
    clubs/                    create, join by code, join an open club
    club/                     sessions, members, requests, venues, settings
    profile/                  avatar, nickname, gender, language, memberships
    event/                    detail, join/withdraw, guests, share
    create/                   format template → capacity → deadlines → post
    manage/                   organizer: courts, signup rules, booking helper, roster
    bill/                     post-play: the split, and who has paid
    hosting/                  球局管理 — sessions you run, and what each needs
cloudfunctions/api/
  index.js                    action router; identity from getWXContext
  lib/
    rules.js  formats.js  naming.js   ◆ authoritative copies
    db.js                     the storage seam — Cloud DB, or an injected store
    events.js                 list / mine / hosting / detail / create / courts / rules
    signups.js                join / withdraw / guests / promotion (transactional)
    clubs.js                  create / join / approve / roles / settings
    venues.js                 venues, memberships, booking helper
    bills.js                  publish the split, mark paid / waive / void
    profile.js  errors.js
platform/                     the own-API path: browsers, LINE, WhatsApp, bots
  server/                     Hono + PostgreSQL; runs the lib/ above unchanged
  web/                        Vue 3 + Vite; invite links, dashboard, organizer tools
tests/                        rules, bills, organizer, i18n```

◆ = **deliberately duplicated.** A cloud function only packages files inside its own
directory, so shared pure logic can't cross the boundary. Both copies are pure — no
`wx.*`, no `db`, no i18n — specifically so they stay trivially diffable, and
`tests/rules.test.js` runs identical assertions against each. Edit one, copy to the other,
run the tests.

The four backend files (`events`, `signups`, `clubs`, `bills`) are *not* shared: each
exists as a cloud version and a branch of `utils/mock.js`. The mock is not a stub — it
enforces the same rules and returns the same shapes, which is what lets tourist mode
exercise real flows. Add an action to both, and to the `ACTIONS` table in `index.js`.

---

## Rules the code assumes

**Session status is derived, never stored.** Only `DRAFT` / `ACTIVE` / `CANCELLED` persist;
`OPEN`, `FULL_CLOSED`, `SIGNUP_CLOSED`, `COMPLETED` and the rest are computed from
timestamps at read time. No scheduler is needed to keep status honest, and moving a
deadline into the future reopens signup by itself.

**Seat allocation is transactional.** Two people tapping the last seat is the obvious way
to corrupt a roster, so every count change runs inside `db.runTransaction`. Cloud DB
transactions support `doc()` but **not** `where()`, and picking the head of the waitlist
needs a query — so promotion is optimistic: choose outside the transaction, re-verify
inside, retry on a lost race. Withdrawal and promotion are therefore two transactions,
deliberately, so a failure mid-promotion leaves a vacancy rather than rolling back
somebody's withdrawal.

**A party is seated all-or-nothing.** A member plus two guests needs three contiguous
seats; if two remain, the whole party waits. A waitlisted party that doesn't fit the gap is
skipped and the next one that does is promoted — a paid seat sitting empty is worse than an
out-of-order promotion.

**Time is stored twice.** `start_at` (UTC ms) drives every comparison and deadline;
`start_local` (`"2026-09-14T19:00"`) drives every display. Never render from the timestamp —
7pm must read as 7pm regardless of who is looking, which also avoids depending on `Intl`
timezone support, unreliable across the mini program's iOS and Android engines.

**Money is integer minor units plus an ISO 4217 code.** Never floats, and never assume
1/100 — JPY and KRW have no fractional part. Decimals are exact: `96.75` is stored as
`9675`, and the split conserves every cent by handing the remainder out one minor unit at a
time in signup order. Amounts render as bare numbers with the fraction always shown
(`96.75`, `12.00`) because the decimal is the money cue; the currency code appears once per
screen, not on every figure. Use `fmt.toMajorInput` to put a stored amount back into an
input — never `minor / 100`, which is wrong for zero-decimal currencies.

**Every head that held a seat pays.** There is no attendance step. A seat was yours to
release before the withdraw deadline or to fill with a replacement, so it is billed whether
you used it or not; an organizer who must tally faces before charging anyone is doing
bookkeeping this app exists to remove. `WAIVE` covers the genuinely unfair case.

**Errors are codes, not sentences.** The server throws `fail('FULL')`; the client renders
it through `i18n.errText`. One backend serves both locales, and a third could be added
without redeploying it.

**The client's rule answers are advisory.** They disable buttons and render hints; the
backend re-checks everything. In Cloud mode identity comes from
`cloud.getWXContext()`; in HTTP mode it comes from a signed session resolved to the
canonical user. It never comes from an action payload.

**Deterministic ids.** Domain records are one row per canonical user and entity:
`${eventId}_${userId}`, `${clubId}_${userId}`, `${userId}_${venueId}` and
`${eventId}_${userId}`. The Cloud implementation still calls this field `openid`; the
HTTP prototype treats it as a canonical actor id. Rename it to `user_id` in the production
database migration. Do not key domain data by a LINE, WhatsApp, phone, or other provider id.

**WXML can't call functions.** Every display string is precomputed — `utils/present.js` for
session cards, the page's own `decorate()` for the rest. Locale strings come from
`i18n.pack()` into `data.t`, read as `{{t.join}}`.

**All colour values are literal, and there are no CSS variables.** A palette declared as
`page { --x }` left the custom tab bar with no background: a custom tab bar is a
style-isolated Component, so page-level properties never reach it. The palette and the type
scale are documented as comments at the top of `app.wxss`; substitution is by hand.

**Lightweight is a constraint, not an aspiration.** No component library, no npm dependency
in `miniprogram/`, one shared stylesheet, `lazyCodeLoading` on, screens firing their reads
in parallel. The 2MB package limit is generous now and easy to squander.

---

## Going live with WeChat Cloud

1. Put your AppID in `project.config.json`
2. Create a cloud environment in the WeChat console
3. Create collections: `users`, `events`, `signups`, `clubs`, `club_members`, `venues`,
   `venue_memberships`, `event_bills`, `bill_shares`
4. Set every collection to **cloud-function-only** writes, and reads too for `signups` and
   `club_members` — those rows carry user identity
5. Right-click `cloudfunctions/api` → 上传并部署（云端安装依赖）
6. Set `API_MODE: 'cloud'` in `miniprogram/config.js`

**Confirm before building much further:** that Cloud Development is available to an overseas
(境外主体) mini program account. The audience is Chinese and SE-Asian clubs *outside*
mainland China, and overseas accounts have a different feature set.

The own-API path under `platform/` is no longer a prototype: PostgreSQL, revocable
sessions, rate-limited recovery codes, and the same `cloudfunctions/api/lib/` rules running
unchanged behind an injected document store. What is still missing before external users is
real provider verification — LINE, WhatsApp, email, phone — and binding an existing browser
guest to a WeChat account. The schema and provider binding plan are in
[`platform/README.md`](platform/README.md#identity).

Also unverified: that WeChat's 订阅消息 template library holds templates whose field types
fit the notification set, and that the mini program's category permits them. Worth checking
in the console before starting on notifications.

## Status

**In WeChat**, the core loop, clubs, and fee tracking are done: create from a format
template, join with guests, waitlist and automatic promotion, withdraw, share; clubs with
roles and join requests, venues and venue memberships; and post-play settlement — publish
the split, mark paid or waived, revise or void, with the player's own "I've paid" flag.

**On the web**, the player and organizer loops are done: open an invite link, join with
guests, withdraw, copy the roster back to the chat; create a session, adjust capacity and
courts, remove a player, cancel, publish the split and mark shares paid. Light and dark.
Club, venue and membership administration is still WeChat-only.

**Next:** real provider sign-in — LINE first, then WhatsApp and email/phone — and binding
an existing browser guest to a WeChat account, because today those become two accounts.
**Then** notifications, and after them the overdue block, which waits on notifications
deliberately: a lockout that fires on someone who was never told is worse than no lockout,
and without a push "told" means "happened to open the app". Overdue is computed and shown
today, and enforced nowhere.

The ordered work list, with the reasoning, is in
[`platform/README.md`](platform/README.md#ordered-next-work).

Not built: real provider verification, guest-to-WeChat binding, notifications, the overdue
block, the 30-day retention purge with counter roll-up, recurring series, a per-player
reliability score, and a public GPS-filtered discovery feed.
````
