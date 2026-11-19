// Kalibrierung und Bewertung des Prognosemodells.
//   node scripts/calibrate.mjs [--gens 60] [--valFrom 2017] [--quick] [--reuse]
// Ergebnis: data/model/params.json (Parameter) und data/model/skill.json (Hindcast-Güte, Fehlerquantile)
import fs from "node:fs";
import path from "node:path";
import { MODEL_DIR, ZONE_AREAS } from "./config.mjs";
import { loadAll, zoneForcing } from "./lib/data.mjs";
import { ZONE_PARAMS, zoneState, cloneState, runZone, mmh2cms, runLake, lakeOutflow, nse, kge, optimize, quantile } from "./lib/model.mjs";
import { runChain } from "./lib/forecast.mjs";
import { HOUR, DAY } from "./lib/time.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; };
const GENS = +opt("gens", 60);
const QUICK = args.includes("--quick");
const VAL_FROM = +opt("valFrom", 2017);
// --reuse: Zonenparameter aus params.json übernehmen, nur Fehlerkorrektur und Hindcasts neu rechnen
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const OLD = args.includes("--reuse") ? readJson(path.join(MODEL_DIR, "params.json")) : null;
const OLD_SKILL = OLD ? readJson(path.join(MODEL_DIR, "skill.json")) : null;

