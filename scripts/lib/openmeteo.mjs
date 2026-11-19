// Wetterdaten von Open-Meteo (open-meteo.com, CC BY 4.0).
// - archive: Reanalyse (ERA5/ERA5-Land, "best_match") für Kalibrierung und Modell-Warmlauf
// - forecast: deterministische Vorhersage inkl. der letzten Tage (füllt die Lücke bis zum Archiv)
// - ensemble: ICON-D2-EPS / ICON-EU-EPS / ECMWF-ENS für die Unsicherheit
import { sleep, parseIsoHour } from "./time.mjs";

async function getJson(url, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120e3) });
      const j = await res.json();
      if (j.error) throw new Error(j.reason);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return j;
    } catch (e) {
      lastErr = e;
      await sleep(3000 * (i + 1) ** 2);
    }
  }
  throw new Error(`Open-Meteo ${url.slice(0, 120)}…: ${lastErr?.message}`);
}

const loc = (pts) =>
  `latitude=${pts.map((p) => p.lat).join(",")}&longitude=${pts.map((p) => p.lon).join(",")}&elevation=${pts.map((p) => p.elev).join(",")}`;

// Normalisiert die Antwort (ein oder mehrere Orte) zu {time:[ms], points:[{var: [..]}]}
function norm(j, vars) {
  const arr = Array.isArray(j) ? j : [j];
  const time = arr[0].hourly.time.map(parseIsoHour);
  const points = arr.map((r) => Object.fromEntries(vars.map((v) => [v, r.hourly[v] ?? []])));
  return { time, points };
}

export const MET_VARS = ["precipitation", "temperature_2m", "et0_fao_evapotranspiration"];

export async function archive(points, startDate, endDate) {
  const url = `https://archive-api.open-meteo.com/v1/archive?${loc(points)}&start_date=${startDate}&end_date=${endDate}&hourly=${MET_VARS.join(",")}&timezone=UTC`;
  return norm(await getJson(url), MET_VARS);
}

// Deterministische Vorhersage (best_match = in DE: ICON-D2 -> ICON-EU -> ICON/ECMWF), mit past_days
export async function forecast(points, { pastDays = 10, days = 16, model = "best_match" } = {}) {
  const url = `https://api.open-meteo.com/v1/forecast?${loc(points)}&hourly=${MET_VARS.join(",")}&models=${model}&past_days=${pastDays}&forecast_days=${days}&timezone=UTC`;
  return norm(await getJson(url), MET_VARS);
}

// Ensemble: liefert {time, points:[{members:[{precipitation:[], temperature_2m:[]}]}]}
export async function ensemble(points, model, days) {
  const vars = ["precipitation", "temperature_2m"];
  const url = `https://ensemble-api.open-meteo.com/v1/ensemble?${loc(points)}&hourly=${vars.join(",")}&models=${model}&forecast_days=${days}&timezone=UTC`;
  const j = await getJson(url);
  const arr = Array.isArray(j) ? j : [j];
  const time = arr[0].hourly.time.map(parseIsoHour);
  const pts = arr.map((r) => {
    const h = r.hourly;
    const ids = Object.keys(h)
      .filter((k) => k.startsWith("precipitation"))
      .map((k) => k.slice("precipitation".length)); // "" (Kontrolllauf) bzw. "_member01" ...
    const members = ids.map((id) => ({ precipitation: h["precipitation" + id], temperature_2m: h["temperature_2m" + id] }));
    return { members };
  });
  return { time, points: pts };
}
