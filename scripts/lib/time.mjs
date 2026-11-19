// Zeit-Hilfen. Intern wird alles in UTC-Stunden gerechnet (ms seit Epoche, volle Stunde).
export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

// Letzter Sonntag eines Monats (UTC-Datum) – für die EU-Sommerzeitregel.
function lastSunday(year, month) {
  const d = new Date(Date.UTC(year, month + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getUTCDate();
}

// Offset Europe/Berlin (Stunden) für einen UTC-Zeitpunkt.
export function berlinOffset(utcMs) {
  const y = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(y, 2, lastSunday(y, 2), 1); // 01:00 UTC
  const end = Date.UTC(y, 9, lastSunday(y, 9), 1);
  return utcMs >= start && utcMs < end ? 2 : 1;
}

// "19.11.2026 11:15" (Ortszeit Berlin) -> UTC ms
export function parseGermanLocal(s) {
  const m = s.match(/(\d{2})\.(\d{2})\.(\d{4})(?:,)?\s+(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const naive = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  // Erst mit Winterzeit annehmen, dann prüfen, ob Sommerzeit gilt.
  let utc = naive - 1 * HOUR;
  if (berlinOffset(utc) === 2) utc = naive - 2 * HOUR;
  return utc;
}

export const fmtDE = (utcMs) => {
  const d = new Date(utcMs);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

// Datumsangabe für GKD-Abfragen (dd.mm.yyyy) aus Jahr/Monat/Tag
export const gkdDate = (y, m, d) => `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;

export const floorHour = (ms) => Math.floor(ms / HOUR) * HOUR;
export const isoHour = (ms) => new Date(ms).toISOString().slice(0, 13);
export const parseIsoHour = (s) => Date.parse(s.length === 13 ? s + ":00Z" : s.endsWith("Z") ? s : s + "Z");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
