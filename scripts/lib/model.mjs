// Hydrologisches Modell Ammer -> Ammersee -> Amper (Grafrath), Zeitschritt 1 h.
//
//  1) Zonenmodell (HBV-light-artig) je Teileinzugsgebiet:
//     Schnee (Gradtag, je Wetterpunkt/Höhenlage) -> Bodenfeuchte -> oberer/unterer Speicher -> Dreiecks-Routing
//  2) Ammersee: Speicher mit Fläche A, Ausfluss = Kennlinie(Seepegel) * Korrekturfaktor
//  3) Grafrath = Ausfluss Stegen (verzögert) + Zwischengebiet (Windach, Ampermoos)

// ---------- Parameter (Grenzen für die Kalibrierung, stündliche Raten) ----------
export const ZONE_PARAMS = {
  TT: [-1.5, 2.0], //   Schwellentemperatur Regen/Schnee (°C)
  CFMAX: [1.0, 8.0], // Gradtagfaktor (mm/°C/Tag)
  SFCF: [0.6, 1.4], //  Schneefall-Korrektur
  PCORR: [0.6, 1.6], // Niederschlags-Korrektur
  FC: [40, 450], //     Feldkapazität Boden (mm)
  LP: [0.3, 1.0], //    ET-Reduktionsschwelle (Anteil FC)
  BETA: [0.8, 6.0], //  Form der Abflussbildung
  CET: [0.5, 1.3], //   Faktor auf ET0
  PERC: [0.0, 0.2], //  Perkolation (mm/h)
  UZL: [0, 60], //      Schwelle schneller Abfluss (mm)
  K0: [0.004, 0.12], // schneller Abfluss (1/h)
  K1: [0.001, 0.04], // Interflow (1/h)
  K2: [0.00002, 0.004], // Basisabfluss (1/h)
  MAXBAS: [1, 60], //   Routing-Basis (h)
};
const CWH = 0.1, CFR = 0.05;

export function zoneState(nPoints) {
  return { sp: new Float64Array(nPoints), wc: new Float64Array(nPoints), sm: 50, suz: 0, slz: 20, buf: [] };
}
export const cloneState = (s) => ({ sp: Float64Array.from(s.sp), wc: Float64Array.from(s.wc), sm: s.sm, suz: s.suz, slz: s.slz, buf: s.buf.slice() });

function routingWeights(maxbas) {
  const n = Math.max(1, Math.round(maxbas));
  if (n === 1) return [1];
  const w = [];
  for (let i = 0; i < n; i++) {
    const a = i / n, b = (i + 1) / n;
    // Integral der Dreiecksfunktion über [a,b]
    const tri = (x) => (x <= 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));
    w.push(tri(b) - tri(a));
  }
  return w;
}

// forcing: {P: [Float64Array je Punkt], T: [...], E: [...], w: [Gewichte]}, Bereich [i0, i1)
// Rückgabe: q (mm/h) Float64Array der Länge i1-i0; state wird fortgeschrieben (in place)
export function runZone(p, forcing, state, i0, i1) {
  const { P, T, E, w } = forcing;
  const np = w.length;
  const cfmax = p.CFMAX / 24;
  const rw = routingWeights(p.MAXBAS);
  if (state.buf.length !== rw.length) {
    const b = new Array(rw.length).fill(0);
    for (let i = 0; i < Math.min(b.length, state.buf.length); i++) b[i] = state.buf[i];
    state.buf = b;
  }
  const buf = state.buf;
  const out = new Float64Array(i1 - i0);
  let { sm, suz, slz } = state;
  const { sp, wc } = state;
  for (let i = i0; i < i1; i++) {
    // --- Schnee je Punkt, gewichtetes Wasserangebot ---
    let inp = 0, et0 = 0;
    for (let k = 0; k < np; k++) {
      let pr = P[k][i]; if (!(pr > 0)) pr = 0;
      let t = T[k][i]; if (!Number.isFinite(t)) t = 5;
      pr *= p.PCORR;
      let liquid;
      if (t < p.TT) {
        sp[k] += pr * p.SFCF;
        liquid = 0;
        const refr = Math.min(wc[k], CFR * cfmax * (p.TT - t));
        wc[k] -= refr; sp[k] += refr;
      } else {
        liquid = pr;
        const melt = Math.min(sp[k], cfmax * (t - p.TT));
        sp[k] -= melt; wc[k] += melt;
      }
      wc[k] += liquid;
      const hold = CWH * sp[k];
      let release = 0;
      if (wc[k] > hold) { release = wc[k] - hold; wc[k] = hold; }
      inp += w[k] * release;
      const e = E[k][i];
      et0 += w[k] * (e > 0 ? e : 0);
    }
    // --- Boden ---
    const rel = Math.min(sm / p.FC, 1);
    const recharge = inp * Math.pow(rel, p.BETA);
    sm += inp - recharge;
    const eta = Math.min(sm, p.CET * et0 * Math.min(sm / (p.LP * p.FC), 1));
    sm -= eta;
    if (sm > p.FC) { suz += sm - p.FC; sm = p.FC; }
    // --- Abflusskomponenten ---
    suz += recharge;
    const perc = Math.min(p.PERC, suz);
    suz -= perc; slz += perc;
    const q0 = p.K0 * Math.max(suz - p.UZL, 0);
    const q1 = p.K1 * suz;
    suz -= q0 + q1;
    const q2 = p.K2 * slz;
    slz -= q2;
    const qg = q0 + q1 + q2;
    // --- Routing ---
    for (let j = 0; j < rw.length; j++) buf[j] += qg * rw[j];
    out[i - i0] = buf[0];
    buf.shift(); buf.push(0);
  }
  state.sm = sm; state.suz = suz; state.slz = slz;
  return out;
}

