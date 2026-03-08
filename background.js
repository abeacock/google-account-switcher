/**
 * background.js — service worker
 *
 * Listens for tab activation, navigation, and window focus events so the
 * toolbar icon stays in sync with the currently active tab without requiring
 * the popup to be opened.
 *
 * Icon derivation (URL is the only signal available here):
 *   - /u/{N}/ found in tab URL → show N with the matching account colour
 *   - No /u/{N}/ or non-Google tab  → show the four-colour grid icon
 *
 * Drawing uses OffscreenCanvas (available in MV3 service workers).
 */

import { getIndexFromUrl } from './utils.js';
import {
  ICON_BG_COLORS,
  ICON_TEXT_COLORS,
  ICON_SIZES,
  drawFourSquareImageData,
  drawIconImageData,
} from './icons.js';

const createCanvas = (size) => new OffscreenCanvas(size, size);

/* ── Icon application ───────────────────────────────────────────────────────── */

function applyFourSquareIcon() {
  const imageData = {};
  for (const size of ICON_SIZES) {
    imageData[size] = drawFourSquareImageData(size, createCanvas);
  }
  chrome.action.setIcon({ imageData });
}

function applyIcon(label, bgColor, fgColor) {
  const imageData = {};
  for (const size of ICON_SIZES) {
    imageData[size] = drawIconImageData(size, label, bgColor, fgColor, createCanvas);
  }
  chrome.action.setIcon({ imageData });
}

/* ── Tab → icon mapping ─────────────────────────────────────────────────────── */

function setIconFromTab(tab) {
  const idx = getIndexFromUrl(tab?.url);
  if (idx !== null) {
    const c = idx % ICON_BG_COLORS.length;
    applyIcon(String(idx), ICON_BG_COLORS[c], ICON_TEXT_COLORS[c]);
    return;
  }
  applyFourSquareIcon();
}

async function refreshIcon() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setIconFromTab(tab ?? null);
  } catch {
    applyFourSquareIcon();
  }
}

/* ── Google Meet account prompt ─────────────────────────────────────────────── */

/**
 * When a Meet room tab finishes loading without an authuser parameter, open
 * the extension popup so the user can pick which account to join with.
 * tabs.onUpdated only fires on actual navigation, not on tab switches, so this
 * naturally prompts once per page load without any extra tracking needed.
 */
function isMeetRoomWithoutAccount(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'meet.google.com') return false;
    if (!u.pathname.match(/^\/[a-z]+-[a-z]+-[a-z]+/i)) return false; // needs a room path
    return getIndexFromUrl(url) === null; // no authuser set
  } catch { return false; }
}

/* ── Event listeners ────────────────────────────────────────────────────────── */

// User switches to a different tab
chrome.tabs.onActivated.addListener(() => refreshIcon());

// Tab navigates to a new URL or finishes loading
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id === tabId) refreshIcon();
  } catch { /* ignore */ }

  if (changeInfo.url && isMeetRoomWithoutAccount(changeInfo.url)) {
    try {
      await chrome.action.openPopup();
    } catch { /* requires Chrome 127+; silently skip on older versions */ }
  }
});

// User switches between browser windows
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) refreshIcon();
});

// Initialise on service worker startup
refreshIcon();
