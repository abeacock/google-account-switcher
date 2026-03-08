'use strict';

/**
 * background.js — service worker
 *
 * Listens for tab activation, navigation, and window focus events so the
 * toolbar icon stays in sync with the currently active tab without requiring
 * the popup to be opened.
 *
 * Icon derivation (URL is the only signal available here):
 *   - /u/{N}/ found in tab URL → show N with the matching account colour
 *   - No /u/{N}/ or non-Google tab  → show grey '?'
 *
 * Drawing uses OffscreenCanvas (available in MV3 service workers) with the
 * same colour palette and rounded-rect style as popup.js.
 */

// Must stay in sync with ICON_BG_COLORS / ICON_TEXT_COLORS in popup.js
const ICON_BG_COLORS   = ['#4285F4', '#9c27b0', '#34A853', '#FBBC05', '#EA4335'];
const ICON_TEXT_COLORS = ['#ffffff', '#ffffff', '#ffffff', '#1a1a1a', '#ffffff'];

/* ── Icon drawing ───────────────────────────────────────────────────────────── */

function drawFourSquareImageData(size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const half = size / 2;

  // Clip all drawing to a circle
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.clip();

  ctx.fillStyle = '#4285F4'; ctx.fillRect(0,    0,    half, half); // top-left:     blue
  ctx.fillStyle = '#EA4335'; ctx.fillRect(half, 0,    half, half); // top-right:    red
  ctx.fillStyle = '#FBBC05'; ctx.fillRect(0,    half, half, half); // bottom-left:  yellow
  ctx.fillStyle = '#34A853'; ctx.fillRect(half, half, half, half); // bottom-right: green

  return ctx.getImageData(0, 0, size, size);
}

function applyFourSquareIcon() {
  const imageData = {};
  for (const size of [16, 32, 48, 128]) {
    imageData[size] = drawFourSquareImageData(size);
  }
  chrome.action.setIcon({ imageData });
}

function drawIconImageData(size, label, bgColor, fgColor) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Full-size circle
  const half = size / 2;
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();

  // Label
  const fontSize = label.length > 1 ? Math.round(size * 0.75) : Math.round(size * 0.90);
  ctx.fillStyle = fgColor;
  ctx.font = `bold ${fontSize}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(label);
  const y = size / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  ctx.fillText(label, size / 2, y);

  return ctx.getImageData(0, 0, size, size);
}

function applyIcon(label, bgColor, fgColor) {
  const imageData = {};
  for (const size of [16, 32, 48, 128]) {
    imageData[size] = drawIconImageData(size, label, bgColor, fgColor);
  }
  chrome.action.setIcon({ imageData });
}

/* ── Tab → icon mapping ─────────────────────────────────────────────────────── */

function getIndexFromUrl(url) {
  if (!url) return null;
  const uMatch = url.match(/\/u\/(\d+)\//);
  if (uMatch) return parseInt(uMatch[1], 10);
  try {
    const param = new URL(url).searchParams.get('authuser');
    if (param !== null) return parseInt(param, 10);
  } catch { /* ignore */ }
  return null;
}

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
