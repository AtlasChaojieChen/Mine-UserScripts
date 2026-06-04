# Claude Usage Tracker — Userscript Build Design

**Date:** 2026-06-03
**Status:** Approved design, pre-implementation
**Goal:** Turn `Claude-Usage-Tracker-Final-Mockup.html` into a shipping Tampermonkey
userscript by keeping the mockup's render layer verbatim and building the live
data/interaction layer around it.

## Scope

- **In:** New file `Claude-Usage-Tracker.user.js` — full IIFE with Tampermonkey
  header, live data layer for the documented endpoints, local 7-day chart
  reconstruction, drag/position/scale, expand⇄collapse, polling, SPA re-mount,
  Shadow DOM isolation.
- **Out:** Build tooling, tests, framework. The mockup HTML stays as the design
  reference and is not modified. No new UI features beyond the mockup's states.

## Findings from live endpoint probe (Pro account, 2026-06-03)

These supersede CLAUDE.md where they differ; CLAUDE.md should be updated after.

1. **`/api/organizations`** → array; first element gives `uuid` and
   `capabilities`. Observed `capabilities: ["chat","claude_pro"]`.
2. **`/api/organizations/{org}/usage`** →
   ```json
   {
     "five_hour": {"utilization": 85.0, "resets_at": "2026-06-04T02:59:59.659027+00:00"},
     "seven_day": {"utilization": 37.0, "resets_at": "2026-06-04T10:00:00.659055+00:00"},
     "seven_day_cowork": null,
     "extra_usage": {"is_enabled": true, "monthly_limit": 2000, "used_credits": 0.0,
                     "utilization": null, "currency": "USD", "disabled_reason": null}
   }
   ```
   - **`extra_usage` is inline** — the separate `overage_spend_limit` endpoint
     documented in CLAUDE.md returns the same numbers and is **not needed**.
   - `monthly_limit` / `used_credits` are in **cents** (2000 → $20.00). Divided
     by a named `CREDIT_DIVISOR = 100` constant so it is trivial to flip if wrong.
   - `extra_usage.utilization` is `null` → compute `used/limit` locally.
3. **`/v1/code/routines/run-budget`** → requires headers `x-organization-uuid`,
   `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-triggers-2026-01-30`,
   `anthropic-client-platform: web_claude_ai`. Could not be verified via plain
   navigation (returns `authentication_error` without the headers). Success shape
   parsed **tolerantly**: look for `used`/`limit` at top level or one level of
   nesting; any failure → routines row hidden.

## Architecture

One IIFE, ordered per CLAUDE.md (read top-to-bottom):

1. **Config / constants** — storage keys, `POLL_MS = 60000`, `CREDIT_DIVISOR`,
   ring radii + precomputed circumferences, `RAMP`, endpoint header constants.
2. **Colour ramp** — `rampRGB` / `rampColor` / `rampGlowCss` / `ringGlow`,
   lifted verbatim from the mockup.
3. **Storage + positioning** — `localStorage` get/set helpers; edge-anchored
   position (nearest corner + offset, survives resize); width-scaled size; custom
   drag with a movement threshold to separate click from drag; persisted
   collapsed flag.
4. **CSS** — the mockup's widget CSS as one string (gallery-only `.page-*`,
   `.gallery`, `.specimen`, `.stage`, `body` rules removed), injected into a
   **Shadow DOM** root.
5. **Component builders** — `ringSVG`, `pillMini`, `smoothPath`, `chartHTML`,
   `rowHTML`, `weeklyPanelHTML` — **verbatim** from the mockup.
6. **Views** — `ringHTML`, `timersHTML`, `headerHTML`, `chartSection`,
   `expandedHTML`, `pillHTML`, `errorHTML` — verbatim; plus a `render()` that
   swaps expanded/pill/error into the shadow host and rewires event listeners.
7. **Data layer** — `getOrg()`, `fetchUsage()`, `fetchRoutines()`,
   `buildState()`; render loop polls every `POLL_MS`.

## Data layer → STATE mapping

`buildState()` returns exactly the mockup `STATE` shape so renderers are untouched:

