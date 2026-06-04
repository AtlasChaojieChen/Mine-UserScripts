// ==UserScript==
// @name         Claude Usage Tracker
// @namespace    https://github.com/atlas/claude-usage-tracker
// @version      1.0.0
// @description  Floating usage dashboard for claude.ai — session/weekly rings, routines, extra-usage credits, reset timers, and a locally reconstructed 7-day chart. Reads the exact values Claude exposes in Settings → Usage.
// @author       atlas
// @match        https://claude.ai/*
// @icon         https://claude.ai/favicon.ico
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    /* =====================================================================
     1. CONFIG / CONSTANTS
     ===================================================================== */
    const POLL_MS = 60000; // re-read usage every 60s
    const CREDIT_DIVISOR = 100; // extra_usage amounts are in cents → dollars
    const POS_KEY = 'cut_pos';
    const COLLAPSE_KEY = 'cut_collapsed';
    const HIST_KEY = 'cut_history';
    const FONTS_HREF =
        'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..600;1,9..144,300..400&family=Instrument+Sans:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap';

    // Anthropic-API headers required by the routines (run-budget) endpoint.
    const ROUTINE_HEADERS = {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'ccr-triggers-2026-01-30',
        'anthropic-client-platform': 'web_claude_ai',
    };
    const PRO_ROUTINE_LIMIT = 5;
    /* =====================================================================
     2. COLOUR RAMP  — continuous, glow-aware, re-anchored to Editorial green.
        (Ported verbatim from the design mockup.)
     ===================================================================== */
    const RAMP = [
        { stop: 0, color: [124, 184, 124] }, // #7cb87c  Editorial low
        { stop: 25, color: [124, 184, 124] }, // hold green across 0–25
        { stop: 45, color: [201, 189, 90] }, // #c9bd5a  midlow
        { stop: 60, color: [212, 168, 87] }, // #d4a857  mid
        { stop: 70, color: [226, 97, 78] }, // #e2614e  red-orange ~70%
        { stop: 88, color: [237, 77, 58] }, // #ed4d3a  crit
        { stop: 100, color: [237, 77, 58] },
    ];
    const lerp = (a, b, t) => a + (b - a) * t;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    function rampRGB(pct) {
        const p = clamp(pct, 0, 100);
        for (let i = 1; i < RAMP.length; i++) {
            if (p <= RAMP[i].stop) {
                const a = RAMP[i - 1],
                    b = RAMP[i];
                const t = (p - a.stop) / Math.max(1, b.stop - a.stop);
                return [0, 1, 2].map((k) =>
                    Math.round(lerp(a.color[k], b.color[k], t))
                );
            }
        }
        return RAMP[RAMP.length - 1].color.slice();
    }
    const rampColor = (pct) => `rgb(${rampRGB(pct).join(', ')})`;
    const rampGlowCss = (pct) => `rgba(${rampRGB(pct).join(', ')}, 0.5)`;
    const ringGlow = (pct) =>
        Math.min(1, 0.3 + (clamp(pct, 0, 100) / 100) * 0.8).toFixed(3);

    /* =====================================================================
     3. STORAGE + POSITIONING
     ===================================================================== */
    function loadJSON(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            return v == null ? fallback : JSON.parse(v);
        } catch {
            return fallback;
        }
    }
    function saveJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            /* quota / private mode */
        }
    }

    const defaultPos = () => ({ corner: 'br', dx: 20, dy: 20 });

    // Subtle width-based scale so the widget feels right on small + large screens.
    const computeScale = () => clamp(window.innerWidth / 1600, 0.8, 1.0);

    const ORIGIN = {
        tl: 'top left',
        tr: 'top right',
        bl: 'bottom left',
        br: 'bottom right',
    };

    // Edge-anchored placement: nearest corner + offset, so it survives resize.
    function applyPos(host) {
        if (!host) return;
        const pos = loadJSON(POS_KEY, defaultPos());
        host.style.transform = `scale(${computeScale()})`;
        host.style.transformOrigin = ORIGIN[pos.corner] || ORIGIN.br;
        host.style.left =
            host.style.right =
            host.style.top =
            host.style.bottom =
                'auto';
        if (pos.corner.includes('l')) host.style.left = pos.dx + 'px';
        else host.style.right = pos.dx + 'px';
        if (pos.corner.includes('t')) host.style.top = pos.dy + 'px';
        else host.style.bottom = pos.dy + 'px';
    }

    function persistCorner(host) {
        const r = host.getBoundingClientRect();
        const vw = window.innerWidth,
            vh = window.innerHeight;
        const left = r.left,
            top = r.top,
            right = vw - r.right,
            bottom = vh - r.bottom;
        const vert = top <= bottom ? 't' : 'b';
        const horiz = left <= right ? 'l' : 'r';
        saveJSON(POS_KEY, {
            corner: vert + horiz,
            dx: Math.max(0, Math.round(horiz === 'l' ? left : right)),
            dy: Math.max(0, Math.round(vert === 't' ? top : bottom)),
        });
    }

    // Custom drag with a movement threshold separating click from drag.
    function makeDraggable(host, handle, onClick) {
        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0 || e.target.closest('button')) return;
            e.preventDefault();
            const start = host.getBoundingClientRect();
            const startX = e.clientX,
                startY = e.clientY;
            host.style.transformOrigin = 'top left';
            host.style.right = host.style.bottom = 'auto';
            host.style.left = start.left + 'px';
            host.style.top = start.top + 'px';
            let moved = false;

            const move = (ev) => {
                const dx = ev.clientX - startX,
                    dy = ev.clientY - startY;
                if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
                const r = host.getBoundingClientRect();
                const nl = clamp(
                    start.left + dx,
                    0,
                    window.innerWidth - r.width
                );
                const nt = clamp(
                    start.top + dy,
                    0,
                    window.innerHeight - r.height
                );
                host.style.left = nl + 'px';
                host.style.top = nt + 'px';
            };
            const up = (ev) => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
                if (moved) {
                    persistCorner(host);
                    applyPos(host);
                } else if (onClick) onClick(ev);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
        });
    }

    /* =====================================================================
     4. CSS  — the widget block from the mockup, vars hoisted onto :host,
        injected into a Shadow DOM so claude.ai styles can't reach it.
     ===================================================================== */
    const CSS = `
  :host {
    --paper: #f5f4ee; --sec: #d6cfc4; --mute: #8b8275; --faint: #5e564e;
    --line: #3a352f; --line2: #48413a; --ember: #cc785c; --crit: #ed4d3a;
    all: initial;
    font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .cut-root, .cut-root * { box-sizing: border-box; margin: 0; padding: 0; }

  .cut { font-variant-numeric: tabular-nums lining-nums; font-feature-settings: 'lnum' 1, 'tnum' 1; color: var(--paper); }

  .card {
    background: linear-gradient(155deg, #2a2521 0%, #221f1c 60%, #1f1d1a 100%);
    border: 1px solid var(--line); border-radius: 16px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    position: relative; overflow: hidden; color: var(--paper);
  }
  .card::before {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(circle at 100% 0%, rgba(204, 120, 92, 0.10), transparent 55%);
  }
  .card::after {
    content: ''; position: absolute; inset: 0; pointer-events: none;
    background-image: radial-gradient(rgba(255, 255, 255, 0.012) 1px, transparent 1px);
    background-size: 3px 3px; opacity: 0.5;
  }
  .card > * { position: relative; z-index: 1; }
  .card.expanded { width: 372px; padding: 14px; }

  .ed-top {
    display: flex; justify-content: space-between; align-items: center;
    padding: 0 2px 2px; margin-bottom: 4px; cursor: move; user-select: none;
  }
  .ed-top .left { display: flex; align-items: center; gap: 7px; margin-left: 6px; }
  .ed-top .dot {
    width: 6px; height: 6px; border-radius: 99px;
    background: var(--ember); box-shadow: 0 0 6px rgba(204, 120, 92, 0.55);
  }
  .ed-top .dot.error { background: var(--crit); box-shadow: 0 0 6px rgba(237, 77, 58, 0.7); }
  .ed-top .dot.loading { animation: cut-pulse 1.4s infinite; }
  @keyframes cut-pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }
  .ed-top .plan {
    font-family: 'Geist Mono', ui-monospace, monospace; font-size: 15px; font-weight: 500;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--sec);
  }
  .ed-top .actions { display: flex; align-items: center; gap: 2px; }
  .ed-top .x, .ed-top .refresh {
    width: 18px; height: 18px; border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    color: #8b8275; cursor: pointer; line-height: 1;
    background: transparent; border: none; font-family: inherit;
    transition: background 150ms, color 150ms;
  }
  .ed-top .x { font-size: 14px; }
  .ed-top .x:hover, .ed-top .refresh:hover { background: rgba(255, 255, 255, 0.05); color: var(--sec); }
  .ed-top .refresh:active { transform: scale(0.92); }
  .ed-top .refresh svg { width: 12px; height: 12px; transition: transform 200ms ease; }
  .ed-top .refresh:hover svg { transform: rotate(45deg); }
  .ed-top .refresh.spinning svg { animation: cut-spin 0.8s linear infinite; }
  @keyframes cut-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .ed-grid { display: grid; grid-template-columns: 150px 1fr; gap: 12px; margin-bottom: 12px; align-items: stretch; }
  .ed-leftcol { display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 6px; transform: translateY(-5px); }
  .card.ed-free { display: inline-flex; flex-direction: column; width: auto; padding: 14px; }
  .ed-solo { display: flex; align-items: center; gap: 12px; }
  .ed-solo .cut-timers { font-size: 14px; gap: 10px; }
  .ed-solo .cut-timers em { font-size: 15px; }

  .cut-ringwrap { position: relative; width: 150px; height: 150px; }
  .cut-ringwrap svg.cut-ring { width: 100%; height: 100%; display: block; }
  .cut-ring-center {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    pointer-events: none;
  }
  .cut-pct {
    position: absolute; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-family: 'Fraunces', Georgia, serif; color: var(--paper);
    transition: opacity 0.22s, transform 0.22s;
  }
  .cut-pct-val { font-weight: 500; font-size: 44px; line-height: 0.92; letter-spacing: -0.04em; }
  .cut-pct.is-wide .cut-pct-val { font-size: 32px; }
  .cut-pct-lab {
    margin-top: 6px; font-family: 'Geist Mono', monospace; font-size: 9px; font-weight: 500;
    letter-spacing: 0.2em; text-transform: uppercase; color: var(--mute);
  }
  .cut-pct .u { font-size: 0.4em; font-weight: 400; font-style: italic; margin-left: 2px; opacity: 0.55; }
  .cut-pct.cut-weekly { opacity: 0; transform: scale(0.96); }
  .cut-pct.cut-weekly .cut-pct-lab { font-size: 6.5px; }
  .cut-ring-hover { fill: none; stroke: transparent; stroke-width: 18; pointer-events: stroke; cursor: pointer; }
  .cut-ringwrap:has(.cut-ring-hover:hover) .cut-pct.cut-session { opacity: 0; transform: scale(0.96); }
  .cut-ringwrap:has(.cut-ring-hover:hover) .cut-pct.cut-weekly { opacity: 1; transform: scale(1); }

  .cut-timers {
    display: flex; flex-direction: column; align-items: center; gap: 6px;
    font-size: 14px; color: rgba(232, 220, 204, 0.72);
  }
  .cut-timers-item { display: flex; align-items: center; gap: 7px; white-space: nowrap; line-height: 1; }
  .cut-timers em {
    font-family: 'Fraunces', Georgia, serif; font-style: normal; color: var(--paper);
    font-size: 14px; letter-spacing: -0.02em;
  }
  .cut-tdot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }

  .pill-state {
    font-family: 'Geist Mono', monospace; font-size: 8.5px; letter-spacing: 0.06em;
    padding: 1px 7px; border-radius: 3px; text-transform: uppercase; font-weight: 500;
  }
  .pill-on { color: #8fce8f; background: rgba(124, 184, 124, 0.12); border: 1px solid rgba(124, 184, 124, 0.32); border-left: 0; border-right: 0; }
  .pill-off { color: var(--mute); background: rgba(255, 255, 255, 0.03); border: 1px solid var(--line2); border-left: 0; border-right: 0; }

  .ed-week {
    background: rgba(255, 255, 255, 0.022); border: 1px solid var(--line);
    border-radius: 12px; padding: 11px 12px 10px;
    display: flex; flex-direction: column; gap: 11px; min-width: 0;
  }
  .ed-rows { display: flex; flex-direction: column; gap: 9px; }
  .na { color: var(--mute); font-style: italic; font-family: 'Fraunces', serif; font-size: 12px; }
  .ed-week .wtop { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .ed-week .wname { font-family: 'Fraunces', serif; font-style: italic; font-weight: 500; font-size: 15px; line-height: 1; }
  .ed-week .wname small {
    display: block; font-style: normal; color: var(--mute); font-size: 9px;
    letter-spacing: 0.16em; text-transform: uppercase; margin-top: 6px; font-weight: 500;
    font-family: 'Geist Mono', monospace;
  }
  .ed-week .wpct {
    font-family: 'Fraunces', serif; font-weight: 300; font-size: 26px; line-height: 0.9;
    letter-spacing: -0.04em;
  }
  .ed-week .wpct .u { font-size: 12px; font-style: italic; font-weight: 400; opacity: 0.6; margin-left: 1px; }
  .ed-week .wbar { height: 5px; border-radius: 999px; background: rgba(110, 100, 90, 0.5); box-shadow: inset 0 0 0 1px rgba(245, 244, 238, 0.06); overflow: hidden; }
  .ed-week .wbar i { display: block; height: 100%; border-radius: 999px; transition: width 0.4s; }

  .ed-row { min-width: 0; }
  .ed-row .r-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .ed-row:has(.track, .ed-seg) .r-top { margin-bottom: 6px; }
  .ed-week .r-lab {
    display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; color: var(--sec);
    white-space: nowrap; flex: none;
  }
  .ed-week .sw { width: 7px; height: 7px; border-radius: 2px; flex: none; }
  .ed-week .r-val {
    font-family: 'Geist Mono', monospace; font-size: 10.5px; font-weight: 500; color: var(--sec);
    flex: 0 1 auto; min-width: 0; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .ed-week .r-val small { color: var(--mute); font-weight: 400; }
  .ed-week .track { height: 3px; border-radius: 999px; background: rgba(110, 100, 90, 0.5); box-shadow: inset 0 0 0 1px rgba(245, 244, 238, 0.06); overflow: hidden; }
  .ed-week .track i { display: block; height: 100%; border-radius: 999px; transition: width 0.4s; }

  .ed-seg { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; }
  .ed-seg .pip { height: 4px; border-radius: 999px; background: rgba(110, 100, 90, 0.5); box-shadow: inset 0 0 0 1px rgba(245, 244, 238, 0.06); overflow: hidden; }
  .ed-seg .pip i { display: block; height: 100%; border-radius: 999px; transition: width 0.4s; }

  .ed-daily {
    background: rgba(255, 255, 255, 0.018); border: 1px solid var(--line);
    border-radius: 12px; padding: 10px 12px 8px;
  }
  .ed-daily .head-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .ed-daily .label {
    font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--mute); font-weight: 500;
  }
  .ed-daily .meta { font-family: 'Fraunces', serif; font-style: italic; font-size: 11px; color: var(--mute); }
  .b-chart-wrap { position: relative; height: 90px; }
  .b-empty {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-family: 'Fraunces', serif; font-style: italic; font-size: 12px;
    color: var(--mute); opacity: 0.6;
  }
  .b-chart-wrap svg { display: block; width: 100%; height: 100%; overflow: visible; }
  .b-dot { fill: #a89e91; stroke: #221f1c; stroke-width: 2; }
  .b-dot.null { fill: #5e564e; opacity: 0.5; }
  .b-dot.today { fill: var(--ember); filter: drop-shadow(0 0 5px rgba(204, 120, 92, 0.7)); }
  .b-lbl {
    position: absolute; transform: translate(-50%, -100%); margin-top: -4px;
    font-family: 'Fraunces', serif; font-style: italic; font-size: 10px; color: #a89e91;
    pointer-events: none; white-space: nowrap; z-index: 2;
  }
  .b-lbl .pct { font-size: 7.5px; opacity: 0.7; margin-left: 0.5px; }
  .b-lbl.today { color: var(--ember); font-weight: 500; font-size: 11px; }
  .ed-daily .lbls {
    display: grid; grid-template-columns: repeat(7, 1fr); margin-top: 4px;
    font-family: 'Geist Mono', monospace; font-size: 9px; font-weight: 500;
    color: var(--faint); letter-spacing: 0.04em; text-align: center;
  }
  .ed-daily .lbls span { text-transform: uppercase; }
  .ed-daily .lbls span.today { color: var(--ember); font-weight: 600; }

  .card.collapsed {
    width: auto; display: inline-flex; align-items: center; gap: 11px;
    padding: 8px 16px; border-radius: 999px; cursor: pointer; transition: transform 150ms; user-select: none;
  }
  .card.collapsed:hover { transform: translateY(-1px); }
  .pill-mini { width: 27px; height: 27px; border-radius: 99px; flex: none; position: relative; }
  .pill-mini .arc-outer, .pill-mini .arc-inner, .pill-mini .core { position: absolute; inset: 0; border-radius: 99px; }
  .pill-mini .arc-inner { inset: 4px; }
  .pill-mini .core { inset: 9px; background: #221f1c; z-index: 1; }
  .card.collapsed .num {
    font-family: 'Fraunces', serif; font-style: italic; font-size: 19px; font-weight: 500; letter-spacing: -0.02em;
  }
  .card.collapsed .num .pct { font-size: 11.5px; margin-left: 1px; opacity: 0.9; }
  .card.collapsed .sep { color: var(--paper); font-family: 'Instrument Sans', sans-serif; font-size: 15px; }
  .card.collapsed .dot {
    width: 6px; height: 6px; border-radius: 99px;
    background: var(--ember); box-shadow: 0 0 6px rgba(204, 120, 92, 0.55);
  }
  .card.collapsed .dot.loading { animation: cut-pulse 1.4s infinite; }

  .err { padding: 6px 14px 16px; font-family: 'Fraunces', serif; font-size: 13px; color: var(--paper); text-align: center; line-height: 1.5; }
  .err .msg { color: var(--crit); font-style: italic; }
  .err .detail { font-size: 10.5px; color: var(--mute); margin-top: 6px; font-family: 'Geist Mono', monospace; }
  .err .retry {
    display: inline-block; margin-top: 12px; padding: 5px 12px; border-radius: 6px;
    background: rgba(255, 255, 255, 0.05); border: 1px solid var(--line2); color: var(--sec); cursor: pointer;
    font-family: 'Instrument Sans', sans-serif; font-size: 11px; transition: background 150ms;
  }
  .err .retry:hover { background: rgba(255, 255, 255, 0.08); }
  `;

    /* =====================================================================
     5. COMPONENT BUILDERS  (ported verbatim from the mockup)
     ===================================================================== */
    const ringDash = (pct, c) => ({
        da: c.toFixed(2),
        off: (c * (1 - clamp(pct, 0, 100) / 100)).toFixed(2),
    });

    function ringSVG(weekly, session) {
        const Rc = 2 * Math.PI * 59,
            Ri = 2 * Math.PI * 45;
        const wo = ringDash(weekly, Rc),
            wi = ringDash(session, Ri);
        return `
      <svg class="cut-ring" viewBox="-10 -10 150 150" style="transform:rotate(-90deg)">
        <defs><filter id="cut-ring-glow" x="-25%" y="-25%" width="150%" height="150%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>
        <circle cx="65" cy="65" r="59" fill="none" stroke="rgba(72,65,58,0.45)" stroke-width="10"/>
        <circle cx="65" cy="65" r="59" fill="none" stroke="${rampColor(weekly)}" stroke-width="10"
          stroke-dasharray="${wo.da}" stroke-dashoffset="${wo.off}" filter="url(#cut-ring-glow)" opacity="${ringGlow(weekly)}"/>
        <circle cx="65" cy="65" r="59" fill="none" stroke="${rampColor(weekly)}" stroke-width="10"
          stroke-dasharray="${wo.da}" stroke-dashoffset="${wo.off}"/>
        <circle cx="65" cy="65" r="45" fill="none" stroke="rgba(72,65,58,0.45)" stroke-width="7"/>
        <circle cx="65" cy="65" r="45" fill="none" stroke="${rampColor(session)}" stroke-width="7"
          stroke-dasharray="${wi.da}" stroke-dashoffset="${wi.off}" filter="url(#cut-ring-glow)" opacity="${ringGlow(session)}"/>
        <circle cx="65" cy="65" r="45" fill="none" stroke="${rampColor(session)}" stroke-width="7"
          stroke-dasharray="${wi.da}" stroke-dashoffset="${wi.off}"/>
        <circle class="cut-ring-hover" cx="65" cy="65" r="59"/>
      </svg>`;
    }

    function pillMini(weekly, session) {
        const colW = rampColor(weekly),
            colH = rampColor(session);
        return `
      <span class="pill-mini">
        <span class="arc-outer" style="background: conic-gradient(${colW} 0% ${weekly}%, rgba(72,65,58,0.45) ${weekly}% 100%)"></span>
        <span class="arc-inner" style="background: conic-gradient(${colH} 0% ${session}%, #221f1c ${session}% 100%)"></span>
        <span class="core"></span>
      </span>`;
    }

    function smoothPath(points, tension = 6) {
        const ext = [points[0], ...points, points[points.length - 1]];
        let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        for (let i = 1; i < points.length; i++) {
            const p0 = ext[i - 1],
                p1 = ext[i],
                p2 = ext[i + 1],
                p3 = ext[i + 2];
            const c1x = p1.x + (p2.x - p0.x) / tension,
                c1y = p1.y + (p2.y - p0.y) / tension;
            const c2x = p2.x - (p3.x - p1.x) / tension,
                c2y = p2.y - (p3.y - p1.y) / tension;
            d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
        }
        return d;
    }
    function chartHTML(daily) {
        const hasData = daily.some((d) => (d.usage ?? 0) > 0);
        if (!hasData) {
            return `<div class="b-empty">No recent usage data</div>`;
        }
        const W = 360,
            H = 90,
            padX = 14,
            labelBand = 18,
            padBottom = 4;
        const innerW = W - padX * 2,
            innerH = H - labelBand - padBottom;
        const max = Math.max(1, ...daily.map((d) => d.usage ?? 0));
        const pts = daily.map((d, i) => ({
            x: padX + (i / (daily.length - 1)) * innerW,
            y: labelBand + (innerH - ((d.usage ?? 0) / max) * innerH),
            d,
            isNull: d.usage == null,
        }));
        const line = smoothPath(pts);
        const area =
            line +
            ` L ${pts[pts.length - 1].x.toFixed(2)} ${H} L ${pts[0].x.toFixed(2)} ${H} Z`;
        const dots = pts
            .map((p) => {
                const cls = p.d.isToday
                    ? 'b-dot today'
                    : p.isNull
                      ? 'b-dot null'
                      : 'b-dot';
                return `<circle class="${cls}" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${p.d.isToday ? 4.5 : 3}"/>`;
            })
            .join('');
        const labels = pts
            .map((p) => {
                if (p.isNull) return '';
                const v = Math.round(p.d.usage);
                const l = ((p.x / W) * 100).toFixed(2),
                    t = ((p.y / H) * 100).toFixed(2);
                return `<div class="${p.d.isToday ? 'b-lbl today' : 'b-lbl'}" style="left:${l}%;top:${t}%">${v}<span class="pct">%</span></div>`;
            })
            .join('');
        return `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs><linearGradient id="cut-area" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#cc785c" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="#cc785c" stop-opacity="0.02"/>
        </linearGradient></defs>
        <path d="${area}" fill="url(#cut-area)"/>
        <path d="${line}" fill="none" stroke="#cc785c" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
        ${dots}
      </svg>${labels}`;
    }

    function rowHTML({ label, swatch, value, meter, cls }) {
        return `
        <div class="ed-row${cls ? ' ' + cls : ''}">
          <div class="r-top">
            <span class="r-lab"><span class="sw" style="background:${swatch}"></span>${label}</span>
            <span class="r-val">${value}</span>
          </div>
          ${meter || ''}
        </div>`;
    }

    const GREY = '#5e564e';
    const GOLD = '#c9a96e';

    function weeklyPanelHTML(s) {
        const w = s.weekly;
        const rows = [];

        if (s.routines) {
            if (s.routines.limit > 0) {
                const rPct = (s.routines.used / s.routines.limit) * 100;
                const frac = s.routines.used / s.routines.limit;
                const segs = Array.from(
                    { length: 5 },
                    (_, i) =>
                        `<span class="pip"><i style="width:${clamp(frac * 5 - i, 0, 1) * 100}%;background:${rampColor(rPct)}"></i></span>`
                ).join('');

                rows.push(
                    rowHTML({
                        label: 'Routines',
                        swatch: rampColor(rPct),
                        value: `${s.routines.used}<small> / ${s.routines.limit}</small>`,
                        meter: `<div class="ed-seg">${segs}</div>`,
                    })
                );
            } else {
                rows.push(
                    rowHTML({
                        label: 'Routines',
                        swatch: GREY,
                        value: '<span class="na">N/A</span>',
                    })
                );
            }
        }

        const ex = s.extra;
        if (ex && ex.available) {
            const on = ex.enabled;
            const exPct = ex.limit ? (ex.spent / ex.limit) * 100 : 0;
            rows.push(
                rowHTML({
                    label: 'Extra Usage',
                    swatch: on ? '#7cb87c' : GREY,
                    cls: 'row-extra',
                    value: `<span class="pill-state ${on ? 'pill-on' : 'pill-off'}">${on ? 'On' : 'Off'}</span>`,
                })
            );
            rows.push(
                rowHTML({
                    label: 'Spent',
                    swatch: on ? rampColor(exPct) : GREY,
                    value: on
                        ? `$${ex.spent.toFixed(2)}<small>/$${ex.limit}</small>`
                        : '<span class="na">N/A</span>',
                    meter: on
                        ? `<div class="track"><i style="width:${clamp(exPct, 0, 100)}%;background:${rampColor(exPct)}"></i></div>`
                        : '',
                })
            );
            rows.push(
                rowHTML({
                    label: 'Balance',
                    swatch: on ? GOLD : GREY,
                    value: on
                        ? `$${ex.balance.toFixed(2)}`
                        : '<span class="na">N/A</span>',
                })
            );
        }

        return `
      <div class="ed-week">
        <div>
          <div class="wtop">
            <div class="wname">Weekly<small>All models</small></div>
            <div class="wpct" style="color:${rampColor(w)}">${w}<span class="u">%</span></div>
          </div>
          <div class="wbar" style="margin-top:9px"><i style="width:${clamp(w, 0, 100)}%;background:${rampColor(w)}"></i></div>
        </div>
        <div class="ed-rows">${rows.join('')}</div>
      </div>`;
    }

    /* =====================================================================
     6. VIEWS  (ported verbatim, with live event wiring in render())
     ===================================================================== */
    function hasBreakdown(s) {
        return (
            (s.routines && s.routines.limit > 0) ||
            (s.extra && s.extra.available)
        );
    }

    function ringHTML(s) {
        const sWide = s.session >= 100 ? ' is-wide' : '';
        const wWide = s.weekly >= 100 ? ' is-wide' : '';
        return `
            <div class="cut-ringwrap">
              ${ringSVG(s.weekly, s.session)}
              <div class="cut-ring-center">
                <div class="cut-pct cut-session${sWide}">
                  <span class="cut-pct-val">${s.session}<span class="u">%</span></span>
                  <span class="cut-pct-lab">Used</span>
                </div>
                <div class="cut-pct cut-weekly${wWide}">
                  <span class="cut-pct-val">${s.weekly}<span class="u">%</span></span>
                  <span class="cut-pct-lab">Weekly</span>
                </div>
              </div>
            </div>`;
    }

    function timersHTML(s) {
        return `
            <div class="cut-timers">
              <span class="cut-timers-item"><span class="cut-tdot" style="background:${rampColor(s.session)};box-shadow:0 0 8px ${rampGlowCss(s.session)}"></span>Session · <em>${s.sessionResetIn}</em></span>
              <span class="cut-timers-item"><span class="cut-tdot" style="background:${rampColor(s.weekly)};box-shadow:0 0 7px ${rampGlowCss(s.weekly)}"></span>Weekly · <em>${s.weeklyResetIn}</em></span>
            </div>`;
    }

    const headerHTML = (s) => `
        <div class="ed-top">
          <div class="left">
            <span class="dot"></span>
            <span class="plan">${s.plan}</span>
          </div>
          <div class="actions">
            <button class="refresh" title="Refresh">
              <svg viewBox="0 0 16 16" fill="none">
                <path d="M2 8a6 6 0 0 1 10.5-3.97M14 8a6 6 0 0 1-10.5 3.97" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <path d="M12.5 1.5v3.2h-3.2M3.5 14.5v-3.2h3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
            <button class="x" title="Collapse">&times;</button>
          </div>
        </div>`;

    const chartSection = (s) => `
        <div class="ed-daily">
          <div class="head-row"><span class="label">Last 7 Days</span><span class="meta"></span></div>
          <div class="b-chart-wrap">${chartHTML(s.daily)}</div>
          <div class="lbls">${s.daily.map((d) => `<span class="${d.isToday ? 'today' : ''}">${d.label}</span>`).join('')}</div>
        </div>`;

    function expandedHTML(s) {
        if (!hasBreakdown(s)) {
            return `
      <div class="cut card ed-free">
        ${headerHTML(s)}
        <div class="ed-solo">
          ${ringHTML(s)}
          ${timersHTML(s)}
        </div>
      </div>`;
        }
        return `
      <div class="cut card expanded">
        ${headerHTML(s)}
        <div class="ed-grid">
          <div class="ed-leftcol">${ringHTML(s)}${timersHTML(s)}</div>
          ${weeklyPanelHTML(s)}
        </div>
        ${chartSection(s)}
      </div>`;
    }

    function pillHTML(s) {
        return `
      <div class="cut card collapsed">
        ${pillMini(s.weekly, s.session)}
        <span class="num">${s.session}<span class="pct">%</span></span>
        <span class="sep">/</span>
        <span class="num">${s.weekly}<span class="pct">%</span></span>
      </div>`;
    }

    function errorHTML(detail) {
        return `
      <div class="cut card" style="width:236px;">
        <div class="ed-top" style="padding:11px 12px 8px;margin-bottom:0;">
          <div class="left"><span class="dot error"></span><span class="plan">Error</span></div>
          <div class="actions"><button class="x" title="Collapse">&times;</button></div>
        </div>
        <div class="err">
          <div class="msg">Couldn't fetch usage</div>
          <div class="detail">${detail}</div>
          <button class="retry">Try again</button>
        </div>
      </div>`;
    }

    function loadingHTML() {
        return `
      <div class="cut card collapsed" style="cursor:default">
        <span class="dot loading"></span>
        <span class="num" style="font-size:14px;color:var(--mute)">Loading…</span>
      </div>`;
    }

    /* =====================================================================
     7. DATA LAYER
     ===================================================================== */
    const BASE = location.origin; // https://claude.ai

    async function getJSON(url, opts) {
        const res = await fetch(
            url,
            Object.assign({ credentials: 'include' }, opts || {})
        );
        if (!res.ok) {
            const e = new Error('HTTP ' + res.status);
            e.status = res.status;
            throw e;
        }
        return res.json();
    }

    async function getOrg() {
        const orgs = await getJSON(`${BASE}/api/organizations`);
        if (!Array.isArray(orgs) || orgs.length === 0)
            throw new Error('No organization');
        const o = orgs[0];
        return { id: o.uuid, caps: o.capabilities || [] };
    }

    function planLabel(caps) {
        const has = (re) => caps.some((c) => re.test(c));
        if (has(/team/i)) return 'Team';
        if (has(/max/i)) return 'Max';
        if (has(/pro/i)) return 'Pro';
        if (has(/enterprise/i)) return 'Enterprise';
        return 'Free';
    }

    // Tolerant numeric extraction — the run-budget shape is unverified, so search
    // top-level then one level of nesting for the named key.
    function pickNum(obj, key) {
        if (obj == null || typeof obj !== 'object') return null;
        if (typeof obj[key] === 'number') return obj[key];
        for (const k in obj) {
            const v = obj[k];
            if (v && typeof v === 'object' && typeof v[key] === 'number')
                return v[key];
        }
        return null;
    }

    async function fetchRoutines(orgId) {
        try {
            const r = await getJSON(`${BASE}/v1/code/routines/run-budget`, {
                headers: Object.assign(
                    { 'x-organization-uuid': orgId },
                    ROUTINE_HEADERS
                ),
            });
            const limit = pickNum(r, 'limit');
            if (limit == null || limit <= 0) return { used: 0, limit: 0 };
            return { used: pickNum(r, 'used') ?? 0, limit };
        } catch {
            return { used: 0, limit: 0 }; // unavailable (e.g. Free) → row hidden
        }
    }

    function humanize(iso) {
        const t = new Date(iso).getTime();
        if (isNaN(t)) return '—';
        let s = Math.max(0, Math.floor((t - Date.now()) / 1000));
        const d = Math.floor(s / 86400);
        s -= d * 86400;
        const h = Math.floor(s / 3600);
        s -= h * 3600;
        const m = Math.floor(s / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }

    /* ---- 7-day chart: reconstructed locally from cumulative weekly % ---- */
    function localDate(d = new Date()) {
        return (
            d.getFullYear() +
            '-' +
            String(d.getMonth() + 1).padStart(2, '0') +
            '-' +
            String(d.getDate()).padStart(2, '0')
        );
    }
    const WD_FULL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const WD_MINI = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    function updateHistory(weekly, resetAt) {
        const h = loadJSON(HIST_KEY, {
            days: {},
            lastWeekly: null,
            lastResetAt: null,
        });
        if (typeof h.days !== 'object' || h.days == null) h.days = {};
        const today = localDate();
        if (h.lastWeekly == null) {
            h.lastWeekly = weekly; // first observation: establish the delta baseline
        } else {
            // weekly is cumulative; a drop means the week reset, so attribute the new
            // cumulative to today rather than producing a negative delta.
            const delta =
                weekly >= h.lastWeekly ? weekly - h.lastWeekly : weekly;
            h.days[today] = (h.days[today] || 0) + delta;
            h.lastWeekly = weekly;
        }
        // Today should never under-report current usage that isn't already attributed to
        // earlier days. Recovers usage that predates the script's first run (baseline loss),
        // so an existing 1% today shows on the chart instead of a misleading empty state.
        let earlier = 0;
        for (const k in h.days) if (k !== today) earlier += h.days[k] || 0;
        h.days[today] = Math.max(h.days[today] || 0, weekly - earlier);
        h.lastResetAt = resetAt || h.lastResetAt;
        const cutoff = Date.now() - 8 * 86400000;
        for (const k in h.days) {
            if (new Date(k + 'T00:00:00').getTime() < cutoff) delete h.days[k];
        }
        saveJSON(HIST_KEY, h);
    }

    function buildDaily(breakdown) {
        const h = loadJSON(HIST_KEY, { days: {} });
        const days = h.days || {};
        const now = new Date();
        const out = [];
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            const key = localDate(d);
            const wd = d.getDay();
            const val = days[key];
            out.push({
                label: breakdown ? WD_FULL[wd] : WD_MINI[wd],
                usage: val == null ? null : Math.round(val),
                isToday: i === 0,
            });
        }
        return out;
    }

    async function buildState() {
        const org = await getOrg(); // throws → error card
        const usage = await getJSON(
            `${BASE}/api/organizations/${org.id}/usage`
        ); // throws → error card
        const plan = planLabel(org.caps);

        let routines = await fetchRoutines(org.id); // never throws
        if (plan === 'Pro' && (!routines || routines.limit <= 0)) {
            routines = { used: 0, limit: PRO_ROUTINE_LIMIT };
        }
        const fh = usage.five_hour || {},
            sd = usage.seven_day || {};
        const session = Math.round(fh.utilization || 0);
        const weekly = Math.round(sd.utilization || 0);

        const ex = usage.extra_usage;
        const extra = ex
            ? {
                  available: true,
                  enabled: !!ex.is_enabled,
                  spent: (ex.used_credits || 0) / CREDIT_DIVISOR,
                  limit: (ex.monthly_limit || 0) / CREDIT_DIVISOR,
                  balance: (ex.used_credits || 0) / CREDIT_DIVISOR,
              }
            : { available: false };

        updateHistory(weekly, sd.resets_at);
        const breakdown = routines.limit > 0 || extra.available;

        return {
            plan,
            session,
            weekly,
            sessionResetIn: humanize(fh.resets_at),
            weeklyResetIn: humanize(sd.resets_at),
            routines,
            extra,
            daily: buildDaily(breakdown),
        };
    }

    /* =====================================================================
     8. RENDER + MOUNT + LOOP
     ===================================================================== */
    let host = null,
        shadow = null,
        rootEl = null;
    let lastState = null,
        lastError = null,
        inFlight = false;

    function setCollapsed(v) {
        saveJSON(COLLAPSE_KEY, v);
        render();
    }

    function render() {
        if (!rootEl) return;
        const collapsed = loadJSON(COLLAPSE_KEY, false);
        let html;
        if (lastError) html = errorHTML(lastError);
        else if (!lastState) html = loadingHTML();
        else if (collapsed) html = pillHTML(lastState);
        else html = expandedHTML(lastState);

        rootEl.innerHTML = html;
        wireEvents();
        applyPos(host);
    }

    function wireEvents() {
        const refresh = rootEl.querySelector('.refresh');
        if (refresh)
            refresh.addEventListener('click', (e) => {
                e.stopPropagation();
                refresh.classList.add('spinning');
                refreshNow();
            });

        const x = rootEl.querySelector('.x');
        if (x)
            x.addEventListener('click', (e) => {
                e.stopPropagation();
                setCollapsed(true);
            });

        const retry = rootEl.querySelector('.retry');
        if (retry)
            retry.addEventListener('click', (e) => {
                e.stopPropagation();
                refreshNow();
            });

        const header = rootEl.querySelector('.ed-top');
        if (header) makeDraggable(host, header, null);

        const pill = rootEl.querySelector('.card.collapsed');
        if (pill && lastState)
            makeDraggable(host, pill, () => setCollapsed(false));
    }

    async function refreshNow() {
        if (inFlight) return;
        inFlight = true;
        try {
            lastState = await buildState();
            lastError = null;
        } catch (e) {
            lastError =
                e && (e.status === 401 || e.status === 403)
                    ? 'Not logged in'
                    : (e && e.message) || 'Unknown error';
        } finally {
            inFlight = false;
            render();
        }
    }

    function mount() {
        host = document.createElement('div');
        host.id = 'cut-host';
        host.style.cssText = 'position:fixed;z-index:2147483600;';
        shadow = host.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = CSS;
        rootEl = document.createElement('div');
        rootEl.className = 'cut-root';
        shadow.append(style, rootEl);

        document.body.appendChild(host);
        applyPos(host);

        // Fonts load at document scope; @font-face is global and reaches the shadow.
        if (!document.getElementById('cut-fonts')) {
            const link = document.createElement('link');
            link.id = 'cut-fonts';
            link.rel = 'stylesheet';
            link.href = FONTS_HREF;
            document.head.appendChild(link);
        }
    }

    // SPA re-mount: Claude tears down document.body children on navigation.
    function observeBody() {
        const obs = new MutationObserver(() => {
            if (host && !document.body.contains(host)) {
                document.body.appendChild(host);
                applyPos(host);
            }
        });
        obs.observe(document.body, { childList: true });
    }

    let resizeTimer = null;
    function onResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => applyPos(host), 150);
    }

    function init() {
        if (document.getElementById('cut-host')) return;
        mount();
        render(); // initial loading pill
        refreshNow(); // first fetch
        setInterval(refreshNow, POLL_MS);
        observeBody();
        window.addEventListener('resize', onResize);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
