// Ablage der Stunden-Historie als CSV je Jahr (gut diff-/komprimierbar im Git).
// data/history/hourly/<jahr>.csv : t,<serien...>
// data/history/meteo/<jahr>.csv  : t,P_<punkt>,T_<punkt>,E_<punkt>...
import fs from "node:fs";
import path from "node:path";
import { HOUR, isoHour, parseIsoHour } from "./time.mjs";

export function readYearCsv(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    const t = parseIsoHour(parts[0]);
    rows.set(t, parts.slice(1).map((x) => (x === "" ? NaN : +x)));
  }
  return { header: header.slice(1), rows };
}

const fmt = (v, digits) => (Number.isFinite(v) ? String(+v.toFixed(digits)) : "");

// cols: {key: Map(hourMs -> value)} ; digits: {key: n}
export function writeYearCsv(file, year, keys, getter, digits = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year + 1, 0, 1);
  const out = ["t," + keys.join(",")];
  for (let t = start; t < end; t += HOUR) {
    const vals = keys.map((k) => getter(k, t));
    if (vals.every((v) => !Number.isFinite(v))) continue;
    out.push(isoHour(t) + "," + vals.map((v, i) => fmt(v, digits[keys[i]] ?? 3)).join(","));
  }
  fs.writeFileSync(file, out.join("\n") + "\n");
}

// Lädt alle Jahresdateien eines Verzeichnisses zu dichten Arrays ab t0.
export function loadDense(dir, { fromYear = 0, toMs = Date.now() } = {}) {
  if (!fs.existsSync(dir)) return null;
  const years = fs.readdirSync(dir).filter((f) => /^\d{4}\.csv$/.test(f)).map((f) => +f.slice(0, 4)).filter((y) => y >= fromYear).sort();
  if (!years.length) return null;
  const t0 = Date.UTC(years[0], 0, 1);
  const n = Math.floor((toMs - t0) / HOUR) + 1;
  const cols = {};
  for (const y of years) {
    const { header, rows } = readYearCsv(path.join(dir, `${y}.csv`));
    for (const k of header) if (!cols[k]) cols[k] = new Float64Array(n).fill(NaN);
    for (const [t, vals] of rows) {
      const i = (t - t0) / HOUR;
      if (i < 0 || i >= n) continue;
      header.forEach((k, j) => (cols[k][i] = vals[j]));
    }
  }
  return { t0, n, cols };
}

// Lineare Interpolation kurzer Lücken (max. maxGap Stunden) in einem Float64Array
export function fillGaps(arr, maxGap = 6) {
  let last = -1;
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) continue;
    if (last >= 0 && i - last > 1 && i - last <= maxGap + 1) {
      for (let k = last + 1; k < i; k++) arr[k] = arr[last] + ((arr[i] - arr[last]) * (k - last)) / (i - last);
    }
    last = i;
  }
  return arr;
}
