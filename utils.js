/**
 * utils.js — shared utility helpers
 */

export const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

/**
 * Extracts the Google account index from a URL, supporting two patterns:
 *   /u/N/       — Gmail, Drive, Calendar, Keep, Chat, …
 *   ?authuser=N — Meet, and other services that use a query parameter
 * Returns the integer index, or null if neither pattern is present.
 */
export function getIndexFromUrl(url) {
  if (!url) return null;
  const uMatch = url.match(/\/u\/(\d+)\//);
  if (uMatch) return parseInt(uMatch[1], 10);
  try {
    const param = new URL(url).searchParams.get('authuser');
    if (param !== null) return parseInt(param, 10);
  } catch { /* ignore malformed URLs */ }
  return null;
}
