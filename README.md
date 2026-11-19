# Amperwasser – Amper in Grafrath

Wasserstand und Abfluss der Amper am Pegel **Grafrath** (Messstelle 16603000): aktuell, historisch seit 1964 und als **14-Tage-Prognose mit Unsicherheitsbereich**.

**Website:** https://stxffd.github.io/amperwasser/

Die Seite wird stündlich von GitHub Actions neu gerechnet und auf GitHub Pages veröffentlicht. Server und Datenbank gibt es nicht.

---

## Was die Seite zeigt

| Bereich | Inhalt |
|---|---|
| Kacheln | Abfluss, Wasserstand (mit 24-h-Änderung), Einordnung gegenüber der Jahreszeit (Perzentil seit 1964, HQ-Schwellen), Prognose-Tendenz 3 Tage |
| Verlauf | Messung + Prognose (Median, 50 %- und 80 %-Bereich), umschaltbar Abfluss/Wasserstand und Prognose / 30 Tage / 1 Jahr (mit „üblichem Bereich“) / seit 1964 |
| Niederschlag | Gebietsniederschlag der letzten 7 Tage und Ensemble-Vorhersage |
| Prognose nach Tagen | Tagesmittel mit Spanne, Niederschlag |
| Oberlauf | Ammersee, Ausfluss Stegen, Ammer (Weilheim, Peißenberg, Oberammergau), Halbammer, Rott, Windach, Seepegel-Prognose |

## Hydrologischer Hintergrund

```
Ammergauer Alpen ──► Ammer (Oberammergau → Peißenberg → Weilheim, 608 km²) ─┐
Halbammer, Rott, Uferzuflüsse (339 km²) ────────────────────────────────────┤
                                                                            ▼
                                                   Ammersee (46,6 km², Pegel Stegen)
                                                                            │  Ausfluss Stegen/Amper (993 km²)
Windach (128 km²), Ampermoos ─────────────────────────────────────────────┤  6,35 km
                                                                            ▼
                                                      Pegel Grafrath / Amper (1 194,6 km²)
```

Der Ammersee ist der Schlüssel zur Prognose. Er dämpft Hochwasserwellen der Ammer und verzögert sie um Tage. Sein Pegel wird gemessen, deshalb ist der Abfluss in Grafrath für die nächsten Tage gut vorhersagbar. Unsicher wird es erst durch künftigen Niederschlag, und den deckt das Wetter-Ensemble ab.

## Datenquellen

