# Stock module — open issues

**Branch:** `feat/stock-phase1` · **Head at review:** `4c7575a` · **Reviewed:** 2026-07-30

Found by reading the module end to end (models, ledger engine, all four controllers,
routes, middleware, migrations). Nothing here was reproduced against a running
database — there are no tests in the project — so each entry carries a **Verify**
line telling you how to confirm it before you spend time on a fix.

IDs (`STK-01` …) are just handles for commits and chat. Priority is about what
misleads a user or risks patient safety, not about how hard the fix is.

| ID | Priority | Status | Issue | Area |
|----|----------|--------|-------|------|
| STK-01 | P1 | **Fixed** | Dashboard hides items that are completely out of stock | `stockMovementController` |
| STK-02 | P1 | **Fixed** | `/use` has no dispensing-location guard | `stockMovementController` |
| STK-03 | P1 | **Fixed** | FEFO overrides report misses the advisory overrides | `stockReportController` |
| STK-04 | P2 | **Fixed** | Stocktake reads expected quantities outside its transaction | `stockRoomController` |
| STK-05 | P2 | **Fixed** | Expired batches vanish from the list used to write them off | `stockMovementController` |
| STK-06 | P2 | **Fixed** | Two different definitions of "today" | `stockLedger` / `stockExpirySweep` |
| STK-07 | P2 | **Fixed** | `adjustLevel` swallows every error, not just the race | `stockLedger` |
| STK-08 | P2 | **Fixed** | No automated tests for the ledger invariants | project-wide |
| STK-09 | P3 | **Fixed** | Stale comment: dispense patient is required, not optional | `stockMovementController` |
| STK-10 | P3 | **Fixed** | Stale comment: recall patient-linking described as future | `stockReportController` |
| STK-11 | P3 | **Fixed** | `copyParLevels` doesn't validate the destination location | `stockRoomController` |
| STK-12 | P3 | **Fixed** | Stocktake ignores batches absent from the submitted counts | `stockRoomController` |

All twelve are fixed.

## How to check this work

```
npm test
```

19 assertions over the ledger invariants, against a real database (the guarantees are
transaction and row-lock behaviour, which a mock would not exercise). Fixtures are
created under a `__TEST_LEDGER__` prefix and removed afterwards; the suite refuses to
run when `NODE_ENV=production`.

## What changed

The recurring cause was one rule written out in several places, with one copy drifting.
Three rules now have exactly one definition:

- **`utils/stockTotals.js`** *(new)* — the one place `StockLevel` rows are rolled up:
  `itemTotals()`, `itemLocationTotals()`, `itemsBelowReorder()`. The dashboard, the
  reorder report and the room-balance grid each had their own copy.
- **`utils/clinicTime.js`** *(new)* — the one definition of "now". Everything stays in
  `YYYY-MM-DD` string space, which is how `DATEONLY` comes back from Sequelize and
  which sorts chronologically, so no timezone conversion happens at all. Timezone is
  `CLINIC_TIMEZONE`, defaulting to `Africa/Mogadishu`.

  **This has since been rolled out across the whole backend, not just stock** — the
  same UTC-vs-local confusion was in appointments, the dashboard, the queue, analytics,
  the GLP-1 dose ladder and all five clinical record types. See
  `SYSTEM_TIME_FIXES.md`.
- **`resolveDispensingLocation()`** in `stockMovementController` — the one definition of
  the quarantine rule, used by `/dispense`, `/use` and `/checkout-dispense`.

### Per issue

- **STK-01** — the dashboard card now calls `itemsBelowReorder()`. Its old pass iterated
  levels, and an item at zero has no level rows, so it silently dropped exactly the
  items that needed ordering.
- **STK-02** — `/use` now calls `resolveDispensingLocation()`. It previously had no
  location check at all, so quarantined stock could be used on a patient straight out
  of the Faulty Box, and a bad `locationId` returned a foreign-key 500.
- **STK-03** — the report pattern lost its colon: `'FEFO override%'`. The old one
  matched only the blocking paths, never `(use)` or `(checkout)`.
