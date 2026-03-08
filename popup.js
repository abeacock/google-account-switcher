/**
 * Google Account Switcher — popup.js
 *
 * Three-layer account detection strategy (run in parallel, merged & deduplicated):
 *
 * METHOD 1 — Chrome Identity API
 *   chrome.identity.getProfileUserInfo({ accountStatus: "ANY" }, callback)
 *   Returns the email/id of the Chrome profile's primary signed-in Google account.
 *   Marked as active:true, source:"Chrome Profile". May only surface one account.
 *   Requires the "identity" permission in manifest.json.
 *
 * METHOD 2 — ACCOUNT_CHOOSER cookie
 *   Reads the ACCOUNT_CHOOSER cookie from https://accounts.google.com.
 *   The cookie value is URL-encoded and contains an email list inside a JSON-like
 *   structure. We decode it and extract all email addresses with a regex.
 *   Requires the "cookies" permission and host_permissions for google.com.
 *
 * METHOD 3 — ListAccounts endpoint (most reliable)
 *   GET https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&json=standard
 *   Google returns a JSON response prefixed with )]}'\n to prevent JSON hijacking.
 *   After stripping the prefix, json[1] is an array of account entries where each
 *   entry is an array: [2]=display name, [3]/[11]=email, [8]===1 means active session.
 *   The array index (0, 1, 2…) maps to /u/{index}/ in myaccount.google.com URLs.
 *
 *   IMPORTANT: The fetch must run inside an existing Google tab via executeScript,
 *   not from the extension popup context. Chrome only sends Google session cookies
 *   when the request originates from a tab's browsing context. A direct fetch from
 *   the popup (chrome-extension:// origin) will be sent without session cookies,
 *   causing ListAccounts to return an empty or unauthenticated response.
 *   Falls back to a direct popup fetch if no Google tab is open.
 *
 * METHOD 4 — Google tab titles
 *   Scans all open https://*.google.com/* tabs and extracts email addresses from
 *   their titles. Gmail titles follow the pattern "Inbox - user@gmail.com - Gmail"
 *   making this the most direct method when Gmail is open. The /u/{N}/ segment of
 *   the tab URL provides the account index for switching. This method works even
 *   when cookie access and network requests both fail.
 */

'use strict';

/* ── Constants ─────────────────────────────────────────────────────────────── */

const COLOR_COUNT = 5;
const STORAGE_KEY = 'knownAccounts';
const LIST_ACCOUNTS_URL =
  'https://accounts.google.com/ListAccounts?gpsia=1&source=ogb&json=standard';
const ACCOUNT_CHOOSER_URL = 'https://accounts.google.com';
const SWITCH_BASE_URL = 'https://myaccount.google.com/u/';
const CHOOSER_URL = 'https://accounts.google.com/AccountChooser';

/* ── URL account-index helpers ──────────────────────────────────────────────── */

/**
 * Extracts the Google account index from a tab URL, supporting two patterns:
 *   /u/N/      — Gmail, Drive, Calendar, Keep, Chat, …
 *   ?authuser=N — Meet, and other services that use a query parameter
 * Returns the integer index, or null if neither pattern is present.
 */
function getIndexFromUrl(url) {
  if (!url) return null;
  const uMatch = url.match(/\/u\/(\d+)\//);
  if (uMatch) return parseInt(uMatch[1], 10);
  try {
    const param = new URL(url).searchParams.get('authuser');
    if (param !== null) return parseInt(param, 10);
  } catch { /* ignore malformed URLs */ }
  return null;
}

/**
 * Returns a copy of `url` with the account index replaced by `newIndex`,
 * or null if the URL contains neither a /u/N/ segment nor an authuser param.
 */
function replaceIndexInUrl(url, newIndex) {
  if (!url) return null;
  if (/\/u\/\d+\//.test(url)) {
    return url.replace(/\/u\/\d+\//, `/u/${newIndex}/`);
  }
  try {
    const u = new URL(url);
    if (u.searchParams.has('authuser')) {
      u.searchParams.set('authuser', String(newIndex));
      return u.toString();
    }
  } catch { /* ignore */ }
  return null;
}

/* ── DOM refs ───────────────────────────────────────────────────────────────── */

const listEl = document.getElementById('accountList');
const btnRefresh = document.getElementById('btnRefresh');
const toastEl = document.getElementById('toast');

/* ── Toast ──────────────────────────────────────────────────────────────────── */

let toastTimer = null;

function showToast(message) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2800);
}

