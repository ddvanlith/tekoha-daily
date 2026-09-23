// Tekoha dashboard page. Reads the JSON that pipeline/build-dashboard.mjs writes each morning and
// renders every panel for the selected market. The builder already applied min-n and the asking or
// closed split; this file only formats, so a suppressed figure arrives as {n, suppressed} and is
// shown as its n, never as a number. Chart.js and Leaflet are the only dependencies (cdnjs, pinned).
const FLOW = [["cuts", "Price cuts", "#3987e5"], ["increases", "Price rises", "#d95926"], ["new", "New to market", "#199e70"],
  ["delisted", "Delisted", "#c98500"], ["went_sold", "Marked sold", "#d55181"], ["went_rented", "Marked rented", "#008300"]];
const KIND_COLOR = { departamento: "#3987e5", casa: "#d95926", duplex: "#199e70" };
const RAMP = ["#764f00", "#966700", "#b5811c", "#d49c3a", "#efba64", "#ffd691"];
const CUT_DOT = "#3987e5", REO_DOT = "#d55181", INK = "#171310", GOLD = "#a97e2f";
const SOURCES = { remax: "RE/MAX", infocasas: "InfoCasas", uprop: "uProp", c21: "Century 21", cb: "Coldwell Banker",
  psir: "Sotheby's", prestige: "Prestige" };
const BANKS = { atlas: "Atlas", bancop: "Bancop", basa: "BASA", bna: "Banco Nación", bnf: "BNF", caja_bancaria: "Caja Bancaria",
  gnb: "GNB", itau: "Itaú", solar: "Solar", sudameris: "Sudameris" };