| Quelle | Daten | Nutzung | Lizenz |
|---|---|---|---|
| [Gewässerkundlicher Dienst Bayern](https://www.gkd.bayern.de) (LfU) | 15-min-Werte aller Pegel, Grafrath seit 1964, Oberlieger ab 1990 | Historie, aktuelle Werte, Kalibrierung | CC BY 4.0 |
| [Hochwassernachrichtendienst Bayern](https://www.hnd.bayern.de) (LfU) | Abflusstafel Grafrath (gültig seit 12/2023), HQ-Statistik, Stammdaten | W↔Q-Umrechnung, Schwellen | CC BY 4.0 |
| [Open-Meteo](https://open-meteo.com) Archiv (ERA5/ERA5-Land) | Stündlich Niederschlag, Temperatur, ET0 an 9 Punkten im Einzugsgebiet seit 1998 | Kalibrierung, Modell-Warmlauf | CC BY 4.0 |
| Open-Meteo Forecast (`best_match`: ICON-D2 → ICON-EU → …) | Letzte Tage + 16 Tage Vorhersage | Lücke bis heute, ET0 | CC BY 4.0 |
| Open-Meteo Ensemble | ICON-D2-EPS (20 Member, 2 Tage), ICON-EU-EPS (40, 5 Tage), ECMWF-ENS (51, 15 Tage) | Prognose-Szenarien | CC BY 4.0 |
| Open-Meteo Historical Forecast | Archivierte ICON/ECMWF-Läufe | Niederschlags-Bias je Modell gegenüber ERA5 | CC BY 4.0 |

Die verwendeten Pegel:

| Messstelle | Nr. | Rolle |
|---|---|---|
| Grafrath / Amper | 16603000 | Zielpegel (W, Q) |
| Stegen / Amper | 16602303 | Ammersee-Ausfluss |
| Stegen / Ammersee | 16602008 | Seepegel (Startwert der Seebilanz) |
| Weilheim / Ammer | 16613004 | Hauptzufluss, Fehlerkorrektur |
| Peißenberg, Oberammergau / Ammer; Unternogg / Halbammer | 16612001, 16610709, 16615203 | Oberlauf (Anzeige, Plausibilisierung) |
| Raisting / Rott | 16625003 | seitlicher Seezufluss |
| Eching / Windach | 16646400 | Zwischengebiet |

## Prognosemodell

Das Modell ist physikalisch aufgebaut statt als reine Blackbox. Es kann so auch Hochwasser extrapolieren, die im Trainingszeitraum selten sind.

1. **Niederschlag-Abfluss (HBV-Ansatz, stündlich)** für drei Teilgebiete: Ammer bis Weilheim, Seezuflüsse, Zwischengebiet Stegen–Grafrath.
   * Schnee: Gradtagverfahren je Wetterpunkt. Die Temperatur wird auf die Höhe des Punktes gerechnet (560–1350 m), das ist für Schneeschmelze und Regen-auf-Schnee in den Ammergauer Alpen wichtig.
   * Boden (Feldkapazität, Verdunstung aus ET0), oberer/unterer Speicher, Dreiecks-Routing.
2. **Ammersee-Wasserbilanz:** Ammer (Fließzeit kalibriert) + Seezuflüsse + Niederschlag − Verdunstung auf der Seefläche. Der Ausfluss folgt der Kennlinie `Q = a·(H − h0)^b`, gefittet aus Seepegel und Abfluss Stegen der letzten 12 Jahre, mit Monatsfaktoren für die Verkrautung.
3. **Grafrath** = Ausfluss Stegen (Fließzeit aus Kreuzkorrelation) + Zwischengebiet.
4. **Datenassimilation bei jedem Lauf:**
   * Die Seebilanz startet am gemessenen Seepegel.
   * Die Ausfluss-Kennlinie wird auf den aktuell gemessenen Ausfluss geeicht.
   * Abweichungen bei Weilheim und Grafrath werden mit kalibrierter Abklingzeit korrigiert.
5. **Kalibrierung:** Differential Evolution auf Stundenwerten 1999–2016 (Ziel: NSE von Q und √Q).
6. **Unsicherheit:** Jedes Ensemble-Member (bis zu 111 Wetterszenarien) wird durch die Modellkette gerechnet. Jede Trajektorie wird dann mit der empirischen Fehlerverteilung aus den Rückrechnungen kombiniert. Daraus entstehen die Quantile 10/25/50/75/90 %.
7. **Wasserstand:** aus dem Abfluss über die amtliche Abflusstafel, auf den aktuellen Messwert geeicht.

### Validierung

Rückrechnungen („Hindcasts“) im unabhängigen Zeitraum ab 2017, alle 36 h, mit gemessenem Wetter. Mittlere relative Abweichung des Abflusses in Grafrath:

| Vorhersagezeit | Modell | Persistenz | NSE |
|---|---|---|---|
| 6 h | 1,7 % | 1,8 % | 0,997 |
| 24 h | 3,6 % | 4,9 % | 0,988 |
| 2 Tage | 6,0 % | 8,6 % | 0,973 |
| 3 Tage | 7,9 % | 11,6 % | 0,960 |
| 5 Tage | 11,1 % | 17,0 % | 0,927 |
| 7 Tage | 13,6 % | 21,4 % | 0,899 |
| 10 Tage | 16,3 % | 27,0 % | 0,875 |
| 14 Tage | 18,8 % | 32,7 % | 0,855 |

Kalibrierung 1999–2016, 2376 Hindcasts 2017–2026. Teilmodelle: Ammer bis Weilheim KGE 0,83 (Validierung), Ammersee-Ausfluss Stegen NSE 0,95.

Persistenz bedeutet „Abfluss bleibt wie jetzt“. Mit echter Wettervorhersage kommt Unsicherheit dazu, die über das Ensemble abgebildet wird.

## Betrieb

| Workflow | Zeitplan | Aufgabe |
|---|---|---|
| `update.yml` | stündlich :17 | aktuelle Pegel (GKD) + Wetter/Ensembles (Open-Meteo) holen, Prognose rechnen, `site/` auf Pages veröffentlichen |
| `maintain.yml` | monatlich (3., 02:40 UTC) | Historie nachführen, neu kalibrieren, committen. Hält auch die Zeitpläne aktiv. |

Die Historie liegt als CSV je Jahr in `data/history/` (Stundenwerte UTC). Pro Monat ändert sich nur die Datei des laufenden Jahres. Live-Daten werden nicht committet, sie landen direkt im Pages-Artefakt.

Ein stündlicher Lauf verbraucht bei Open-Meteo etwa 150 von 10 000 freien API-Calls pro Tag. Fällt ein Ensemble aus, rechnet die Seite mit den übrigen weiter, notfalls nur deterministisch mit Modellfehler-Band.

## Lokal ausführen

Benötigt Node.js ≥ 20, keine Abhängigkeiten.

```bash
# Historie (einmalig, dauert wegen Drosselung ~1,5 h für das Wetterarchiv)
node scripts/fetch-history.mjs gauges --from 1990
node scripts/fetch-history.mjs daily
node scripts/fetch-history.mjs meteo --from 1998
node scripts/fetch-history.mjs bias

node scripts/calibrate.mjs          # Kalibrierung + Hindcasts -> data/model/
node scripts/update.mjs             # Live-Prognose -> site/data/
node scripts/serve.mjs              # http://localhost:8080/
```

## Ausbauplan

Umgesetzt (Stufe 1–3):

- [x] Datenpipeline GKD/HND inkl. Historie seit 1964, Zeitumstellung, Lücken
- [x] Physikalisches Modell Ammer → Ammersee → Amper, kalibriert und validiert
- [x] Multi-Modell-Ensemble mit Bias-Korrektur je Wettermodell, Modellfehler aus Hindcasts
- [x] Statische Website mit stündlicher Aktualisierung

Mögliche nächste Schritte, sortiert nach erwartetem Nutzen:

1. **Prognose-Archiv & Verifikation im Betrieb:** jede ausgegebene Prognose speichern (z. B. wöchentlich gebündelt) und die echte Güte inkl. Wetterunsicherheit messen. Auf dieser Basis lässt sich die Spanne nachkalibrieren (Quantil-Regression/EMOS).
2. **Radar-Nowcasting** (DWD RADOLAN/RADVOR) für Starkregen in den ersten 2 Stunden. Für Grafrath wegen der Seedämpfung meist wenig relevant, für die Windach eher.
3. **Schneedecke assimilieren** (HND-Schneemessstellen, DWD SNOW4): bessere Prognosen bei Schneeschmelze im Frühjahr.
4. **Langfrist-Ausblick** (4–6 Wochen) aus ECMWF-Extended-Range oder GloFAS. Sinnvoll vor allem für den Seepegel.
5. **Benachrichtigung** (z. B. ntfy/Telegram), wenn die Prognose Schwellen überschreitet.

## Hinweise

Dies ist **keine amtliche Hochwasserwarnung**. Maßgeblich sind die Meldungen des [Hochwassernachrichtendienstes Bayern](https://www.hnd.bayern.de). Rohdaten sind ungeprüft.

Datenquellen: Bayerisches Landesamt für Umwelt, [www.lfu.bayern.de](https://www.lfu.bayern.de) (CC BY 4.0); Wetterdaten von [Open-Meteo.com](https://open-meteo.com) (CC BY 4.0) auf Basis von DWD, ECMWF und Copernicus ERA5.

Diagramme: [uPlot](https://github.com/leeoniya/uPlot) (MIT).
