// After a new deployment the file names of lazily loaded parts change, so a
// tab opened before the deployment can no longer load them ("Failed to fetch
// dynamically imported module"). Reload once to pick up the new version.
const KEY = "gdx_reloaded_at";

export const isStaleChunk = (e) =>
  /dynamically imported module|Importing a module script failed|Failed to load module script|Unable to preload CSS/i.test(e?.message || String(e || ""));

/** reload the page unless we already did in the last 30 s (avoids a loop if the server is really down) */
export function reloadForNewVersion() {
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY) || 0); } catch { /* storage blocked */ }
  if (Date.now() - last < 30000) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* storage blocked */ }
  window.location.reload();
  return true;
}