| STATE field        | Source |
| ------------------ | ------ |
| `plan`             | `capabilities` → label (`claude_pro`→"Pro", `claude_max*`→"Max", `claude_team*`→"Team", else "Free"); fallback "Claude" if unrecognized but non-free |
| `session`          | `round(five_hour.utilization)` |
| `weekly`           | `round(seven_day.utilization)` |
| `sessionResetIn`   | humanize(`five_hour.resets_at` − now) → "2h 21m" / "54m" |
| `weeklyResetIn`    | humanize(`seven_day.resets_at` − now) → "5d 6h" / "3d 1h" |
| `routines`         | `{used,limit}` from run-budget, else `{used:0,limit:0}` (row hidden) |
| `extra.available`  | `extra_usage != null` |
| `extra.enabled`    | `extra_usage.is_enabled` |
| `extra.spent`      | `used_credits / CREDIT_DIVISOR` |
| `extra.limit`      | `monthly_limit / CREDIT_DIVISOR` |
| `extra.balance`    | `(monthly_limit − used_credits) / CREDIT_DIVISOR` |
| `daily`            | from local 7-day reconstruction (below) |

**Humanize:** `ms → "Nd Nh" | "Nh Nm" | "Nm"`, dropping zero leading units,
clamped at 0 ("0m") if already reset.

## 7-day chart reconstruction

The API exposes only the *current* cumulative weekly `utilization`. We attribute
deltas to the current calendar day and persist a rolling per-day map.

`localStorage["cut_history"]`:
```json
{ "days": { "2026-06-03": 11.0 }, "lastWeekly": 37, "lastResetAt": "2026-06-04T10:00:00..." }
```

Each successful usage poll:
1. `today = local YYYY-MM-DD`.
2. If `lastWeekly` undefined → first run: set `lastWeekly = weekly`, leave today's
   bucket at its current value (starts 0), persist. (History cannot be recovered;
   matches ReadME "recorded locally over time".)
3. Else `delta = weekly >= lastWeekly ? weekly - lastWeekly : weekly`
   (the else-branch absorbs a weekly reset without producing a negative delta).
4. `days[today] = (days[today] ?? 0) + delta`.
5. `lastWeekly = weekly`, `lastResetAt = seven_day.resets_at`; prune `days` keys
   older than 8 days; persist.

**Render:** build the 7-element `daily` array for the last 7 calendar days:
`label = weekday short name` (3-letter for breakdown plans, 1-letter for Free to
match the mockup's compact variant — driven by `hasBreakdown`), `usage = days[date]`
(rounded) or `null` if absent, `isToday` on the last slot.

## Error handling

- `getOrg()` or `fetchUsage()` throws / non-OK → render the **error card** with a
  short detail ("Not logged in" on 401/403, else status text). Manual refresh and
  the 60s loop both retry.
- `fetchRoutines()` failure → `routines.limit = 0` → row hidden, rest renders.
- `extra_usage` null → Extra/Spent/Balance rows hidden.
- A plan with neither routines nor extra → `hasBreakdown` false → ring + timers
  only (Free layout), no weekly panel, no chart.

## Isolation & mounting

- A single host `<div>` appended to `document.body`, `attachShadow({mode:'open'})`;
  all CSS + markup live inside the shadow root so claude.ai styles neither leak in
  nor get clobbered. The Google Fonts `<link>` is appended **both** to
  `document.head` (font loading is global) and referenced inside the shadow.
- **SPA re-mount:** a `MutationObserver` on `document.body` re-appends the host
  whenever it is removed by Claude's navigation teardown.
- Position/drag operate on the host element; `render()` only rewrites the shadow
  content and reattaches button/drag listeners.

## Verification

1. Paste into Tampermonkey → reload claude.ai (signed-in Pro account). Expect:
   plan "Pro", session ~85%, weekly ~37%, session/weekly reset timers counting
   down, Extra Usage **On** with Spent `$0.00 / $20.00`, Balance `$20.00`,
   routines row only if the headered call succeeds.
2. Visual parity: compare expanded/pill/error against the mockup gallery.
3. Drag to each corner + resize window → widget re-anchors. Collapse/expand →
   persists across reload. Force a 401 (logged out) → error card.
4. After two polls a today bucket appears in `cut_history`; confirm the chart
   point grows.

## Follow-up (not in this build)

Update CLAUDE.md: drop the `overage_spend_limit` endpoint (folded into `/usage`),
note `extra_usage` field names + cents unit, and the unverified routines shape.
