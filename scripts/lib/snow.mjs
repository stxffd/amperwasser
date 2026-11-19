// Schneehöhen der DWD-Stationen (Tageswert, Messung morgens ~06 UTC) und Schnee-Assimilation.
import fs from "node:fs";
import path from "node:path";
import { HIST_DIR, SNOW_STATIONS, UA } from "../config.mjs";
import { unzip } from "./zip.mjs";
import { HOUR } from "./time.mjs";

const BASE = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/more_precip/";
export const SNOW_FILE = path.join(HIST_DIR, "snow.csv");

async function getBuf(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.status === 404) return null;
      if (r.ok) return Buffer.from(await r.arrayBuffer());
    } catch {}
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error("DWD nicht erreichbar: " + url);
}

// Schneehöhe (cm) je Datum "YYYY-MM-DD" aus einem DWD-Tageswerte-ZIP
function parseZip(buf) {
  const out = new Map();
  for (const [name, read] of unzip(buf)) {
    if (!name.startsWith("produkt_")) continue;
    const lines = read().toString("latin1").split(/\r?\n/);
    const head = lines[0].split(";").map((s) => s.trim());
    const iD = head.indexOf("MESS_DATUM"), iS = head.indexOf("SH_TAG");
    for (const l of lines.slice(1)) {
      const c = l.split(";");
      if (c.length < head.length) continue;
      const v = +c[iS];
      if (!Number.isFinite(v) || v < 0) continue;
      const d = c[iD].trim();
      out.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, v);
    }
  }
  return out;
}

export async function fetchStation(id, { historical = false } = {}) {
  const res = new Map();
  if (historical) {
    const idx = (await getBuf(BASE + "historical/"))?.toString("latin1") || "";
    const m = idx.match(new RegExp(`tageswerte_RR_${id}_\\d+_\\d+_hist\\.zip`));
    if (m) { const b = await getBuf(BASE + "historical/" + m[0]); if (b) for (const [d, v] of parseZip(b)) res.set(d, v); }
  }
  const b = await getBuf(BASE + `recent/tageswerte_RR_${id}_akt.zip`);
  if (b) for (const [d, v] of parseZip(b)) res.set(d, v);
  return res;
}

export function readSnow(file = SNOW_FILE) {
  const data = new Map(SNOW_STATIONS.map((s) => [s.id, new Map()]));
  if (!fs.existsSync(file)) return data;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const head = lines[0].split(",");
  for (const l of lines.slice(1)) {
    const c = l.split(",");
    for (let k = 1; k < head.length; k++) if (c[k] !== "" && c[k] !== undefined && data.has(head[k])) data.get(head[k]).set(c[0], +c[k]);
  }
  return data;
}

export function writeSnow(data, file = SNOW_FILE) {
  const ids = SNOW_STATIONS.map((s) => s.id);
  const dates = [...new Set(ids.flatMap((id) => [...(data.get(id)?.keys() || [])]))].sort();
  const rows = dates.map((d) => [d, ...ids.map((id) => data.get(id)?.get(d) ?? "")].join(","));
  fs.writeFileSync(file, ["date," + ids.join(","), ...rows].join("\n") + "\n");
}

// ---------------------------------------------------------------- Assimilation
// Schneedichte (Anteil) nach Monat für die Umrechnung Schneehöhe -> Wasseräquivalent
export const RHO = [0.24, 0.27, 0.31, 0.36, 0.38, 0.38, 0.3, 0.3, 0.2, 0.2, 0.2, 0.22];

/**
 * Bereitet die Assimilation vor: Stationsbeobachtungen auf den Stundenindex (06 UTC) und
 * Zuordnung Station -> Zone/Punkt. forcingZones: {ammer, see, amper} aus zoneForcing().
 */
export function snowSetup(snowData, t0, n, forcingZones, meteoPoints) {
  const st = [];
  for (const s of SNOW_STATIONS) {
    const mp = meteoPoints.find((p) => p.key === s.pt);
    if (!mp) continue;
    const F = forcingZones[mp.zone];
    const k = F.keys.indexOf(s.pt);
    const obs = new Map(); // Stundenindex -> Schneehöhe cm
    for (const [d, v] of snowData.get(s.id) || []) {
      const i = Math.round((Date.parse(d + "T06:00Z") - t0) / HOUR);
      if (i >= 0 && i < n) obs.set(i, v);
    }
    st.push({ ...s, zone: mp.zone, k, dz: (mp.elev - s.elev) * 0.0065, obs, swe: 0, wc: 0 });
  }
  return st;
}