const KINDS = { casa: "Casa", departamento: "Departamento", terreno: "Terreno", duplex: "Duplex", local: "Local",
  oficina: "Oficina", deposito: "Deposito", quinta: "Quinta", edificio: "Edificio", rural: "Rural", otro: "Otro", unknown: "Unknown" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const D = {};
const S = { market: "py", cellKind: "departamento", closeOp: "sale", metric: "asking_price_usd", tables: new Set() };
const charts = {};
let map, cells, cutDots, reoDots, breaks = {};
const renderers = {};

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid));
  return e;
}
const nf = new Intl.NumberFormat("en-US");
const num = (x) => (x == null ? "-" : nf.format(Math.round(x)));
const usd = (x) => (x == null ? "-" : "$" + nf.format(Math.round(x)));
const usdK = (x) => (x == null ? "-" : x >= 1e6 ? "$" + +(x / 1e6).toFixed(2) + "M" : x >= 1e4 ? "$" + +(x / 1e3).toFixed(1) + "K" : usd(x));
const money = (x, cur) => (x == null ? "-" : cur === "PYG" ? "Gs " + nf.format(Math.round(x)) : usd(x));
const pct = (x) => (x == null ? "-" : (x > 0 ? "+" : "") + x.toFixed(1) + "%");
const day = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${+d} ${MONTHS[m - 1]} ${y}`; };
const dayShort = (iso) => day(iso).slice(0, -5);
const monthYear = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const addDays = (iso, n) => new Date(Date.parse(iso.slice(0, 10) + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const norm = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const kindName = (k) => KINDS[k] || k;
const market = () => D.byId.get(S.market);
const here = (row) => row.mk.includes(S.market);
const tag = (closed) => h("span", { class: closed ? "tag closed" : "tag", text: closed ? "CLOSED" : "ASKING" });
const stamp = (id, closed, text) => $(id).replaceChildren(tag(closed), text);
const nLabel = (d, min) => `n ${num(d.n)}, below ${min}`;

// ---------- data ----------
async function load() {
  const get = (f) => fetch("data/" + f, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`${f} returned HTTP ${r.status}`);
    return r;
  });
  const [summary, markets, trends, movers, geo, series] = await Promise.all([
    get("summary.json").then((r) => r.json()), get("markets.json").then((r) => r.json()),
    get("trends.json").then((r) => r.json()), get("movers.json").then((r) => r.json()), get("geo.json").then((r) => r.json()),
    get("series.jsonl").then((r) => r.text()).then((t) => t.split("\n").filter(Boolean).map((l) => JSON.parse(l))).catch(() => []),
  ]);
  Object.assign(D, { summary, markets: markets.markets, trends, movers, geo, series });
  D.byId = new Map(D.markets.map((m) => [m.id, m]));
}

// Reading from about a week before the latest one, for the deltas. None until the series has two days.
function prior(pickValue) {
  const rows = D.series;
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const before = rows.slice(0, -1);
  const ref = [...before].reverse().find((r) => r.date <= addDays(last.date, -7)) || before[0];
  const a = pickValue(last.markets[S.market] || {}), b = pickValue(ref.markets[S.market] || {});
  return a == null || b == null ? null : { from: ref.date, diff: a - b, rel: b ? (a - b) / b : null };
}
const deltaText = (p, fmt, what = "") => (p ? `${what}vs ${dayShort(p.from)}: ${p.diff >= 0 ? "+" : "-"}${fmt(Math.abs(p.diff))}${p.rel != null ? ` (${pct(p.rel * 100)})` : ""}`
  : "First reading, no change to show yet");

// ---------- header, picker, hero ----------
function buildPicker() {
  const btn = $("pick-btn"), pane = $("pick-pane"), q = $("pick-q"), list = $("pick-list");
  const items = D.markets.map((m) => ({ m, key: norm(`${m.name} ${D.byId.get(m.parent)?.name || ""}`) }));
  let shown = [], active = 0;
  const draw = () => {
    const t = norm(q.value.trim());
    shown = items.filter((i) => !t || i.key.includes(t));
    list.replaceChildren(...shown.map((i, k) => h("li", { class: `${i.m.level}${k === active ? " on" : ""}`, role: "option",
      "aria-selected": String(i.m.id === S.market), onclick: () => pick(i.m.id) }, i.m.name, h("span", { text: num(i.m.asking_active.total) }))));
    list.children[active]?.scrollIntoView({ block: "nearest" });
  };
  const open = (v) => {
    pane.hidden = !v;
    btn.setAttribute("aria-expanded", String(v));
    if (v) { q.value = ""; active = Math.max(0, items.findIndex((i) => i.m.id === S.market)); draw(); q.focus(); }
  };
  const pick = (id) => { open(false); select(id); btn.focus(); };
  btn.addEventListener("click", () => open(pane.hidden));
  q.addEventListener("input", () => { active = 0; draw(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { active = Math.max(0, Math.min(shown.length - 1, active + (e.key === "ArrowDown" ? 1 : -1))); draw(); e.preventDefault(); }
    else if (e.key === "Enter" && shown[active]) pick(shown[active].m.id);
    else if (e.key === "Escape") { open(false); btn.focus(); }
  });
  document.addEventListener("click", (e) => { if (!$("picker").contains(e.target)) open(false); });
  $("pick-q").placeholder = `Search ${D.markets.length} markets`;
}

function select(id) {
  if (!D.byId.has(id)) return;
  if (id === "py") history.pushState(null, "", location.pathname + location.search);
  else location.hash = "m=" + encodeURIComponent(id);
  S.market = id;
  render();
}
const fromHash = () => { const m = /m=([^&]+)/.exec(location.hash); const id = m && decodeURIComponent(m[1]); return D.byId.has(id) ? id : "py"; };

function renderHero(m) {
  const chain = [];
  for (let x = m; x; x = D.byId.get(x.parent)) chain.unshift(x);
  $("crumbs").replaceChildren(...chain.flatMap((x, i) => [i ? " / " : "", x === m ? x.name : h("button", { type: "button", text: x.name, onclick: () => select(x.id) })]));
  $("title").textContent = m.name;
  $("pick-btn").textContent = m.name;
  document.title = m.id === "py" ? "Tekoha Market Dashboard" : `${m.name}: Tekoha Market Dashboard`;
  const a = m.asking_active;
  $("lede").className = "";
  $("lede").textContent = `${num(a.total)} active listings: ${num(a.sale_total)} for sale, ${num(a.rent_total)} for rent` +
    `${m.note ? ` (${m.note})` : ""}. Asking figures unless tagged closed; every figure carries its n and window.`;
}

// ---------- KPI row ----------
function kpi(title, body, delta, closed, stampText) {
  return h("div", { class: "kpi" }, h("h3", { text: title }), body, delta && h("div", { class: "delta", text: delta }),
    h("div", { class: "stamp" }, tag(closed), stampText));
}
function kindRows(dists, kinds, fmt, min) {
  const rows = kinds.filter((k) => dists[k]).map((k) => h("div", { class: "row" }, dists[k].suppressed
    ? [h("span", { class: "v none", text: "n/a" }), h("small", { text: `${kindName(k).toLowerCase()}, ${nLabel(dists[k], min)}` })]
    : [h("span", { class: "v", text: fmt(dists[k]) }), h("small", { text: `${kindName(k).toLowerCase()}, n ${num(dists[k].n)}` })]));
  return rows.length ? h("div", { class: "rows" }, rows) : h("div", { class: "empty", text: "No listings of these kinds" });
}
function renderKpis(m) {
  const s = D.summary, a = m.asking_active, f = m.asking_flow_30d, sp = m.closed_ask_to_close_pct, min = s.min_n.median;
  const fxLine = `USD at Gs ${num(s.fx.rate)}, SET mid ${dayShort(s.fx.date)}`;
  const ageSrc = s.sources.filter((x) => x.staleness_used).map((x) => SOURCES[x.code] || x.code).join(" and ");
  $("kpis").replaceChildren(
    kpi("Active listings", [h("div", { class: "v", text: num(a.total) }), h("div", { class: "sub", text: `${num(a.sale_total)} sale, ${num(a.rent_total)} rent` })],
      deltaText(prior((x) => (x.active_sale == null ? null : x.active_sale + (x.active_rent ?? 0))), num), false, ` all sources, ${dayShort(s.date)}`),
    kpi("Median ask, sale", kindRows(m.asking_price_usd, ["casa", "departamento"], (d) => usdK(d.median), min),
      deltaText(prior((x) => x.asking_price_usd?.casa?.[0]), usdK, "Casa "), false, ` ${fxLine}`),
    kpi("Median rent, monthly", kindRows(m.asking_rent_usd_month, ["departamento", "casa"], (d) => usd(d.median), min),
      deltaText(prior((x) => x.asking_rent_usd_month?.departamento?.[0]), usd, "Depto "), false, ` ${fxLine}`),
    kpi("Ask-to-close, median", sp.status
      ? [h("div", { class: "v small", text: "Insufficient closes" }), h("div", { class: "sub", text: `n ${num(sp.n)}, needs ${s.min_n.spread}` })]
      : [h("div", { class: "v", text: pct(sp.p50) }), h("div", { class: "sub", text: `P25 ${pct(sp.p25)}, P75 ${pct(sp.p75)}` })],
      null, true, sp.status ? " same-currency sales, RE/MAX" : ` n ${num(sp.n)} same-currency sales, RE/MAX, ${monthYear(sp.first)} to ${monthYear(sp.last)}`),
    kpi("Stock age, median", kindRows(m.asking_staleness_days, ["casa", "departamento"], (d) => `${num(d.p50)} days`, min),
      null, false, ` since publish, ${ageSrc} sale listings`),
    kpi("Price cuts, 30 days", [h("div", { class: "v", text: num(f.all.cuts) }), h("div", { class: "sub", text: `${num(f.sale.cuts)} sale, ${num(f.rent.cuts)} rent; ${num(f.all.increases)} rises` })],
      null, false, ` ${dayShort(s.flow_window.from)} to ${dayShort(s.flow_window.to)}, past -90% excluded`),
  );
}

// ---------- map ----------
function quantileBreaks(values) {
  const v = values.slice().sort((x, y) => x - y), out = [];
  for (let i = 1; i < RAMP.length; i++) {
    const b = Math.round(v[Math.floor((v.length * i) / RAMP.length)] / 50) * 50;
    if (!out.length || b > out.at(-1)) out.push(b);
  }
  return out;
}
const cellValue = (c) => (S.cellKind === "casa" ? c[5] : c[7]);
const rampColor = (v) => RAMP[breaks[S.cellKind].filter((b) => v >= b).length];
// 1 km cells from zoom 11, 5 km from 8.5, 25 km below: a cell never draws smaller than about 7 px.
const gridFor = (z) => D.geo.grids[z >= 11 ? 0 : z >= 8.5 ? 1 : 2];
const cellKm = (deg) => `about ${Math.round(deg * 100)} km`;
let gridShown = null;
function cellTip(c, deg) {
  const line = (label, v, n) => h("div", {}, `${label}: `, v == null ? h("span", { class: "muted", text: `n ${n}, below 5` }) : h("b", { text: `${usd(v)}/m2` }), v == null ? "" : ` (n ${n})`);
  return h("div", {}, h("div", { class: "muted", text: `${deg} degree cell (${cellKm(deg)}) at ${c[0].toFixed(2)}, ${c[1].toFixed(2)}: ${num(c[2])} active sale listings` }),
    line("Departamento", c[7], c[8]), line("Casa", c[5], c[6]),
    h("div", {}, `Median ask, all kinds: ${c[3] == null ? "n below 5" : usd(c[3])}`), h("div", { class: "muted", text: "ASKING prices" }));
}
function cutTip(r) {
  return h("div", {}, h("b", { text: `${pct(r.pct)} ` }), `${kindName(r.kind)}${r.m2 ? ` ${r.m2} m2` : ""}`,
    h("div", { text: `${[r.area, r.place].filter(Boolean).join(", ") || "Paraguay"}` }),
    h("div", { text: `${money(r.asking_old, r.currency)} to ${money(r.asking_new, r.currency)}` }),
    h("div", { class: "muted", text: `ASKING, cut ${dayShort(r.observed)}, ${r.days_listed ?? "?"} days listed, ${SOURCES[r.source] || r.source}` }));
}
function reoTip(r) {
  return h("div", {}, h("b", { text: r.asking_base_net_usd == null ? "No published price" : `${usd(r.asking_base_net_usd)} net base` }),
    h("div", { text: `${kindName(r.kind)}, ${[r.city, r.department].filter(Boolean).join(", ")}` }),
    h("div", { class: "muted", text: `Bank REO, ${BANKS[r.bank] || r.bank} item ${r.item}${r.land_m2 ? `, land ${num(r.land_m2)} m2` : ""}` }));
}
function buildMap() {
  map = L.map("map", { preferCanvas: true, scrollWheelZoom: false, zoomSnap: 0.5 });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());
  // Cells and dots get their own canvases so a cell redraw (kind switch, zoom level) can never
  // paint over the dots; the dot canvas widens the hover target to about 24 px.
  map.createPane("cells").style.zIndex = 390;
  map.createPane("dots").style.zIndex = 450;
  renderers.cells = L.canvas({ pane: "cells" });
  renderers.dots = L.canvas({ pane: "dots", tolerance: 6 });
  // Breaks come from the 1 km grid and serve every zoom, so a color means the same USD/m2 everywhere.
  for (const [kind, col] of [["casa", 5], ["departamento", 7]]) breaks[kind] = quantileBreaks(D.geo.grids[0].cells.map((c) => c[col]).filter((v) => v != null));
  cells = L.layerGroup().addTo(map);
  cutDots = L.layerGroup().addTo(map);
  reoDots = L.layerGroup();
  map.on("zoomend", () => drawCells(false));
}
function drawCells(force) {
  const g = gridFor(map.getZoom());
  if (!force && g === gridShown) return;
  gridShown = g;
  cells.clearLayers();
  const half = g.deg / 2;
  for (const c of g.cells) {
    const v = cellValue(c);
    if (v == null) continue;
    L.rectangle([[c[0] - half, c[1] - half], [c[0] + half, c[1] + half]], { pane: "cells", renderer: renderers.cells, stroke: false, fillColor: rampColor(v), fillOpacity: 0.8 })
      .bindTooltip(() => cellTip(c, g.deg), { sticky: true }).addTo(cells);
  }
  if (map.getZoom() != null) renderLegend();
}
function dots(group, rows, color, tip) {
  group.clearLayers();
  for (const r of rows) if (r.lat != null) {
    L.circleMarker([r.lat, r.lon], { pane: "dots", renderer: renderers.dots, radius: 6, color: INK, weight: 2, fillColor: color, fillOpacity: 1 })
      .bindTooltip(() => tip(r)).addTo(group);
  }
}
function renderMap(m, refit = true) {
  dots(cutDots, D.movers.asking_cuts_7d.filter(here), CUT_DOT, cutTip);
  dots(reoDots, D.movers.reo_parcels.filter(here), REO_DOT, reoTip);
  if (refit && m.bbox) map.fitBounds(m.bbox, { padding: [18, 18], maxZoom: 14 });
  drawCells(!refit);
  renderLegend();
  const mp = D.summary.map;
  stamp("map-stamp", false, ` cells with 5 or more listings of the kind: 0.01 degree (about 1 km) when zoomed in, 0.05 and 0.25 degree further out, each its own median. ` +
    `Color breaks are country-wide sextiles of the 1 km cells. ${num(mp.mapped)} active listings mapped; ${num(mp.placeholder)} sit on shared placeholder points and ` +
    `${num(mp.no_coordinates)} have no coordinates, so they count in their market but are not drawn.`);
}
function renderLegend() {
  const cutsHere = D.movers.asking_cuts_7d.filter(here), reoHere = D.movers.reo_parcels.filter(here), b = breaks[S.cellKind];
  $("legend").replaceChildren(
    h("span", {}, `Median asking USD per built m2, ${kindName(S.cellKind).toLowerCase()}, ${cellKm(gridShown.deg)} cells: `),
    h("span", { class: "ramp" }, RAMP.slice(0, b.length + 1).map((col, i) => h("span", {}, h("i", { style: `background:${col}` }), i ? num(b[i - 1]) + (i === b.length ? "+" : "") : `< ${num(b[0])}`))),
    h("span", {}, h("span", { class: "key", style: `background:${CUT_DOT}` }), ` ${cutsHere.filter((r) => r.lat != null).length} of ${cutsHere.length} cuts mapped`),
    h("span", {}, h("span", { class: "key", style: `background:${REO_DOT}` }), ` ${reoHere.filter((r) => r.lat != null).length} of ${reoHere.length} REO parcels mapped`));
}

// ---------- charts ----------
function chartDefaults() {
  Object.assign(Chart.defaults, { color: "#9a8d7a", borderColor: "#2e2820", maintainAspectRatio: false, animation: false });
  Object.assign(Chart.defaults.font, { family: "'Instrument Sans', system-ui, sans-serif", size: 11.5 });
  Object.assign(Chart.defaults.plugins.tooltip, { backgroundColor: "#0f0c0a", borderColor: "#4a4034", borderWidth: 1, padding: 9,
    titleColor: "#f2ede7", bodyColor: "#f2ede7", footerColor: "#9a8d7a", boxPadding: 4, usePointStyle: true,
    filter: (item) => item.raw != null });
  Object.assign(Chart.defaults.plugins.legend.labels, { boxWidth: 10, boxHeight: 10, color: "#b7aa96", padding: 12 });
}
const yAxis = (fmt, extra = {}) => ({ beginAtZero: true, grid: { color: "#2e2820" }, border: { display: false },
  ticks: { callback: fmt, maxTicksLimit: 5 }, afterFit: (s) => { s.width = 60; }, ...extra });
const xAxis = (fmt, extra = {}) => ({ grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7,
  callback(v) { return fmt(this.getLabelForValue(v)); } }, ...extra });
function makeChart(id, type, options) {
  return new Chart($(id).querySelector("canvas"), { type, data: { labels: [], datasets: [] },
    options: { interaction: { mode: "index", intersect: false }, ...options } });
}
function note(id, text) {
  const box = $(id);
  box.querySelector(".note")?.remove();
  if (text) box.append(h("div", { class: "note" }, h("span", { text })));
}
function buildCharts() {
  chartDefaults();
  charts.flow = makeChart("c-flow", "bar", { scales: { x: xAxis(dayShort, { stacked: true }), y: yAxis(num, { stacked: true }) },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { title: (it) => day(it[0].label) } } } });
  const weekTitle = { title: (it) => `Week of ${day(it[0].label)}` };
  charts.closes = makeChart("c-closes", "bar", { scales: { x: xAxis(monthYear, { ticks: { display: false } }), y: yAxis(num) },
    plugins: { legend: { display: false }, tooltip: { callbacks: { ...weekTitle, label: (c) => ` ${num(c.raw)} priced closes` } } } });
  charts.closemed = makeChart("c-closemed", "line", { scales: { x: xAxis(monthYear), y: yAxis(usdK, { beginAtZero: false }) },
    plugins: { legend: { display: false }, tooltip: { callbacks: { ...weekTitle, label: (c) => ` Median ${usd(c.raw)}` } } } });
  charts.rent = makeChart("c-rent", "line", { scales: { x: xAxis(monthYear), y: yAxis(usd, { beginAtZero: false }) },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { title: (it) => monthYear(it[0].label),
      label: (c) => ` ${c.dataset.label}: ${usd(c.raw)} a month` } } } });
  charts.series = makeChart("c-series", "line", { scales: { x: xAxis(dayShort, { offset: true }), y: yAxis(usdK, { beginAtZero: false }) },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { title: (it) => day(it[0].label),
      label: (c) => ` ${c.dataset.label}: ${usd(c.raw)}` } } } });
}
const lineSet = (label, data, color) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0,
  spanGaps: false, borderJoinStyle: "round", borderCapStyle: "round", pointBackgroundColor: color, pointBorderColor: "#1e1914",
  pointBorderWidth: 2, pointHoverRadius: 5, pointRadius: (c) => (c.dataIndex === lastIndex(c.dataset.data) ? 4 : 0) });
const lastIndex = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i; return -1; };
const weeksFrom = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 7)) out.push(d); return out; };
const monthsFrom = (from, to) => { const out = []; for (let y = +from.slice(0, 4), mo = +from.slice(5, 7); `${y}-${String(mo).padStart(2, "0")}` <= to.slice(0, 7); mo === 12 ? (y++, mo = 1) : mo++) out.push(`${y}-${String(mo).padStart(2, "0")}-01`); return out; };

function renderFlow() {
  const t = D.trends.asking_flow_daily, f = t.markets[S.market];
  charts.flow.data = { labels: t.days, datasets: FLOW.map(([k, label, color]) => ({ label, data: f[k], backgroundColor: color,
    borderColor: "#1e1914", borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, borderSkipped: false, borderRadius: 2, maxBarThickness: 24 })) };
  charts.flow.update();
  stamp("flow-stamp", false, ` listing events per capture day, all operations, ${day(t.days[0])} to ${day(t.days.at(-1))}. ` +
    `A missing bar means no capture ran that day. The series starts the day after our first capture (${day(D.summary.history_start)}).`);
}
function renderCloses() {
  const rows = D.trends.closed_weekly.markets[S.market][S.closeOp];
  const monday = addDays(D.summary.date, -((new Date(D.summary.date + "T00:00:00Z").getUTCDay() + 6) % 7));
  const weeks = weeksFrom("2024-01-01", monday), byWeek = new Map(rows.map((r) => [r[0], r]));
  charts.closes.data = { labels: weeks, datasets: [{ data: weeks.map((w) => byWeek.get(w)?.[1] ?? 0), backgroundColor: GOLD, maxBarThickness: 24, borderRadius: 1 }] };
  charts.closemed.data = { labels: weeks, datasets: [lineSet("Median close", weeks.map((w) => byWeek.get(w)?.[2] ?? null), GOLD)] };
  charts.closes.update(); charts.closemed.update();
  const total = rows.reduce((a, r) => a + r[1], 0);
  note("c-closes", total ? "" : `No broker-reported ${S.closeOp === "sale" ? "sales" : "rentals"} with a price in this market`);
  note("c-closemed", rows.some((r) => r[2] != null) ? "" : "No week reaches 20 closes here, so no weekly median is shown");
  stamp("closes-stamp", true, ` ${num(total)} priced ${S.closeOp === "sale" ? "sales" : "rentals"} from the RE/MAX network since Jan 2024, by close date, USD at each close date's SET rate. ` +
    `Median shown for weeks with 20 or more closes; the latest week is still in progress. Earlier weeks are thinner because the feed only shows closed listings RE/MAX still indexes.`);
}
function renderRent() {
  const byKind = D.trends.closed_rent_monthly.markets[S.market];
  const months = monthsFrom("2024-01-01", D.summary.date);
  // Residential kinds only, each on its fixed color, so a color never changes meaning between markets.
  const kinds = Object.keys(KIND_COLOR).filter((k) => byKind[k]?.some((x) => x[2] != null));
  charts.rent.data = { labels: months, datasets: kinds.map((k) => {
    const m = new Map(byKind[k].map((x) => [x[0], x[2]]));
    return lineSet(kindName(k), months.map((mo) => m.get(mo) ?? null), KIND_COLOR[k]);
  }) };
  charts.rent.update();
  note("c-rent", kinds.length ? "" : "No month in this market reaches 20 rented closes of one kind");
  const n = Object.values(byKind).flat().reduce((a, x) => a + x[1], 0);
  stamp("rent-stamp", true, ` median monthly rent of ${num(n)} rented closes, RE/MAX network, USD at each close date's SET rate. Months under 20 closes of a kind are gaps.`);
}
function renderSeries() {
  const rows = D.series, lab = { asking_price_usd: "median ask", asking_usd_per_m2_built: "median USD per built m2", asking_rent_usd_month: "median monthly rent" }[S.metric];
  const kinds = S.metric === "asking_rent_usd_month" ? ["departamento", "casa"] : ["casa", "departamento"];
  charts.series.data = { labels: rows.map((r) => r.date), datasets: kinds.map((k) =>
    lineSet(kindName(k), rows.map((r) => r.markets[S.market]?.[S.metric]?.[k]?.[0] ?? null), KIND_COLOR[k])) };
  charts.series.update();
  const first = rows[0]?.date;
  note("c-series", rows.length < 2 ? `One reading so far (${first ? day(first) : "today"}). A reading is added each morning; nothing before launch is back-filled.` : "");
  stamp("series-stamp", false, ` daily ${lab} of active listings, same rules as the tiles above. Series begins ${first ? day(first) : "today"}.`);
}

