# Changelog

All notable changes to Claude Usage Tracker are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-06-03

Initial release.

### Added

- Floating, draggable, edge-anchored usage widget for claude.ai.
- Dual rings: 5-hour session (inner) and weekly (outer), with hover to swap the centre figure.
- Session and weekly reset countdown timers.
- Routines daily budget (`used / limit`) for Pro/Max/Team plans.
- Extra-usage credit tracking (`used / limit`) when enabled.
- Locally reconstructed 7-day weekly-utilisation chart.
- Collapsible `session% / weekly%` pill mode.
- Plan-aware rendering (Free vs Pro/Max/Team).
- Continuous green → red severity colour ramp across rings, bars, and chart.
- `localStorage` persistence for position and collapsed state.
- `MutationObserver` re-mount to survive Claude's SPA navigation.
