// Live-Aktualisierung: aktuelle Messwerte + Ensemble-Vorhersage -> site/data/*.json
//   node scripts/update.mjs
import fs from "node:fs";
import path from "node:path";
import { SERIES, METEO_POINTS, ENS_POINTS, ENS_MAP, HIST_DIR, MODEL_DIR, SITE_DATA_DIR, ZONE_AREAS, AREAS, GRAFRATH_STATS, GRAFRATH_RATING } from "./config.mjs";
import { loadAll, zoneForcing, lastValid } from "./lib/data.mjs";
import { fetchRaw, toHourly } from "./lib/gkd.mjs";
import { forecast as omForecast, ensemble as omEnsemble } from "./lib/openmeteo.mjs";
import { zoneState, runZone, mmh2cms, quantile, wFromQ } from "./lib/model.mjs";
import { runChain } from "./lib/forecast.mjs";
import { HOUR, DAY, floorHour, sleep } from "./lib/time.mjs";
import { fillGaps } from "./lib/store.mjs";

const T_START = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T_START) / 1000).toFixed(1)}s]`, ...a);
const P = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "params.json"), "utf8"));
const SKILL = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, "skill.json"), "utf8"));
const biasFile = path.join(MODEL_DIR, "precip_bias.json");
const BIAS = fs.existsSync(biasFile) ? JSON.parse(fs.readFileSync(biasFile, "utf8")).factors : {};
const bf = (k) => BIAS[k] ?? 1;
const H = 14 * 24; // Vorhersagehorizont (h)
const now = Date.now();
const nowH = floorHour(now);

// ------------------------------------------------------------------ 1) Historie + aktuelle Messwerte
const D = loadAll({ fromYear: new Date(now).getUTCFullYear() - 3, toMs: nowH + (H + 24) * HOUR });
const { t0, n, gauges: G, meteo: M } = D;
const I = (ms) => Math.round((ms - t0) / HOUR);

const recentRaw = {};
{
  const start = new Date(now - 12 * DAY), end = new Date(now + DAY);
  const ymd = (d) => ({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
  for (const s of SERIES) {
    try {
      const raw = await fetchRaw(s, ymd(start), ymd(end));
      recentRaw[s.key] = raw;
      if (!G[s.key]) G[s.key] = new Float64Array(n).fill(NaN);
      for (const [h, v] of toHourly(raw)) { const i = I(h); if (i >= 0 && i < n) G[s.key][i] = v; }
      fillGaps(G[s.key], 6);
    } catch (e) {
      log("WARNUNG Pegel", s.key, e.message);
    }
    await sleep(300);
  }
}
const i0 = lastValid(G.grafrath_q, I(nowH));
if (i0 < 0) throw new Error("Keine aktuellen Messwerte für Grafrath");
const tIssue = t0 + i0 * HOUR;
log("Letzter Messwert Grafrath:", new Date(tIssue).toISOString(), G.grafrath_q[i0]);

// ------------------------------------------------------------------ 2) Wetter: Lücke seit Archiv + deterministische Vorhersage
const pKey = `P_${METEO_POINTS[0].key}`;
let lastMet = lastValid(M[pKey]);
// Fallback: Historie lange nicht nachgeführt -> Lücke aus dem Archiv holen
if ((i0 - lastMet) * HOUR > 60 * DAY && !process.argv.includes("--no-archive")) {
  const { archive } = await import("./lib/openmeteo.mjs");
  const s = new Date(t0 + (lastMet + 1) * HOUR).toISOString().slice(0, 10);
  const e = new Date(now - 5 * DAY).toISOString().slice(0, 10);
  log("Archiv-Lücke", s, "bis", e);
  const a = await archive(METEO_POINTS, s, e);
  METEO_POINTS.forEach((p, k) => a.time.forEach((t, j) => {
    const i = I(t); if (i < 0 || i >= n) return;
    const pt = a.points[k];
    if (pt.precipitation[j] != null) M[`P_${p.key}`][i] = pt.precipitation[j];
    if (pt.temperature_2m[j] != null) M[`T_${p.key}`][i] = pt.temperature_2m[j];
    if (pt.et0_fao_evapotranspiration[j] != null) M[`E_${p.key}`][i] = pt.et0_fao_evapotranspiration[j];
  }));
  lastMet = lastValid(M[pKey]);
}
const pastDays = Math.min(92, Math.max(3, Math.ceil(((i0 - lastMet) * HOUR) / DAY) + 2));
const det = await omForecast(METEO_POINTS, { pastDays, days: 16 });
METEO_POINTS.forEach((p, k) => {
  det.time.forEach((t, j) => {
    const i = I(t);
    if (i <= lastMet || i < 0 || i >= n) return;
    const pt = det.points[k];
    if (pt.precipitation[j] != null) M[`P_${p.key}`][i] = pt.precipitation[j] * bf("best_match");
    if (pt.temperature_2m[j] != null) M[`T_${p.key}`][i] = pt.temperature_2m[j];
    if (pt.et0_fao_evapotranspiration[j] != null) M[`E_${p.key}`][i] = pt.et0_fao_evapotranspiration[j];
  });
});
for (const k of Object.keys(M)) fillGaps(M[k], 6);
log("Wetter ergänzt ab", new Date(t0 + (lastMet + 1) * HOUR).toISOString(), `(past_days=${pastDays})`);

// ------------------------------------------------------------------ 3) Modell-Warmlauf bis i0
const F = { ammer: zoneForcing(M, "ammer"), see: zoneForcing(M, "see"), amper: zoneForcing(M, "amper") };
const states = { ammer: zoneState(F.ammer.w.length), see: zoneState(F.see.w.length), amper: zoneState(F.amper.w.length) };
const simPast = { ammer: new Float64Array(n).fill(NaN), amper: new Float64Array(n).fill(NaN) };
{
  const qa = runZone(P.ammer, F.ammer, states.ammer, 0, i0 + 1);
  runZone(P.see, F.see, states.see, 0, i0 + 1);
  const qr = runZone(P.amper, F.amper, states.amper, 0, i0 + 1);
  for (let i = 0; i <= i0; i++) { simPast.ammer[i] = mmh2cms(qa[i], ZONE_AREAS.ammer); simPast.amper[i] = mmh2cms(qr[i], ZONE_AREAS.amper); }
}
const obs = { weilheim_q: G.weilheim_q, stegen_q: G.stegen_q, ammersee_w: G.ammersee_w, grafrath_q: G.grafrath_q };
const baseCtx = { i0, H, tIssue, states, forcing: F, lakeP: M.P_ammersee, lakeE: M.E_ammersee, obs, simPast };
const detRun = runChain(P, baseCtx);
log("Deterministischer Lauf: Grafrath +24h", detRun.qG[23].toFixed(2), "+72h", detRun.qG[71].toFixed(2));

// ------------------------------------------------------------------ 4) Ensembles
// Ensemble-Stützpunkte; jeder Wetterpunkt nutzt den nächstgelegenen (Temperatur höhenkorrigiert).
const MAP = ENS_MAP;
const MODELS = [
  { model: "icon_d2", days: 2, label: "ICON-D2-EPS", bias: "icon_d2" },
  { model: "icon_eu_eps", days: 5, label: "ICON-EU-EPS", bias: "icon_eu" },
  { model: "ecmwf_ifs025", days: 15, label: "ECMWF-ENS", bias: "ecmwf_ifs025" },
];
const ens = {};
for (const m of MODELS) {
  try {
    const model = m.model === "icon_d2" ? "icon_d2_eps" : m.model;
    const r = await omEnsemble(ENS_POINTS, model, m.days);
    r.bias = bf(m.bias);
    ens[m.model] = r;
    log("Ensemble", m.label, r.points[0].members.length, "Member");
  } catch (e) {
    log("WARNUNG Ensemble", m.label, e.message);
  }
}

// Baut für ein Member die Zukunftswerte je Wetterpunkt. chain = [[ensObj, memberIdx], ...] (Fallback-Kette)
function memberSeries(chain, ptIdx, varName, ti) {
  for (const [E, mi] of chain) {
    if (!E) continue;
    const j = E.idx.get(ti);
    if (j === undefined) continue;
    const v = E.points[ptIdx].members[mi % E.points[ptIdx].members.length][varName][j];
    if (v != null) return varName === "precipitation" ? v * E.bias : v;
  }
  return null;
}
for (const E of Object.values(ens)) E.idx = new Map(E.time.map((t, j) => [t, j]));

const chains = [];
const ec = ens.ecmwf_ifs025, eu = ens.icon_eu_eps, d2 = ens.icon_d2;
const nEC = ec ? ec.points[0].members.length : 0, nEU = eu ? eu.points[0].members.length : 0, nD2 = d2 ? d2.points[0].members.length : 0;
for (let k = 0; k < nEC; k++) chains.push([[ec, k]]);
for (let k = 0; k < nEU; k++) chains.push([[eu, k], [ec, k]]);
for (let k = 0; k < nD2; k++) chains.push([[d2, k], [eu, k], [ec, k]]);
log("Member gesamt:", chains.length);

function runMember(chain) {
  // Kopie der Zukunftsabschnitte der Wetterreihen
  const Mm = {};
  for (const p of METEO_POINTS) {
    const e = MAP[p.key], dz = (ENS_POINTS[e].elev - p.elev) * 0.0065;
    const Pa = M[`P_${p.key}`].slice(), Ta = M[`T_${p.key}`].slice();
    for (let l = 1; l <= H; l++) {
      const i = i0 + l, ti = t0 + i * HOUR;
      const pr = memberSeries(chain, e, "precipitation", ti), te = memberSeries(chain, e, "temperature_2m", ti);
      if (pr != null) Pa[i] = pr;
      if (te != null) Ta[i] = te + dz;
    }
    Mm[`P_${p.key}`] = Pa; Mm[`T_${p.key}`] = Ta; Mm[`E_${p.key}`] = M[`E_${p.key}`];
  }
  const Fm = { ammer: zoneForcing(Mm, "ammer"), see: zoneForcing(Mm, "see"), amper: zoneForcing(Mm, "amper") };
  return { r: runChain(P, { ...baseCtx, forcing: Fm, lakeP: Mm.P_ammersee }), pf: futurePrecip(Mm) };
}
// Nur der Gebietsniederschlag der Zukunft wird je Member behalten (Speicher!)
function futurePrecip(Mx) {
  const out = new Float64Array(H);
  for (let l = 1; l <= H; l++) out[l - 1] = areaPrecip(Mx, i0 + l);
  return out;
}

// Gebietsniederschlag (flächengewichtet)
const zoneW = { ammer: ZONE_AREAS.ammer, see: ZONE_AREAS.see + AREAS.ammersee, amper: ZONE_AREAS.amper };
const zoneWsum = Object.values(zoneW).reduce((a, b) => a + b, 0);
function areaPrecip(Mx, i) {
  let s = 0;
  for (const zone of Object.keys(zoneW)) {
    const pts = METEO_POINTS.filter((p) => p.zone === zone);
    const ws = pts.reduce((a, p) => a + p.w, 0);
    let z = 0;
    for (const p of pts) z += (p.w / ws) * Math.max(0, Mx[`P_${p.key}`][i] || 0);
    s += (zoneW[zone] / zoneWsum) * z;
  }
  return s;
}

const members = chains.length ? chains.map(runMember) : [{ r: detRun, pf: futurePrecip(M) }];
log("Ensemble gerechnet");

// ------------------------------------------------------------------ 5) Unsicherheit: Ensemble x Modellfehler (Hindcasts)
const EQ = SKILL.errQuantiles;
const errAt = (lead) => {
  let k = EQ.leads.findIndex((L) => L >= lead);
  if (k < 0) k = EQ.leads.length - 1;
  return EQ.values[k];
};
const PCT = [0.1, 0.25, 0.5, 0.75, 0.9];
const qBands = PCT.map(() => new Float64Array(H));
const lakeBands = [0.1, 0.5, 0.9].map(() => new Float64Array(H));
for (let l = 0; l < H; l++) {
  const errs = errAt(l + 1);
  const sample = [];
  for (const { r } of members) for (const e of errs) sample.push(r.qG[l] * Math.exp(e));
  sample.sort((a, b) => a - b);
  PCT.forEach((p, k) => (qBands[k][l] = quantile(sample, p)));
  const hs = members.map(({ r }) => r.H[l]).sort((a, b) => a - b);
  [0.1, 0.5, 0.9].forEach((p, k) => (lakeBands[k][l] = quantile(hs, p)));
}

// Wasserstand über Abflusstafel, auf aktuellen Messwert geeicht
const wObs = G.grafrath_w[i0], qObs = G.grafrath_q[i0];
const dW = Number.isFinite(wObs) ? wObs - wFromQ(GRAFRATH_RATING, qObs) : 0;
const wBands = qBands.map((b) => b.map((q) => wFromQ(GRAFRATH_RATING, q) + dW));

// Gebietsniederschlag – Vergangenheit und Ensemble
const precipPast = [];
for (let i = i0 - 7 * 24 + 1; i <= i0; i++) precipPast.push(+areaPrecip(M, i).toFixed(2));
const precipFc = { p50: [], p90: [] };
for (let l = 1; l <= H; l++) {
  const v = members.map(({ pf }) => pf[l - 1]).sort((a, b) => a - b);
  precipFc.p50.push(+quantile(v, 0.5).toFixed(2));
  precipFc.p90.push(+quantile(v, 0.9).toFixed(2));
}

// ------------------------------------------------------------------ 6) Historie, Klimatologie, Einordnung
const dailyFile = path.join(HIST_DIR, "grafrath_daily.csv");
const daily = new Map();
for (const l of fs.existsSync(dailyFile) ? fs.readFileSync(dailyFile, "utf8").trim().split("\n").slice(1) : []) {
  const [d, qm, qx, wm, wx] = l.split(",");
  daily.set(d, { q: qm === "" ? null : +qm, qx: qx === "" ? null : +qx, w: wm === "" ? null : +wm, wx: wx === "" ? null : +wx });
}
// Tage nach dem CSV-Ende aus Stundenwerten ergänzen (MEZ-Tag)
{
  const agg = new Map();
  for (let i = Math.max(0, i0 - 400 * 24); i <= i0; i++) {
    const q = G.grafrath_q[i], w = G.grafrath_w[i];
    if (!Number.isFinite(q)) continue;
    const d = new Date(t0 + i * HOUR + HOUR).toISOString().slice(0, 10);
    const a = agg.get(d) || { qs: 0, qx: -1, ws: 0, wx: -1, n: 0, nw: 0 };
    a.qs += q; a.qx = Math.max(a.qx, q); a.n++;
    if (Number.isFinite(w)) { a.ws += w; a.wx = Math.max(a.wx, w); a.nw++; }
    agg.set(d, a);
  }
  for (const [d, a] of agg) if (!daily.has(d) || a.n >= 20) daily.set(d, { q: +(a.qs / a.n).toFixed(2), qx: +a.qx.toFixed(2), w: a.nw ? Math.round(a.ws / a.nw) : null, wx: a.nw ? Math.round(a.wx) : null });
}
// Lückenloses Tagesraster (Index = Tage seit Start)
const days = [];
{
  const ks = [...daily.keys()].sort();
  for (let t = Date.parse(ks[0] + "T00:00Z"), end = Date.parse(ks.at(-1) + "T00:00Z"); t <= end; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!daily.has(d)) daily.set(d, { q: null, qx: null, w: null, wx: null });
    days.push(d);
  }
}
const thisYear = new Date(now).getUTCFullYear();

// Klimatologie je Kalendertag (±7 Tage Fenster), Jahre bis Vorjahr
const doyOf = (d) => { const dt = Date.parse(d + "T00:00Z"); return Math.min(365, Math.floor((dt - Date.UTC(+d.slice(0, 4), 0, 1)) / DAY)); };
const byDoy = Array.from({ length: 366 }, () => []);
const byDoyW = Array.from({ length: 366 }, () => []);
for (const d of days) {
  if (+d.slice(0, 4) >= thisYear) continue;
  const v = daily.get(d);
  const k = doyOf(d);
  for (let o = -7; o <= 7; o++) {
    const kk = (k + o + 366) % 366;
    if (v.q != null) byDoy[kk].push(v.q);
    if (v.w != null && +d.slice(0, 4) >= 2000) byDoyW[kk].push(v.w); // Wasserstand nur jüngere Jahre (Sohlveränderungen)
  }
}
const CPCT = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
const clim = { q: CPCT.map(() => []), w: CPCT.map(() => []) };
for (let k = 0; k < 366; k++) {
  const a = byDoy[k].sort((x, y) => x - y), b = byDoyW[k].sort((x, y) => x - y);
  CPCT.forEach((p, j) => { clim.q[j].push(+quantile(a, p).toFixed(2)); clim.w[j].push(Math.round(quantile(b, p))); });
}
// Perzentil des aktuellen Abflusses (Mittel letzte 24 h) im Jahresvergleich
const q24 = (() => { let s = 0, c = 0; for (let i = i0 - 23; i <= i0; i++) if (Number.isFinite(G.grafrath_q[i])) { s += G.grafrath_q[i]; c++; } return s / c; })();
const todayDoy = doyOf(new Date(tIssue + HOUR).toISOString().slice(0, 10));
const ref = byDoy[todayDoy];
const pctRank = ref.length ? ref.filter((x) => x < q24).length / ref.length : null;
const allQ = days.filter((d) => +d.slice(0, 4) < thisYear).map((d) => daily.get(d).q).filter((x) => x != null);
const MQ = allQ.reduce((a, b) => a + b, 0) / allQ.length;

// ------------------------------------------------------------------ 7) Ausgabe
fs.mkdirSync(SITE_DATA_DIR, { recursive: true });
const r2 = (x, d = 2) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const at = (key, i) => (G[key] && Number.isFinite(G[key][i]) ? G[key][i] : null);
const lastRaw = (key) => { const r = recentRaw[key]; return r && r.length ? r[r.length - 1] : null; };
const delta24 = (key) => { const j = lastValid(G[key] || [], i0); const a = at(key, j), b = at(key, j - 24); return a != null && b != null ? a - b : null; };

const upstream = SERIES.filter((s) => !s.key.startsWith("grafrath")).map((s) => {
  const lr = lastRaw(s.key);
  return { key: s.key, name: s.name, unit: s.unit, t: lr ? lr[0] : null, value: lr ? lr[1] : null, delta24: r2(delta24(s.key), s.key === "ammersee_w" ? 3 : 2) };
});
const lrQ = lastRaw("grafrath_q"), lrW = lastRaw("grafrath_w");

const recentFrom = i0 - 30 * 24 + 1;
const series = (key, from, to, d) => { const o = []; for (let i = from; i <= to; i++) o.push(r2(at(key, i), d)); return o; };

// Tagesübersicht der Prognose (MEZ/MESZ-Tage nach Ortszeit vereinfacht als UTC+1)
const fcDays = [];
{
  const firstT = tIssue + HOUR;
  const byDay = new Map();
  for (let l = 0; l < H; l++) {
    const d = new Date(firstT + l * HOUR + HOUR).toISOString().slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(l);
  }
  for (const [d, ls] of byDay) {
    if (ls.length < 12) continue;
    const mean = (arr) => ls.reduce((a, l) => a + arr[l], 0) / ls.length;
    fcDays.push({
      date: d,
      q: [r2(mean(qBands[0])), r2(mean(qBands[2])), r2(mean(qBands[4]))],
      w: [Math.round(mean(wBands[0])), Math.round(mean(wBands[2])), Math.round(mean(wBands[4]))],
      p: r2(ls.reduce((a, l) => a + precipFc.p50[l], 0), 1),
      p90: r2(ls.reduce((a, l) => a + precipFc.p90[l], 0), 1),
    });
  }
}

const latest = {
  generated: now,
  issued: tIssue,
  current: {
    t: lrQ ? lrQ[0] : tIssue,
    q: lrQ ? lrQ[1] : qObs,
    w: lrW ? lrW[1] : wObs,
    dq24: r2(delta24("grafrath_q")),
    dw24: r2(delta24("grafrath_w"), 0),
    q24,
    percentile: pctRank,
  },
  stats: { ...GRAFRATH_STATS, MQ: r2(MQ, 1), climYears: [days[0].slice(0, 4), String(thisYear - 1)] },
  upstream,
  recent: { t0: t0 + recentFrom * HOUR, step: HOUR, q: series("grafrath_q", recentFrom, i0, 2), w: series("grafrath_w", recentFrom, i0, 0) },
  forecast: {
    t0: tIssue + HOUR,
    step: HOUR,
    pct: PCT,
    q: qBands.map((b) => Array.from(b, (x) => r2(x))),
    w: wBands.map((b) => Array.from(b, (x) => r2(x, 1))),
    lake: lakeBands.map((b) => Array.from(b, (x) => r2(x, 3))),
    precip: precipFc,
    members: members.length,
    models: MODELS.filter((m) => ens[m.model]).map((m) => m.label),
    days: fcDays,
  },
  precipPast: { t0: tIssue - 7 * 24 * HOUR + HOUR, step: HOUR, p: precipPast },
  skill: SKILL.skill,
  calibrated: P.calibrated,
};
fs.writeFileSync(path.join(SITE_DATA_DIR, "latest.json"), JSON.stringify(latest));

const history = {
  generated: now,
  start: days[0],
  q: days.map((d) => daily.get(d).q),
  qx: days.map((d) => daily.get(d).qx),
  w: days.map((d) => daily.get(d).w),
  clim: { pct: CPCT, q: clim.q, w: clim.w },
};
fs.writeFileSync(path.join(SITE_DATA_DIR, "history.json"), JSON.stringify(history));
log("geschrieben:", path.join(SITE_DATA_DIR, "latest.json"), "+ history.json");
