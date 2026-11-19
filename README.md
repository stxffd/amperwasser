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
| Prognose-Check | Mittlere Abweichung der Prognose in Rückrechnungen mit archivierten Wettervorhersagen und (sobald genug Daten da sind) der archivierten Live-Prognosen; im Diagramm Vergleich mit der Prognose von vor 1/3/7 Tagen |
| Oberlauf | Ammersee, Ausfluss Stegen, Ammer (Weilheim, Peißenberg, Oberammergau), Halbammer, Rott, Windach, Seepegel-Prognose, Schneehöhen |

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
| Open-Meteo Previous Runs | Damals vorliegende Vorhersagen von ECMWF IFS (Tag 0–7) und ICON (Tag 0–6) seit Feb. 2024 | Rückrechnungen mit echten Vorhersagen, Variantenwahl, Unsicherheit | CC BY 4.0 |
| [DWD Open Data](https://opendata.dwd.de) (Klimadaten, `more_precip`) | Tägliche Schneehöhe an 14 Stationen im Einzugsgebiet seit 1998 | Kalibrierung der Schneedecke, Anzeige | CC BY 4.0 |

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
5. **Kalibrierung:** Differential Evolution auf Stundenwerten 1999–2016. Ziel für die Ammer: 75 % Abfluss Weilheim (NSE von Q und √Q), 25 % Schneedecke (Wasseräquivalent an 10 DWD-Stationen, Nov.–Mai, ~30 000 Messungen). Ohne den Schnee-Term „versteckte“ das Modell fehlenden Schnee hinter einer unrealistischen Regen/Schnee-Grenze von −1,4 °C. Mit ihm liegt sie bei −0,15 °C, und die Schneeschmelze wird realistisch.
6. **Unsicherheit:** Jedes Ensemble-Member (bis zu 111 Wetterszenarien) wird durch die Modellkette gerechnet und mit der Modellfehler-Verteilung bei bekanntem Wetter kombiniert. Zu gleichen Teilen kommt der Ensemble-Median mit den Abweichungen hinzu, die in den Rückrechnungen mit echten Vorhersagen aufgetreten sind. Daraus entstehen die Quantile 10/25/50/75/90 %.
7. **Wasserstand:** aus dem Abfluss über die amtliche Abflusstafel, auf den aktuellen Messwert geeicht.

### Validierung mit gemessenem Wetter (reiner Modellfehler)

Rückrechnungen („Hindcasts“) im unabhängigen Zeitraum ab 2017, alle 36 h. Mittlere relative Abweichung des Abflusses in Grafrath:

| Vorhersagezeit | Modell | Persistenz | NSE |
|---|---|---|---|
| 6 h | 1,6 % | 1,8 % | 0,997 |
| 24 h | 3,6 % | 4,9 % | 0,989 |
| 2 Tage | 5,8 % | 8,6 % | 0,976 |
| 3 Tage | 7,6 % | 11,6 % | 0,963 |
| 5 Tage | 10,6 % | 17,0 % | 0,936 |
| 7 Tage | 12,9 % | 21,4 % | 0,916 |
| 10 Tage | 15,4 % | 27,0 % | 0,899 |
| 14 Tage | 17,7 % | 32,7 % | 0,882 |

Kalibrierung 1999–2016, 2376 Hindcasts 2017–2026. Teilmodelle: Ammer bis Weilheim KGE 0,84 (Validierung), Ammersee-Ausfluss Stegen NSE 0,95. Persistenz bedeutet „Abfluss bleibt wie jetzt“.

### Prüfung mit echten Wettervorhersagen und Variantenwahl (`scripts/verify.mjs`)

Für jeden Tag seit Feb. 2024 (992 Ausgabezeitpunkte) wird die Prognose so nachgerechnet, wie sie damals möglich gewesen wäre. Bis zum Ausgabezeitpunkt läuft das Modell mit gemessenem Wetter. Danach bekommt es die Vorhersagen, die damals tatsächlich vorlagen (Open-Meteo Previous Runs: für Vorlauftag d der Lauf von vor d Tagen; ab Tag 8 Klimatologie). Gemessen wird die mittlere Abweichung des **Wasserstands** in cm.

Getestete Varianten:

| Variante | Ergebnis |
|---|---|
| Kalibrierung mit Schneehöhen (statt nur Abfluss) | **besser** in beiden Zeiträumen (Frühjahr: 4,97 → 4,77 cm) → übernommen |
| Täglicher Schnee-Abgleich mit DWD-Schneehöhen (7 Varianten: einmalig/täglich, Stärke, Schneedichte) | in allen Varianten schlechter → nicht verwendet |
| Niederschlag der Vorhersage Tag 1–3 skaliert (0,4–1,2) | ×0,9 besser → übernommen |
| Niederschlag Tag 4–8 skaliert | keine Verbesserung |
| Gewichtung ICON/ECMWF (0–100 %) | keine Verbesserung gegenüber 54 % ICON |
| Abklingzeiten der Fehlerkorrektur | keine Verbesserung |

Eine Änderung wird nur übernommen, wenn sie in **beiden** Hälften des Zeitraums (Feb. 2024 – Aug. 2025 und Sep. 2025 – Nov. 2026) besser ist. Im ersten Versuch ohne diese Regel waren die auf der ersten Hälfte optimierten Einstellungen in der zweiten Hälfte schlechter als vorher.

Ergebnis (mittlere Abweichung Wasserstand):

| Vorhersage für | neu | erste Version | „bleibt wie jetzt“ |
|---|---|---|---|
| 24 h | 1,8 cm | 1,9 cm | 2,9 cm |
| 3 Tage | 3,8 cm | 4,2 cm | 6,7 cm |
| 5 Tage | 5,5 cm | 6,0 cm | 9,9 cm |
| 7 Tage | 7,2 cm | 7,8 cm | 12,5 cm |
| 14 Tage | 12,8 cm | 13,3 cm | 18,4 cm |

Mittel über alle Vorlaufzeiten: 5,80 → 5,47 cm (erste Hälfte), 4,85 → 4,59 cm (zweite Hälfte).

### Live-Prognosearchiv

Alle ~6 h wird die veröffentlichte Prognose archiviert (`data/archive.json` auf der Seite, monatliche Sicherung in `data/archive/forecasts.json`) und später mit dem gemessenen Wasserstand verglichen. Die Seite zeigt diese Live-Güte, sobald je Vorlaufzeit mindestens 20 Prognosen geprüft werden können. Im Diagramm lässt sich die Prognose von vor 1, 3 oder 7 Tagen einblenden.

## Betrieb

| Workflow | Zeitplan | Aufgabe |
|---|---|---|
| `update.yml` | stündlich :17 | aktuelle Pegel (GKD) + Wetter/Ensembles (Open-Meteo) holen, Prognose rechnen, `site/` auf Pages veröffentlichen |
| `maintain.yml` | monatlich (3., 02:40 UTC) | Historie, Schneehöhen und archivierte Vorhersagen nachführen, Prognosearchiv sichern, neu kalibrieren, Varianten mit Reforecasts prüfen (`verify.mjs`), committen. Hält auch die Zeitpläne aktiv. |

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
node scripts/fetch-history.mjs snow --historical
node scripts/fetch-history.mjs reforecast

node scripts/calibrate.mjs          # Kalibrierung + Hindcasts -> data/model/params.json, skill.json
node scripts/verify.mjs             # Reforecast-Prüfung + Variantenwahl -> forecast_config.json, verify.json
node scripts/update.mjs --local     # Live-Prognose -> site/data/ (--local: Archiv der Seite darf fehlen)
node scripts/serve.mjs              # http://localhost:8080/
```

## Ausbauplan

Umgesetzt (Stufe 1–3):

- [x] Datenpipeline GKD/HND inkl. Historie seit 1964, Zeitumstellung, Lücken
- [x] Physikalisches Modell Ammer → Ammersee → Amper, kalibriert und validiert
- [x] Multi-Modell-Ensemble mit Bias-Korrektur je Wettermodell, Modellfehler aus Hindcasts
- [x] Statische Website mit stündlicher Aktualisierung

Mögliche nächste Schritte, sortiert nach erwartetem Nutzen:

- [x] Prognose-Archiv & Verifikation, Rückrechnungen mit echten Vorhersagen, Variantenwahl
- [x] Schneedecke: Kalibrierung mit DWD-Schneehöhen (täglicher Abgleich getestet, nicht hilfreich)

1. **Spanne aus dem Live-Archiv nachkalibrieren**, sobald einige Monate archiviert sind (Ziel: 80 % der Messwerte in der 80-%-Spanne).
2. **Stationsniederschlag statt ERA5 für die Vergangenheit** (DWD-Tageswerte im Einzugsgebiet): genauerer Modellzustand zum Prognosestart.
3. **Radar-Nowcasting** (DWD RADOLAN/RADVOR) für Starkregen in den ersten 2 Stunden. Für Grafrath wegen der Seedämpfung meist wenig relevant, für die Windach eher.
4. **Langfrist-Ausblick** (4–6 Wochen) aus ECMWF-Extended-Range oder GloFAS. Sinnvoll vor allem für den Seepegel.
5. **Benachrichtigung** (z. B. ntfy/Telegram), wenn die Prognose Schwellen überschreitet.

## Hinweise

Dies ist **keine amtliche Hochwasserwarnung**. Maßgeblich sind die Meldungen des [Hochwassernachrichtendienstes Bayern](https://www.hnd.bayern.de). Rohdaten sind ungeprüft.

Datenquellen: Bayerisches Landesamt für Umwelt, [www.lfu.bayern.de](https://www.lfu.bayern.de) (CC BY 4.0); Wetterdaten von [Open-Meteo.com](https://open-meteo.com) (CC BY 4.0) auf Basis von DWD, ECMWF und Copernicus ERA5.

Diagramme: [uPlot](https://github.com/leeoniya/uPlot) (MIT).

## Lizenz

Der Programmcode steht unter der [MIT-Lizenz](LICENSE). Die Daten in `data/` stammen vom LfU Bayern, vom DWD und von Open-Meteo und stehen unter [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de); Einzelheiten in [data/LICENSE.md](data/LICENSE.md).
