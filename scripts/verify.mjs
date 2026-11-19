// Prognoseprüfung mit archivierten Wettervorhersagen ("Reforecasts") und Variantenvergleich.
//   node scripts/verify.mjs [--quick]
// Für jeden Tag seit Feb. 2024 wird die Prognose so nachgerechnet, wie sie damals möglich gewesen wäre:
// Modellzustand aus gemessenem Wetter bis zum Ausgabezeitpunkt, danach die damals tatsächlich
// vorliegenden Vorhersagen von ICON und ECMWF (Vorlauftag d = Lauf von vor d Tagen), ab Tag 8 Klimatologie.
// Varianten (Schnee-Assimilation, Modellgewichte, Niederschlagsfaktoren, Fehlerkorrektur) werden auf einem
// Trainingszeitraum optimiert und auf einem unabhängigen Testzeitraum geprüft.
// Ergebnis: data/model/forecast_config.json (gewählte Variante) und data/model/verify.json (Gütetabelle).
import fs from "node:fs";
import path from "node:path";
import { MODEL_DIR, HIST_DIR, ZONE_AREAS, METEO_POINTS, ENS_POINTS, ENS_MAP, REFORECAST_MODELS, REFORECAST_FROM, GRAFRATH_RATING } from "./config.mjs";
import { loadAll, zoneForcing, lastValid } from "./lib/data.mjs";
import { loadDense } from "./lib/store.mjs";
import { zoneState, cloneState, runZone, mmh2cms, quantile, wFromQ } from "./lib/model.mjs";
import { runChain } from "./lib/forecast.mjs";
import { readSnow, snowSetup, snowCorrect, cloneSnow, lastObsHour, runZonesSnow } from "./lib/snow.mjs";
import { HOUR, DAY } from "./lib/time.mjs";

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const T_START = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T_START) / 1000).toFixed(0)}s]`, ...a);
const readJson = (f, d = null) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);

const PARAMS_FILE = args.includes("--params") ? args[args.indexOf("--params") + 1] : "params.json";
const DRY = args.includes("--dry"); // nur bewerten, nichts schreiben
const P0 = readJson(path.join(MODEL_DIR, PARAMS_FILE));
const BASE_FILE = args.includes("--baseline") ? args[args.indexOf("--baseline") + 1] : PARAMS_FILE; // Vergleich "bisher"
const PB = readJson(path.join(MODEL_DIR, BASE_FILE));
console.log("Parametersatz:", PARAMS_FILE, "(Schneegewicht Kalibrierung:", P0.snowWeight ?? 0, ") · Vergleich bisher:", BASE_FILE);
const BIAS = readJson(path.join(MODEL_DIR, "precip_bias.json"), { factors: {} }).factors;
const bI = BIAS.icon_eu ?? 1, bE = BIAS.ecmwf_ifs025 ?? 1;
const H = 14 * 24;

// ---------------------------------------------------------------- Daten
const D = loadAll({ fromYear: 1998 });
const { gauges: G, meteo: M, t0 } = D;
const idx = (ms) => Math.round((ms - t0) / HOUR);
let N = D.n; // Ende des gemessenen Wetters
while (N > 0 && !Number.isFinite(M[`P_${METEO_POINTS[0].key}`][N - 1])) N--;
const lastG = lastValid(G.grafrath_q);
log("Wetter bis", new Date(t0 + (N - 1) * HOUR).toISOString(), "Pegel bis", new Date(t0 + lastG * HOUR).toISOString());

const F = { ammer: zoneForcing(M, "ammer"), see: zoneForcing(M, "see"), amper: zoneForcing(M, "amper") };
const obs = { weilheim_q: G.weilheim_q, stegen_q: G.stegen_q, ammersee_w: G.ammersee_w, grafrath_q: G.grafrath_q };

// Reforecasts auf das gemeinsame Stundenraster
const RF = {};
for (const model of Object.keys(REFORECAST_MODELS)) {
  const d = loadDense(path.join(HIST_DIR, "reforecast", model), { fromYear: 2024, toMs: t0 + (D.n - 1) * HOUR });
  if (!d) throw new Error("Reforecasts fehlen – zuerst scripts/fetch-history.mjs reforecast");
  const off = Math.round((d.t0 - t0) / HOUR);
  RF[model] = {};
  for (const [k, a] of Object.entries(d.cols)) {
    const out = new Float32Array(D.n).fill(NaN);
    for (let i = 0; i < a.length && i + off < D.n; i++) out[i + off] = a[i];
    RF[model][k] = out;
  }
}
const RFI = RF.icon_seamless, RFE = RF.ecmwf_ifs025;

// Klimatologie je Wetterpunkt (Training 1999–2016): Niederschlag je Monat, Temperatur je Monat und Stunde
const CLIM = {};
{
  const a = idx(Date.UTC(1999, 0, 1)), b = idx(Date.UTC(2017, 0, 1));
  for (const p of METEO_POINTS) {
    const ps = new Float64Array(12), pn = new Float64Array(12), ts = new Float64Array(288), tn = new Float64Array(288);
    const Pa = M[`P_${p.key}`], Ta = M[`T_${p.key}`];
    for (let i = a; i < b; i++) {
      const dt = new Date(t0 + i * HOUR), mo = dt.getUTCMonth(), h = dt.getUTCHours();
      if (Number.isFinite(Pa[i])) { ps[mo] += Pa[i]; pn[mo]++; }
      if (Number.isFinite(Ta[i])) { ts[mo * 24 + h] += Ta[i]; tn[mo * 24 + h]++; }
    }
    CLIM[p.key] = { P: Array.from(ps, (s, k) => s / pn[k]), T: Array.from(ts, (s, k) => s / tn[k]) };
  }
}

// Schneehöhen
const SNOW = readSnow();

// ---------------------------------------------------------------- Ausgabezeitpunkte
const iEndRF = Math.min(N - 1, lastG - H);
const issuesRF = [];
for (let t = Date.parse(REFORECAST_FROM + "T06:00Z") + 8 * DAY; idx(t) <= iEndRF; t += DAY) issuesRF.push(idx(t));
// Perfektes Wetter, Frühjahr (März–Juni) 2017–heute: Prüfstand für die Schnee-Varianten
const issuesPW = [];
for (let i = idx(Date.UTC(2017, 2, 1, 6)); i + H < Math.min(N, lastG); i += 36) {
  const mo = new Date(t0 + i * HOUR).getUTCMonth();
  if (mo >= 2 && mo <= 5) issuesPW.push(i);
}
const SPLIT = idx(Date.UTC(2025, 8, 1));
const springRF = issuesRF.filter((i) => { const mo = new Date(t0 + i * HOUR).getUTCMonth(); return mo >= 2 && mo <= 5; });
log("Ausgabezeitpunkte: Reforecast", issuesRF.length, `(Training ${issuesRF.filter((i) => i < SPLIT).length}, Test ${issuesRF.filter((i) => i >= SPLIT).length})`, "· Frühjahr perfektes Wetter", issuesPW.length);

// ---------------------------------------------------------------- Modelllauf mit Zustands-Schnappschüssen
const ALL_ISSUES = [...new Set([...issuesRF, ...issuesPW])].sort((a, b) => a - b);
function continuous(snowOpt, Pset = P0) {
  const PZ = { ammer: Pset.ammer, see: Pset.see, amper: Pset.amper };
  const states = { ammer: zoneState(F.ammer.w.length), see: zoneState(F.see.w.length), amper: zoneState(F.amper.w.length) };
  const st = snowSetup(SNOW, t0, D.n, F, METEO_POINTS);
  const opt = snowOpt && snowOpt.alpha > 0 ? { ...snowOpt, t0 } : null;
  const simPast = { ammer: new Float64Array(D.n).fill(NaN), amper: new Float64Array(D.n).fill(NaN) };
  const snaps = new Map();
  let prev = 0;
  for (const i0 of ALL_ISSUES) {
    const q = runZonesSnow(runZone, PZ, F, states, st, prev, i0 + 1, opt);
    for (let k = 0; k < q.ammer.length; k++) { simPast.ammer[prev + k] = mmh2cms(q.ammer[k], ZONE_AREAS.ammer); simPast.amper[prev + k] = mmh2cms(q.amper[k], ZONE_AREAS.amper); }
    const s = { ammer: cloneState(states.ammer), see: cloneState(states.see), amper: cloneState(states.amper) };
    if (opt && opt.mode === "once") snowCorrect(cloneSnow(st), s, lastObsHour(i0, t0), opt);
    snaps.set(i0, s);
    prev = i0 + 1;
  }
  return { snaps, simPast };
}

// ---------------------------------------------------------------- Wetter der Zukunft aus Reforecasts einsetzen
const PTS = METEO_POINTS.map((p) => {
  const e = ENS_POINTS[ENS_MAP[p.key]];
  return { key: p.key, e: e.key, dz: (e.elev - p.elev) * 0.0065, P: M[`P_${p.key}`], T: M[`T_${p.key}`] };
});
const fin = Number.isFinite;
function blend(a, b, w) {
  if (fin(a) && fin(b)) return w * a + (1 - w) * b;
  return fin(a) ? a : b;
}
function patch(i0, cfg) {
  const saved = [];
  for (const pt of PTS) {
    saved.push([pt.P.slice(i0 + 1, i0 + 1 + H), pt.T.slice(i0 + 1, i0 + 1 + H)]);
    const C = CLIM[pt.key];
    let anom = 0, lA = 0;
    for (let l = 1; l <= H; l++) {
      const i = i0 + l, d = Math.floor((l - 1) / 24);
      const dt = new Date(t0 + i * HOUR), mo = dt.getUTCMonth(), hr = dt.getUTCHours();
      const wI = d <= 4 ? cfg.wIcon : 0;
      const ic = d <= 6 ? RFI[`P${d}_${pt.e}`][i] * bI : NaN, ec = d <= 7 ? RFE[`P${d}_${pt.e}`][i] * bE : NaN;
      const tic = d <= 6 ? RFI[`T${d}_${pt.e}`][i] : NaN, tec = d <= 7 ? RFE[`T${d}_${pt.e}`][i] : NaN;
      let pr = blend(ic, ec, wI), te = blend(tic, tec, wI);
      if (fin(te)) { te += pt.dz; anom = te - C.T[mo * 24 + hr]; lA = l; }
      else te = C.T[mo * 24 + hr] + anom * Math.exp(-(l - lA) / 120);
      if (fin(pr)) pr *= d <= 2 ? cfg.fS : cfg.fM;
      else pr = C.P[mo];
      pt.P[i] = pr; pt.T[i] = te;
    }
  }
  return saved;
}
function unpatch(i0, saved) {
  PTS.forEach((pt, k) => { pt.P.set(saved[k][0], i0 + 1); pt.T.set(saved[k][1], i0 + 1); });
}

// Ein Hindcast-Satz: {i0, qG, qW} je Ausgabezeitpunkt
function hindcasts(cont, issues, cfg, reforecast, Pset = P0) {
  const Pp = { ...Pset, TA: cfg.TA, TG: cfg.TG };
  const out = [];
  for (const i0 of issues) {
    const saved = reforecast ? patch(i0, cfg) : null;
    const r = runChain(Pp, { i0, H, tIssue: t0 + i0 * HOUR, states: cont.snaps.get(i0), forcing: F, lakeP: M.P_ammersee, lakeE: M.E_ammersee, obs, simPast: cont.simPast });
    if (saved) unpatch(i0, saved);
    out.push({ i0, qG: Float32Array.from(r.qG), qW: Float32Array.from(r.qW) });
  }
  return out;
}

// ---------------------------------------------------------------- Bewertung
const LEADS = [6, 12, 24, 48, 72, 120, 168, 240, 336];
function wAt(i0, q) {
  const w0 = G.grafrath_w[i0], q0 = G.grafrath_q[i0];
  return wFromQ(GRAFRATH_RATING, q) + (fin(w0) && fin(q0) ? w0 - wFromQ(GRAFRATH_RATING, q0) : 0);
}
function score(runs, filter = () => true) {
  const rows = LEADS.map((L) => ({ L, n: 0, w: 0, wp: 0, q: 0, qp: 0, weil: 0 }));
  for (const { i0, qG, qW } of runs) {
    if (!filter(i0)) continue;
    const w0 = G.grafrath_w[i0], q0 = G.grafrath_q[i0];
    if (!fin(w0) || !fin(q0)) continue;
    LEADS.forEach((L, k) => {
      const wo = G.grafrath_w[i0 + L], qo = G.grafrath_q[i0 + L];
      if (!fin(wo) || !(qo > 0)) return;
      const r = rows[k];
      r.n++;
      r.w += Math.abs(wAt(i0, qG[L - 1]) - wo);
      r.wp += Math.abs(w0 - wo);
      r.q += Math.abs(qG[L - 1] - qo) / qo;
      r.qp += Math.abs(q0 - qo) / qo;
      const wwo = G.weilheim_q[i0 + L];
      if (wwo > 0 && qW[L - 1] > 0) r.weil += Math.abs(Math.log(qW[L - 1] / wwo));
    });
  }
  const tab = rows.map((r) => ({ lead_h: r.L, n: r.n, mae_w: r.w / r.n, mae_w_pers: r.wp / r.n, mape_q: (100 * r.q) / r.n, mape_q_pers: (100 * r.qp) / r.n, weil: r.weil / r.n }));
  return { obj: tab.reduce((a, r) => a + r.mae_w, 0) / tab.length, weil: tab.reduce((a, r) => a + r.weil, 0) / tab.length, tab };
}

// ---------------------------------------------------------------- 1) Schnee-Varianten
const BASE = { TA: P0.TA, TG: P0.TG, wIcon: 60 / 111, fS: 1, fM: 1 }; // entspricht der bisherigen Live-Prognose
const SNOW_VARIANTS = QUICK
  ? [{ name: "aus", alpha: 0 }, { name: "täglich α=0.5", mode: "daily", alpha: 0.5 }]
  : [
      { name: "aus", alpha: 0 },
      { name: "einmalig α=0.5", mode: "once", alpha: 0.5 },
      { name: "einmalig α=1", mode: "once", alpha: 1 },
      { name: "täglich α=0.1", mode: "daily", alpha: 0.1 },
      { name: "täglich α=0.25", mode: "daily", alpha: 0.25 },
      { name: "täglich α=0.5", mode: "daily", alpha: 0.5 },
      { name: "täglich α=0.25, Dichte −20 %", mode: "daily", alpha: 0.25, rhoScale: 0.8 },
      { name: "täglich α=0.25, Dichte +25 %", mode: "daily", alpha: 0.25, rhoScale: 1.25 },
    ];
const snowResults = [];
let best = null, off = null;
const train = (i) => i < SPLIT;
for (const v of SNOW_VARIANTS) {
  const cont = continuous(v);
  const pw = score(hindcasts(cont, issuesPW, BASE, false));
  const rfS = score(hindcasts(cont, springRF, BASE, true));
  snowResults.push({ name: v.name, pw: +pw.obj.toFixed(2), pwWeilheim: +pw.weil.toFixed(4), rfSpring: +rfS.obj.toFixed(2) });
  log(`Schnee ${v.name.padEnd(28)} Frühjahr MAE W: perfektes Wetter ${pw.obj.toFixed(2)} cm, Reforecast ${rfS.obj.toFixed(2)} cm · Weilheim log-Fehler ${pw.weil.toFixed(3)}`);
  const cand = { v, pw: pw.obj, rf: rfS.obj, cont };
  if (!off) { off = best = cand; continue; }
  // Übernehmen nur, wenn in beiden Prüfständen (perfektes Wetter 2017–26, Reforecasts 2024–26) besser
  const better = (a, b) => a.pw < b.pw * 0.99 && a.rf < b.rf * 0.995;
  if (better(cand, off) && (best === off || cand.pw + cand.rf < best.pw + best.rf)) best = cand;
}
const snowChoice = best.v;
log("Gewählt Schnee:", snowChoice.name);
const cont = best.cont;

// ---------------------------------------------------------------- 2) Prognose-Einstellungen (Koordinatensuche auf Training)
const SPACE = {
  TA: [12, 24, 48, 96, 192, 384, 768, 1536],
  TG: [12, 24, 48, 96, 192, 384, 768, 1536],
  wIcon: [0, 0.25, 0.5, 0.75, 1],
  fS: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2],
  fM: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2],
};
const trainRF = issuesRF.filter(train), testRF = issuesRF.filter((i) => !train(i));
// Bewertung getrennt nach erster Hälfte (Feb. 2024 – Aug. 2025) und zweiter Hälfte (ab Sep. 2025)
function objOf(cfg) {
  const runs = hindcasts(cont, issuesRF, cfg, true);
  return { a: score(runs, train).obj, b: score(runs, (i) => !train(i)).obj };
}
// Koordinatensuche mit Konsistenzregel: Eine Änderung wird nur übernommen, wenn sie in BEIDEN
// Zeiträumen besser ist (mind. 0,5 %). Das verhindert, dass Zufallsschwankungen eines Zeitraums
// zu Einstellungen führen, die anderswo schlechter sind (im ersten Versuch beobachtet).
function descend(cfg0) {
  let cfg = { ...cfg0 }, b = objOf(cfg);
  for (let pass = 0; pass < (QUICK ? 1 : 2); pass++) {
    let changed = false;
    for (const key of Object.keys(SPACE)) {
      for (const v of SPACE[key]) {
        if (v === cfg[key]) continue;
        const c = { ...cfg, [key]: v }, s = objOf(c);
        if (s.a < b.a * 0.995 && s.b < b.b * 0.995 && s.a + s.b < b.a + b.b) { b = s; cfg = c; changed = true; }
      }
      log(`  ${key} = ${cfg[key]} → MAE ${b.a.toFixed(2)} / ${b.b.toFixed(2)} cm`);
    }
    if (!changed) break;
  }
  return { cfg, obj: b };
}
log("Optimierung der Prognose-Einstellungen (Zeitraum 1 / Zeitraum 2) …");
const base0 = objOf(BASE);
log(`  bisherige Einstellungen → MAE ${base0.a.toFixed(2)} / ${base0.b.toFixed(2)} cm`);
const opt = descend(BASE);
const CFG = opt.cfg;


// ---------------------------------------------------------------- 3) Ergebnis
const runsAll = hindcasts(cont, issuesRF, CFG, true);
// "bisher": bisheriger Parametersatz, bisherige Einstellungen, ohne Schnee-Abgleich
const BASE_PB = { TA: PB.TA, TG: PB.TG, wIcon: 60 / 111, fS: 1, fM: 1 };
const runsBase = hindcasts(continuous({ alpha: 0 }, PB), issuesRF, BASE_PB, true, PB);
const allNew = score(runsAll), allBase = score(runsBase);
const half = (runs, f) => +score(runs, f).obj.toFixed(2);
const halves = { before: [half(runsBase, train), half(runsBase, (i) => !train(i))], after: [half(runsAll, train), half(runsAll, (i) => !train(i))] };
log("MAE W Zeitraum 1 / 2: bisher", halves.before.join(" / "), "cm → neu", halves.after.join(" / "), "cm");
console.table(allNew.tab.map((r, k) => ({ lead_h: r.lead_h, n: r.n, "MAE W neu": r.mae_w.toFixed(1), "MAE W bisher": allBase.tab[k].mae_w.toFixed(1), "MAE W Persistenz": r.mae_w_pers.toFixed(1), "MAPE Q neu": r.mape_q.toFixed(1), "MAPE Q Persistenz": r.mape_q_pers.toFixed(1) })));

// Fehlerquantile (log Q) je Vorlaufzeit aus den Reforecast-Hindcasts -> Unsicherheitsbänder live
const QS = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
const qLeads = []; for (let L = 3; L <= H; L += 3) qLeads.push(L);
const errQ = qLeads.map((L) => {
  const e = [];
  for (const { i0, qG } of runsAll) { const o = G.grafrath_q[i0 + L]; if (o > 0 && qG[L - 1] > 0) e.push(Math.log(o / qG[L - 1])); }
  e.sort((a, b) => a - b);
  return QS.map((q) => +quantile(e, q).toFixed(4));
});
// Abdeckung der 80-%-Spanne im Test (Quantile nur aus Training geschätzt)
const cover = (() => {
  const trainRuns = runsAll.filter((r) => train(r.i0)), testRuns = runsAll.filter((r) => !train(r.i0));
  return LEADS.map((L) => {
    const e = trainRuns.map(({ i0, qG }) => { const o = G.grafrath_q[i0 + L]; return o > 0 ? Math.log(o / qG[L - 1]) : NaN; }).filter(fin).sort((a, b) => a - b);
    const lo = quantile(e, 0.1), hi = quantile(e, 0.9);
    let n = 0, k = 0;
    for (const { i0, qG } of testRuns) { const o = G.grafrath_q[i0 + L]; if (!(o > 0)) continue; n++; const x = Math.log(o / qG[L - 1]); if (x >= lo && x <= hi) k++; }
    return +(k / n).toFixed(3);
  });
})();

const r1 = (x) => +x.toFixed(1);
const config = {
  generated: new Date().toISOString(),
  snow: { name: snowChoice.name, mode: snowChoice.mode || "off", alpha: snowChoice.alpha || 0, rhoScale: snowChoice.rhoScale || 1 },
  wIcon: CFG.wIcon, fS: CFG.fS, fM: CFG.fM, TA: CFG.TA, TG: CFG.TG,
  errQuantiles: { q: QS, leads: qLeads, values: errQ },
};
const iso = (i) => new Date(t0 + i * HOUR).toISOString().slice(0, 10);
const verify = {
  generated: config.generated,
  period: [iso(issuesRF[0]), iso(issuesRF.at(-1))],
  split: iso(SPLIT),
  issues: issuesRF.length,
  table: allNew.tab.map((r, k) => ({ lead_h: r.lead_h, n: r.n, mae_w: r1(r.mae_w), mae_w_before: r1(allBase.tab[k].mae_w), mae_w_pers: r1(r.mae_w_pers), mape_q: r1(r.mape_q), mape_q_pers: r1(r.mape_q_pers), cover80_test: cover[k] })),
  halves: { ...halves, persistence: [score(runsAll, train), score(runsAll, (i) => !train(i))].map((x) => +(x.tab.reduce((a, r) => a + r.mae_w_pers, 0) / x.tab.length).toFixed(2)) },
  params: PARAMS_FILE,
  snowVariants: snowResults,
  chosen: { snow: config.snow.name, wIcon: CFG.wIcon, fS: CFG.fS, fM: CFG.fM, TA: CFG.TA, TG: CFG.TG },
};
if (!DRY) {
  fs.writeFileSync(path.join(MODEL_DIR, "forecast_config.json"), JSON.stringify({ ...config, params: PARAMS_FILE }, null, 1));
  fs.writeFileSync(path.join(MODEL_DIR, "verify.json"), JSON.stringify(verify, null, 1));
  log("gespeichert: forecast_config.json, verify.json", JSON.stringify(verify.chosen));
} else log("Probelauf, nichts gespeichert", JSON.stringify(verify.chosen));
