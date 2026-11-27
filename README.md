# Fridge — Pantry & Refrigerator Manager

A small installable PWA for keeping track of food and non-fridge items. Everything is stored locally in IndexedDB — no account, no server, works offline.

## Layout

| Path | Purpose |
| --- | --- |
| `source/` | Readable, unminified source (HTML, CSS, JS, service worker, manifest, icon generator). |
| `scripts/` | Build, icon and local-server scripts. |
| `docs/` | Generated, uglified/minified deployable PWA (ready for GitHub Pages). |

## Build

```sh
npm install
npm run build      # regenerate /docs from /source
npm run serve      # serve /docs at http://localhost:8080
npm run icons      # regenerate the PNG icons (requires Pillow)
```

`npm run build` walks `source/` recursively and mirrors it into `docs/`, minifying HTML (`html-minifier-terser`), CSS (`clean-css`) and JS (`terser`, with variable mangling), writing a minified web manifest, and tying the service-worker cache name to a hash of the built assets so updates always refresh the offline cache. `docs/` is cleaned on every build.

### Routing

Following the same convention as `pwa-player` (needed by Cloudflare Pages), every non-root HTML page is emitted as a directory route: `source/help/index.html` → `docs/help/index.html`, served at `/help/`. An HTML file named `xxx.html` would likewise become `docs/xxx/index.html`. Links use directory URLs (`./help/`), and subpages reference assets with `../` so they work both at a domain root and under a subpath. The root `index.html` stays at `docs/index.html`.

To deploy on GitHub Pages, publish the `/docs` directory from the `main` branch. Service workers require a secure context (HTTPS or localhost).

## Features

- **Quick entry** — name, amount, unit, price, dates and storage location; nothing else. Fields have sensible defaults and "Now" / "+7d" shortcut buttons.
- **Dates** — the Added and Expires fields accept either **ISO 8601** strings or **Unix timestamps** (seconds or milliseconds). Both default to the current time; expiry defaults to exactly **7 days**. The `ISO`/`UNIX` button switches how all dates are entered and displayed.
- **Price with currency** — ISO 4217 currency selector; values are formatted with `Intl.NumberFormat`.
- **SI units only** — `kg`, `g`, `mg`, `L`, `mL`, plus a dimensionless count (`pcs`). Sorting is by **price per kilogram**; litres and counts are normalised at 1 L ≈ 1 kg, which is noted in the UI.
- **Sorting & filtering** — price/kg ascending (default) or descending, soonest expiry, name, newest; plus free-text search and storage filters.
- **More than a fridge** — every item has a storage location: Fridge, Freezer, Pantry or Other.
- **Expiry alerts** — requesting notification permission enables local notifications for items expiring within 24 hours or already expired. Each item notifies once per state. The service worker also registers Periodic Background Sync (`expiry-check`, 12 h) where supported and handles push messages and notification clicks.
- **Offline-first** — the service worker precaches the app shell, uses network-first for navigation and cache-first for assets, and falls back to the cached page when offline.

## Notes

- Items are private to the browser profile that added them. Clearing site data removes them.
- Notification permission is required and is only requested when you press **Enable alerts**. Background delivery depends on browser/OS support for periodic sync or push.
