# Google Account Switcher

A Chrome extension that detects all active Google accounts in your browser and lets you switch between them with a single click.

## What it does

Click the toolbar icon to see all your signed-in Google accounts. Click any account to switch the current tab to that account — keeping you on the same page (Gmail, Drive, Meet, etc.) but under the selected account.

The toolbar icon dynamically reflects which Google account is active in the current tab, using a colour-coded number badge (0, 1, 2…) that matches the account index Google assigns.

## Features

- **Multi-method account detection** — runs four detection strategies in parallel for maximum reliability:
  1. **Chrome Identity API** — reads the primary signed-in Chrome profile account
  2. **ACCOUNT_CHOOSER cookie** — extracts all accounts from Google's account chooser cookie
  3. **ListAccounts endpoint** — queries `accounts.google.com/ListAccounts` (injected into an existing Google tab so session cookies are included)
  4. **Tab title scanning** — reads email addresses from open Google tab titles (e.g. "Inbox - user@gmail.com - Gmail")

- **Smart account switching** — swaps the `/u/N/` index or `?authuser=N` parameter directly in the current URL when possible, so you stay on the same page. Falls back to Google's AccountChooser redirect for services that don't embed an account index.

- **Dynamic toolbar icon** — updates automatically when you switch tabs, navigate, or change windows. Shows the account number in its assigned colour, or a grey `?` for non-Google tabs.

- **Google Meet prompt** — automatically opens the popup when you navigate to a Meet room without an `authuser` parameter, so you can choose which account to join with.

- **Persistent account memory** — previously seen accounts are remembered across popup opens, so you can switch back to an account even if it has no open tab.

- **Manual refresh** — the refresh button in the popup re-scans all sources and clears stale accounts.

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top right).
4. Click **Load unpacked** and select the folder containing this extension.

## Permissions used

| Permission | Purpose |
|---|---|
| `identity` | Read the primary signed-in Chrome profile account |
| `cookies` | Read the `ACCOUNT_CHOOSER` cookie from `accounts.google.com` |
| `scripting` | Inject the `ListAccounts` fetch into an existing Google tab |
| `storage` | Persist known accounts across popup sessions |
| `tabs` | Query open tabs for account detection and perform URL switching |
| `https://*.google.com/*` | Access Google cookies and inject scripts into Google tabs |

## Files

| File | Description |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background.js` | Service worker — updates the toolbar icon on tab/window changes and triggers the Meet prompt |
| `popup.html` | Popup UI markup and styles |
| `popup.js` | Account detection, merging, rendering, and switching logic |
