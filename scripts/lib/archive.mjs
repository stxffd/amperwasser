// Archiv der Live-Prognosen (alle ~6 h eine) und Abgleich mit den später gemessenen Werten.
// Gespeichert wird es auf der veröffentlichten Seite (data/archive.json); jeder stündliche Lauf lädt es von dort,
// ergänzt und veröffentlicht es wieder. Monatlich wird eine Sicherung ins Repo übernommen (data/archive/forecasts.json).
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SITE_URL } from "../config.mjs";
import { HOUR, DAY } from "./time.mjs";

export const ARCHIVE_BACKUP = path.join(DATA_DIR, "archive", "forecasts.json");
export const STEP_H = 6; // Zeitschritt der archivierten Prognosen
const KEEP_DAYS = 400;

export async function loadArchive({ allowOffline = false } = {}) {
  const items = new Map();
  const add = (arr) => { for (const e of arr || []) if (e && Number.isFinite(e.t)) items.set(e.t, e); };
  if (fs.existsSync(ARCHIVE_BACKUP)) add(JSON.parse(fs.readFileSync(ARCHIVE_BACKUP, "utf8")).items);
  try {
    const r = await fetch(SITE_URL + "data/archive.json", { signal: AbortSignal.timeout(30000), headers: { "Cache-Control": "no-cache" } });
    if (r.ok) add((await r.json()).items);
    else if (r.status !== 404) throw new Error("HTTP " + r.status);
  } catch (e) {
    // Ohne das bisherige Archiv nicht veröffentlichen, sonst ginge es verloren
    if (!allowOffline) throw new Error("Prognosearchiv nicht ladbar: " + e.message);
  }
  return [...items.values()].sort((a, b) => a.t - b.t);
}

// Prognose anhängen, wenn die letzte archivierte älter als ~6 h ist
export function appendForecast(items, tIssue, bands /* {w:[p10,p50,p90], q:[...]} je Float-Array ab Lead 1 h */) {
  const last = items.at(-1);
  if (last && tIssue - last.t < (STEP_H - 0.5) * HOUR) return false;
  const pick = (arr, d) => { const o = []; for (let L = STEP_H; L <= arr.length; L += STEP_H) o.push(+arr[L - 1].toFixed(d)); return o; };
  items.push({ t: tIssue, w: pick(bands.w[1], 0), wl: pick(bands.w[0], 0), wh: pick(bands.w[2], 0), q: pick(bands.q[1], 1) });
  const cut = tIssue - KEEP_DAYS * DAY;
  while (items.length && items[0].t < cut) items.shift();
  return true;
}

/**
 * Abgleich: obsW(tMs) liefert den gemessenen Wasserstand (cm) zur vollen Stunde oder NaN.
 * Rückgabe: Tabelle je Vorlaufzeit (MAE, Persistenz, Trefferquote 80-%-Spanne) über die letzten `days` Tage.
 */
export function liveStats(items, obsW, nowMs, { days = 90, leads = [6, 12, 24, 48, 72, 120, 168, 240, 336] } = {}) {
  const from = nowMs - days * DAY;
  const rows = leads.map((L) => ({ lead_h: L, n: 0, e: 0, ep: 0, hit: 0 }));
  let used = 0, first = null;
  for (const it of items) {
    if (it.t < from - 14 * DAY) continue;
    const w0 = obsW(it.t);
    let any = false;
    leads.forEach((L, k) => {
      const tt = it.t + L * HOUR;
      if (tt < from || tt > nowMs) return;
      const j = L / STEP_H - 1;
      if (!Number.isInteger(j) || it.w[j] == null) return;
      const o = obsW(tt);
      if (!Number.isFinite(o)) return;
      const r = rows[k];
      r.n++; r.e += Math.abs(it.w[j] - o);
      if (Number.isFinite(w0)) r.ep += Math.abs(w0 - o);
      if (o >= it.wl[j] - 0.5 && o <= it.wh[j] + 0.5) r.hit++;
      any = true;
    });
    if (any) { used++; if (first == null) first = it.t; }
  }
  return {
    since: first, forecasts: used,
    table: rows.map((r) => ({ lead_h: r.lead_h, n: r.n, mae_w: r.n ? +(r.e / r.n).toFixed(1) : null, mae_w_pers: r.n ? +(r.ep / r.n).toFixed(1) : null, cover80: r.n ? +(r.hit / r.n).toFixed(2) : null })),
  };
}

// Frühere Prognosen für den Vergleich im Diagramm (vor 1, 3, 7 Tagen)
export function pastForecasts(items, tIssue, agoDays = [1, 3, 7]) {
  const out = [];
  for (const d of agoDays) {
    const target = tIssue - d * DAY;
    let best = null;
    for (const it of items) if (Math.abs(it.t - target) <= 4 * HOUR && (!best || Math.abs(it.t - target) < Math.abs(best.t - target))) best = it;
    if (best) out.push({ days: d, t: best.t, step: STEP_H * HOUR, w: best.w, wl: best.wl, wh: best.wh, q: best.q });
  }
  return out;
}
