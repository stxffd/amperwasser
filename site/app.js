/* Amper Grafrath – Frontend (vanilla JS + uPlot) */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const HOUR = 3600e3, DAY = 24 * HOUR;
  const TZ = "Europe/Berlin";
  const state = { param: "w", range: "fc", cmp: 0 };
  let L = null, Hs = null, V = null; // latest.json, history.json, verify.json
  let charts = [];

  // ---------- Formatierung ----------
  const nf = (d) => new Intl.NumberFormat("de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
  const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);
  const fq = (v) => (v == null || !isFinite(v) ? "–" : v >= 10 ? NF1.format(v) : NF2.format(v));
  const fw = (v) => (v == null || !isFinite(v) ? "–" : NF0.format(v));
  const fmt = (p) => (p === "q" ? fq : fw);
  const unit = (p) => (p === "q" ? "m³/s" : "cm");
  const dtf = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const df = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const dshort = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "numeric", month: "numeric" });
  const tf = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const sign = (v, f) => {
    const s = f(Math.abs(v));
    return (/^0([,.]0+)?$/.test(s) ? "±" : v > 0 ? "+" : "−") + s;
  };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Abflusstafel Grafrath (cm -> m³/s), für HQ-Linien im Wasserstand
  const RATING = [[0,0.53],[10,1.01],[20,1.66],[30,2.53],[40,3.66],[50,5.2],[60,7.37],[70,10.1],[80,13.1],[90,16.3],[100,19.7],[110,23.2],[120,26.7],[130,30.3],[140,33.9],[150,37.7],[160,41.5],[170,45.4],[180,49.3],[190,53.3],[200,57.4],[210,61.8],[220,66.4],[230,71.3],[240,76.4],[250,81.8],[260,87.4],[270,93.2],[280,99.4],[290,106],[300,112],[310,119],[320,126],[330,133],[340,140],[350,147],[360,154],[370,161],[380,169],[390,176],[400,184],[410,192],[420,200],[430,209]];
  const wFromQ = (q) => {
    for (let i = 1; i < RATING.length; i++) if (q <= RATING[i][1]) {
      const [w0, q0] = RATING[i - 1], [w1, q1] = RATING[i];
      return w0 + ((w1 - w0) * (q - q0)) / (q1 - q0);
    }
    return RATING.at(-1)[0];
  };

  // ---------- Laden ----------
  async function load() {
    const get = (f) => fetch(`data/${f}`, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(f + ": " + r.status); return r.json(); });
    try {
      [L, Hs, V] = await Promise.all([get("latest.json"), get("history.json"), get("verify.json").catch(() => null)]);
    } catch (e) {
      $("stand").textContent = "Daten konnten nicht geladen werden.";
      console.error(e);
      return;
    }
    renderTiles();
    renderTables();
    renderCheck();
    renderCharts();
  }

  // ---------- Prognose-Check ----------
  const leadName = (h) => (h < 48 ? (h === 24 ? "morgen (24 h)" : `${h} h`) : `in ${h / 24} Tagen`);
  const monthYear = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, month: "short", year: "numeric" });
  function renderCheck() {
    const hc = V?.hindcast;
    if (!hc?.table) return;
    $("check").hidden = false;
    const live = V.live;
    const liveOk = live?.table?.some((r) => r.n >= 20);
    $("check-intro").textContent =
      `Für jeden Tag von ${monthYear.format(Date.parse(hc.period[0]))} bis ${monthYear.format(Date.parse(hc.period[1]))} wurde die Prognose so nachgerechnet, wie sie damals möglich gewesen wäre – mit den Wettervorhersagen, die zu dem Zeitpunkt vorlagen. Mittlere Abweichung des Wasserstands:`;
    $("check-live-h").textContent = liveOk ? `Live seit ${monthYear.format(live.since)}` : "Live-Prognosen";
    const tb = $("check-table").querySelector("tbody");
    tb.replaceChildren();
    for (const r of hc.table) {
      if (![24, 72, 168, 336].includes(r.lead_h)) continue;
      const lv = live?.table?.find((x) => x.lead_h === r.lead_h);
      const tr = document.createElement("tr");
      tr.append(
        td(leadName(r.lead_h)),
        td(`± ${NF0.format(r.mae_w)} cm`, "num" + (r.mae_w < r.mae_w_pers ? " good" : "")),
        td(`± ${NF0.format(r.mae_w_pers)} cm`, "num"),
        td(lv && lv.n >= 20 ? `± ${NF0.format(lv.mae_w)} cm · ${NF0.format(lv.cover80 * 100)} % in Spanne` : "noch zu wenige", "num range")
      );
      tb.append(tr);
    }
    const hv = hc.halves;
    const n = live?.archived ?? 0;
    const imp = hv ? hc.table.reduce((a, r) => a + r.mae_w_before, 0) / hc.table.reduce((a, r) => a + r.mae_w, 0) - 1 : 0;
    $("check-note").textContent =
      (hv && imp > 0.005 ? `Die Kalibrierung mit gemessenen Schneehöhen und die Optimierung verringern die Abweichung im Mittel um ${NF0.format(imp * 100)} % – geprüft getrennt für beide Hälften des Zeitraums (${NF1.format(hv.before[0])} → ${NF1.format(hv.after[0])} cm und ${NF1.format(hv.before[1])} → ${NF1.format(hv.after[1])} cm). ` : "") +
      `Jede veröffentlichte Prognose wird archiviert und später mit dem Gemessenen verglichen` +
      (n ? ` (bisher ${n} Prognosen).` : ".");
  }

  // ---------- Kacheln ----------
  function trendText(d, f, u, base) {
    if (d == null) return "&nbsp;";
    if (Math.abs(d) < Math.max(0.01 * base, u === "cm" ? 1 : 0.05)) return "→ gleich wie vor 24 h";
    return `${d > 0 ? "▲" : "▼"} ${sign(d, f)} ${u} in 24 h`;
  }
  function renderTiles() {
    const c = L.current, s = L.stats;
    $("stand").textContent = `Pegel Grafrath · Messwert ${dtf.format(c.t)} Uhr`;
    $("q-now").textContent = fq(c.q);
    $("w-now").textContent = fw(c.w);
    $("q-delta").innerHTML = trendText(c.dq24, (v) => (c.q >= 10 ? NF1 : NF2).format(v), "m³/s", c.q);
    $("w-delta").innerHTML = trendText(c.dw24, fw, "cm", 100);

    // Einordnung
    let label = "–", sub = "";
    const p = c.percentile;
    if (c.q >= s.HQ5) label = "Hochwasser";
    else if (c.q >= s.HQ1) label = "Erhöht (über HQ1)";
    else if (p != null) label = p < 0.1 ? "Sehr niedrig" : p < 0.25 ? "Niedrig" : p <= 0.75 ? "Normal" : p <= 0.9 ? "Erhöht" : "Hoch";
    if (p != null) sub = `Mehr Wasser als an ${Math.round(p * 100)} % der Tage um diese Jahreszeit (${s.climYears[0]}–${s.climYears[1]})`;
    $("class-label").textContent = label;
    $("class-sub").textContent = sub;

    // Prognose-Tendenz (Median nach 72 h)
    const f = L.forecast, k = Math.min(71, f.q[2].length - 1);
    const med = f.q[2][k];
    const r = med / c.q;
    const tr = r > 1.15 ? "Steigend" : r > 1.05 ? "Leicht steigend" : r < 0.87 ? "Fallend" : r < 0.95 ? "Leicht fallend" : "Gleichbleibend";
    $("fc-label").textContent = tr;
    $("fc-sub").textContent = `in 3 Tagen ca. ${fw(f.w[2][k])} cm (${fw(f.w[0][k])}–${fw(f.w[4][k])})`;

    // Hinweise: veraltete Daten / mögliche Überschreitung HQ1
    const msgs = [];
    const age = (Date.now() - c.t) / HOUR;
    if (age > 3) msgs.push([`Der letzte Messwert ist ${Math.round(age)} Stunden alt.`, false]);
    const maxMed = Math.max(...f.q[2]), maxHi = Math.max(...f.q[4]);
    if (maxMed >= s.HQ1) msgs.push([`⚠ Die Prognose erwartet Abflüsse über HQ1 (${s.HQ1} m³/s). Bitte die amtlichen Meldungen des HND beachten.`, true]);
    else if (maxHi >= s.HQ1) msgs.push([`⚠ In ungünstigen Szenarien kann der Abfluss in den nächsten 14 Tagen HQ1 (${s.HQ1} m³/s) erreichen.`, false]);
    const al = $("alert");
    if (msgs.length) {
      al.hidden = false;
      al.textContent = msgs.map((m) => m[0]).join(" ");
      al.classList.toggle("crit", msgs.some((m) => m[1]));
    }
    $("gen").textContent = `Aktualisiert ${dtf.format(L.generated)} Uhr · Modell kalibriert ${new Date(L.calibrated).toLocaleDateString("de-DE")}`;
  }

  // ---------- Tabellen ----------
  function td(text, cls) { const e = document.createElement("td"); e.textContent = text; if (cls) e.className = cls; return e; }
  function renderTables() {
    const tb = $("fc-table").querySelector("tbody");
    tb.replaceChildren();
    for (const d of L.forecast.days) {
      const tr = document.createElement("tr");
      const date = Date.parse(d.date + "T12:00Z");
      tr.append(
        td(dshort.format(date)),
        td(fw(d.w[1]), "num"), td(`${fw(d.w[0])}–${fw(d.w[2])}`, "num range"),
        td(fq(d.q[1]), "num"), td(`${fq(d.q[0])}–${fq(d.q[2])}`, "num range"),
        td(d.p < 0.1 ? "–" : `${NF1.format(d.p)}${d.p90 > d.p * 1.5 && d.p90 >= 1 ? ` (bis ${NF0.format(d.p90)})` : ""}`, "num")
      );
      tb.append(tr);
    }
    const ub = $("up-table").querySelector("tbody");
    ub.replaceChildren();
    const order = ["ammersee_w", "stegen_q", "weilheim_q", "peissenberg_q", "oberammergau_q", "halbammer_q", "rott_q", "windach_q"];
    for (const key of order) {
      const s = L.upstream.find((u) => u.key === key);
      if (!s) continue;
      const tr = document.createElement("tr");
      const isLake = key === "ammersee_w";
      const val = s.value == null ? "–" : isLake ? `${NF2.format(s.value)} m NHN` : `${fq(s.value)} m³/s`;
      const d = s.delta24 == null ? "–" : isLake ? `${sign(s.delta24 * 100, (v) => NF0.format(v))} cm` : sign(s.delta24, fq);
      tr.append(td(s.name), td(val, "num"), td(d, "num"), td(s.t ? tf.format(s.t) : "–", "num"));
      ub.append(tr);
    }
    // Seepegel-Prognose als Zusatzzeile
    const lk = L.forecast.lake;
    if (lk && lk[1].length > 72) {
      const h0 = L.upstream.find((u) => u.key === "ammersee_w")?.value;
      if (h0 != null) {
        const tr = document.createElement("tr");
        const d3 = (lk[1][71] - h0) * 100, d7 = (lk[1][Math.min(167, lk[1].length - 1)] - h0) * 100;
        tr.append(td("Ammersee – Prognose"), td(`3 T: ${sign(d3, (v) => NF0.format(v))} cm`, "num"), td(`7 T: ${sign(d7, (v) => NF0.format(v))} cm`, "num"), td("Median", "num"));
        ub.append(tr);
      }
    }
    // Gütetabelle
    const sb = $("skill-table").querySelector("tbody");
    sb.replaceChildren();
    for (const s of L.skill || []) {
      if (![24, 72, 168, 336].includes(s.lead_h)) continue;
      const tr = document.createElement("tr");
      tr.append(td(s.lead_h < 48 ? `${s.lead_h} h` : `${s.lead_h / 24} Tage`), td(`± ${NF1.format(s.mape_model)} %`, "num"), td(`± ${NF1.format(s.mape_persistence)} %`, "num"));
      sb.append(tr);
    }
    // Schneehöhen
    for (const s of L.snow?.stations || []) {
      if (s.cm == null) continue;
      const tr = document.createElement("tr");
      const age = Math.round((Date.now() - Date.parse(s.date + "T06:00Z")) / DAY);
      tr.append(td(`Schneehöhe ${s.name} (${NF0.format(s.elev)} m)`), td(`${NF0.format(s.cm)} cm`, "num"), td("", "num"), td(age <= 0 ? "heute" : age === 1 ? "gestern" : dshort.format(Date.parse(s.date + "T06:00Z")), "num"));
      ub.append(tr);
    }
    if (L.forecast.models?.length) $("about-models").textContent = L.forecast.models.join(", ") + ` (${L.forecast.members} Szenarien)`;
    $("about-snow").textContent = `${L.snow?.assim ? `täglicher Abgleich aktiv: ${L.snow.assim}; ` : ""}im Modell derzeit gespeichert im Ammergebiet: ca. ${NF0.format(L.snow?.swe ?? 0)} mm Wasser`;
    const ch = V?.hindcast?.chosen;
    if (ch) $("about-chosen").textContent = `täglicher Schnee-Abgleich: ${ch.snow}; Gewicht ICON ${NF0.format(ch.wIcon * 100)} %, ECMWF ${NF0.format((1 - ch.wIcon) * 100)} % (Tag 1–5); Niederschlag ×${NF1.format(ch.fS)} (Tag 1–3), ×${NF1.format(ch.fM)} (Tag 4–8)`;
  }

  // ---------- Diagramm-Daten ----------
  function hourlyView(param, days) {
    const r = L.recent, f = L.forecast;
    const obs = param === "q" ? r.q : r.w;
    const bands = param === "q" ? f.q : f.w;
    const xs = [], o = [], m = [], p10 = [], p90 = [], p25 = [], p75 = [];
    const start = f.t0 - days * DAY;
    for (let i = 0; i < obs.length; i++) {
      const t = r.t0 + i * r.step;
      if (t < start) continue;
      xs.push(t / 1e3); o.push(obs[i]); m.push(null); p10.push(null); p90.push(null); p25.push(null); p75.push(null);
    }
    // Anschluss Prognose an letzten Messwert
    const last = o.length - 1;
    if (last >= 0) { m[last] = o[last]; p10[last] = p90[last] = p25[last] = p75[last] = o[last]; }
    for (let i = 0; i < bands[2].length; i++) {
      xs.push((f.t0 + i * f.step) / 1e3); o.push(null);
      m.push(bands[2][i]); p10.push(bands[0][i]); p90.push(bands[4][i]); p25.push(bands[1][i]); p75.push(bands[3][i]);
    }
    // Frühere Prognose (Median, 6-h-Schritte) zum Vergleich
    const cmp = xs.map(() => null);
    const pf = state.cmp ? pastFc(state.cmp) : null;
    if (pf) {
      const vals = param === "q" ? pf.q : pf.w;
      const pos = new Map(xs.map((x, k) => [Math.round(x), k]));
      vals.forEach((v, j) => { const k = pos.get(Math.round((pf.t + (j + 1) * pf.step) / 1e3)); if (k != null) cmp[k] = v; });
    }
    return { xs, data: [xs, o, m, p10, p90, p25, p75, cmp], now: L.forecast.t0 - HOUR, pf };
  }
  const pastFc = (d) => V?.past?.find((p) => p.days === d) || null;

  function precipView(xs) {
    const pp = L.precipPast, f = L.forecast;
    const past = [], fc = [], fc90 = [];
    const pm = new Map(pp.p.map((v, i) => [Math.round((pp.t0 + i * pp.step) / 1e3), v]));
    const fm = new Map(f.precip.p50.map((v, i) => [Math.round((f.t0 + i * f.step) / 1e3), i]));
    for (const x of xs) {
      const a = pm.get(Math.round(x)), j = fm.get(Math.round(x));
      past.push(a ?? null);
      fc.push(j != null ? f.precip.p50[j] : null);
      fc90.push(j != null ? f.precip.p90[j] : null);
    }
    return [xs, past, fc, fc90];
  }

  const dayIdx = (iso) => Math.round((Date.parse(iso + "T00:00Z") - Date.parse(Hs.start + "T00:00Z")) / DAY);
  const doyOf = (ms) => { const d = new Date(ms); return Math.min(365, Math.floor((ms - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY)); };

  function dailyView(param, days) {
    const vals = param === "q" ? Hs.q : Hs.w;
    const clim = param === "q" ? Hs.clim.q : Hs.clim.w; // [min,p10,p25,p50,p75,p90,max][doy]
    const t0 = Date.parse(Hs.start + "T00:00Z");
    const n = vals.length;
    const from = days ? Math.max(0, n - days) : 0;
    const xs = [], o = [], c10 = [], c25 = [], c50 = [], c75 = [], c90 = [], fm = [], f10 = [], f90 = [];
    const withClim = !!days;
    for (let i = from; i < n; i++) {
      const t = t0 + i * DAY + 12 * HOUR;
      xs.push(t / 1e3); o.push(vals[i]);
      const k = doyOf(t);
      c10.push(withClim ? clim[1][k] : null); c25.push(withClim ? clim[2][k] : null); c50.push(withClim ? clim[3][k] : null);
      c75.push(withClim ? clim[4][k] : null); c90.push(withClim ? clim[5][k] : null);
      fm.push(null); f10.push(null); f90.push(null);
    }
    if (days) {
      // Prognose-Tagesmittel anhängen
      const lastT = xs.at(-1) * 1e3;
      if (o.length) { fm[fm.length - 1] = o.at(-1); f10[f10.length - 1] = o.at(-1); f90[f90.length - 1] = o.at(-1); }
      for (const d of L.forecast.days) {
        const t = Date.parse(d.date + "T12:00Z");
        if (t <= lastT) continue;
        const b = param === "q" ? d.q : d.w;
        const k = doyOf(t);
        xs.push(t / 1e3); o.push(null);
        c10.push(clim[1][k]); c25.push(clim[2][k]); c50.push(clim[3][k]); c75.push(clim[4][k]); c90.push(clim[5][k]);
        fm.push(b[1]); f10.push(b[0]); f90.push(b[2]);
      }
    }
    return { xs, data: [xs, o, fm, f10, f90, c10, c90, c25, c75, c50], now: L.current.t };
  }

  // ---------- uPlot-Konfiguration ----------
  const DE = {
    MMMM: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
    MMM: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
    WWWW: ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"],
    WWW: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"],
  };
  const fd = (tpl) => uPlot.fmtDate(tpl, DE);
  // [Tick-Abstand (s), Standardformat, Wechsel Jahr, Monat, Tag, Stunde, Minute, Sekunde, Modus]
  const xValues = [
    [3600 * 24 * 365, "{YYYY}", null, null, null, null, null, null, 1],
    [3600 * 24 * 28, "{MMM}", "\n{YYYY}", null, null, null, null, null, 1],
    [3600 * 24, "{WWW} {D}.{M}.", "\n{YYYY}", null, null, null, null, null, 1],
    [3600, "{HH}:{mm}", "\n{D}.{M}.{YY}", null, "\n{WWW} {D}.{M}.", null, null, null, 1],
  ];

  function hqLines(param) {
    const s = L.stats;
    const ls = [["HQ1", s.HQ1], ["HQ5", s.HQ5], ["HQ10", s.HQ10], ["HQ100", s.HQ100]];
    return ls.map(([n, q]) => ({ label: n, v: param === "q" ? q : wFromQ(q), q }));
  }

  // Plugin: Referenzlinien (HQ) und "jetzt"-Marke
  function refPlugin(param, nowMs) {
    return {
      hooks: {
        draw: (u) => {
          const ctx = u.ctx, { left, top, width, height } = u.bbox;
          const dpr = devicePixelRatio || 1;
          ctx.save();
          ctx.font = `${12 * dpr}px system-ui, sans-serif`;
          const ymax = u.scales.y.max;
          for (const h of hqLines(param)) {
            if (h.v > ymax) continue;
            const y = Math.round(u.valToPos(h.v, "y", true)) + 0.5;
            ctx.strokeStyle = css("--axis"); ctx.lineWidth = dpr;
            ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
            ctx.fillStyle = css("--ink-2"); ctx.textAlign = "left"; ctx.textBaseline = "bottom";
            const lbl = param === "q" ? `${h.label} · ${fq(h.q)} m³/s` : `${h.label} · ca. ${fw(h.v)} cm`;
            ctx.fillText(lbl, left + 4 * dpr, y - 2 * dpr);
          }
          if (nowMs) {
            const x = Math.round(u.valToPos(nowMs / 1e3, "x", true)) + 0.5;
            if (x > left && x < left + width) {
              ctx.strokeStyle = css("--muted"); ctx.lineWidth = dpr;
              ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
              ctx.fillStyle = css("--ink-2"); ctx.textAlign = "left"; ctx.textBaseline = "top";
              ctx.fillText("jetzt", x + 4 * dpr, top + 2 * dpr);
            }
          }
          ctx.restore();
        },
      },
    };
  }

  // Plugin: Tooltip (alle Serien am Cursor)
  function tipPlugin(rowsFn) {
    const tip = $("tip");
    return {
      hooks: {
        setCursor: (u) => {
          const i = u.cursor.idx;
          if (i == null || u.cursor.left < 0) { tip.hidden = true; return; }
          const rows = rowsFn(u, i).filter((r) => r && r[1] != null);
          if (!rows.length) { tip.hidden = true; return; }
          tip.replaceChildren();
          const head = document.createElement("div"); head.className = "t";
          head.textContent = rowsFn.title(u.data[0][i] * 1e3);
          tip.append(head);
          for (const [label, val, color] of rows) {
            const r = document.createElement("div"); r.className = "r";
            const s = document.createElement("span");
            if (color) { const k = document.createElement("i"); k.className = "key-line"; k.style.background = color; s.append(k); }
            s.append(document.createTextNode(label));
            const b = document.createElement("b"); b.textContent = val;
            r.append(s, b); tip.append(r);
          }
          tip.hidden = false;
          const rect = u.over.getBoundingClientRect();
          let x = rect.left + u.cursor.left + 14, y = rect.top + u.cursor.top + 14;
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          if (x + tw > window.innerWidth - 8) x = rect.left + u.cursor.left - tw - 14;
          if (y + th > window.innerHeight - 8) y = rect.top + u.cursor.top - th - 14;
          tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
        },
      },
    };
  }

  function legend(items) {
    const el = $("legend");
    el.replaceChildren();
    for (const [kind, color, text] of items) {
      const s = document.createElement("span");
      const k = document.createElement("i");
      k.className = kind === "band" ? "key-band" : kind === "dash" ? "key-dash" : "key-line";
      if (kind === "dash") k.style.borderTopColor = color;
      else k.style.background = color;
      s.append(k, document.createTextNode(text));
      el.append(s);
    }
  }

  function baseOpts(width, height, extra) {
    return Object.assign({
      width, height,
      tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), TZ),
      fmtDate: fd,
      cursor: { sync: { key: "amper" }, points: { size: 7 }, drag: { x: true, y: false } },
      legend: { show: false },
      padding: [8, 8, 0, 0],
      axes: [
        { stroke: css("--muted"), grid: { show: false }, ticks: { stroke: css("--axis"), width: 1, size: 4 }, values: xValues, font: "12px system-ui, sans-serif", space: 60 },
        { stroke: css("--muted"), grid: { stroke: css("--grid"), width: 1 }, ticks: { show: false }, font: "12px system-ui, sans-serif", size: 52, gap: 6 },
      ],
    }, extra);
  }

  function chartSize(el, h) {
    const w = Math.max(280, el.clientWidth);
    return { width: w, height: window.innerWidth < 600 ? Math.round(h * 0.78) : h };
  }

  function renderCharts() {
    charts.forEach((c) => c.destroy());
    charts = [];
    const p = state.param, r = state.range, F = fmt(p), U = unit(p);
    const mainEl = $("chart-main"), precEl = $("chart-precip");
    const OBS = css("--obs"), FC = css("--fc");
    const hourly = r === "fc" || r === "30";
    $("precip-wrap").hidden = !hourly;
    $("cmp-wrap").hidden = !(hourly && V?.past?.length);
    if (!$("cmp-wrap").hidden) for (const o of $("cmp").options) o.disabled = o.value !== "0" && !pastFc(+o.value);
    $("cmp").value = String(state.cmp);

    let opts, data;
    if (hourly) {
      const v = hourlyView(p, r === "fc" ? 5 : 30);
      data = v.data;
      const CMP = css("--ink-2");
      const cmpLabel = v.pf ? `Prognose vom ${dtf.format(v.pf.t)} Uhr` : "";
      const rows = (u, i) => [
        ["Messung", data[1][i] != null ? `${F(data[1][i])} ${U}` : null, OBS],
        ["Prognose (Median)", data[2][i] != null && data[1][i] == null ? `${F(data[2][i])} ${U}` : null, FC],
        ["80 % der Szenarien", data[3][i] != null && data[1][i] == null ? `${F(data[3][i])}–${F(data[4][i])}` : null, null],
        v.pf ? [state.cmp === 1 ? "Prognose von gestern" : `Prognose von vor ${state.cmp} Tagen`, data[7][i] != null ? `${F(data[7][i])} ${U}` : null, CMP] : null,
      ];
      rows.title = (ms) => dtf.format(ms) + " Uhr";
      opts = baseOpts(...Object.values(chartSize(mainEl, 340)), {
        scales: { x: { time: true }, y: { range: (u, mn, mx) => [p === "q" ? 0 : Math.max(0, Math.floor((mn - 10) / 10) * 10), mx + (mx - (p === "q" ? 0 : mn)) * 0.15] } },
        series: [
          {},
          { stroke: OBS, width: 2, spanGaps: false },
          { stroke: FC, width: 2 },
          { stroke: "transparent", width: 0 }, { stroke: "transparent", width: 0 },
          { stroke: "transparent", width: 0 }, { stroke: "transparent", width: 0 },
          { stroke: CMP, width: 2, dash: [6, 4], spanGaps: true, points: { show: false } },
        ],
        bands: [{ series: [4, 3], fill: css("--fc-band") }, { series: [6, 5], fill: css("--fc-band-in") }],
        plugins: [refPlugin(p, v.now), tipPlugin(rows)],
      });
      legend([["line", OBS, "Messung"], ["line", FC, "Prognose (Median)"], ["band", css("--fc-band-in"), "50 % der Szenarien"], ["band", css("--fc-band"), "80 %"], ...(v.pf ? [["dash", CMP, cmpLabel]] : [])]);
      $("chart-hint").textContent = `Stundenwerte · Prognose ${L.forecast.members} Wetterszenarien + Modellfehler · Bereich ziehen zum Zoomen, Doppelklick zurück`;
      charts.push(new uPlot(opts, data, mainEl));

      // Niederschlag
      const pd = precipView(data[0]);
      const bars = uPlot.paths.bars({ size: [0.9, 6], align: 0 });
      const prow = (u, i) => [
        ["Niederschlag", pd[1][i] != null ? `${NF1.format(pd[1][i])} mm` : null, OBS],
        ["Prognose (Median)", pd[2][i] != null ? `${NF1.format(pd[2][i])} mm` : null, FC],
        ["Ungünstig (90 %)", pd[3][i] != null ? `${NF1.format(pd[3][i])} mm` : null, null],
      ];
      prow.title = rows.title;
      const popts = baseOpts(...Object.values(chartSize(precEl, 120)), {
        scales: { x: { time: true }, y: { range: (u, mn, mx) => [0, Math.max(1, mx * 1.1)] } },
        series: [
          {},
          { stroke: OBS, fill: OBS, paths: bars, width: 0 },
          { stroke: FC, fill: FC, paths: bars, width: 0 },
          { stroke: css("--muted"), width: 1, paths: uPlot.paths.stepped({ align: 1 }) },
        ],
        plugins: [tipPlugin(prow)],
      });
      popts.axes[1].size = 52;
      popts.axes[1].values = (u, vals) => vals.map((x) => NF1.format(x));
      const pc = new uPlot(popts, pd, precEl);
      charts.push(pc);
    } else {
      const v = dailyView(p, r === "365" ? 366 : 0);
      data = v.data;
      const withClim = r === "365";
      const CL = css("--clim-line");
      const rows = (u, i) => [
        ["Tagesmittel", data[1][i] != null ? `${F(data[1][i])} ${U}` : null, OBS],
        ["Prognose", data[2][i] != null && data[1][i] == null ? `${F(data[2][i])} ${U}` : null, FC],
        withClim ? ["Üblich (Median)", data[9][i] != null ? `${F(data[9][i])} ${U}` : null, CL] : null,
        withClim ? ["Üblicher Bereich", data[5][i] != null ? `${F(data[5][i])}–${F(data[6][i])}` : null, null] : null,
      ];
      rows.title = (ms) => df.format(ms);
      const T = { stroke: "transparent", width: 0 };
      opts = baseOpts(...Object.values(chartSize(mainEl, 340)), {
        scales: { x: { time: true }, y: { range: (u, mn, mx) => [p === "q" ? 0 : Math.max(0, Math.floor((mn - 10) / 10) * 10), mx * 1.08] } },
        series: [
          {},
          { stroke: OBS, width: r === "all" ? 1 : 2 },
          { stroke: FC, width: 2 },
          T, T, T, T, T, T,
          { stroke: withClim ? CL : "transparent", width: withClim ? 1 : 0 },
        ],
        bands: withClim
          ? [{ series: [4, 3], fill: css("--fc-band") }, { series: [6, 5], fill: css("--clim-band") }, { series: [8, 7], fill: css("--clim-band-in") }]
          : [],
        plugins: [refPlugin(p, r === "365" ? v.now : null), tipPlugin(rows)],
      });
      if (withClim) {
        legend([["line", OBS, "Tagesmittel"], ["line", FC, "Prognose"], ["line", CL, `Üblich (Median ${Hs.start.slice(0, 4)}–${L.stats.climYears[1]})`], ["band", css("--clim-band-in"), "50 % der Jahre"], ["band", css("--clim-band"), "80 %"]]);
        $("chart-hint").textContent = "Grau: so viel Wasser führt die Amper an diesem Kalendertag normalerweise.";
      } else {
        legend([["line", OBS, "Tagesmittel"]]);
        $("chart-hint").textContent = `Tagesmittel seit ${df.format(Date.parse(Hs.start))} · Bereich ziehen zum Zoomen, Doppelklick zurück · Größte Hochwasser: Mai 1999 (167 m³/s), Juni 1965, Juni 1979.`;
      }
      charts.push(new uPlot(opts, data, mainEl));
    }
  }

  // ---------- Interaktion (Zustand auch in der URL, z. B. #365-w) ----------
  function syncButtons() {
    document.querySelectorAll("[data-param]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.param === state.param)));
    document.querySelectorAll("[data-range]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.range === state.range)));
  }
  function setState(patch) {
    Object.assign(state, patch);
    syncButtons();
    history.replaceState(null, "", state.range === "fc" && state.param === "w" ? location.pathname : `#${state.range}-${state.param}`);
    if (L) renderCharts();
  }
  {
    const m = location.hash.match(/^#(fc|30|365|all)-(q|w)$/);
    if (m) { state.range = m[1]; state.param = m[2]; }
    syncButtons();
  }
  document.querySelectorAll("[data-param]").forEach((b) => b.addEventListener("click", () => setState({ param: b.dataset.param })));
  document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => setState({ range: b.dataset.range })));
  $("cmp").addEventListener("change", (e) => { state.cmp = +e.target.value; if (L) renderCharts(); });
  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => charts.forEach((c) => {
      const el = c.root.parentElement;
      const h = el.id === "chart-precip" ? 120 : 340;
      c.setSize(chartSize(el, h));
    }), 120);
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => L && renderCharts());
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".u-over")) $("tip").hidden = true; });
  // Daten alle 15 Minuten neu laden
  setInterval(load, 15 * 60e3);
  load();
})();
