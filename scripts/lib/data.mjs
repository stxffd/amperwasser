// Lädt Pegel- und Wetterhistorie auf ein gemeinsames Stundenraster.
import path from "node:path";
import { HIST_DIR, METEO_POINTS, VALID_RANGE } from "../config.mjs";
import { loadDense, fillGaps } from "./store.mjs";
import { HOUR } from "./time.mjs";

export function loadAll({ fromYear = 1998, toMs = Date.now() } = {}) {
  const g = loadDense(path.join(HIST_DIR, "hourly"), { fromYear, toMs });
  let m = loadDense(path.join(HIST_DIR, "meteo"), { fromYear, toMs });
  if (!g) throw new Error("Pegel-Historie fehlt – zuerst scripts/fetch-history.mjs gauges ausführen");
  if (!m) {
    // keine Wetterhistorie im Zeitraum: leere Spalten (update.mjs füllt aus dem Archiv)
    const nn = Math.floor((toMs - g.t0) / HOUR) + 1;
    m = { t0: g.t0, n: nn, cols: Object.fromEntries(METEO_POINTS.flatMap((p) => ["P", "T", "E"].map((v) => [`${v}_${p.key}`, new Float64Array(nn).fill(NaN)]))) };
  }
  const t0 = Math.max(g.t0, m.t0);
  const n = Math.floor((toMs - t0) / HOUR) + 1;
  const slice = (src) => {
    const off = (t0 - src.t0) / HOUR;
    const out = {};
    for (const [k, arr] of Object.entries(src.cols)) {
      const a = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n && i + off < arr.length; i++) a[i] = arr[i + off];
      out[k] = a;
    }
    return out;
  };
  const gauges = slice(g), meteo = slice(m);
  for (const k of Object.keys(gauges)) { cleanSeries(k, gauges[k]); fillGaps(gauges[k], 6); }
  for (const k of Object.keys(meteo)) fillGaps(meteo[k], 3);
  return { t0, n, gauges, meteo };
}

// Messfehler entfernen: Bereichsgrenzen + isolierte Sprünge (Spikes)
export function cleanSeries(key, a) {
  const [lo, hi] = VALID_RANGE[key] || VALID_RANGE.default_q;
  for (let i = 0; i < a.length; i++) if (!(a[i] >= lo && a[i] <= hi)) a[i] = NaN;
  // Spike: Wert weicht stark von beiden Nachbarn ab, die Nachbarn aber kaum voneinander
  const rel = key.endsWith("_q");
  for (let i = 1; i < a.length - 1; i++) {
    const p = a[i - 1], c = a[i], n = a[i + 1];
    if (!Number.isFinite(p) || !Number.isFinite(c) || !Number.isFinite(n)) continue;
    const d1 = Math.abs(c - p), d2 = Math.abs(c - n), dn = Math.abs(n - p);
    const scale = rel ? Math.max(1, 0.5 * (p + n)) * 0.5 : key === "ammersee_w" ? 0.15 : 40;
    if (d1 > scale && d2 > scale && dn < scale / 3) a[i] = NaN;
  }
  return a;
}

// Antrieb einer Modellzone aus den Wetterspalten
export function zoneForcing(meteo, zone) {
  const pts = METEO_POINTS.filter((p) => p.zone === zone);
  const wsum = pts.reduce((a, p) => a + p.w, 0);
  return {
    P: pts.map((p) => meteo[`P_${p.key}`]),
    T: pts.map((p) => meteo[`T_${p.key}`]),
    E: pts.map((p) => meteo[`E_${p.key}`]),
    w: pts.map((p) => p.w / wsum),
    keys: pts.map((p) => p.key),
  };
}

// Index des letzten endlichen Werts
export function lastValid(arr, upTo = arr.length - 1) {
  for (let i = upTo; i >= 0; i--) if (Number.isFinite(arr[i])) return i;
  return -1;
}