- **STK-04** — the stocktake's expected-quantity read moved inside the transaction with
  `LOCK.UPDATE`, so a dispense landing mid-count can no longer make `expected` stale and
  record a variance that never happened.
- **STK-05** — the expiry window now accepts `status IN ('active','expired')`. Expired
  stock is still on the shelf and still has to be found to be written off.
- **STK-06** — `isExpired()`, the expiry sweep, FEFO, the restock plan and the dashboard
  buckets all read `clinicTime` now. No `toISOString()` or `toDateString()` date
  derivation is left anywhere in the stock code.
- **STK-07** — `adjustLevel` catches only `SequelizeUniqueConstraintError` and rethrows
  everything else, so FK violations and connection failures reach the logs instead of
  masquerading as "level row could not be created".
- **STK-11** — `copyParLevels` validates the destination before destroying anything there.
- **STK-09 / STK-10** — comments corrected to match the code.
- **STK-12** — decided: a stocktake now reconciles the **whole location**. A batch the
  system holds there that nobody scanned is recorded as counted zero, because "we looked
  and it isn't on the shelf" is the finding a count exists to produce. `mode: 'partial'`
  keeps the old behaviour for counting one shelf of a big room.

  One hazard came with that, and is handled: the count screen draws its list at *Start
  count*, so a delivery arriving into the room mid-count would look "unscanned" and get
  written off. The client now sends `startedAt`, and stock whose level changed after
  that point is left alone and reported as `arrivedDuringCount`. Without `startedAt`
  the endpoint does a pure full count.

  The response gained `missing` and `arrivedDuringCount` counters, and
  `StockStocktakeTab.jsx` now sends `mode: 'full'` and `startedAt` — **the only
  frontend change in this whole batch of work.**

Two user-facing error strings changed as a result of unifying the quarantine rule:

- `/dispense` — was "X is not a dispensing location"
- `/checkout-dispense` — was "X is a non-dispensing location — its stock is quarantined
  and cannot be dispensed"
- both now — "X is a non-dispensing location — its stock is quarantined. Transfer it
  back into normal stock first." (tells the user what to do next)

API response shapes are unchanged; no frontend edit is needed. The dashboard keeps its
`total` field name and the reorder report keeps `totalQuantity`, which is what
`StockDashboardTab.jsx` and `StockReportsTab.jsx` already read.

---

## P1 — wrong information, or a safety gap

### STK-01 · Dashboard hides items that are completely out of stock

**Where:** `controllers/stockMovementController.js:500-520`

`totalsByItem` is built only from `StockLevel` rows with `quantity > 0`. An item that
has hit zero across every location has no such rows, so it never enters the map and
can never appear in `itemsBelowReorder`. The "items below reorder" card therefore
excludes exactly the items that most need reordering.

`reports/reorder` (`stockReportController.js:26-52`) implements the same concept
correctly — it starts from `StockItem.findAll` and defaults with `totals[i.id] || 0`.
So the dashboard card and the reorder report disagree, and the dashboard is the one
that's wrong.

**Impact:** Someone watching the dashboard sees a lower count than reality and never
gets told about a stocked-out item. Both numbers are visible in the same UI, so the
disagreement is user-facing.

**Fix:** Build the dashboard totals the way the report does — enumerate active items
with `reorderLevel > 0`, then attach summed levels, defaulting missing ones to zero.
Worth extracting one shared helper so the two can't drift again.

**Verify:** Take any item to zero everywhere, then compare the dashboard card against
`GET /api/stock/reports/reorder`. The report lists it; the card doesn't count it.

---

### STK-02 · `/use` has no dispensing-location guard

**Where:** `controllers/stockMovementController.js:223-247`

`/dispense` checks `location.isDispensing` (line 181) and `/checkout-dispense` checks
it (line 612). `/use` never looks the location up at all. Nothing stops point-of-care
use being recorded against the Faulty Box — the non-dispensing quarantine whose entire
purpose is that returned faulty stock cannot reach a patient without an explicit,
logged transfer back into normal stock first.

