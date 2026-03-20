# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Chrome Manifest V3 extension that detects multiple signed-in Google accounts and allows seamless switching between them. There is no build step — it is plain vanilla JavaScript loaded directly by Chrome.

## Installation & Loading

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory

After editing any file, click the refresh icon on the extension card in `chrome://extensions` to reload it. For popup changes you can just close and reopen the popup.

## Architecture

The extension has two execution contexts that cannot share live state — they communicate only via `chrome.storage` and message passing:

- **Service worker** (`background.js`) — Persistent background process. Monitors tab activation, URL navigation, and window focus events to update the toolbar icon. Also auto-opens the popup when navigating to Google Meet rooms without an `authuser` parameter. Uses `OffscreenCanvas` (not DOM canvas) for icon drawing.

- **Popup** (`popup.html` + `popup.js`) — Rendered when the user clicks the toolbar icon. Runs 4 account detection methods in parallel via `Promise.allSettled()`, merges results, and renders account cards.

### Account Detection (popup.js)

Four methods run in parallel; results are merged and deduplicated, preferring richer data sources:

1. **Chrome Identity API** — Gets the primary signed-in Chrome profile account
2. **ACCOUNT_CHOOSER cookie** — Reads Google's account chooser cookie from `accounts.google.com`
3. **ListAccounts endpoint** — Most reliable; injects a `fetch` into an existing Google tab so session cookies are included (a direct fetch from the extension context would lack cookies)
4. **Tab title scanning** — Extracts emails from open Google tab titles (e.g. `"Inbox - user@gmail.com - Gmail"`)

Previously detected accounts are persisted in `chrome.storage.local` so they survive tab closure.

### Shared Modules

- **`icons.js`** — Canvas drawing utilities for the toolbar icon. Exports color constants (5 Google brand colors for account indices 0–4), `drawFourSquareImageData()` (the Google 2×2 grid icon when no account is active), and `drawIconImageData()` (solid circle with account initial/number). Works with both `OffscreenCanvas` (service worker) and `HTMLCanvasElement` (popup).

- **`utils.js`** — Exports `EMAIL_RE` regex and `getIndexFromUrl(url)` which extracts the account index from `/u/N/` or `?authuser=N` URL patterns.

### URL Switching Logic

When switching accounts, `popup.js` tries to rewrite the URL directly (swapping `/u/N/` or `?authuser=N`). For Google services that don't embed account indices in their URLs, it falls back to a Google AccountChooser redirect. Right-clicking a non-Google tab opens Gmail for the selected account instead.

## Key Constraints

- **MV3 service workers have no DOM** — use `OffscreenCanvas`, never `document` or `window`, in `background.js`.
- **ES6 modules** — all files use `import`/`export`. The `manifest.json` declares `"type": "module"` for the service worker.
- **No external dependencies** — pure Chrome APIs and vanilla JS only; do not introduce npm packages or a bundler.
- **Host permission is `https://*.google.com/*`** — the extension only operates on Google domains.