/* ── Detection: Method 1 — Chrome Identity API ─────────────────────────────── */

function detectViaIdentity() {
  return new Promise((resolve) => {
    if (!chrome.identity || !chrome.identity.getProfileUserInfo) {
      return resolve([]);
    }
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
      if (chrome.runtime.lastError || !info || !info.email) {
        return resolve([]);
      }
      resolve([
        {
          email: info.email.toLowerCase(),
          name: '',
          active: true,
          source: 'Chrome Profile',
          index: null,
        },
      ]);
    });
  });
}

/* ── Detection: Method 2 — ACCOUNT_CHOOSER cookie ──────────────────────────── */

function detectViaCookie() {
  return new Promise((resolve) => {
    if (!chrome.cookies || !chrome.cookies.get) {
      return resolve([]);
    }
    chrome.cookies.get(
      { url: ACCOUNT_CHOOSER_URL, name: 'ACCOUNT_CHOOSER' },
      (cookie) => {
        if (chrome.runtime.lastError || !cookie || !cookie.value) {
          return resolve([]);
        }
        try {
          const decoded = decodeURIComponent(cookie.value);
          const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
          const matches = decoded.match(emailRegex) || [];
          const unique = [...new Set(matches.map((e) => e.toLowerCase()))];
          resolve(
            unique.map((email) => ({
              email,
              name: '',
              active: false,
              source: 'Cookie',
              index: null,
            }))
          );
        } catch {
          resolve([]);
        }
      }
    );
  });
}

/* ── Detection: Method 3 — ListAccounts endpoint ───────────────────────────── */

/**
 * Fetch the raw ListAccounts text by injecting a fetch call into an existing
 * Google tab. This ensures Google session cookies are included in the request,
 * which they would not be when fetching from the extension popup context.
 * Prefers accounts.google.com tabs (same-origin = no CORS); falls back to any
 * fully-loaded Google tab. Tries up to three tabs before giving up.
 */
async function fetchListAccountsViaTab() {
  let tabs = [];
  try {
    // Same-origin tabs first — no CORS required
    tabs = await chrome.tabs.query({ url: 'https://accounts.google.com/*', status: 'complete' });
  } catch { /* ignore */ }

  if (!tabs.length) {
    try {
      tabs = await chrome.tabs.query({ url: 'https://*.google.com/*', status: 'complete' });
    } catch { /* ignore */ }
  }
  if (!tabs.length) return null;

  for (const tab of tabs.slice(0, 3)) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // Use .then()/.catch() instead of async/await for reliable result serialization
        func: (url) =>
          fetch(url, { credentials: 'include', cache: 'no-store' })
            .then((r) => (r.ok ? r.text() : null))
            .catch(() => null),
        args: [LIST_ACCOUNTS_URL],
      });
      const text = results?.[0]?.result;
      if (text) return text;
    } catch {
      // Tab may be restricted (e.g. Chrome Web Store); try next
    }
  }
  return null;
}