Same omission means `/use` doesn't check the location exists or is active either, so a
bad `locationId` comes back as a 500 from a foreign-key error instead of a clean 400.

**Impact:** The quarantine is bypassable through the one endpoint that is deliberately
open to every clinical role. This is the highest-consequence item on the list.

**Fix:** Load the location, mirror the guards `/dispense` already uses (exists, active,
`isDispensing`). Keep the route's role gate as it is — the point is validating the
location, not restricting who may record use.

**Verify:** Return an item as faulty so it lands in the Faulty Box, then `POST
/api/stock/use` with that batch and the Faulty Box location. It currently succeeds.

---

### STK-03 · FEFO overrides report misses the advisory overrides

**Where:** `controllers/stockReportController.js:208`

The filter is `reason LIKE 'FEFO override:%'`. The blocking paths write
`FEFO override: <reason>` (lines 204 and 281) and match. The advisory paths write
`FEFO override (use): …` and `FEFO override (checkout): …` (lines 60 and 628) — the
parenthesical sits between the word and the colon, so those rows never match.

Both code comments explicitly promise the advisory overrides "still surface in the
FEFO-overrides report". They don't.

**Impact:** The report silently under-reports. Point-of-care use and checkout
dispensing are the higher-volume paths, so most overrides are probably missing.

**Fix:** `reason: { [Op.like]: 'FEFO override%' }` (drop the colon). Consider a
dedicated column or a structured prefix later if the reason string picks up more
overloaded jobs — the inventory report already regex-parses `Stocktake …` reasons out
of the same field, which is a pattern worth not extending.

**Verify:** Record a `/use` against a non-earliest-expiring batch, confirm the movement
row's reason starts `FEFO override (use):`, then check it is absent from
`GET /api/stock/reports/fefo-overrides`.

---

## P2 — integrity and robustness

### STK-04 · Stocktake reads expected quantities outside its transaction

**Where:** `controllers/stockRoomController.js:301` (read) vs `:307` (transaction opens)

Current levels are loaded before the transaction begins. A dispense landing in the gap
makes `expected` stale, so the adjustment writes the wrong corrected figure **and**
records a false variance in the reason string — which then feeds the variances report
and the inventory report's `lastStocktake`.

**Impact:** Corrupts the reconciliation record under concurrency. Low probability on a
quiet clinic, but it's the audit trail, and a wrong variance is worse than no variance.

**Fix:** Move the level read inside the transaction and take the same `LOCK.UPDATE`
row locks `adjustLevel` uses, so a count and a dispense serialise properly.

---

### STK-05 · Expired batches vanish from the list used to write them off

**Where:** `controllers/stockMovementController.js:453-459`

`?expiringWithinDays=` forces `status: 'active'`. Once the daily sweep flips a
passed-expiry batch to `'expired'`, it drops out of that response — but the physical
stock is still on the shelf and still needs writing off.

The dashboard's `expired` bucket is unaffected because it is computed separately from
levels, so this only bites whichever screen calls `/batches` directly.

**Impact:** Expired stock becomes hard to find through the endpoint you'd naturally use
to find it. Fails toward stock sitting on a shelf uncounted.

**Fix:** Allow `status: ['active', 'expired']` for the expiry window, or drop the
status filter and rely on the `levels` join already requiring `quantity > 0`. Check
what the frontend expiry screen calls before choosing.

---

### STK-06 · Two different definitions of "today"

**Where:** `utils/stockLedger.js:47-48` and `utils/stockExpirySweep.js:24`

`isExpired` compares a UTC-parsed `DATEONLY` against **local** midnight. The sweep uses
`toISOString()`, i.e. the **UTC** date. At UTC+03 they agree, so this is currently
latent — but they can disagree by a day, and on a negative UTC offset `isExpired` would
flag batches as expired a day early and block dispensing stock that is still good.

**Impact:** None today on a +03 server. It's a landmine for a deployment or a container
running in UTC, and the two files disagreeing is a maintenance hazard regardless.

