// Abruf von Messwerten beim Gewässerkundlichen Dienst Bayern (gkd.bayern.de).
// Die Tabellenansicht liefert alle 15-min-Werte eines beliebigen Zeitraums (getestet: 1 Jahr pro Abruf).
// Lizenz der Daten: CC BY 4.0, Bayerisches Landesamt für Umwelt.
import { UA } from "../config.mjs";
import { parseGermanLocal, gkdDate, sleep, HOUR } from "./time.mjs";

const BASE = "https://www.gkd.bayern.de/de/";

async function get(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "de-DE,de;q=0.9" },
        signal: AbortSignal.timeout(90e3),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (text.includes("Request Rejected")) throw new Error("WAF rejected request");
      return text;
    } catch (e) {
      lastErr = e;
      await sleep(2000 * (i + 1));
    }
  }
  throw new Error(`GKD ${url}: ${lastErr?.message}`);
}

const num = (s) => {
  const v = parseFloat(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
};

// Liefert [[utcMs, wert], ...] aufsteigend sortiert.
export async function fetchRaw(series, from, to) {
  // from/to: {y,m,d}
  const url = `${BASE}${series.kind}/isar/p-${series.id}/messwerte/tabelle?beginn=${gkdDate(from.y, from.m, from.d)}&ende=${gkdDate(to.y, to.m, to.d)}`;
  const html = await get(url);
  const out = [];
  const re = /<tr[^>]*>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const t = parseGermanLocal(m[1]);
    const v = num(m[2].trim());
    if (Number.isFinite(t) && v !== null) out.push([t, v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

// Mittelwert je UTC-Stunde [h, h+1) -> Map(hourMs -> wert)
export function toHourly(raw) {
  const sum = new Map(), cnt = new Map();
  for (const [t, v] of raw) {
    const h = Math.floor(t / HOUR) * HOUR;
    sum.set(h, (sum.get(h) || 0) + v);
    cnt.set(h, (cnt.get(h) || 0) + 1);
  }
  const out = new Map();
  for (const [h, s] of sum) out.set(h, s / cnt.get(h));
  return out;
}

// Aktuelle Werte aller Pegel einer Flussgebiets-Karte des HND (ein Abruf für alle Pegel).
export async function fetchHndSnapshot(region = "isar") {
  const html = await get(`https://www.hnd.bayern.de/pegel/${region}`);
  const attr = (s, a) => (s.match(new RegExp(a + '="([^"]*)"')) || [])[1];
  const out = {};
  for (const tag of html.match(/<img[^>]*data-name[^>]*>/g) || []) {
    const id = (attr(tag, "id") || "").replace(/^p/, "");
    out[id] = {
      w: num(attr(tag, "data-wert") || ""),
      q: num(attr(tag, "data-wert2") || ""),
      ms: attr(tag, "data-ms") || null,
      t: parseGermanLocal(attr(tag, "data-datum") || ""),
    };
  }
  return out;
}
