// Status of an Ajeer contract from its dates — nothing is closed by hand:
// upcoming (not started) | active | ending (within SOON days) | ended
import { today } from "./format.js";

export const SOON = 30;
export const daysLeft = (d, now = today()) => Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(now + "T00:00:00Z")) / 864e5);
export function ajeerState(w, now = today()) {
  if (w.start_date > now) return "upcoming";
  const left = daysLeft(w.end_date, now);
  if (left < 0) return "ended";
  return left <= SOON ? "ending" : "active";
}
/** an Ajeer permit lasts less than three years from its start */
export const addYears = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + n); return x.toISOString().slice(0, 10); };
