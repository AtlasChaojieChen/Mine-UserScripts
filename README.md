# UserScripts

A personal collection of browser userscripts — small, single-file enhancements you install with a userscript manager like [Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/), or Greasemonkey.

Each script lives in its own folder with its own README, changelog, and the installable `.user.js` file.

## Scripts

| Script | Description |
| ------ | ----------- |
| [**Claude Usage Tracker**](./claude-usage-tracker) | A floating dashboard for claude.ai showing session/weekly usage rings, reset timers, routines, extra-usage credits, and a local 7-day chart. |

## Installing a script

1. Install a userscript manager ([Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/), or Greasemonkey).
2. Open the script's folder and click its `*.user.js` file — your manager should detect it and offer to install.
3. See each script's own README for details, supported sites, and options.

## Repository layout

```
UserScripts/
├── README.md                       this index
├── LICENSE                         MIT
└── <script-name>/                  one folder per script (kebab-case)
    ├── <script-name>.user.js       the installable userscript
    ├── README.md                   what it does + how to install
    ├── CHANGELOG.md                version history
    └── docs/                       design notes, mockups, specs (optional)
```

### Adding a new script

Create a `kebab-case` folder named after the script, drop in `<name>.user.js`, a `README.md`, and a `CHANGELOG.md`, then add a row to the table above.

## Licence

[MIT](./LICENSE)