export const mmh2cms = (qmm, areaKm2) => (qmm * areaKm2) / 3.6;

// ---------- Ammersee ----------
// Kennlinie als Stützstellen-Tabelle {h:[], q:[]} (monoton, linear interpoliert, oben linear extrapoliert)
export function lakeOutflow(r, H) {
  const h = r.h, q = r.q, n = h.length;
  if (H <= h[0]) return Math.max(0.1, q[0] + ((q[1] - q[0]) / (h[1] - h[0])) * (H - h[0]));
  if (H >= h[n - 1]) return q[n - 1] + ((q[n - 1] - q[n - 2]) / (h[n - 1] - h[n - 2])) * (H - h[n - 1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (h[m] <= H) lo = m; else hi = m; }
  return q[lo] + ((q[hi] - q[lo]) * (H - h[lo])) / (h[hi] - h[lo]);
}

// Seebilanz: inflow (m³/s) je Stunde, Start-Pegel H0, Korrekturfaktor corr auf die Kennlinie.
// Zwei Halbschritte pro Stunde für Stabilität.
export function runLake(lake, inflow, H0, corr = 1) {
  const n = inflow.length;
  const H = new Float64Array(n), Q = new Float64Array(n);
  let h = H0;
  const A = lake.area * 1e6;
  for (let i = 0; i < n; i++) {
    let qsum = 0;
    for (let s = 0; s < 2; s++) {
      const q = corr * lakeOutflow(lake.rating, h);
      h += ((inflow[i] - q) * 1800) / A;
      qsum += q;
    }
    H[i] = h; Q[i] = qsum / 2;
  }
  return { H, Q };
}

// ---------- Gütemaße ----------
export function nse(sim, obs, tf = (x) => x) {
  let mo = 0, n = 0;
  for (let i = 0; i < obs.length; i++) if (Number.isFinite(obs[i]) && Number.isFinite(sim[i])) { mo += tf(obs[i]); n++; }
  if (n < 10) return -Infinity;
  mo /= n;
  let a = 0, b = 0;
  for (let i = 0; i < obs.length; i++) {
    if (!Number.isFinite(obs[i]) || !Number.isFinite(sim[i])) continue;
    const o = tf(obs[i]), s = tf(sim[i]);
    a += (s - o) ** 2; b += (o - mo) ** 2;
  }
  return 1 - a / b;
}

export function kge(sim, obs) {
  let n = 0, ms = 0, mo = 0;
  for (let i = 0; i < obs.length; i++) if (Number.isFinite(obs[i]) && Number.isFinite(sim[i])) { ms += sim[i]; mo += obs[i]; n++; }
  if (n < 10) return -Infinity;
  ms /= n; mo /= n;
  let ss = 0, so = 0, cov = 0;
  for (let i = 0; i < obs.length; i++) {
    if (!Number.isFinite(obs[i]) || !Number.isFinite(sim[i])) continue;
    ss += (sim[i] - ms) ** 2; so += (obs[i] - mo) ** 2; cov += (sim[i] - ms) * (obs[i] - mo);
  }
  const r = cov / Math.sqrt(ss * so), alpha = Math.sqrt(ss / so), beta = ms / mo;
  return 1 - Math.sqrt((r - 1) ** 2 + (alpha - 1) ** 2 + (beta - 1) ** 2);
}

// ---------- Optimierer: Differential Evolution (deterministischer Zufall) ----------
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function optimize(bounds, objective, { pop = 0, gens = 60, seed = 1, log = null, init = null } = {}) {
  const keys = Object.keys(bounds);
  const D = keys.length;
  const NP = pop || Math.max(20, 6 * D);
  const r = rng(seed);
  const toObj = (v) => Object.fromEntries(keys.map((k, i) => [k, v[i]]));
  const P = [], F = [];
  for (let i = 0; i < NP; i++) {
    const v = keys.map((k) => bounds[k][0] + r() * (bounds[k][1] - bounds[k][0]));
    if (i === 0 && init) keys.forEach((k, j) => { if (init[k] !== undefined) v[j] = Math.min(Math.max(init[k], bounds[k][0]), bounds[k][1]); });
    P.push(v); F.push(objective(toObj(v)));
  }
  for (let g = 0; g < gens; g++) {
    for (let i = 0; i < NP; i++) {
      let a, b, c;
      do a = Math.floor(r() * NP); while (a === i);
      do b = Math.floor(r() * NP); while (b === i || b === a);
      do c = Math.floor(r() * NP); while (c === i || c === a || c === b);
      const jr = Math.floor(r() * D);
      const Fw = 0.5 + 0.3 * r();
      const u = P[i].map((x, j) => {
        if (r() < 0.8 || j === jr) {
          let y = P[a][j] + Fw * (P[b][j] - P[c][j]);
          const [lo, hi] = bounds[keys[j]];
          if (y < lo) y = lo + r() * (x - lo);
          if (y > hi) y = hi - r() * (hi - x);
          return y;
        }
        return x;
      });
      const fu = objective(toObj(u));
      if (fu >= F[i]) { P[i] = u; F[i] = fu; }
    }
    if (log) {
      const best = Math.max(...F);
      log(g, best);
    }
  }
  const bi = F.indexOf(Math.max(...F));
  return { best: toObj(P[bi]), score: F[bi] };
}

// ---------- Hilfen ----------
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// Gewichtete Quantile: vals/wts gleich lang, ps aufsteigend in [0,1]
export function wQuantiles(vals, wts, ps) {
  const ord = Array.from(vals.keys()).filter((k) => Number.isFinite(vals[k]) && wts[k] > 0).sort((a, b) => vals[a] - vals[b]);
  if (!ord.length) return ps.map(() => NaN);
  const tot = ord.reduce((s, k) => s + wts[k], 0);
  // Stützstellen in der Mitte jedes Gewichtsblocks (wie quantile() bei gleichen Gewichten)
  const pos = [];
  let c = 0;
  for (const k of ord) { pos.push((c + wts[k] / 2) / tot); c += wts[k]; }
  return ps.map((p) => {
    if (p <= pos[0]) return vals[ord[0]];
    for (let j = 1; j < ord.length; j++) {
      if (p <= pos[j]) return vals[ord[j - 1]] + ((vals[ord[j]] - vals[ord[j - 1]]) * (p - pos[j - 1])) / (pos[j] - pos[j - 1]);
    }
    return vals[ord.at(-1)];
  });
}

// W (cm) <-> Q (m³/s) über Abflusstafel [[cm, m3s], ...] (monoton)
export function qFromW(table, w) {
  if (w <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (w <= table[i][0]) {
      const [w0, q0] = table[i - 1], [w1, q1] = table[i];
      return q0 + ((q1 - q0) * (w - w0)) / (w1 - w0);
    }
  }
  const [w0, q0] = table.at(-2), [w1, q1] = table.at(-1);
  return q1 + ((q1 - q0) * (w - w1)) / (w1 - w0);
}
export function wFromQ(table, q) {
  if (q <= table[0][1]) return table[0][0];
  for (let i = 1; i < table.length; i++) {
    if (q <= table[i][1]) {
      const [w0, q0] = table[i - 1], [w1, q1] = table[i];
      return w0 + ((w1 - w0) * (q - q0)) / (q1 - q0);
    }
  }
  const [w0, q0] = table.at(-2), [w1, q1] = table.at(-1);
  return w1 + ((w1 - w0) * (q - q1)) / (q1 - q0);
}