const t = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t) / 1000).toFixed(0)}s]`, ...a);

const D = loadAll({ fromYear: 1998 });
const { gauges: G, meteo: M, t0 } = D;
const idx = (y, m = 1, d = 1) => Math.round((Date.UTC(y, m - 1, d) - t0) / HOUR);
// Ende: letzte Stunde mit vollständigem Wetter
let N = D.n;
while (N > 0 && !Number.isFinite(M[Object.keys(M)[0]][N - 1])) N--;
log("Daten", new Date(t0).toISOString(), "bis", new Date(t0 + (N - 1) * HOUR).toISOString(), N, "Stunden");

const WARM = Math.min(idx(1999), N);
const CAL_END = Math.min(idx(VAL_FROM), N);
const F = { ammer: zoneForcing(M, "ammer"), see: zoneForcing(M, "see"), amper: zoneForcing(M, "amper") };
const lakeP = M.P_ammersee, lakeE = M.E_ammersee;

// ---------------------------------------------------------------- Hilfen
function simZone(p, f, i0, i1, state = null) {
  const s = state || zoneState(f.w.length);
  return { q: runZone(p, f, s, i0, i1), state: s };
}
const maskFrom = (arr, from, to) => { const a = arr.slice(from, to); return a; };
function shift(arr, lag) { const out = new Float64Array(arr.length).fill(NaN); for (let i = lag; i < arr.length; i++) out[i] = arr[i - lag]; return out; }
function dailyMeans(arr, from, to) {
  const out = [];
  for (let i = from; i + 24 <= to; i += 24) {
    let s = 0, n = 0;
    for (let k = i; k < i + 24; k++) if (Number.isFinite(arr[k])) { s += arr[k]; n++; }
    out.push(n >= 18 ? s / n : NaN);
  }
  return Float64Array.from(out);
}
function corrAtLag(x, y, lag, from, to) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let i = from + lag; i < to; i++) {
    const a = x[i - lag], b = y[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; n++;
  }
  return (n * sxy - sx * sy) / Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
}
const diff = (a, k = 3) => { const o = new Float64Array(a.length).fill(NaN); for (let i = k; i < a.length; i++) o[i] = a[i] - a[i - k]; return o; };

// ---------------------------------------------------------------- A) Fließzeit Stegen -> Grafrath
const dS = diff(G.stegen_q), dG = diff(G.grafrath_q);
let lagS = 0, bestC = -1;
for (let l = 0; l <= 12; l++) { const c = corrAtLag(dS, dG, l, Math.max(0, N - 15 * 8766), N); if (c > bestC) { bestC = c; lagS = l; } }
log(`Fließzeit Stegen→Grafrath: ${lagS} h (r=${bestC.toFixed(3)})`);

// ---------------------------------------------------------------- B) Ausflusskennlinie Ammersee
// Empirische Kennlinie: Median-Abfluss je 5-cm-Pegelklasse, monoton gemacht.
// Für die seltenen hohen Seestände werden alle Jahre seit 1990 herangezogen.
function fitRating(from, to) {
  const W = 0.05;
  const collect = (a, b) => {
    const bins = new Map();
    for (let i = a; i < b; i++) {
      const H = G.ammersee_w[i], Q = G.stegen_q[i];
      if (!Number.isFinite(H) || !(Q > 0)) continue;
      const k = Math.round(H / W);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(Q);
    }
    return bins;
  };
  const recent = collect(from, to), all = collect(0, to);
  const keys = [...new Set([...recent.keys(), ...all.keys()])].sort((x, y) => x - y);
  const h = [], q = [];
  for (const k of keys) {
    const r = recent.get(k), a = all.get(k);
    const src = r && r.length >= 48 ? r : a && a.length >= 12 ? a : null;
    if (!src) continue;
    src.sort((x, y) => x - y);
    h.push(+(k * W).toFixed(3)); q.push(quantile(src, 0.5));
  }
  // Monotonie (Pool-Adjacent-Violators vereinfacht: laufendes Maximum)
  for (let i = 1; i < q.length; i++) if (q[i] < q[i - 1] + 0.05) q[i] = q[i - 1] + 0.05;
  return { h, q: q.map((x) => +x.toFixed(2)) };
}
const RFROM = Math.max(0, N - 12 * 8766); // jüngste ~12 Jahre (Gerinne/Verkrautung ändern sich)
const rating = fitRating(RFROM, N);
// Monatsfaktoren (Verhältnis Messung/Kennlinie)
const mSum = new Array(12).fill(0), mCnt = new Array(12).fill(0);
for (let i = RFROM; i < N; i += 3) {
  const H = G.ammersee_w[i], Q = G.stegen_q[i];
  if (!Number.isFinite(H) || !(Q > 0)) continue;
  const r = Math.log(Q / lakeOutflow(rating, H));
  const mo = new Date(t0 + i * HOUR).getUTCMonth();
  mSum[mo] += r; mCnt[mo]++;
}
const month = mSum.map((s, k) => +Math.exp(s / Math.max(mCnt[k], 1)).toFixed(3));
log("Seekennlinie", rating.h.length, "Stützstellen", `${rating.h[0]}…${rating.h.at(-1)} m`, `${rating.q[0]}…${rating.q.at(-1)} m³/s`, "Monatsfaktoren", month.join(" "));
const LAKE = { area: 46.6, rating, month };

// ---------------------------------------------------------------- C) Ammer bis Weilheim
const obsW = G.weilheim_q;
function objAmmer(p) {
  const { q } = simZone(p, F.ammer, 0, CAL_END);
  const sim = q.map((x) => mmh2cms(x, ZONE_AREAS.ammer)).subarray(WARM);
  const obs = obsW.subarray(WARM, CAL_END);
  return 0.5 * nse(sim, obs) + 0.5 * nse(sim, obs, Math.sqrt);
}
log("Kalibriere Ammer (Weilheim) …");
const calA = OLD ? { best: OLD.ammer, score: OLD_SKILL?.scores?.ammer ?? objAmmer(OLD.ammer) } : optimize(ZONE_PARAMS, objAmmer, { gens: QUICK ? 10 : GENS, seed: 1, log: (g, b) => g % 10 === 9 && log(`  Gen ${g + 1}: ${b.toFixed(4)}`) });
const PA = calA.best;
log("Ammer kalibriert, Ziel", calA.score.toFixed(4));

// ---------------------------------------------------------------- D) Seitliche Seezuflüsse + Fließzeit Weilheim->See
const SNOW = ["TT", "CFMAX", "SFCF"];
const subBounds = Object.fromEntries(Object.entries(ZONE_PARAMS).filter(([k]) => !SNOW.includes(k)));
const simAfull = simZone(PA, F.ammer, 0, N).q.map((x) => mmh2cms(x, ZONE_AREAS.ammer));
const wIn = obsW.map((v, i) => (Number.isFinite(v) ? v : simAfull[i]));
const BLOCK = 30 * 24;

function lakeSim(pSee, lagW, lakeEvap, from, to) {
  const pz = { ...pSee, TT: PA.TT, CFMAX: PA.CFMAX, SFCF: PA.SFCF };
  const qL = simZone(pz, F.see, 0, to).q;
  const simQ = new Float64Array(to).fill(NaN);
  for (let b = from; b + 24 < to; b += BLOCK) {
    const e = Math.min(b + BLOCK, to);
    const H0 = G.ammersee_w[b];
    if (!Number.isFinite(H0)) continue;
    const inflow = new Float64Array(e - b);
    for (let i = b; i < e; i++) {
      const w = wIn[Math.max(0, i - lagW)];
      const pr = Math.max(lakeP[i] || 0, 0) * pz.PCORR, ev = Math.max(lakeE[i] || 0, 0);
      inflow[i - b] = w + mmh2cms(qL[i], ZONE_AREAS.see) + mmh2cms(pr - lakeEvap * ev, 46.6);
    }
    const mf = month[new Date(t0 + b * HOUR).getUTCMonth()];
    const r = runLake(LAKE, inflow, H0, mf);
    simQ.set(r.Q, b);
  }
  return simQ;
}
const seeBounds = { ...subBounds, lagW: [0, 14], lakeEvap: [0.5, 1.3] };
function objSee(p) {
  const { lagW, lakeEvap, ...pSee } = p;
  const s = lakeSim(pSee, Math.round(lagW), lakeEvap, WARM, CAL_END);
  return nse(s.subarray(WARM, CAL_END), G.stegen_q.subarray(WARM, CAL_END));
}
log("Kalibriere Seezuflüsse/Ammersee …");
const oldSee = OLD && { ...Object.fromEntries(Object.keys(subBounds).map((k) => [k, OLD.see[k]])), lagW: OLD.lagW, lakeEvap: OLD.lakeEvap };
const calS = OLD ? { best: oldSee, score: OLD_SKILL?.scores?.stegen_nse ?? objSee(oldSee) } : optimize(seeBounds, objSee, { gens: QUICK ? 8 : Math.round(GENS * 0.7), seed: 2, init: PA, log: (g, b) => g % 10 === 9 && log(`  Gen ${g + 1}: ${b.toFixed(4)}`) });
const { lagW: lagWf, lakeEvap, ...PSsub } = calS.best;
const lagW = Math.round(lagWf);
const PS = { ...PSsub, TT: PA.TT, CFMAX: PA.CFMAX, SFCF: PA.SFCF };
log("See kalibriert, NSE(Stegen)", calS.score.toFixed(4), "lagW", lagW, "h");

// ---------------------------------------------------------------- E) Zwischengebiet Stegen -> Grafrath (Windach, Ampermoos)
const Rh = G.grafrath_q.map((v, i) => v - (i >= lagS ? G.stegen_q[i - lagS] : NaN));
const Rd = dailyMeans(Rh, WARM, CAL_END);
function objAmper(p) {
  const pz = { ...p, TT: PA.TT, CFMAX: PA.CFMAX, SFCF: PA.SFCF };
  const q = simZone(pz, F.amper, 0, CAL_END).q.map((x) => mmh2cms(x, ZONE_AREAS.amper));
  const sd = dailyMeans(q, WARM, CAL_END);
  return nse(sd, Rd);
}
log("Kalibriere Zwischengebiet …");
const oldAmper = OLD && Object.fromEntries(Object.keys(subBounds).map((k) => [k, OLD.amper[k]]));
const calR = OLD ? { best: oldAmper, score: OLD_SKILL?.scores?.zwischengebiet_nse ?? objAmper(oldAmper) } : optimize(subBounds, objAmper, { gens: QUICK ? 8 : Math.round(GENS * 0.7), seed: 3, init: PA, log: (g, b) => g % 10 === 9 && log(`  Gen ${g + 1}: ${b.toFixed(4)}`) });
const PR = { ...calR.best, TT: PA.TT, CFMAX: PA.CFMAX, SFCF: PA.SFCF };
log("Zwischengebiet kalibriert, NSE(Tageswerte)", calR.score.toFixed(4));

// ---------------------------------------------------------------- F) Hindcasts im Validierungszeitraum
const P = { ammer: PA, see: PS, amper: PR, lake: LAKE, lagW, lagS, lakeEvap, TA: 48, TG: 48 };
const HZ = 14 * 24;
const VFROM = CAL_END, VTO = N - HZ - 1;
const STEP = QUICK ? 7 * 24 : 36;
const issues = [];
for (let i = VFROM + 30 * 24 + 6; i < VTO; i += STEP) issues.push(i);
log("Hindcasts:", issues.length, "Ausgabezeitpunkte");

// Kontinuierlicher Lauf mit Zustands-Schnappschüssen
const snaps = new Map();
const simPast = { ammer: new Float64Array(N), amper: new Float64Array(N) };
{
  const st = { ammer: zoneState(F.ammer.w.length), see: zoneState(F.see.w.length), amper: zoneState(F.amper.w.length) };
  let prev = 0;
  for (const i0 of [...issues, N - 1]) {
    const qa = runZone(PA, F.ammer, st.ammer, prev, i0 + 1);
    const qs = runZone(PS, F.see, st.see, prev, i0 + 1);
    const qr = runZone(PR, F.amper, st.amper, prev, i0 + 1);
    for (let k = 0; k < qa.length; k++) { simPast.ammer[prev + k] = mmh2cms(qa[k], ZONE_AREAS.ammer); simPast.amper[prev + k] = mmh2cms(qr[k], ZONE_AREAS.amper); }
    snaps.set(i0, { ammer: cloneState(st.ammer), see: cloneState(st.see), amper: cloneState(st.amper) });
    prev = i0 + 1;
  }
}
const obs = { weilheim_q: G.weilheim_q, stegen_q: G.stegen_q, ammersee_w: G.ammersee_w, grafrath_q: G.grafrath_q };
function hindcast(Pp) {
  return issues.map((i0) => ({ i0, r: runChain(Pp, { i0, H: HZ, tIssue: t0 + i0 * HOUR, states: snaps.get(i0), forcing: F, lakeP, lakeE, obs, simPast }) }));
}
// Abklingzeiten der Fehlerkorrektur (Gitter)
const leadsEval = [6, 12, 24, 48, 72, 120, 168];
function scoreRuns(runs, key, obsArr) {
  let s = 0, n = 0;
  for (const { i0, r } of runs) for (const L of leadsEval) {
    const o = obsArr[i0 + L], f = r[key][L - 1];
    if (o > 0 && f > 0) { s += Math.abs(Math.log(f / o)); n++; }
  }
  return s / n;
}
// erst TA (Weilheim), dann TG (Grafrath) bei festem TA; 1e6 h = Korrektur klingt praktisch nicht ab
const TGRID = [6, 12, 24, 48, 96, 192, 384, 768, 1536, 1e6];
let bestTA = 48, bestTG = 48, bA = Infinity, bG = Infinity;
for (const T of TGRID) {
  const ea = scoreRuns(hindcast({ ...P, TA: T }), "qW", G.weilheim_q);
  if (ea < bA) { bA = ea; bestTA = T; }
}
for (const T of TGRID) {
  const eg = scoreRuns(hindcast({ ...P, TA: bestTA, TG: T }), "qG", G.grafrath_q);
  if (eg < bG) { bG = eg; bestTG = T; }
}
P.TA = bestTA; P.TG = bestTG;
log("Abklingzeiten Fehlerkorrektur: TA", bestTA, "h, TG", bestTG, "h");

// Endgültige Hindcasts -> Gütemaße und Fehlerquantile je Vorhersagezeit
const runs = hindcast(P);
const LEADS = []; for (let L = 3; L <= HZ; L += 3) LEADS.push(L);
// Gleichabständige Wahrscheinlichkeiten -> Fehlerverteilung lässt sich direkt als Stichprobe nutzen
const QS = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
const errQ = {}, skill = [];
for (const L of LEADS) {
  const e = [], absM = [], absP = [], fo = [], ob = [];
  for (const { i0, r } of runs) {
    const o = G.grafrath_q[i0 + L], f = r.qG[L - 1], p0 = G.grafrath_q[i0];
    if (!(o > 0 && f > 0 && p0 > 0)) continue;
    e.push(Math.log(o / f)); absM.push(Math.abs(f - o) / o); absP.push(Math.abs(p0 - o) / o); fo.push(f); ob.push(o);
  }
  e.sort((a, b) => a - b);
  errQ[L] = QS.map((q) => +quantile(e, q).toFixed(4));
  if ([6, 12, 24, 48, 72, 120, 168, 240, 336].includes(L)) {
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    skill.push({ lead_h: L, n: e.length, mape_model: +(100 * mean(absM)).toFixed(1), mape_persistence: +(100 * mean(absP)).toFixed(1), nse: +nse(Float64Array.from(fo), Float64Array.from(ob)).toFixed(3) });
  }
}
console.table(skill);

// Simulationsgüte (kontinuierlich, ohne Korrektur) im Validierungszeitraum
const vSlice = (a) => a.subarray(VFROM, N);
const sim = {
  weilheim_kge: +kge(vSlice(simPast.ammer), vSlice(G.weilheim_q)).toFixed(3),
  weilheim_nse: +nse(vSlice(simPast.ammer), vSlice(G.weilheim_q)).toFixed(3),
};
log("Simulation Validierung", sim);

fs.mkdirSync(MODEL_DIR, { recursive: true });
const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" ? +v.toPrecision(6) : v)));
fs.writeFileSync(path.join(MODEL_DIR, "params.json"), JSON.stringify(round({ calibrated: new Date().toISOString(), calPeriod: [new Date(t0 + WARM * HOUR).toISOString().slice(0, 10), new Date(t0 + CAL_END * HOUR).toISOString().slice(0, 10)], ...P }), null, 1));
fs.writeFileSync(path.join(MODEL_DIR, "skill.json"), JSON.stringify({ valPeriod: [new Date(t0 + VFROM * HOUR).toISOString().slice(0, 10), new Date(t0 + VTO * HOUR).toISOString().slice(0, 10)], issues: issues.length, scores: { ammer: calA.score, stegen_nse: calS.score, zwischengebiet_nse: calR.score, ...sim }, skill, errQuantiles: { q: QS, leads: LEADS, values: LEADS.map((L) => errQ[L]) } }, null, 1));
log("gespeichert:", path.join(MODEL_DIR, "params.json"));