**Fix:** One shared `clinicToday()` helper used by both, explicit about the clinic
timezone rather than inheriting the process's.

---

### STK-07 · `adjustLevel` swallows every error, not just the race

**Where:** `utils/stockLedger.js:57-61`

The `.catch(() => {})` on `findOrCreate` exists to absorb the unique-index race between
two concurrent creates — correct intent. But it also absorbs FK violations, validation
errors and connection failures, which then resurface as the misleading
`'Stock level row could not be created'` from the `findOne` below.

**Impact:** Real failures get a confusing message and the true error never reaches the
logs. Directly relevant to debugging STK-02, where a bad `locationId` takes this path.

**Fix:** Narrow the catch to `SequelizeUniqueConstraintError` and rethrow anything else.

---

### STK-08 · No automated tests for the ledger invariants

**Where:** project-wide — no `*.test.js` outside `node_modules`

The module's whole value proposition is "the append-only ledger and the materialized
levels can never disagree", and none of it is covered. The invariants are cheap to test
and stable enough to be worth locking down:

- a level can never go negative, including two concurrent dispenses of the last unit
- expired stock rejects `dispense` / `use` / `transfer` but accepts `expiry_writeoff`
- a `requiresColdChain` item is refused by a non-fridge destination
- a recalled batch refuses every movement type
- a reversal restores levels exactly, cannot be re-reversed, and cannot be double-applied
- `rebuildLevels()` reproduces the live `StockLevel` table from the ledger
- FEFO picks earliest expiry, with `receivedAt` as tiebreaker and undated batches last

That last one is the cheapest way to catch regressions in all four dispensing paths at
once, since they each call `suggestFefoBatch` differently.

---

## P3 — hygiene, and one decision

### STK-09 · Stale comment on `dispense`

`controllers/stockMovementController.js:164-167` still documents `uhid?` as optional and
describes over-the-counter collection. Commit `e41f884` made the patient mandatory and
line 185 enforces it. The comment is stale, not the behaviour.

### STK-10 · Stale comment in the recall report

`controllers/stockReportController.js:113-114` says the "every patient who received it"
half activates "with the future patient-linking phase". Lines 143-155 implement it. The
second comment even says so — the first was never updated.

### STK-11 · `copyParLevels` doesn't validate the destination

`controllers/stockRoomController.js:121-149` validates neither that `toLocationId`
exists nor that it is active, though its sibling `setParLevels` validates both
(`:74-75`). It destroys the destination's par levels before bulk-creating, so a typo'd
id wipes nothing recoverable but does create orphan rows against a non-existent
location.

### STK-12 · Stocktake ignores batches absent from the submitted counts

`controllers/stockRoomController.js:301-329` reconciles only the batches present in
`counts`. A batch sitting at the location that the counter never scanned keeps its
phantom quantity untouched.

**This may well be intended** — it makes partial counts safe, which matters if you're
counting one shelf rather than a whole room. But it means a full stocktake cannot
detect stock that has vanished without being scanned, which is the single thing a
stocktake is for. **Decision needed:** leave as-is and document it, or add an explicit
"full count" mode that zeroes unlisted batches at that location.

---

## Files touched

| File | Change |
|------|--------|
| `utils/stockTotals.js` | new — shared quantity roll-ups |
| `utils/clinicTime.js` | new — shared date handling |
| `tests/stockLedger.test.js` | new — 19 invariant assertions |
| `utils/stockLedger.js` | STK-06, STK-07 |
| `utils/stockExpirySweep.js` | STK-06 |
| `controllers/stockMovementController.js` | STK-01, STK-02, STK-05, STK-06, STK-09 |
| `controllers/stockReportController.js` | STK-01, STK-03, STK-10 |
| `controllers/stockRoomController.js` | STK-01, STK-04, STK-06, STK-11 |
| `package.json` | `npm test` now runs the suite |

No migrations, no schema changes, no API response-shape changes.

---

# Production-readiness pass