function parseListAccountsResponse(rawText) {
  const cleaned = rawText.replace(/^\)\]\}'\s*\n?/, '');
  const json = JSON.parse(cleaned);

  // Handle both response shapes:
  //   Shape A: ["gaia.l.a.r", [[account], ...]]   → json[1] is accounts array
  //   Shape B: [["gaia.l.a.r", [[account], ...]]]  → json[0][1] is accounts array
  let entries = null;
  if (Array.isArray(json[1])) {
    entries = json[1];
  } else if (Array.isArray(json[0]) && Array.isArray(json[0][1])) {
    entries = json[0][1];
  }
  if (!entries) return [];

  return entries
    .map((entry, idx) => {
      if (!Array.isArray(entry)) return null;

      const name = entry[2] || '';
      // Email can be at index 3 or 11 — pick whichever contains '@'
      let email = '';
      if (typeof entry[3] === 'string' && entry[3].includes('@')) {
        email = entry[3];
      } else if (typeof entry[11] === 'string' && entry[11].includes('@')) {
        email = entry[11];
      }
      if (!email) return null;

      const active = entry[8] === 1;

      return {
        email: email.toLowerCase(),
        name,
        active,
        source: 'ListAccounts',
        index: idx,
      };
    })
    .filter(Boolean);
}

async function detectViaListAccounts() {
  try {
    // Primary: run fetch inside a Google tab so session cookies are sent
    let rawText = await fetchListAccountsViaTab();

    // Fallback: direct fetch from popup context (works if cookies happen to be shared)
    if (!rawText) {
      try {
        const res = await fetch(LIST_ACCOUNTS_URL, { credentials: 'include', cache: 'no-store' });
        if (res.ok) rawText = await res.text();
      } catch { /* ignore */ }
    }

    if (!rawText) return [];
    return parseListAccountsResponse(rawText);
  } catch {
    return [];
  }
}

/* ── Detection: Method 4 — Google tab titles ───────────────────────────────── */

/**
 * Gmail tab titles typically read "Inbox - user@gmail.com - Gmail" or
 * "Inbox (3) - user@gmail.com - Gmail". Scanning all open Google tabs for an
 * email address in the title is the most direct way to detect the active account
 * without relying on cookies or network requests.
 * The /u/{index}/ segment in the URL gives us the account index for switching.
 */
async function detectViaTabTitles() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.google.com/*' });
    const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
    const seen = new Set();
    const accounts = [];

    for (const tab of tabs) {
      const emailMatch = tab.title?.match(EMAIL_RE);
      if (!emailMatch) continue;
      const email = emailMatch[0].toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);

      const index = getIndexFromUrl(tab.url);

      accounts.push({ email, name: '', active: false, source: 'Tab', index });
    }
    return accounts;
  } catch {
    return [];
  }
}

/* ── Merge & deduplicate ────────────────────────────────────────────────────── */

function mergeAccounts(results) {
  const map = new Map(); // keyed by lowercased email

  for (const list of results) {
    for (const account of list) {
      const key = account.email;
      if (!map.has(key)) {
        map.set(key, { ...account });
      } else {
        const existing = map.get(key);
        // Prefer richer data: name from ListAccounts, active flag, index
        if (account.name && !existing.name) existing.name = account.name;
        if (account.active) existing.active = true;
        if (account.index !== null && existing.index === null) {
          existing.index = account.index;
        }
        // Prefer ListAccounts as source since it's most reliable
        if (account.source === 'ListAccounts') existing.source = 'ListAccounts';
      }
    }
  }

  return [...map.values()];
}

/* ── Active tab helpers ─────────────────────────────────────────────────────── */

function isGoogleAppUrl(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'google.com' || host.endsWith('.google.com');
  } catch { return false; }
}

async function getActiveTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ?? null;
  } catch { return null; }
}

/* ── Render helpers ─────────────────────────────────────────────────────────── */

function getInitial(account) {
  if (account.name) return account.name.charAt(0).toUpperCase();
  if (account.email) return account.email.charAt(0).toUpperCase();
  return '?';
}

function getName(account) {
  const domain = account.email.split('@')[1] || account.email;
  return domain.split('.')[0];
}

