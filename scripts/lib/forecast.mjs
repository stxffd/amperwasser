// Prognosekette ab einem Ausgabezeitpunkt i0 (letzte Stunde mit Messwerten).
// Wird identisch für Hindcasts (Kalibrierung/Bewertung) und die Live-Vorhersage verwendet.
import { ZONE_AREAS, AREAS } from "../config.mjs";
import { runZone, cloneState, mmh2cms, runLake, lakeOutflow } from "./model.mjs";

const meanRange = (a, i0, i1) => {
  let s = 0, n = 0;
  for (let i = Math.max(i0, 0); i <= i1; i++) if (Number.isFinite(a[i])) { s += a[i]; n++; }
  return n ? s / n : NaN;
};

// Monatsfaktor der Seeausfluss-Kennlinie (Verkrautung o. ä.)
export const monthFactor = (lake, ms) => lake.month?.[new Date(ms).getUTCMonth()] ?? 1;

/**
 * @param P   kalibrierte Parameter (params.json)
 * @param ctx {
 *   i0, H,                    Ausgabeindex, Horizont (h)
 *   tIssue,                   Zeitstempel (ms) von i0
 *   states: {ammer, see, amper}  Modellzustände nach Stunde i0 (werden geklont)
 *   forcing: {ammer, see, amper} Antrieb (Arrays über den gleichen Index wie obs; Zukunft ab i0+1)
 *   lakeP, lakeE              Niederschlag/ET0 am See (mm/h), gleicher Index
 *   obs: {weilheim_q, stegen_q, ammersee_w, grafrath_q, grafrath_w}  Messreihen (Index wie oben)
 *   simPast: {ammer, amper}   simulierte Abflüsse (m³/s) bis i0 (für die Fehlerkorrektur)
 * }
 * Rückgabe: {qW, H, qS, qG} je Float64Array(H) für die Stunden i0+1 … i0+H
 */
export function runChain(P, ctx) {
  const { i0, H, states, forcing, obs, simPast } = ctx;
  const lagW = P.lagW, lagS = P.lagS;

  // 1) Ammer (Weilheim): Modell weiterrechnen + abklingende Fehlerkorrektur im Log-Raum
  const sA = cloneState(states.ammer);
  const qA = runZone(P.ammer, forcing.ammer, sA, i0 + 1, i0 + 1 + H).map((q) => mmh2cms(q, ZONE_AREAS.ammer));
  const oA = meanRange(obs.weilheim_q, i0 - 2, i0), mA = meanRange(simPast.ammer, i0 - 2, i0);
  const cA = Number.isFinite(oA) && mA > 0 ? Math.max(-1.5, Math.min(1.5, Math.log(oA / mA))) : 0;
  const qW = qA.map((q, l) => q * Math.exp(cA * Math.exp(-(l + 1) / P.TA)));

  // 2) Seitliche Zuflüsse zum See + Niederschlag/Verdunstung auf der Seefläche
  const sS = cloneState(states.see);
  const qL = runZone(P.see, forcing.see, sS, i0 + 1, i0 + 1 + H).map((q) => mmh2cms(q, ZONE_AREAS.see));
  const inflow = new Float64Array(H);
  for (let l = 0; l < H; l++) {
    const i = i0 + 1 + l;
    const j = i - lagW; // Fließzeit Weilheim -> See
    let w = j <= i0 ? obs.weilheim_q[j] : qW[j - i0 - 1];
    if (!Number.isFinite(w)) w = j <= i0 ? simPast.ammer[j] : qW[Math.max(0, j - i0 - 1)];
    const p = Math.max(ctx.lakeP[i] || 0, 0) * P.see.PCORR, e = Math.max(ctx.lakeE[i] || 0, 0);
    inflow[l] = w + qL[l] + mmh2cms(p - P.lakeEvap * e, AREAS.ammersee);
  }

  // 3) Ammersee: Start am gemessenen Seepegel, Kennlinie auf aktuellen Ausfluss geeicht
  let H0 = obs.ammersee_w[i0];
  if (!Number.isFinite(H0)) H0 = meanRange(obs.ammersee_w, i0 - 6, i0);
  const mf = monthFactor(P.lake, ctx.tIssue);
  const qSo = meanRange(obs.stegen_q, i0 - 1, i0);
  let corr = mf;
  if (Number.isFinite(qSo) && Number.isFinite(H0)) corr = Math.max(0.5, Math.min(2, qSo / lakeOutflow(P.lake.rating, H0)));
  const lake = runLake(P.lake, inflow, H0, corr);

  // 4) Grafrath = Stegen (verzögert) + Zwischengebiet, additive Fehlerkorrektur
  const sG = cloneState(states.amper);
  const qR = runZone(P.amper, forcing.amper, sG, i0 + 1, i0 + 1 + H).map((q) => mmh2cms(q, ZONE_AREAS.amper));
  const stegenAt = (j) => {
    if (j <= i0) { const v = obs.stegen_q[j]; return Number.isFinite(v) ? v : qSo; }
    return lake.Q[j - i0 - 1];
  };
  const base0 = stegenAt(i0 - lagS) + simPast.amper[i0];
  const oG = meanRange(obs.grafrath_q, i0 - 1, i0);
  const eG = Number.isFinite(oG) && Number.isFinite(base0) ? oG - base0 : 0;
  const qG = new Float64Array(H);
  for (let l = 0; l < H; l++) {
    const i = i0 + 1 + l;
    qG[l] = Math.max(0.3, stegenAt(i - lagS) + qR[l] + eG * Math.exp(-(l + 1) / P.TG));
  }
  return { qW, H: lake.H, qS: lake.Q, qG };
}