// Schattenmodell: Schneedecke in Stationshöhe mit den Zonenparametern über [i0, i1) fortschreiben
export function snowShadow(st, params, forcingZones, i0, i1) {
  for (let i = i0; i < i1; i++) {
    for (const s of st) {
      const p = params[s.zone], F = forcingZones[s.zone];
      let pr = F.P[s.k][i]; if (!(pr > 0)) pr = 0;
      let t = F.T[s.k][i]; if (!Number.isFinite(t)) t = 5;
      t += s.dz;
      pr *= p.PCORR;
      const cf = p.CFMAX / 24;
      if (t < p.TT) { s.swe += pr * p.SFCF; const r = Math.min(s.wc, 0.05 * cf * (p.TT - t)); s.wc -= r; s.swe += r; }
      else { const m = Math.min(s.swe, cf * (t - p.TT)); s.swe -= m; s.wc += m + pr; }
      if (s.wc > 0.1 * s.swe) s.wc = 0.1 * s.swe;
    }
  }
}

/**
 * Korrektur der Zonen-Schneespeicher mit den Messungen des Termins iObs (06 UTC).
 * opt: {alpha (0..1), eps (mm), rhoScale, t0}. Gibt die Zahl korrigierter Wetterpunkte zurück.
 */
export function snowCorrect(st, states, iObs, opt) {
  let nAssim = 0;
  {
    const i = iObs;
    // Verhältnis Messung/Modell je Wetterpunkt (geometrisches Mittel über Stationen)
    const byPt = new Map();
    for (const s of st) {
      const d = s.obs.get(i);
      if (d === undefined) continue;
      const rho = RHO[new Date(opt.t0 + i * HOUR).getUTCMonth()] * (opt.rhoScale || 1);
      const oSwe = d * 10 * rho, mSwe = s.swe + s.wc;
      const eps = opt.eps ?? 5;
      const lr = Math.log((oSwe + eps) / (mSwe + eps));
      const key = s.zone + "|" + s.k;
      if (!byPt.has(key)) byPt.set(key, []);
      byPt.get(key).push({ s, lr, diff: oSwe - mSwe, oSwe, mSwe });
    }
    for (const [key, arr] of byPt) {
      const [zone, ks] = key.split("|"), k = +ks;
      // Additive Korrektur: die an den Stationen gemessene Abweichung (mm Wasser) auf den Wetterpunkt
      // übertragen. Additiv statt multiplikativ, damit sich tägliche Korrekturen nicht aufschaukeln.
      const add = (opt.alpha * arr.reduce((a, x) => a + x.diff, 0)) / arr.length;
      const zs = states[zone];
      if (add >= 0) zs.sp[k] += add;
      else {
        const tot = zs.sp[k] + zs.wc[k];
        const f = tot > 0 ? Math.max(0, tot + add) / tot : 0;
        zs.sp[k] *= f; zs.wc[k] *= f;
      }
      // Schattenmodell an den Stationen ebenfalls nachführen
      for (const x of arr) { x.s.swe = (1 - opt.alpha) * x.mSwe + opt.alpha * x.oSwe; x.s.wc = 0; }
      nAssim++;
    }
  }
  return nAssim;
}
export const cloneSnow = (st) => st.map((s) => ({ ...s }));

// Index des letzten Messtermins (06 UTC) <= i
export function lastObsHour(i, t0) {
  const t = t0 + i * HOUR;
  let m = Math.floor(t / 86400000) * 86400000 + 6 * HOUR;
  if (m > t) m -= 86400000;
  return Math.round((m - t0) / HOUR);
}

/**
 * Zonenmodelle über [i0, i1) rechnen, Schattenmodell mitführen und (mode "daily") an jedem
 * Messtermin assimilieren. Rückgabe: {ammer, see, amper} Abflüsse in mm/h.
 */
export function runZonesSnow(runZone, P, F, states, st, i0, i1, opt) {
  const out = { ammer: new Float64Array(i1 - i0), see: new Float64Array(i1 - i0), amper: new Float64Array(i1 - i0) };
  const daily = opt && opt.mode === "daily" && opt.alpha > 0;
  let a = i0;
  while (a < i1) {
    let b = i1;
    if (daily) { const lo = lastObsHour(a, opt.t0); b = Math.min(i1, (lo === a ? a : lo + 24) + 1); }
    for (const z of ["ammer", "see", "amper"]) out[z].set(runZone(P[z], F[z], states[z], a, b), a - i0);
    if (st) snowShadow(st, P, F, a, b);
    if (daily && st && b - 1 === lastObsHour(b - 1, opt.t0)) snowCorrect(st, states, b - 1, opt);
    a = b;
  }
  return out;
}
