// Zentrale Konfiguration: Messstellen, Wetterpunkte, Pfade.
import { fileURLToPath } from "node:url";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = path.join(ROOT, "data");
export const HIST_DIR = path.join(DATA_DIR, "history");
export const MODEL_DIR = path.join(DATA_DIR, "model");
export const SITE_DIR = path.join(ROOT, "site");
export const SITE_DATA_DIR = path.join(SITE_DIR, "data");

// Pegel des Gewässerkundlichen Dienstes Bayern (gkd.bayern.de, CC BY 4.0).
// kind: Pfad-Präfix auf gkd.bayern.de, unit: Einheit, from: erstes Jahr für die Stunden-Historie.
export const SERIES = [
  { key: "grafrath_q", id: "16603000", kind: "fluesse/abfluss", unit: "m³/s", name: "Grafrath / Amper", from: 1990 },
  { key: "grafrath_w", id: "16603000", kind: "fluesse/wasserstand", unit: "cm", name: "Grafrath / Amper", from: 1990 },
  { key: "stegen_q", id: "16602303", kind: "fluesse/abfluss", unit: "m³/s", name: "Stegen / Amper (Ammersee-Ausfluss)", from: 1990 },
  { key: "ammersee_w", id: "16602008", kind: "seen/wasserstand", unit: "m NHN", name: "Stegen / Ammersee", from: 1990 },
  { key: "weilheim_q", id: "16613004", kind: "fluesse/abfluss", unit: "m³/s", name: "Weilheim / Ammer", from: 1990 },
  { key: "peissenberg_q", id: "16612001", kind: "fluesse/abfluss", unit: "m³/s", name: "Peißenberg / Ammer", from: 1990 },
  { key: "oberammergau_q", id: "16610709", kind: "fluesse/abfluss", unit: "m³/s", name: "Oberammergau / Ammer", from: 1990 },
  { key: "halbammer_q", id: "16615203", kind: "fluesse/abfluss", unit: "m³/s", name: "Unternogg / Halbammer", from: 1990 },
  { key: "rott_q", id: "16625003", kind: "fluesse/abfluss", unit: "m³/s", name: "Raisting / Rott", from: 1990 },
  { key: "windach_q", id: "16646400", kind: "fluesse/abfluss", unit: "m³/s", name: "Eching / Windach", from: 1990 },
];
export const SERIES_KEYS = SERIES.map((s) => s.key);

// Plausibilitätsgrenzen (Werte außerhalb gelten als Messfehler)
export const VALID_RANGE = {
  ammersee_w: [531.5, 537],
  grafrath_w: [-20, 500],
  default_q: [0.001, 1000],
};

// Langzeit-Tageswerte Grafrath (Klimatologie, Historie seit 1964)
export const DAILY_FROM = 1964;

// Wetterpunkte (Open-Meteo, CC BY 4.0). elev = Höhe, auf die Temperatur heruntergerechnet wird.
// zone: Teileinzugsgebiet, in das der Punkt eingeht; w: Gewicht innerhalb der Zone.
export const METEO_POINTS = [
  { key: "graswang", lat: 47.575, lon: 11.03, elev: 1350, zone: "ammer", w: 0.18 }, // Ammergauer Alpen
  { key: "oberammergau", lat: 47.6, lon: 11.07, elev: 1000, zone: "ammer", w: 0.14 },
  { key: "trauchberg", lat: 47.64, lon: 10.92, elev: 1050, zone: "ammer", w: 0.16 }, // Halbammer
  { key: "rottenbuch", lat: 47.72, lon: 10.97, elev: 800, zone: "ammer", w: 0.18 },
  { key: "peissenberg", lat: 47.79, lon: 11.06, elev: 700, zone: "ammer", w: 0.18 },
  { key: "weilheim", lat: 47.84, lon: 11.14, elev: 580, zone: "ammer", w: 0.16 },
  { key: "raisting", lat: 47.9, lon: 11.08, elev: 600, zone: "see", w: 0.4 }, // Rott, Seeufer West
  { key: "ammersee", lat: 47.99, lon: 11.13, elev: 560, zone: "see", w: 0.6 }, // See + Ostufer
  { key: "windach", lat: 48.07, lon: 11.04, elev: 580, zone: "amper", w: 1.0 }, // Windach / Ampermoos
];

// Stützpunkte für Ensembles/Bias (weniger Punkte = weniger API-Last); jeder Wetterpunkt nutzt "ens"
// w = Flächengewicht am Gesamtgebiet (für den Bias-Abgleich)
export const ENS_POINTS = [
  { key: "hoch", lat: 47.6, lon: 11.0, elev: 1250, w: 0.21 },
  { key: "mitte", lat: 47.75, lon: 11.0, elev: 780, w: 0.21 },
  { key: "weilheim", lat: 47.86, lon: 11.12, elev: 580, w: 0.24 },
  { key: "ammersee", lat: 47.99, lon: 11.13, elev: 560, w: 0.17 },
  { key: "windach", lat: 48.07, lon: 11.04, elev: 580, w: 0.17 },
];
export const ENS_MAP = { graswang: 0, oberammergau: 0, trauchberg: 0, rottenbuch: 1, peissenberg: 1, weilheim: 2, raisting: 2, ammersee: 3, windach: 4 };

// Flächen (km²) laut HND-Stammdaten bzw. Differenzen
export const AREAS = {
  weilheim: 608.0, // Ammer bis Pegel Weilheim
  stegen: 993.4, // Ammersee-Ausfluss
  grafrath: 1194.6,
  ammersee: 46.6, // Seefläche
};
// Teilgebiete der Modellzonen (km²)
export const ZONE_AREAS = {
  ammer: AREAS.weilheim,
  see: AREAS.stegen - AREAS.weilheim - AREAS.ammersee, // Rott + Uferzuflüsse (ohne Seefläche)
  amper: AREAS.grafrath - AREAS.stegen, // Windach + Ampermoos
};

// Hochwasser-Kennwerte Grafrath (HND-Statistik, m³/s) und Abflusstafel (gültig seit 01.12.2023, cm -> m³/s)
export const GRAFRATH_STATS = { MHQ: 59.4, HQ1: 54, HQ2: 62, HQ5: 72, HQ10: 86, HQ20: 102, HQ50: 125, HQ100: 145, HQmax: 167 };
export const GRAFRATH_RATING = [
  [0, 0.53], [10, 1.01], [20, 1.66], [30, 2.53], [40, 3.66], [50, 5.2], [60, 7.37], [70, 10.1], [80, 13.1], [90, 16.3],
  [100, 19.7], [110, 23.2], [120, 26.7], [130, 30.3], [140, 33.9], [150, 37.7], [160, 41.5], [170, 45.4], [180, 49.3], [190, 53.3],
  [200, 57.4], [210, 61.8], [220, 66.4], [230, 71.3], [240, 76.4], [250, 81.8], [260, 87.4], [270, 93.2], [280, 99.4], [290, 106],
  [300, 112], [310, 119], [320, 126], [330, 133], [340, 140], [350, 147], [360, 154], [370, 161], [380, 169], [390, 176],
  [400, 184], [410, 192], [420, 200], [430, 209],
];

export const UA = "Mozilla/5.0 (compatible; amperwasser/1.0; Pegel-Dashboard Amper)";