A second review looking only for things that behave differently under real load
and real data volume than they do on a demo database. Five found, all fixed.

| ID | Severity | Issue |
|----|----------|-------|
| PROD-1 | **High** | Checkout dispensing can hang every request under load |
| PROD-2 | **High** | Two concurrent checkouts can deadlock |
| PROD-3 | Medium | Inventory report scans the entire movement history, forever |
| PROD-4 | Medium | Dashboard expiry buckets are O(levels²) |
| PROD-5 | Medium | `rebuildLevels` loads the whole ledger into memory |

### PROD-1 · Checkout dispensing can hang every request under load

`checkoutDispense` opened a transaction, then called `suggestFefoBatch` **without
passing it**. That query therefore ran on a *second* connection from the pool while
the first was still held.

The pool is `max: 20` with a 30-second acquire timeout. With 20 concurrent checkouts,
all 20 connections are held by transactions, each waiting for a free connection to run
its FEFO lookup — which never arrives. Every request hangs for 30 seconds and then
fails. Classic pool self-deadlock, and it only shows up under concurrency, which is
exactly when a clinic is busiest.

It was also silently wrong: reading outside the transaction meant FEFO couldn't see
the caller's own uncommitted lines, so a multi-line checkout kept suggesting a batch
its earlier line had just emptied.

`suggestFefoBatch` now takes a transaction, and the doc comment says why it is not
optional. The other callers (`/dispense`, `/use`) were already fine — they run FEFO
before opening their transaction.

### PROD-2 · Two concurrent checkouts can deadlock

`applyMovement` takes a `FOR UPDATE` lock per (batch, location), in whatever order the
client happened to list the lines. Two checkouts sharing two batches in opposite order
deadlock, and InnoDB kills one of them mid-dispense.

Lines are now sorted by batch then location before the loop, so every checkout acquires
locks in the same global order and the cycle cannot form.

### PROD-3 · Inventory report scans the entire movement history

To find each item's most recent delivery, the report loaded **every intake movement
ever recorded** and threw away all but the newest per item — and did the same for every
stocktake adjustment. The ledger is append-only, so that scan grows for the life of the
clinic: fine in month one, minutes and hundreds of megabytes in year three.

Replaced with `latestPerItem()`: one grouped query for the newest timestamp per item,
one fetch of just those rows. Both are proportional to the *catalogue*, which is
roughly constant, rather than to the history.

### PROD-4 · Dashboard expiry buckets are quadratic

Building each batch's location list re-scanned the entire levels array, inside a loop
over that same array. At a few thousand level rows that is tens of millions of
comparisons on every dashboard load. Now grouped into a `Map` once, then looked up.

### PROD-5 · `rebuildLevels` loads the whole ledger into memory

The admin repair tool read every movement ever recorded to sum them in JavaScript — so
the tool you reach for when the levels table is wrong is the one most likely to run the
process out of memory. Now two grouped `SUM` queries (stock out of a location, stock
into one), returning at most one row per (batch, location): the size of the table being
rebuilt, not of the history behind it.

---

# Third pass — data integrity

| ID | Severity | Issue |
|----|----------|-------|
| INT-1 | **Critical** | Concurrent reversals invent stock that was never received |
| INT-2 | Medium | Stock can be moved into a retired location and disappear |
| INT-3 | Low | Unknown location returns a raw 500 with an SQL stack trace |

### INT-1 · Concurrent reversals invent stock — *reproduced*

`reverseMovement` checked for an existing reversal before writing one. That is a
check-then-act race, and MySQL's default REPEATABLE READ makes it a losing one: both
transactions take their snapshot before either commits, both see no reversal, and both
proceed. The `StockLevel` row lock serialises the *writes* but does not invalidate the
second transaction's stale snapshot.

Reproduced against the dev database: a batch of 100 with a dispense of 30 reversed
twice ended at **130 units** — thirty that were never received, in the ledger that is
supposed to be the source of truth. Three concurrent attempts gave three reversals.

