// Lädt bzw. aktualisiert die Historie.
//   node scripts/fetch-history.mjs gauges [--from 1990] [--to 2026] [--only grafrath_q]
//   node scripts/fetch-history.mjs recent [--days 45]          (Pegel: letzte Tage nachladen)
//   node scripts/fetch-history.mjs daily                       (Grafrath Tageswerte seit 1964)
//   node scripts/fetch-history.mjs meteo [--from 1998] [--pause 180]
//   node scripts/fetch-history.mjs meteo-recent                (Meteo: letzte Monate nachladen)
import fs from "node:fs";
import path from "node:path";
import { SERIES, SERIES_KEYS, HIST_DIR, METEO_POINTS, DAILY_FROM } from "./config.mjs";
import { fetchRaw, toHourly } from "./lib/gkd.mjs";
import { archive } from "./lib/openmeteo.mjs";
import { readYearCsv, writeYearCsv } from "./lib/store.mjs";
import { HOUR, DAY, sleep } from "./lib/time.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : def;
};
const nowYear = new Date().getUTCFullYear();
const HOURLY_DIR = path.join(HIST_DIR, "hourly");
const METEO_DIR = path.join(HIST_DIR, "meteo");
const DIGITS = { ammersee_w: 3, grafrath_w: 1 };

// Bestehende Jahresdatei laden und mit neuen Werten zusammenführen.
function mergeYear(dir, year, keys, fresh /* {key: Map} */, digits) {
  const file = path.join(dir, `${year}.csv`);
  const old = readYearCsv(file);
  const idx = old ? Object.fromEntries(old.header.map((k, i) => [k, i])) : {};
  const allKeys = [...new Set([...(old?.header || []), ...keys])];
  writeYearCsv(
    file,
    year,
    allKeys,
    (k, t) => {
      const f = fresh[k]?.get(t);
      if (Number.isFinite(f)) return f;
      const row = old?.rows.get(t);
      return row && idx[k] !== undefined ? row[idx[k]] : NaN;
    },
    digits
  );
}

async function gauges() {
  const from = +opt("from", 0), to = +opt("to", nowYear);
  const only = opt("only", null);
  const list = SERIES.filter((s) => !only || s.key === only);
  const startYear = Math.max(from, Math.min(...list.map((s) => s.from)));
  for (let y = startYear; y <= to; y++) {
    const fresh = {};
    for (const s of list) {
      if (y < s.from) continue;
      try {
        const raw = await fetchRaw(s, { y, m: 1, d: 1 }, { y, m: 12, d: 31 });
        fresh[s.key] = toHourly(raw);
        console.log(y, s.key, raw.length, "Werte");
      } catch (e) {
        console.warn(y, s.key, "FEHLER", e.message);
      }
      await sleep(800);
    }
    mergeYear(HOURLY_DIR, y, SERIES_KEYS, fresh, DIGITS);
  }
}

async function recent() {
  const days = +opt("days", 45);
  const end = new Date(), start = new Date(Date.now() - days * DAY);
  const fresh = {};
  for (const s of SERIES) {
    const raw = await fetchRaw(
      s,
      { y: start.getUTCFullYear(), m: start.getUTCMonth() + 1, d: start.getUTCDate() },
      { y: end.getUTCFullYear(), m: end.getUTCMonth() + 1, d: end.getUTCDate() }
    );
    fresh[s.key] = toHourly(raw);
    console.log(s.key, raw.length, "Werte");
    await sleep(500);
  }
  for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear(); y++) mergeYear(HOURLY_DIR, y, SERIES_KEYS, fresh, DIGITS);
}