function buildCard(account, colorIndex, canSwitch) {
  const card = document.createElement('div');
  card.className = `account-card${account.active ? ` is-active color-${(account.index !== null ? account.index : colorIndex) % COLOR_COUNT}` : ''}`;

  // Avatar
  const avatar = document.createElement('div');
  // Use the Google account index for colour so it always matches the toolbar icon.
  // Fall back to sorted position (colorIndex) for accounts without a known index.
  const avatarColor = (account.index !== null ? account.index : colorIndex) % COLOR_COUNT;
  avatar.className = `avatar color-${avatarColor}`;
  avatar.textContent = account.index !== null ? String(account.index) : getInitial(account);

  // Info block
  const info = document.createElement('div');
  info.className = 'account-info';

  const nameRow = document.createElement('div');
  nameRow.className = 'account-name-row';

  const nameEl = document.createElement('span');
  nameEl.className = 'account-name';
  nameEl.textContent = getName(account);
  nameEl.title = getName(account);
  nameRow.appendChild(nameEl);

  const emailEl = document.createElement('div');
  emailEl.className = 'account-email';
  emailEl.textContent = account.email;
  emailEl.title = account.email;

  info.appendChild(nameRow);
  info.appendChild(emailEl);

  if (account.active) {
    const badge = document.createElement('span');
    badge.className = `badge-active color-${avatarColor}`;
    badge.textContent = 'Active';
    card.appendChild(badge);
  }

  card.appendChild(avatar);
  card.appendChild(info);

  if (!account.active && canSwitch) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => switchToAccount(account));

  }

  return card;
}

function renderAccounts(accounts, canSwitch) {
  listEl.innerHTML = '';

  if (!accounts || accounts.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="8" r="4"/>
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
          </svg>
        </div>
        <p class="empty-text">No Google accounts detected. Sign into Google in your browser.</p>
      </div>`;
    return;
  }

  // Sort by Google account index (0, 1, 2…); accounts with no index go last
  const sorted = [...accounts].sort((a, b) => {
    if (a.index === null && b.index === null) return 0;
    if (a.index === null) return 1;
    if (b.index === null) return -1;
    return a.index - b.index;
  });

  sorted.forEach((account, i) => {
    listEl.appendChild(buildCard(account, i, canSwitch));
  });
}

function renderLoading() {
  listEl.innerHTML = `
    <div class="loading-state">
      <div class="loader"></div>
      <span>Detecting accounts…</span>
    </div>`;
}

function renderError(message) {
  listEl.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <circle cx="12" cy="16" r="0.5" fill="currentColor"/>
        </svg>
      </div>
      <p class="empty-text">${message}</p>
    </div>`;
}

/* ── Resolve active account from the current tab ───────────────────────────── */

/**
 * Overrides the `active` flag on every account so that exactly the one being
 * used in the currently focused tab is marked active.
 *
 * Resolution order:
 *  1. /u/{index}/ in the tab URL — matches by ListAccounts index (most precise)
 *  2. Email address in the tab title — e.g. "Inbox - user@gmail.com - Gmail"
 *  3. No match — leave existing `active` flags unchanged (graceful fallback)
 */
async function resolveActiveAccount(accounts) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    // 1. Match by account index in URL (/u/N/ or ?authuser=N)
    const index = getIndexFromUrl(tab.url);
    if (index !== null) {
      const matched = accounts.find((a) => a.index === index);
      if (matched) {
        accounts.forEach((a) => { a.active = false; });
        matched.active = true;
        return;
      }
    }

    // 2. Match by email in tab title
    const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
    const emailMatch = tab.title?.match(EMAIL_RE);
    if (emailMatch) {
      const email = emailMatch[0].toLowerCase();
      const matched = accounts.find((a) => a.email === email);
      if (matched) {
        accounts.forEach((a) => { a.active = false; });
        matched.active = true;
        return;
      }
    }
  } catch {
    // Non-critical — keep whatever active flags were set by detection methods
  }
}

/* ── Dynamic action icon ────────────────────────────────────────────────────── */

const ICON_BG_COLORS   = ['#4285F4', '#9c27b0', '#34A853', '#FBBC05', '#EA4335'];
const ICON_TEXT_COLORS = ['#ffffff', '#ffffff', '#ffffff', '#1a1a1a', '#ffffff'];

function drawIconImageData(size, label, bgColor, fgColor) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // Full-size square
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, size, size);

  // Label — slightly larger font for single-char, smaller for two-char (index ≥ 10)
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