// Every chart has a table twin, so no value is reachable only by hovering.
const TWINS = {
  flow: () => [["Date", ...FLOW.map((f) => f[1])], D.trends.asking_flow_daily.days.map((d, i) => [day(d),
    ...FLOW.map(([k]) => D.trends.asking_flow_daily.markets[S.market][k][i] ?? "no capture")])],
  closes: () => [["Week of", "Priced closes", "Median close"], D.trends.closed_weekly.markets[S.market][S.closeOp].slice().reverse()
    .map((r) => [day(r[0]), num(r[1]), r[2] == null ? "n below 20" : usd(r[2])])],
  rent: () => [["Month", "Kind", "Rented closes", "Median rent"], Object.entries(D.trends.closed_rent_monthly.markets[S.market])
    .flatMap(([k, rs]) => rs.map((r) => [r[0], kindName(k), num(r[1]), r[2] == null ? "n below 20" : usd(r[2])]))
    .sort((a, b) => (a[0] < b[0] ? 1 : -1)).map((r) => [monthYear(r[0]), ...r.slice(1)])],
  series: () => [["Date", "Kind", "Median", "n"], D.series.flatMap((r) => Object.entries(r.markets[S.market]?.[S.metric] || {})
    .map(([k, v]) => [day(r.date), kindName(k), usd(v[0]), num(v[1])]))],
};
function renderTwins() {
  for (const key of Object.keys(TWINS)) {
    const btn = document.querySelector(`[data-table="${key}"]`), panel = btn.closest(".panel");
    panel.querySelector(".twin")?.remove();
    btn.textContent = S.tables.has(key) ? "Chart only" : "Table";
    if (!S.tables.has(key)) continue;
    const [head, rows] = TWINS[key]();
    panel.querySelector(".stamp").before(h("div", { class: "tbl twin", style: "margin-top:10px;max-height:260px" },
      h("table", {}, h("thead", {}, h("tr", {}, head.map((c) => h("th", { text: c })))),
        h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", { text: c }))))))));
  }
}

// ---------- tables ----------
// cols: [label, value(row) for sorting, display(row) or null, numeric?]
function table(boxId, cols, rows, { sort = 0, dir = 1, onRow, current, empty = "Nothing to show for this market" } = {}) {
  const box = $(boxId);
  box._sort ??= { sort, dir };
  const st = box._sort, key = cols[st.sort][1];
  const sorted = rows.slice().sort((a, b) => {
    const x = key(a), y = key(b);
    if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
    return (x < y ? -1 : x > y ? 1 : 0) * st.dir;
  });
  const head = h("tr", {}, cols.map(([label, , , isNum], i) => h("th", { class: isNum ? "num" : null,
    "aria-sort": i === st.sort ? (st.dir > 0 ? "ascending" : "descending") : null },
  h("button", { type: "button", text: label, onclick: () => { st.dir = st.sort === i ? -st.dir : isNum ? -1 : 1; st.sort = i; table(boxId, cols, rows, { onRow, current, empty }); } }))));
  const body = sorted.map((r) => h("tr", { class: `${onRow ? "pickable" : ""}${current?.(r) ? " current" : ""}`, onclick: onRow ? () => onRow(r) : null },
    cols.map(([, val, show, isNum]) => { const out = show ? show(r) : val(r); return h("td", { class: isNum ? "num" : null }, out ?? "-"); })));
  box.replaceChildren(rows.length ? h("table", {}, h("thead", {}, head), h("tbody", {}, body)) : h("div", { class: "empty", style: "padding:14px", text: empty }));
}
const distCell = (d, fmt, min) => (!d ? null : d.suppressed ? h("span", { class: "muted", text: nLabel(d, min) })
  : h("span", {}, fmt(d.median ?? d.p50), h("small", { text: `n ${num(d.n)}` })));
const placeCell = (r) => [r.area, r.place].filter(Boolean).join(", ") || "Paraguay";
const srcCell = (r) => `${SOURCES[r.source] || r.source}${r.brokers > 1 ? ` x${r.brokers}` : ""}`;
const usdNote = (amt, cur, usdAmt) => (cur === "PYG" ? h("span", {}, money(amt, cur), h("small", { text: `about ${usdK(usdAmt)}` })) : money(amt, cur));

function renderTables(m) {
  const min = D.summary.min_n.median;
  const kinds = [...new Set([...Object.keys(m.asking_active.sale), ...Object.keys(m.asking_active.rent)])];
  table("t-kinds", [
    ["Kind", (k) => kindName(k)],
    ["For sale", (k) => m.asking_active.sale[k] ?? 0, (k) => num(m.asking_active.sale[k] ?? 0), true],
    ["For rent", (k) => m.asking_active.rent[k] ?? 0, (k) => num(m.asking_active.rent[k] ?? 0), true],
    ["Median ask", (k) => m.asking_price_usd[k]?.median, (k) => distCell(m.asking_price_usd[k], usd, min), true],
    ["P25 to P75", (k) => m.asking_price_usd[k]?.p25, (k) => (m.asking_price_usd[k]?.median ? `${usdK(m.asking_price_usd[k].p25)} to ${usdK(m.asking_price_usd[k].p75)}` : null), true],
    ["USD/m2 built", (k) => m.asking_usd_per_m2_built[k]?.median, (k) => distCell(m.asking_usd_per_m2_built[k], usd, min), true],
    ["Rent a month", (k) => m.asking_rent_usd_month[k]?.median, (k) => distCell(m.asking_rent_usd_month[k], usd, min), true],
    ["Age P50 / P75", (k) => m.asking_staleness_days[k]?.p50, (k) => { const d = m.asking_staleness_days[k]; return !d ? null : d.suppressed ? h("span", { class: "muted", text: nLabel(d, min) }) : h("span", {}, `${num(d.p50)}d / ${num(d.p75)}d`, h("small", { text: `n ${num(d.n)}` })); }, true],
  ], kinds, { sort: 1, dir: -1 });
  stamp("kinds-stamp", false, ` active listings today. Medians need n ${min}. Asks and rents in USD at the day's SET mid rate; USD/m2 on built area only, 40 to 800 m2, USD 30,000 to 2,000,000; age from ${D.summary.sources.filter((x) => x.staleness_used).map((x) => SOURCES[x.code]).join(" and ")} only.`);

  const cuts = D.movers.asking_cuts_7d.filter(here);
  table("t-cuts", [["Cut", (r) => r.pct, (r) => h("span", { class: "cut", text: pct(r.pct) }), true],
    ["Now", (r) => r.asking_new_usd, (r) => usdNote(r.asking_new, r.currency, r.asking_new_usd), true],
    ["Was", (r) => r.asking_old, (r) => money(r.asking_old, r.currency), true], ["Place", placeCell], ["Kind", (r) => kindName(r.kind)],
    ["Built m2", (r) => r.m2, (r) => num(r.m2), true], ["Days listed", (r) => r.days_listed, null, true],
    ["Cut on", (r) => r.observed, (r) => dayShort(r.observed)], ["Source", srcCell]],
  cuts, { sort: 0, dir: 1, empty: "No sale price cuts in this market in the last 7 days" });
  stamp("cuts-stamp", false, ` sale listings cut in the last 7 days, deepest first, ${num(cuts.length)} rows (up to 100 per market). Cuts past -90% are entry corrections and excluded. xN is the same unit repriced by N brokers.`);

  const fresh = D.movers.asking_new_7d.filter(here);
  table("t-fresh", [["USD/m2", (r) => r.asking_usd_m2, (r) => usd(r.asking_usd_m2), true],
    ["Ask", (r) => r.asking_usd, (r) => usdNote(r.asking, r.currency, r.asking_usd), true], ["Place", placeCell], ["Kind", (r) => kindName(r.kind)],
    ["Built m2", (r) => r.m2, null, true], ["Beds", (r) => r.bedrooms, null, true],
    ["First seen", (r) => r.first_seen, (r) => dayShort(r.first_seen)], ["Source", srcCell]],
  fresh, { sort: 0, dir: 1, empty: "No new sale listings with a built area in this market this week" });
  stamp("fresh-stamp", false, ` first seen in the last 7 days within a week of the portal's publish date, built area 40 to 800 m2, lowest USD per m2 first (up to 30 per market).`);

  const sp = m.closed_ask_to_close_pct;
  const spRows = [["All kinds", sp], ...Object.entries(m.closed_ask_to_close_pct_by_kind).map(([k, v]) => [kindName(k), v])];
  table("t-spread", [["Kind", (r) => r[0]], ["P25", (r) => r[1].p25, (r) => (r[1].status ? h("span", { class: "muted", text: r[1].status }) : pct(r[1].p25)), true],
    ["Median", (r) => r[1].p50, (r) => pct(r[1].p50), true], ["P75", (r) => r[1].p75, (r) => pct(r[1].p75), true],
    ["n", (r) => r[1].n, (r) => num(r[1].n), true], ["Closes from", (r) => r[1].first, (r) => (r[1].first ? `${monthYear(r[1].first)} to ${monthYear(r[1].last)}` : "-")]],
  spRows, { sort: 4, dir: -1 });
  stamp("spread-stamp", true, ` broker-reported sale price against the last asking price, same currency only, RE/MAX network. Kinds show with ${D.summary.min_n.spread} or more closes. A 0.0% P75 means at least a quarter of closes land at the ask or above.`);

  const flow = m.asking_flow_30d;
  table("t-flow30", [["Event", (r) => FLOW.indexOf(r), (r) => r[1]], ...["sale", "rent", "all"].map((op) => [op === "all" ? "All" : op === "sale" ? "Sale" : "Rent",
    (r) => flow[op][r[0]], (r) => num(flow[op][r[0]]), true])], FLOW, { sort: 0, dir: 1 });
  stamp("flow30-stamp", false, ` events ${day(D.summary.flow_window.from)} to ${day(D.summary.flow_window.to)}. The All column equals the sum of the daily chart's bars over the same 30 days.`);

  const reo = D.movers.reo_parcels.filter(here);
  const placeReo = (r) => [...new Set([r.city, r.department].filter(Boolean))].join(", ");
  table("t-reo", [
    ["Net base", (r) => r.asking_base_net_usd, (r) => (r.asking_base_net_usd == null ? h("span", { class: "muted", text: "not published" }) : h("span", {}, usd(r.asking_base_net_usd), r.price_check ? h("span", { class: "flag", text: "CHECK" }) : null)), true],
    ["Kind", (r) => kindName(r.kind)], ["Place", placeReo], ["Land m2", (r) => r.land_m2, (r) => num(r.land_m2), true],
    ["Built m2", (r) => r.built_m2, (r) => num(r.built_m2), true], ["Bank", (r) => BANKS[r.bank] || r.bank], ["Item", (r) => r.item],
    ["First seen", (r) => r.first_seen, (r) => dayShort(r.first_seen)]],
  reo, { sort: 0, dir: 1, empty: "No bank-owned parcels listed in this market" });
  stamp("reo-stamp", false, ` ${num(reo.length)} active parcels from ${D.summary.reo.banks} bank lists, base price as published net of 10% IVA. CHECK marks a built property under USD 10,000, likely an entry error at the bank. Last capture ${day(D.summary.reo.last_ok_capture)}.`);
}

function renderMarketsTable() {
  const g = (m, f, k) => m[f][k], min = D.summary.min_n.median;
  table("t-markets", [["Market", (m) => m.name], ["Level", (m) => m.level],
    ["For sale", (m) => m.asking_active.sale_total, (m) => num(m.asking_active.sale_total), true],
    ["Casa ask", (m) => g(m, "asking_price_usd", "casa")?.median, (m) => distCell(g(m, "asking_price_usd", "casa"), usdK, min), true],
    ["Depto ask", (m) => g(m, "asking_price_usd", "departamento")?.median, (m) => distCell(g(m, "asking_price_usd", "departamento"), usdK, min), true],
    ["Depto USD/m2", (m) => g(m, "asking_usd_per_m2_built", "departamento")?.median, (m) => distCell(g(m, "asking_usd_per_m2_built", "departamento"), usd, min), true],
    ["Depto rent", (m) => g(m, "asking_rent_usd_month", "departamento")?.median, (m) => distCell(g(m, "asking_rent_usd_month", "departamento"), usd, min), true],
    ["Sale cuts 30d", (m) => m.asking_flow_30d.sale.cuts, (m) => num(m.asking_flow_30d.sale.cuts), true],
    ["Ask-to-close", (m) => m.closed_ask_to_close_pct.p50, (m) => (m.closed_ask_to_close_pct.status ? h("span", { class: "muted", text: `n ${m.closed_ask_to_close_pct.n}` }) : h("span", {}, pct(m.closed_ask_to_close_pct.p50), h("small", { text: `n ${num(m.closed_ask_to_close_pct.n)}` }))), true]],
  D.markets, { sort: 2, dir: -1, onRow: (m) => { select(m.id); window.scrollTo({ top: 0, behavior: "smooth" }); }, current: (m) => m.id === S.market });
  stamp("markets-stamp", false, " medians of active listings (asking) except the last column, which is closed. Cities appear at 100 active sale listings.");
}

// ---------- page furniture that does not depend on the market ----------
function renderStatic() {
  const s = D.summary, t = D.trends.closed_weekly.markets.py;
  const asof = new Date(s.as_of);
  $("asof").textContent = `Data as of ${day(s.as_of)}, ${asof.toISOString().slice(11, 16)} UTC | Gs ${num(s.fx.rate)}/USD`;
  const ic = s.sources.find((x) => x.code === "infocasas"), up = s.staleness_sources.find((x) => x.code === "uprop");
  const fill = { closes_sale: num(t.sale.reduce((a, r) => a + r[1], 0)), closes_rent: num(t.rent.reduce((a, r) => a + r[1], 0)),
    fx_rate: num(s.fx.rate), fx_date: day(s.fx.date), assign_own: num(s.assignment.own), assign_nearest: num(s.assignment.nearest),
    assign_dept: num(s.assignment.nearest_dept), assign_none: num((s.assignment.no_coordinates || 0) + (s.assignment.unassigned || 0)),
    age_sources: s.sources.filter((x) => x.staleness_used).map((x) => SOURCES[x.code]).join(" and "),
    uprop_week: up ? `${Math.round(up.densest_week_share * 100)}%` : "most", map_placeholder: num(s.map.placeholder),
    ic_priced: ic ? `${Math.round((ic.priced / ic.active) * 100)}%` : "part" };
  document.querySelectorAll("[data-s]").forEach((e) => { e.textContent = fill[e.dataset.s] ?? "-"; });
  const share = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
  const PLACED = { own: "own labels", nearest: "nearest labeled listings", nearest_dept: "department only", no_coordinates: "not placed, no coordinates", unassigned: "not placed" };
  const placed = (x) => { const [k, n] = Object.entries(x.placement || {}).sort((a, b) => b[1] - a[1])[0] || []; return k ? `${PLACED[k] || k}, ${share(n, x.active)}` : "-"; };
  table("t-sources", [["Source", (x) => SOURCES[x.code] || x.name], ["Active", (x) => x.active, (x) => num(x.active), true],
    ["With an ask", (x) => x.priced / (x.active || 1), (x) => share(x.priced, x.active), true],
    ["Last good pull", (x) => x.last_ok_pull || x.last_run, (x) => (x.last_ok_pull ? day(x.last_ok_pull) : x.last_run ? `none; last attempt ${day(x.last_run)}` : "none")],
    ["Captured", (x) => x.full_universe, (x) => (x.full_universe ? "whole panel daily" : x.code === "c21" ? "partial crawl, irregular" : "changed listings daily, deep crawl weekly")],
    ["Market from", placed]], s.sources, { sort: 1, dir: -1 });
  $("files").replaceChildren(...s.files.map((f) => h("li", {}, h("a", { href: "data/" + f.file, download: true, text: f.file }),
    ` ${f.description}. ${num(f.rows)} ${f.rows === 1 ? "row" : "rows"}, ${(f.bytes / 1024).toFixed(0)} KB`)));
}

function render() {
  const m = market();
  renderHero(m); renderKpis(m); renderMap(m); renderFlow(); renderCloses(); renderRent(); renderSeries(); renderTwins();
  renderTables(m); renderMarketsTable();
}

function wire() {
  const seg = (id, keyName, after) => $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S[keyName] = b.dataset.v;
    $(id).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    after();
  });
  seg("cell-kind", "cellKind", () => renderMap(market(), false));
  seg("close-op", "closeOp", () => { renderCloses(); renderTwins(); });
  seg("series-metric", "metric", () => { renderSeries(); renderTwins(); });
  const layer = (id, group) => $(id).addEventListener("change", (e) => (e.target.checked ? group.addTo(map) : group.remove()));
  layer("lyr-cells", cells); layer("lyr-cuts", cutDots); layer("lyr-reo", reoDots);
  document.querySelectorAll("[data-table]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.table;
    S.tables.has(k) ? S.tables.delete(k) : S.tables.add(k);
    renderTwins();
  }));
  window.addEventListener("hashchange", () => { const id = fromHash(); if (id !== S.market) { S.market = id; render(); } });
  window.addEventListener("popstate", () => { const id = fromHash(); if (id !== S.market) { S.market = id; render(); } });
}

try {
  await load();
  buildPicker(); buildMap(); buildCharts(); wire(); renderStatic();
  S.market = fromHash();
  render();
} catch (e) {
  $("lede").textContent = `The dashboard could not load today's data (${e.message}). The CSV files in the data folder may still be available.`;
  console.error(e);
}