// Grafrath Tageswerte (Mittel und Maximum, Tag in MEZ) seit 1964
async function daily() {
  const file = path.join(HIST_DIR, "grafrath_daily.csv");
  const existing = new Map();
  if (fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, "utf8").trim().split("\n").slice(1)) existing.set(l.slice(0, 10), l);
  }
  const lastYear = existing.size ? +[...existing.keys()].sort().at(-1).slice(0, 4) : DAILY_FROM;
  const from = +opt("from", existing.size ? lastYear : DAILY_FROM);
  const q = SERIES.find((s) => s.key === "grafrath_q"), w = SERIES.find((s) => s.key === "grafrath_w");
  for (let y = from; y <= nowYear; y++) {
    const agg = new Map(); // date -> {qs, qm, qn, ws, wm, wn}
    for (const [s, p] of [[q, "q"], [w, "w"]]) {
      const raw = await fetchRaw(s, { y, m: 1, d: 1 }, { y, m: 12, d: 31 });
      for (const [t, v] of raw) {
        const d = new Date(t + HOUR).toISOString().slice(0, 10); // MEZ-Tag
        const a = agg.get(d) || { q: [0, -Infinity, 0], w: [0, -Infinity, 0] };
        a[p][0] += v; a[p][1] = Math.max(a[p][1], v); a[p][2]++;
        agg.set(d, a);
      }
      await sleep(800);
    }
    for (const [d, a] of agg) {
      const f = (x, dg) => (x[2] ? [+(x[0] / x[2]).toFixed(dg), +x[1].toFixed(dg)] : ["", ""]);
      existing.set(d, [d, ...f(a.q, 2), ...f(a.w, 0)].join(","));
    }
    console.log("daily", y, agg.size, "Tage");
  }
  const lines = [...existing.keys()].sort().map((k) => existing.get(k));
  fs.writeFileSync(file, "date,q_mean,q_max,w_mean,w_max\n" + lines.join("\n") + "\n");
}

const METEO_KEYS = METEO_POINTS.flatMap((p) => [`P_${p.key}`, `T_${p.key}`, `E_${p.key}`]);
const METEO_DIGITS = Object.fromEntries(METEO_KEYS.map((k) => [k, k.startsWith("T") ? 1 : 2]));

async function meteoRange(startDate, endDate) {
  const r = await archive(METEO_POINTS, startDate, endDate);
  const fresh = {};
  METEO_POINTS.forEach((p, i) => {
    const P = new Map(), T = new Map(), E = new Map();
    r.time.forEach((t, j) => {
      const pt = r.points[i];
      if (pt.precipitation[j] != null) P.set(t, pt.precipitation[j]);
      if (pt.temperature_2m[j] != null) T.set(t, pt.temperature_2m[j]);
      if (pt.et0_fao_evapotranspiration[j] != null) E.set(t, pt.et0_fao_evapotranspiration[j]);
    });
    fresh[`P_${p.key}`] = P; fresh[`T_${p.key}`] = T; fresh[`E_${p.key}`] = E;
  });
  return fresh;
}

async function meteo() {
  const from = +opt("from", 1998), to = +opt("to", nowYear);
  const pause = +opt("pause", 180) * 1000; // Open-Meteo-Kontingent schonen (Jahresabruf zählt als ~230 Calls)
  for (let y = from; y <= to; y++) {
    const end = y === nowYear ? new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10) : `${y}-12-31`;
    const fresh = await meteoRange(`${y}-01-01`, end);
    mergeYear(METEO_DIR, y, METEO_KEYS, fresh, METEO_DIGITS);
    console.log("meteo", y, "ok");
    if (y < to) await sleep(pause);
  }
}

// Letzte Monate: Archiv hat ~2–5 Tage Verzug; Rest füllt update.mjs aus der Vorhersage-API.
async function meteoRecent() {
  const days = +opt("days", 62);
  const start = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const end = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
  const fresh = await meteoRange(start, end);
  for (let y = +start.slice(0, 4); y <= +end.slice(0, 4); y++) mergeYear(METEO_DIR, y, METEO_KEYS, fresh, METEO_DIGITS);
  console.log("meteo-recent", start, end, "ok");
}