function updateActionIcon(accounts) {
  const active = accounts.find((a) => a.active);

  let label, bgColor, fgColor;
  if (active) {
    const colorIdx = (active.index ?? accounts.indexOf(active)) % ICON_BG_COLORS.length;
    label   = active.index !== null ? String(active.index) : '?';
    bgColor = ICON_BG_COLORS[colorIdx];
    fgColor = ICON_TEXT_COLORS[colorIdx];
  } else {
    label   = '?';
    bgColor = '#55555f';
    fgColor = '#ffffff';
  }

  const imageData = {};
  for (const size of [16, 32, 48, 128]) {
    imageData[size] = drawIconImageData(size, label, bgColor, fgColor);
  }
  chrome.action.setIcon({ imageData });
}

/* ── Account switching ──────────────────────────────────────────────────────── */

async function switchToAccount(account) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    let url;
    const switched = account.index !== null ? replaceIndexInUrl(tab.url, account.index) : null;

    if (switched) {
      // Best case: swap the index directly in the current URL (/u/N/ or ?authuser=N).
      // Keeps the user on the same page but under the target account, e.g.:
      //   mail.google.com/mail/u/0/#inbox       → /u/1/#inbox
      //   meet.google.com/abc-def?authuser=0    → ?authuser=1
      url = switched;
    } else {
      // Fallback: send the current tab through AccountChooser then back to the
      // same URL. Works for Google services that don't embed /u/N/ (Docs, etc.)
      const continueUrl = (tab.url?.startsWith('https://'))
        ? tab.url
        : `${SWITCH_BASE_URL}${account.index ?? ''}/`;
      url = `${CHOOSER_URL}?Email=${encodeURIComponent(account.email)}&continue=${encodeURIComponent(continueUrl)}`;
    }

    chrome.tabs.update(tab.id, { url });
  } catch { /* ignore */ }
  window.close();
}

/* ── Persist & recall known accounts ───────────────────────────────────────── */

/**
 * Merges freshly detected accounts with the previously stored list.
 * Any account seen before but not detected this time is kept in the list
 * (with active:false) so the user can still switch back to it.
 * Fresh data always wins for accounts that appear in both sets.
 */
async function mergeWithKnown(freshAccounts) {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const known = stored[STORAGE_KEY] || [];
    const freshEmails = new Set(freshAccounts.map((a) => a.email));
    const preserved = known
      .filter((a) => !freshEmails.has(a.email))
      .map((a) => ({ ...a, active: false }));
    return [...freshAccounts, ...preserved];
  } catch {
    return freshAccounts;
  }
}

/* ── Main detection runner ──────────────────────────────────────────────────── */

async function detectAndRender(clearOld = false) {
  renderLoading();
  btnRefresh.classList.add('spinning');

  try {
    const results = await Promise.allSettled([
      detectViaIdentity(),
      detectViaCookie(),
      detectViaListAccounts(),
      detectViaTabTitles(),
    ]);

    // Extract fulfilled values; treat rejections as empty arrays
    const lists = results.map((r) => (r.status === 'fulfilled' ? r.value : []));
    const fresh = mergeAccounts(lists);

    // On manual refresh, discard previously stored accounts not found this run.
    // On popup open, keep them so the user can switch back to accounts with no open tab.
    const accounts = clearOld ? fresh : await mergeWithKnown(fresh);

    await resolveActiveAccount(accounts);
    updateActionIcon(accounts);
    chrome.storage.local.set({ [STORAGE_KEY]: accounts });

    const canSwitch = isGoogleAppUrl(await getActiveTabUrl());
    renderAccounts(accounts, canSwitch);
  } catch (err) {
    renderError('Something went wrong detecting accounts. Please try again.');
    console.error('[GoogleAccountSwitcher]', err);
  } finally {
    btnRefresh.classList.remove('spinning');
  }
}

/* ── Init ───────────────────────────────────────────────────────────────────── */

btnRefresh.addEventListener('click', () => detectAndRender(true));
detectAndRender();