This is worse than the level races fixed earlier, because each reversal is individually
*valid*: nothing goes negative, no constraint complains, and `rebuildLevels()` faithfully
reproduces the wrong number because the ledger itself is wrong.

No application-level read can close that window, so the invariant now lives in the
database: a unique index on `reversesMovementId`
(`migrations/20260730120000-unique-reversal-per-movement.js`). NULL is exempt, so
ordinary movements are unaffected. `reverseMovement` also locks the movement being
reversed, and translates the index rejection into the same "already been reversed"
message the fast path gives.

The migration refuses to run if duplicates already exist rather than failing halfway,
and says how to resolve them — silently deleting rows from an append-only ledger would
be worse than stopping.

### INT-2 · Stock can be moved into a retired location

`transfer` and `adjustment` never checked the destination, so stock could be moved into
a retired location and accepted with a 201. Every screen filters to active locations, so
those units are then invisible — lost in practice, though the ledger still counts them.

Locations are now validated by direction of travel, which is the distinction that
matters:

- **arriving** — must be active (`resolveDestinationLocation`)
- **leaving** — need only exist (`resolveSourceLocation`), because a retired location
  must still be emptiable or retiring one strands its contents forever
- **leaving with a patient** — must also be a dispensing location

### INT-3 · Unknown location returned a raw 500

`transfer`, `adjustment` and `writeoff` passed the client's `locationId` straight to the
ledger, so a bad one surfaced as a `SequelizeForeignKeyConstraintError` — a 500, a stack
trace in the logs, and "Failed to adjustment" to the user. Now a clean 404. The mangled
messages came from deriving the text from the handler name; each handler now supplies a
readable phrase.

---

# Fourth pass — reference data

The first three passes were all on the ledger and the movement controllers. This one
covers `stockCatalogController`, which had not been reviewed at all.

### CAT-1 · Retiring a location or item orphans the stock it holds — *reproduced*

Retiring is a status update, and nothing checked whether the row still held stock. Both
were accepted silently, with different consequences:

- **A retired LOCATION** disappears from every picker, so its contents can no longer be
  transferred, dispensed or written off through the UI — while still counting towards
  on-hand totals. Reproduced: 40 units left counted but unreachable.
- **A retired ITEM** is worse, because the two figures disagree. Its units stay in the
  ledger and on the Items screen's `totalQuantity`, but `itemsBelowReorder` filters to
  active items, so it silently drops out of the reorder report. The clinic can be short
  of something it still stocks and never be told.

Both are now refused with a 409 naming the quantity, so the stock has to be moved or
written off first. The guard fires only on the transition to `retired` — ordinary edits,
and re-retiring something already retired, are unaffected. Wired into the shared CRUD
factory as a `stockHeld` hook, so a future reference table gets it by declaring one
function.

### Deliberately left uncapped

`GET /levels` and `GET /batches` return every matching row with no limit. Adding one
would be actively dangerous now that a stocktake is a full count: the count screen
builds its list from `GET /levels`, so a silent truncation would make the client submit
a partial list and the server would write off every batch that fell past the cap. If
these ever need paginating, the stocktake flow has to be reworked in the same change.

---

## Open questions

1. **STK-06 — assumption made, please confirm.** `CLINIC_TIMEZONE` defaults to
   `Africa/Mogadishu` (+03), which matches the server's current behaviour, so nothing
   changes today. Set the env var if that's wrong.
2. **The `reason` column.** It carries structured data several ways
   (`FEFO override…`, `Stocktake (expected X, counted Y)`, `Return (faulty —
   quarantined)`) and three consumers parse it back out with `LIKE` or regex. STK-03 was
   the first bug this caused and probably not the last — the STK-12 work had to keep the
   exact `expected X, counted Y` wording so the inventory report's regex kept matching,
   which is the smell. The next consumer should be the trigger to add proper columns.

*(STK-05's question resolved itself: nothing calls `expiringWithinDays` yet —
`getBatches()` is invoked with no params from `StockAnalyticsTab` — so there was no
frontend contract to preserve.)*