// Niederschlags-Bias der Vorhersagemodelle gegenüber dem Archiv (ERA5), mit dem kalibriert wird.
// Vergleich der Gebietssummen über die letzten Jahre (Open-Meteo Historical Forecast API).
// Sparsam: 5 Stützpunkte, Jahresstücke (je ~130 API-Calls), Pause dazwischen.
async function bias() {
  const { MODEL_DIR, ENS_POINTS } = await import("./config.mjs");
  const years = +opt("years", 2);
  const pause = +opt("pause", 45) * 1000;
  const endMs = Date.now() - 10 * DAY;
  const loc = `latitude=${ENS_POINTS.map((p) => p.lat)}&longitude=${ENS_POINTS.map((p) => p.lon)}&elevation=${ENS_POINTS.map((p) => p.elev)}`;
  const chunks = [];
  for (let k = years; k >= 1; k--) {
    const s = new Date(endMs - k * 365 * DAY), e = new Date(endMs - (k - 1) * 365 * DAY - DAY);
    chunks.push([s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]);
  }
  const get = async (base, model, [from, to]) => {
    const url = `${base}?${loc}&start_date=${from}&end_date=${to}&hourly=precipitation&timezone=UTC${model ? `&models=${model}` : ""}`;
    for (let i = 0; i < 4; i++) {
      const res = await fetch(url);
      const j = await res.json().catch(() => ({ error: true, reason: res.status }));
      if (!j.error && res.ok) return (Array.isArray(j) ? j : [j]).map((r) => r.hourly.precipitation);
      console.warn("  Wiederholung", model || "archiv", j.reason);
      await sleep(60e3);
    }
    throw new Error("abgebrochen");
  };
  const sources = [["archiv", "https://archive-api.open-meteo.com/v1/archive", null], ...["icon_d2", "icon_eu", "ecmwf_ifs025", "best_match"].map((m) => [m, "https://historical-forecast-api.open-meteo.com/v1/forecast", m])];
  const data = {}; // name -> [chunk][point][hour]
  for (const [name, base, model] of sources) {
    data[name] = [];
    for (const c of chunks) {
      try { data[name].push(await get(base, model, c)); } catch (e) { console.warn("bias", name, c, e.message); data[name].push(null); }
      console.log("bias", name, c.join("…"));
      await sleep(pause);
    }
  }
  const out = { period: [chunks[0][0], chunks.at(-1)[1]], factors: {} };
  for (const [name] of sources.slice(1)) {
    let se = 0, sf = 0;
    chunks.forEach((_, ci) => {
      const a = data.archiv[ci], f = data[name][ci];
      if (!a || !f) return;
      for (let k = 0; k < ENS_POINTS.length; k++) {
        const n = Math.min(a[k].length, f[k].length);
        for (let i = 0; i < n; i++) {
          if (a[k][i] == null || f[k][i] == null) continue;
          se += ENS_POINTS[k].w * a[k][i]; sf += ENS_POINTS[k].w * f[k][i];
        }
      }
    });
    if (sf > 0) {
      // Faktor, der Vorhersage-Niederschlag auf das Archiv-Niveau (Kalibrierbasis) bringt; begrenzt
      out.factors[name] = +Math.min(1.3, Math.max(0.7, se / sf)).toFixed(3);
      console.log(name, "Archiv", se.toFixed(0), "mm, Modell", sf.toFixed(0), "mm -> Faktor", out.factors[name]);
    }
  }
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  fs.writeFileSync(path.join(MODEL_DIR, "precip_bias.json"), JSON.stringify(out, null, 1));
}

const cmds = { gauges, recent, daily, meteo, "meteo-recent": meteoRecent, bias };
if (!cmds[cmd]) {
  console.error("Befehl: " + Object.keys(cmds).join(" | "));
  process.exit(1);
}
await cmds[cmd]();
