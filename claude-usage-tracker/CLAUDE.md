# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file **Tampermonkey/Greasemonkey userscript** that injects a floating usage dashboard into `claude.ai`. It does not estimate anything — it reads the exact values Claude exposes in Settings → Usage from internal API endpoints and re-presents them (session %, weekly %, routines, extra-usage credits) plus a locally-reconstructed 7-day chart. See `README.md` for the user-facing feature/plan/colour spec.

There is **no build system, package manager, test suite, or linter** — the deliverable is one `.js` file pasted into Tampermonkey. Don't look for `npm`/`make`/CI; there is none.

## Repository layout

- `claude-usage-tracker.user.js` — the **deliverable**: the complete userscript (config → colour ramp → storage/positioning → CSS → component builders → views → data layer). This is the only file an end user installs.
- `README.md` — user-facing spec: features, supported plans, data sources, and the colour ramp.
- `CHANGELOG.md` — version history.
- `final-mockup.html` — a static HTML gallery assembling the UI design (no network/storage/polling). The visual reference; iterate here before porting changes into the userscript.

The userscript was composed from three earlier UI lineages — **Editorial** (shell/header/pill/chart/error), **Glass** (weekly panel), and **Allowance** (rings/timers/size + the `localStorage` data layer). Those source `.js` files are gone; the mockup carries the canonical UI design and the userscript carries the working fetch/render/polling layer.

## Developing & testing

- **Preview the mockup:** open `final-mockup.html` in a browser and refresh after edits. If a feature is blocked on `file://` (or you need automated screenshots), serve it: `python -m http.server 8777` then open `http://localhost:8777/final-mockup.html` (stop the server when done — orphaned `http.server` processes lock the folder). The page renders every state (Pro on/off, Free, collapsed pill, error) in one gallery via demo `STATE` objects.
- **Test the real userscript:** Tampermonkey → Create new script → paste the `.js` → save → reload `claude.ai`. It only produces real data while logged into claude.ai; otherwise it shows the error card.
- There are no unit tests. Verification means rendering in a browser and checking behaviour against `README.md`.

## Architecture

The userscript is one IIFE, laid out in this order; read top-to-bottom:

1. **Config / constants** — storage keys, `POLL_MS`, ring geometry (radii + pre-computed circumferences), and `RAMP`.
2. **Colour ramp** — `rampRGB`/`rampColor` interpolate a single green→red scale that drives *every* ring, bar, and chart point; glow opacity also climbs with %. One value's colour and brightness encode its severity. The final mockup re-anchors the low end to Editorial green (`#7cb87c`) and reaches red-orange by ~70%.
3. **Storage + positioning** — `localStorage` for persisted state. Position is **edge-anchored** (nearest corner + distance) so it survives resize; custom drag with a movement threshold distinguishes click from drag, and the widget is scaled by screen width.
4. **CSS** — injected as one big string; web fonts loaded via a Google Fonts `<link>`.
5. **Component builders** — `ringSVG` (dual concentric ring), pill ring, the **cardinal-spline area chart**, and the breakdown/extras panel.
6. **Views** — `dashboardHTML` (expanded), `pillHTML` (collapsed), and an error view; `render()` swaps between them.
7. **Data layer** — `getOrg()` → `fetchUsage()`; render loop polls every `POLL_MS`.

### Non-obvious cross-cutting behaviour

- **Dual ring semantics:** inner ring = 5-hour session, outer ring = weekly; the centre number is the session %, and hovering the ring swaps it to weekly. The collapsed pill shows `session% / weekly%`.
- **The 7-day chart is reconstructed locally** — the API only returns the *current* weekly utilisation, so the script attributes increases-since-last-poll to today's bucket and shifts the window on date rollover. History is not available from Claude.
- **SPA re-mount:** Claude's SPA tears down `document.body` children on navigation, so a `MutationObserver` re-appends the widget host when it disappears.
- **Plan-aware UI:** rows render only when the plan exposes them — Routines and Extra Usage appear for Pro/Max/Team; the Free plan has neither, so its card collapses to ring + timers with no weekly panel and no chart. Extra Usage that is *available but off* shows `On/Off` + `N/A`; *unavailable* (Free) is hidden entirely.

### Claude API endpoints the data layer depends on

All called with `credentials: 'include'` against the current claude.ai origin:

- `GET /api/organizations` → first org's `uuid` + `capabilities` (used for plan detection).
- `GET /api/organizations/{orgId}/usage` → `five_hour`, `seven_day`, `seven_day_cowork` each with `utilization` + `resets_at`.
- `GET /v1/code/routines/run-budget` → daily routine `used`/`limit`. Requires headers `x-organization-uuid`, `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-triggers-2026-01-30`, `anthropic-client-platform: web_claude_ai`.
- `GET /api/organizations/{orgId}/overage_spend_limit` → extra-usage `is_enabled`, `used_credits`, `monthly_credit_limit`.

> Claude no longer exposes a separate "Claude Design" weekly bucket — it is folded into the single **All models** (`seven_day`) weekly limit. New UI should not reintroduce a Claude Design row.
