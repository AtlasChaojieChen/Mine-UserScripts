# Claude Usage Tracker

A Tampermonkey/Greasemonkey userscript that adds a small floating dashboard to **claude.ai** for tracking your Claude usage, limits, and recent activity at a glance.

It does not estimate or guess. It reads the exact values Claude already exposes under **Settings → Usage** and re-presents them in a compact, always-visible widget — so you never have to dig through account pages to see how much usage is left.

> Unofficial. Not affiliated with Anthropic. Claude is a product of Anthropic; this is a personal browser enhancement that only reads and displays information locally.

## Features

- **Floating widget** on every claude.ai page — draggable, edge-anchored, and persists its position.
- **Dual usage rings** — inner ring = 5-hour session, outer ring = weekly. Hover to swap the centre figure between session and weekly.
- **Reset timers** — countdown to the next session and weekly reset.
- **Routines budget** — daily routine `used / limit` (Pro/Max/Team).
- **Extra-usage credits** — overage spend `used / limit` when enabled.
- **Local 7-day chart** — a reconstructed history of weekly utilisation (see [Notes](#notes)).
- **Collapsible pill mode** — shrink to a compact `session% / weekly%` pill.
- **Plan-aware UI** — rows appear only for plans that expose them.
- **Severity colour ramp** — one continuous green → red scale drives every ring, bar, and chart point; colour and glow encode how close you are to a limit.
- **Tampermonkey menu commands** — refresh, collapse, reset position, and clear local history without touching the widget.
- **Auto-updates** — installs and updates straight from the raw GitHub file.
- **Single file, no build step, no external app.** Just a userscript.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension (Violentmonkey or Greasemonkey also work).
2. Click to install: **[claude-usage-tracker.user.js](https://raw.githubusercontent.com/AtlasChaojieChen/Mine-UserScripts/main/claude-usage-tracker/claude-usage-tracker.user.js)** — Tampermonkey detects the `.user.js` file and opens its install page.
3. Click **Install**.
4. Open `https://claude.ai` — the widget appears as a floating dashboard.

Once installed, Tampermonkey checks the raw file for new versions automatically and prompts you to update when `@version` is bumped.

If your script manager doesn't detect the raw file automatically:

1. Open Tampermonkey → **Create a new script**.
2. Delete the default template.
3. Paste the full contents of `claude-usage-tracker.user.js`.
4. Save with `Ctrl + S` and refresh claude.ai.

## Usage

- Open claude.ai while logged in — the widget reads your live usage automatically.
- **Drag** it anywhere; it snaps to the nearest corner and remembers where you left it.
- **Click** to collapse to the pill, click again to expand.
- **Hover** the ring to swap the centre number between session and weekly.
- **Tampermonkey menu** (extension icon → this script) offers quick actions: *Refresh now*, *Toggle collapsed*, *Reset position*, and *Clear 7-day history*.

If you are not logged in (or the usage endpoints are unreachable) the widget shows an error card instead of data.

## Supported plans

| Plan       | Session + weekly rings | Reset timers | Routines | Extra usage | Weekly panel + chart |
| ---------- | :--------------------: | :----------: | :------: | :---------: | :------------------: |
| Free       | ✅                     | ✅           | —        | —           | —                    |
| Pro        | ✅                     | ✅           | ✅       | ✅          | ✅                   |
| Max / Team | ✅                     | ✅           | ✅       | ✅          | ✅                   |

Extra Usage that is available but switched off shows `On/Off` + `N/A`; on Free (where it doesn't exist) it is hidden entirely.

## Notes

- **The 7-day chart is reconstructed locally.** Claude's API only returns the *current* weekly utilisation, not history. The script attributes each increase since the last poll to today and shifts the window on date rollover, so the chart fills in over time as you use it — it can't backfill days before the script was installed.
- This script does **not** modify Claude's backend or bypass any usage limit. It only reads and displays information in your browser; your position, collapsed state, and the local chart history are stored privately through your userscript manager (`GM_setValue`).

## Roadmap

- Model-specific usage breakdown
- Session history beyond the rolling 7-day window
- Token / context cost estimates
- Richer visual charts
- Export / import usage data
- Custom reset times and thresholds

## Development

This is a single-file userscript — there is no build system, package manager, or test suite. See [`CLAUDE.md`](./CLAUDE.md) for architecture and the Claude API endpoints it depends on, and [`final-mockup.html`](./final-mockup.html) for the UI design reference (open it in a browser).

## Licence

[MIT](../LICENSE)
