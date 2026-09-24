// Tekoha dashboard page. Reads the JSON that pipeline/build-dashboard.mjs writes each morning and
// renders every panel for the selected market. The builder already applied min-n, the seen rule,
// the price-coverage rule and the asking or closed split; this file only formats, so a suppressed
// figure arrives as {n, suppressed} and is shown as its n, never as a number. Chart.js and Leaflet
// are the only dependencies (cdnjs, pinned).
const FLOW = [["cuts", "Price cuts", "#3987e5"], ["increases", "Price rises", "#d95926"], ["new", "New to market", "#199e70"],
  ["delisted", "Delisted", "#c98500"], ["went_sold", "Marked sold", "#d55181"], ["went_rented", "Marked rented", "#008300"]];
const KIND_COLOR = { departamento: "#3987e5", casa: "#d95926", duplex: "#199e70", terreno: "#d55181" };
const RAMP = ["#764f00", "#966700", "#b5811c", "#d49c3a", "#efba64", "#ffd691"];
const CUT_DOT = "#3987e5", REO_DOT = "#d55181", INK = "#171310", GOLD = "#a97e2f";
const SOURCES = { remax: "RE/MAX", infocasas: "InfoCasas", uprop: "uProp", c21: "Century 21", cb: "Coldwell Banker",
  psir: "Sotheby's", prestige: "Prestige" };
const BANKS = { atlas: "Atlas", bancop: "Bancop", basa: "BASA", bna: "Banco Nación", bnf: "BNF", caja_bancaria: "Caja Bancaria",
  gnb: "GNB", itau: "Itaú", solar: "Solar", sudameris: "Sudameris" };
const KINDS = { casa: "Casa", departamento: "Departamento", terreno: "Terreno", duplex: "Duplex", local: "Local",
  oficina: "Oficina", deposito: "Depósito", quinta: "Quinta", edificio: "Edificio", rural: "Rural", otro: "Otro",
  unknown: "Kind not stated" };
const SHORT = { casa: "casa", departamento: "depto" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const D = {};
const S = { market: "py", cellKind: "departamento", closeOp: "sale", recentOp: "sale", metric: "sale", estBasis: "sale", tables: new Set(), borrowed: {}, missing: null };
const charts = {};
let map, renderer, cells, cutDots, reoDots, gridShown = null, fitPending = null, rentWin = "month";
const breaks = {};

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
const gs = (x) => (x == null ? "-" : "Gs " + nf.format(Math.round(x)));
const gsM = (x) => (x == null ? "-" : Math.abs(x) >= 1e6 ? "Gs " + +(x / 1e6).toFixed(2) + "M" : gs(x));
const money = (x, cur) => (x == null ? "-" : cur === "PYG" ? gs(x) : usd(x));
const pct = (x) => (x == null ? "-" : (x > 0 ? "+" : "") + x.toFixed(1) + "%");
const signed = (x) => (x == null ? "-" : (x > 0 ? "+" : x < 0 ? "-" : "") + num(Math.abs(x)));
const share = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const day = (iso) => { const [y, m, d] = iso.slice(0, 10).split("-"); return `${+d} ${MONTHS[m - 1]} ${y}`; };
const dayShort = (iso) => day(iso).slice(0, -5);
const monthYear = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
const quarterName = (iso) => `Q${Math.floor((+iso.slice(5, 7) - 1) / 3) + 1} ${iso.slice(0, 4)}`;
const addDays = (iso, n) => new Date(Date.parse(iso.slice(0, 10) + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const norm = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const kindName = (k) => KINDS[k] || k;
const srcName = (c) => SOURCES[c] || c;
const market = () => D.byId.get(S.market);
const here = (row) => row.mk.includes(S.market);
const tag = (closed) => h("span", { class: closed ? "tag closed" : "tag", text: closed ? "CLOSED" : "ASKING" });
const stamp = (id, closed, text) => $(id).replaceChildren(tag(closed), text);
const nLabel = (d, min) => `n ${num(d.n)}, below ${min}`;
const ext = (href, text, label) => (href
  ? h("a", { href, target: "_blank", rel: "noopener noreferrer", class: "ext", "aria-label": label, title: label, text })
  : h("span", { text, title: "No verified page pattern for this source" }));
const newTag = (r) => (r.new ? h("span", { class: "newtag", title: "Not on file at the previous day's build", text: "NEW" }) : null);
const hhmm = (iso) => iso.slice(11, 16);
const PARTICLES = new Set(["de", "del", "la", "las", "los", "y"]);
const titleSlug = (s) => s.split("-").filter(Boolean).map((w, i) => (i && PARTICLES.has(w) ? w : w[0].toUpperCase() + w.slice(1))).join(" ");

// Top three sources by share, the rest folded into "others".
function mixText(counts) {
  const e = Object.entries(counts || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const tot = e.reduce((a, [, n]) => a + n, 0);
  if (!tot) return null;
  const rest = e.slice(3).reduce((a, [, n]) => a + n, 0);
  return e.slice(0, 3).map(([c, n]) => `${srcName(c)} ${share(n, tot)}`).join(", ") + (rest ? `, others ${share(rest, tot)}` : "");
}
const sumKinds = (byKind, kinds) => {
  const out = {};
  for (const k of kinds) for (const [c, n] of Object.entries(byKind?.[k] || {})) out[c] = (out[c] || 0) + n;
  return out;
};
const exclusionNote = () => D.summary.medians.excluded.map((x) =>
  `${srcName(x.code)} excluded from asking medians until price coverage completes: ${Math.round(x.priced_share * 100)}% today.`).join(" ");
const andList = (a) => (a.length > 1 ? `${a.slice(0, -1).join(", ")} and ${a.at(-1)}` : a[0] || "none");
const counted = () => D.summary.windows.filter((w) => w.pulled);
function seenRule() {
  const w = counted(), full = w.find((x) => x.role === "full_universe");
  const others = w.filter((x) => x.since !== full?.since);
  return `seen by our capture on or after ${full ? dayShort(full.since) : "-"}` +
    (others.length ? ` (${others.map((x) => `${dayShort(x.since)} for ${srcName(x.code)}`).join(", ")})` : "");
}
// The latest change in a tile's source set, from the series: its figures before and after that day
// are not like for like, so the tile says so with the date.
function sourceFlag(key) {
  const c = D.summary.source_changes?.[key];
  if (!c) return null;
  const parts = [c.joined.length && `${andList(c.joined.map(srcName))} joined`, c.left.length && `${andList(c.left.map(srcName))} left`].filter(Boolean);
  return `Sources changed ${dayShort(c.date)}: ${parts.join(", ")}. Figures before and after are not like for like.`;
}
// A market too thin for a chart borrows the nearest larger market that has the data, named on the
// chart and in its table, rather than showing an empty frame.
function borrow(test) {
  for (let m = market(); m; m = D.byId.get(m.parent)) if (test(m.id)) return m;
  return null;
}
function borrowNote(id, text) {
  const box = $(id), prev = box.previousElementSibling;
  if (prev?.classList.contains("borrow")) prev.remove();
  if (text) box.before(h("div", { class: "borrow", text }));
}

// ---------- data ----------
async function load() {
  const get = (f) => fetch("data/" + f, { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`${f} returned HTTP ${r.status}`);
    return r.json();
  });
  // The estimate is optional: a build whose estimate step failed still renders every measured panel.
  const [summary, markets, trends, movers, geo, closes, estimate] = await Promise.all([...["summary.json", "markets.json", "trends.json",
    "movers.json", "geo.json", "closes.json"].map(get), get("estimate.json").catch(() => null)]);
  Object.assign(D, { summary, markets: markets.markets, trends, movers, geo, closes, estimate });
  D.byId = new Map(D.markets.map((m) => [m.id, m]));
}

// The RE/MAX panel is rebuilt daily from whole-panel captures, so its change over about a week is
// like for like: the same source, the same rules, guarani asks at one rate.
function remaxChange(metric, kind) {
  const r = D.trends.asking_remax_daily, rs = r.markets[S.market];
  const arr = kind ? rs?.[metric]?.[kind] : rs?.[metric];
  if (!arr) return null;
  const val = (x) => (x == null ? null : Array.isArray(x) ? x[0] : x);
  let last = -1;
  for (let i = arr.length - 1; i >= 0; i--) if (val(arr[i]) != null) { last = i; break; }
  if (last < 1) return null;
  const target = addDays(r.days[last], -7);
  for (let i = last - 1; i >= 0; i--) {
    if (r.days[i] > target || val(arr[i]) == null) continue;
    const a = val(arr[last]), b = val(arr[i]);
    return { from: r.days[i], to: r.days[last], level: a, diff: a - b, rel: b ? (a - b) / b : null, n: Array.isArray(arr[last]) ? arr[last][1] : null };
  }
  return null;
}
// The change is RE/MAX's own median, not the pooled one on the tile, so its level prints beside it:
// a median of round asks moves in steps from one round price to the next.
function remaxDelta(metric, kinds) {
  const fmt = metric === "sale" ? usdK : usd;
  const parts = kinds.map((k) => [k, remaxChange(metric, k)]).filter(([, c]) => c);
  if (!parts.length) return "RE/MAX panel: no like-for-like reading for these kinds here";
  const c0 = parts[0][1];
  return `RE/MAX panel alone, ${dayShort(c0.to)} against ${dayShort(c0.from)}: ` +
    parts.map(([k, c]) => `${SHORT[k] || k} ${fmt(c.level)}, ${pct(c.rel * 100)} (n ${num(c.n)})`).join("; ");
}

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
  S.missing = null;
  if (id === "py") history.pushState(null, "", location.pathname + location.search);
  else location.hash = "m=" + encodeURIComponent(id);
  S.market = id;
  render();
}
// A link to a market that has no page today (a city under the listing threshold, or a label spread
// too wide) opens its department, or Paraguay, and says so instead of switching silently.
function fromHash() {
  const m = /m=([^&]+)/.exec(location.hash), id = m && decodeURIComponent(m[1]);
  S.missing = null;
  if (!id || D.byId.has(id)) return id || "py";
  const [level, dept, city] = id.split(":");
  const to = level === "c" && D.byId.has(`d:${dept}`) ? `d:${dept}` : "py";
  S.missing = { name: titleSlug(city || dept || id), to };
  return to;
}

function renderHero(m) {
  const chain = [];
  for (let x = m; x; x = D.byId.get(x.parent)) chain.unshift(x);
  $("crumbs").replaceChildren(...chain.flatMap((x, i) => [i ? " / " : "", x === m ? x.name : h("button", { type: "button", text: x.name, onclick: () => select(x.id) })]));
  $("title").textContent = m.name;
  $("pick-btn").textContent = m.name;
  const miss = S.missing && S.missing.to === m.id ? S.missing : null;
  $("missing").hidden = !miss;
  $("missing").textContent = miss ? `There is no ${miss.name} page in today's build: a city gets one at ${num(D.summary.city_min_active_sale)} active sale listings ` +
    `and a label that spreads under ${num(D.summary.city_max_spread_km)} km. This is ${m.name}.` : "";
  document.title = m.id === "py" ? "Tekoha Market Dashboard" : `${m.name}: Tekoha Market Dashboard`;
  const a = m.asking_active;
  $("lede").className = "";
  $("lede").textContent = `${num(a.total)} active listings, ${seenRule()}: ${num(a.sale_total)} for sale, ${num(a.rent_total)} for rent` +
    `${a.other ? `, ${num(a.other)} with no operation stated` : ""}${m.note ? ` (${m.note})` : ""}` +
    `${m.id === "py" ? `, of ${num(D.summary.tracked)} listings tracked in all` : ""}. ` +
    "Asking figures unless tagged closed; every figure carries its n and window.";
}

// ---------- since yesterday ----------
// The morning email's 26-hour counts for this market, then how many rows further down are NEW
// against the latest build of an earlier day.
function renderChanged(m) {
  const w = D.summary.changed, c = m.asking_changed_26h, base = w.baseline;
  const items = [[c.cuts, "price cut", "price cuts"], [c.increases, "price rise", "price rises"], [c.new, "new to market", "new to market"],
    [c.delisted, "delisted", "delisted"], [c.went_sold, "marked sold", "marked sold"], [c.went_rented, "marked rented", "marked rented"]];
  const line = items.reduce((a, [n]) => a + n, 0)
    ? h("p", {}, "Last 26 hours: ", ...items.flatMap(([n, one, many], i) => [i ? ", " : "", h("b", { text: num(n) }), ` ${n === 1 ? one : many}`]), ".")
    : h("p", { text: `Nothing moved in ${m.name} in the last 26 hours: no price cut or rise, no new listing, no delisting, no listing flagged sold or rented.` });
  const cuts = D.movers.asking_cuts_7d.filter(here), fresh = freshShown(), closes = ["sale", "rent"].flatMap(closesShown);
  const tagged = (rows) => `${num(rows.filter((r) => r.new).length)} of ${num(rows.length)}`;
  const tags = base
    ? `Tagged NEW below, against the build of ${dayShort(base.as_of)} ${hhmm(base.as_of)} UTC: ${tagged(cuts)} cut-board rows, ${tagged(fresh)} new-to-market rows, ${tagged(closes)} closes (both tabs).`
    : "Nothing below is tagged NEW yet: no build of an earlier day has recorded its rows, so the tags start with the next day's build.";
  $("changed").replaceChildren(line, h("div", { class: "stamp" }, tag(false),
    ` listing events in ${m.name}, ${dayShort(w.since)} ${hhmm(w.since)} to ${dayShort(w.until)} ${hhmm(w.until)} UTC, stock sources, one count per listing event, the morning email's definitions. ${tags}`));
}

// ---------- KPI row ----------
function kpi(title, body, { delta, closed = false, stampText, mix, flag, own } = {}) {
  return h("div", { class: "kpi" }, h("h3", { text: title }), body,
    mix && h("div", { class: "mix", text: `Sources: ${mix}` }),
    flag && h("div", { class: "srcflag", text: flag }),
    own && h("div", { class: "delta", text: own }),
    delta && h("div", { class: "delta", text: delta }),
    h("div", { class: "stamp" }, tag(closed), stampText));
}
// The Active tile's own change against the previous build day, split by source, so a crawl rolling
// out of its window reads as that source and not as the market. Country only: the split is national.
function activeOwnChange(m) {
  const c = D.summary.active_change;
  if (m.id !== "py" || !c) return null;
  const by = Object.entries(c.by_source).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).map(([k, d]) => `${srcName(k)} ${signed(d)}`);
  return `This count against ${dayShort(c.from)}: ${signed(c.diff)}${by.length ? ` (${by.join(", ")})` : ""}` +
    `${c.same_sources ? "" : ", counted sources differ"}.`;
}
function kindRows(dists, kinds, fmt, min) {
  const rows = kinds.filter((k) => dists[k]).map((k) => h("div", { class: "row" }, dists[k].suppressed
    ? [h("span", { class: "v none", text: "n/a" }), h("small", { text: `${kindName(k).toLowerCase()}, ${nLabel(dists[k], min)}` })]
    : [h("span", { class: "v", text: fmt(dists[k]) }), h("small", { text: `${kindName(k).toLowerCase()}, n ${num(dists[k].n)}` })]));
  return rows.length ? h("div", { class: "rows" }, rows) : h("div", { class: "empty", text: "No listings of these kinds" });
}
function statRows(items) {
  return h("div", { class: "rows" }, items.map(([v, label]) => h("div", { class: "row" }, h("span", { class: "v", text: v }), h("small", { text: label }))));
}
function renderKpis(m) {
  const s = D.summary, a = m.asking_active, f = m.asking_flow_30d, sp = m.closed_ask_to_close.sale.all, min = s.min_n.median;
  const fxLine = `USD at Gs ${num(s.fx.rate)}, SET mid ${dayShort(s.fx.date)}.`;
  const excl = exclusionNote();
  const act = remaxChange("count_sale");
  const ageSrc = s.sources.filter((x) => x.staleness_used).map((x) => srcName(x.code));
  const closesOnly = s.sources.filter((x) => x.role === "closes_only").map((x) => srcName(x.code));
  const agedOut = s.staleness_sources.filter((x) => !x.used).map((x) => srcName(x.code));
  $("kpis").replaceChildren(
    kpi("Active listings", [h("div", { class: "v", text: num(a.total) }),
      h("div", { class: "sub", text: `${num(a.sale_total)} sale, ${num(a.rent_total)} rent${a.other ? `, ${num(a.other)} no operation stated` : ""}` })], {
      flag: sourceFlag("stock_sources"), own: activeOwnChange(m),
      delta: act ? `RE/MAX panel alone, for sale: ${num(act.level)} on ${dayShort(act.to)}, ${signed(act.diff)} against ${dayShort(act.from)}` : null,
      stampText: ` ${seenRule()}. ${num(a.listed)} are listed as active on the counted sources; ${num(a.listed - a.total)} were not seen in that window.` +
        `${closesOnly.length ? ` ${andList(closesOnly)} ${closesOnly.length > 1 ? "count" : "counts"} nowhere: a partial crawl, and ${closesOnly.length > 1 ? "their" : "its"} closed records carry no price.` : ""}` }),
    kpi("Median ask, sale", kindRows(m.asking_price_usd, ["casa", "departamento"], (d) => usdK(d.median), min), {
      mix: mixText(sumKinds(m.asking_mix.sale, ["casa", "departamento"])), flag: sourceFlag("median_sources"),
      delta: remaxDelta("sale", ["casa", "departamento"]), stampText: ` ${fxLine} ${excl}` }),
    kpi("Median rent, monthly", kindRows(m.asking_rent_usd_month, ["departamento", "casa"], (d) => usd(d.median), min), {
      mix: mixText(sumKinds(m.asking_mix.rent, ["departamento", "casa"])), flag: sourceFlag("median_sources"),
      delta: remaxDelta("rent", ["departamento", "casa"]), stampText: ` ${fxLine} ${excl}` }),
    kpi("Ask-to-close, sales", sp.status
      ? [h("div", { class: "v small", text: "Insufficient closes" }), h("div", { class: "sub", text: `n ${num(sp.n)}, needs ${s.min_n.spread}` })]
      : statRows([
        [`${Math.round(sp.at_ask_pct)}%`, `reported price identical to the last ask, ${num(sp.at_ask)} of ${num(sp.n)}`],
        [pct(sp.p50), `median spread, all ${num(sp.n)} closes`],
        [sp.below_p50 == null ? "n/a" : pct(sp.below_p50), sp.below_p50 == null ? `reported below the ask, n ${num(sp.below)} below ${s.min_n.spread}`
          : `median of the ${num(sp.below)} reported below the ask`]]), {
      closed: true, stampText: sp.status ? " same-currency sales, RE/MAX network"
        : ` same-currency sales, RE/MAX network, ${monthYear(sp.first)} to ${monthYear(sp.last)}. A price identical to the ask is a full-price sale or a broker who left the ask in the sold field; the feed cannot say which.` }),
    kpi("Stock age, median", kindRows(m.asking_staleness_days, ["casa", "departamento"], (d) => `${num(d.p50)} days`, min), {
      flag: sourceFlag("age_sources"),
      stampText: ` days since publish, active sale listings, ${andList(ageSrc)}.` +
        `${agedOut.length ? ` ${andList(agedOut)} ${agedOut.length > 1 ? "sit" : "sits"} out: publish dates from one bulk load.` : ""}` }),
    kpi("Price cuts, 30 days", [h("div", { class: "v", text: num(f.all.cuts) }),
      h("div", { class: "sub", text: `${num(f.sale.cuts)} sale, ${num(f.rent.cuts)} rent; ${num(f.all.increases)} rises` })], {
      mix: mixText(m.asking_cuts_30d_by_source),
      stampText: ` ${dayShort(s.flow_window.from)} to ${dayShort(s.flow_window.to)}, cuts past -90% excluded.` }),
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
// Index of the cell field that names the market a dimmed view compares against.
const cellMarketField = (m) => (m.level === "department" ? 9 : m.level === "city" ? 10 : null);
function cellTip(c, deg, owner) {
  const line = (label, v, n) => h("div", {}, `${label}: `, v == null ? h("span", { class: "muted", text: `n ${n}, below 5` }) : h("b", { text: `${usd(v)}/m2` }), v == null ? "" : ` (n ${n})`);
  return h("div", {}, h("div", { class: "muted", text: `${deg} degree cell (${cellKm(deg)}) at ${c[0].toFixed(2)}, ${c[1].toFixed(2)}: ${num(c[2])} active sale listings` }),
    line("Departamento", c[7], c[8]), line("Casa", c[5], c[6]),
    h("div", {}, `Median ask, all kinds: ${c[3] == null ? "n below 5" : usd(c[3])}`),
    owner ? h("div", { class: "muted", text: `Mostly ${owner} listings, so dimmed in this view` }) : null,
    h("div", { class: "muted", text: "ASKING prices" }));
}
function cutTip(r) {
  return h("div", {}, h("b", { text: `${pct(r.pct)} ` }), `${kindName(r.kind)}${r.m2 ? ` ${r.m2} m2` : ""}`,
    h("div", { text: `${[r.area, r.place].filter(Boolean).join(", ") || "Paraguay"}` }),
    h("div", { text: `${money(r.asking_old, r.currency)} to ${money(r.asking_new, r.currency)}` }),
    h("div", { class: "muted", text: `ASKING, cut ${dayShort(r.observed)}, ${r.days_listed ?? "?"} days listed, ${srcName(r.source)}` }));
}
function reoTip(r) {
  return h("div", {}, h("b", { text: r.asking_base_net_usd == null ? "No published price" : `${usd(r.asking_base_net_usd)} net base` }),
    h("div", { text: `${kindName(r.kind)}${r.items > 1 ? `, ${r.items} identical lots` : ""}, ${reoPlace(r)}` }),
    h("div", { class: "muted", text: `Bank REO, ${BANKS[r.bank] || r.bank} item ${r.item}${r.land_m2 ? `, land ${num(r.land_m2)} m2` : ""}` }));
}
function fitTo(bbox) {
  const el = $("map");
  // A zero-size container (first paint, a hidden tab) would fit Paraguay to a single tile.
  if (!el.clientWidth || !el.clientHeight) { fitPending = bbox; return; }
  fitPending = null;
  map.invalidateSize();
  // No zoom animation: an animated fit interrupted by a tab switch can leave the map mid-zoom.
  map.fitBounds(bbox, { padding: [18, 18], maxZoom: 14, animate: false });
}
function buildMap() {
  map = L.map("map", { preferCanvas: true, scrollWheelZoom: false, zoomSnap: 0.5 }).setView([-23.4, -58.2], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());
  // One canvas for cells and dots: Leaflet hit-tests per canvas, so a dot canvas stacked on top
  // swallowed every hover meant for the cells beneath it.
  renderer = L.canvas({ tolerance: 5 });
  // Breaks come from the 1 km grid and serve every zoom, so a color means the same USD/m2 everywhere.
  for (const [kind, col] of [["casa", 5], ["departamento", 7]]) breaks[kind] = quantileBreaks(D.geo.grids[0].cells.map((c) => c[col]).filter((v) => v != null));
  cells = L.layerGroup().addTo(map);
  cutDots = L.layerGroup().addTo(map);
  reoDots = L.layerGroup();
  map.on("zoomend", () => drawCells(false));
  new ResizeObserver(() => { map.invalidateSize(); if (fitPending) fitTo(fitPending); }).observe($("map"));
}
function raiseDots() {
  for (const g of [cutDots, reoDots]) if (map.hasLayer(g)) g.eachLayer((l) => l.bringToFront());
}
function drawCells(force) {
  const g = gridFor(map.getZoom());
  if (!force && g === gridShown) return;
  gridShown = g;
  cells.clearLayers();
  const half = g.deg / 2, m = market(), field = cellMarketField(m), mi = D.geo.markets.indexOf(m.id);
  for (const c of g.cells) {
    const v = cellValue(c);
    if (v == null) continue;
    const inside = field == null || c[field] === mi;
    const owner = inside ? null : D.byId.get(D.geo.markets[c[field]])?.name || "other";
    L.rectangle([[c[0] - half, c[1] - half], [c[0] + half, c[1] + half]], { renderer, stroke: false, fillColor: rampColor(v), fillOpacity: inside ? 0.8 : 0.16 })
      .bindTooltip(() => cellTip(c, g.deg, owner), { sticky: true }).addTo(cells);
  }
  raiseDots();
  renderLegend();
}
const popup = (r, tip, name) => h("div", {}, tip(r), r.url ? h("div", { class: "pop-link" }, ext(r.url, `Open on ${name}`, `Open on ${name} (new tab)`)) : null);
function dots(group, rows, color, tip, nameOf) {
  group.clearLayers();
  for (const r of rows) if (r.lat != null) {
    L.circleMarker([r.lat, r.lon], { renderer, radius: 6, color: INK, weight: 2, fillColor: color, fillOpacity: 1 })
      .bindTooltip(() => tip(r)).bindPopup(() => popup(r, tip, nameOf(r)))
      .on("popupopen", (e) => e.target.closeTooltip()).addTo(group);
  }
}
function renderMap(m, refit = true) {
  dots(cutDots, D.movers.asking_cuts_7d.filter(here), CUT_DOT, cutTip, (r) => srcName(r.source));
  dots(reoDots, D.movers.reo_parcels.filter(here), REO_DOT, reoTip, (r) => `${BANKS[r.bank] || r.bank}${r.url_is_item ? "" : " (bank list)"}`);
  if (refit && m.bbox) fitTo(m.bbox);
  drawCells(true);
  const mp = D.summary.map;
  stamp("map-stamp", false, ` cells with 5 or more listings of the kind: 0.01 degree (about 1 km) when zoomed in, 0.05 and 0.25 degree further out, each its own median, ` +
    `asking prices from the sources in the medians. Color breaks are country-wide sextiles of the 1 km cells. In a department or city view, cells whose listings mostly belong elsewhere are dimmed. ` +
    `${num(mp.mapped)} active listings mapped; ${num(mp.placeholder)} sit on ${num(mp.placeholder_points)} points shared by ${mp.placeholder_min} or more listings (a geocoder's city or barrio center) and ` +
    `${num(mp.no_coordinates)} have no coordinates, so they count in their market but are not drawn. Click a dot to open its listing.`);
}
function renderLegend() {
  if (!gridShown) return;
  const cutsHere = D.movers.asking_cuts_7d.filter(here), reoHere = D.movers.reo_parcels.filter(here), b = breaks[S.cellKind], m = market();
  const mp = m.asking_map, act = m.asking_active.total, off = act - mp.mapped;
  $("legend").replaceChildren(
    h("span", { class: "offmap", text: `${share(off, act)} of the ${num(act)} active listings here are not drawn: ${num(mp.placeholder)} sit on a shared placeholder point, ` +
      `${num(mp.no_coordinates)} have no coordinates. They count in every figure but not in the map cells.` }),
    h("span", {}, `Median asking USD per built m2, ${kindName(S.cellKind).toLowerCase()}, ${cellKm(gridShown.deg)} cells: `),
    h("span", { class: "ramp" }, RAMP.slice(0, b.length + 1).map((col, i) => h("span", {}, h("i", { style: `background:${col}` }), i ? num(b[i - 1]) + (i === b.length ? "+" : "") : `< ${num(b[0])}`))),
    h("span", {}, h("span", { class: "key", style: `background:${CUT_DOT}` }), ` ${cutsHere.filter((r) => r.lat != null).length} of ${cutsHere.length} cuts mapped`),
    h("span", {}, h("span", { class: "key", style: `background:${REO_DOT}` }), ` ${reoHere.filter((r) => r.lat != null).length} of ${reoHere.length} REO rows mapped`),
    ...(cellMarketField(m) != null ? [h("span", { class: "muted", text: `Cells mostly outside ${m.name} are dimmed` })] : []));
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
  ticks: { callback: fmt, maxTicksLimit: 5 }, afterFit: (s) => { s.width = 64; }, ...extra });
const xAxis = (fmt, extra = {}) => ({ grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7,
  callback(v) { return fmt(this.getLabelForValue(v)); } }, ...extra });
function makeChart(id, type, options) {
  return new Chart($(id).querySelector("canvas"), { type, data: { labels: [], datasets: [] },
    options: { interaction: { mode: "index", intersect: false }, ...options } });
}
// An empty chart is not drawn at all: its canvas collapses to a one-line note, so a market with no
// data never shows a blank frame with placeholder axis ticks.
function empty(id, text) {
  const box = $(id);
  box.classList.toggle("is-empty", !!text);
  box.querySelector(".note")?.remove();
  if (text) box.append(h("div", { class: "note" }, h("span", { text })));
}
function buildCharts() {
  chartDefaults();
  charts.flow = makeChart("c-flow", "bar", { scales: { x: xAxis(dayShort, { stacked: true }), y: yAxis(num, { stacked: true }) },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { title: (it) => day(it[0].label) } } } });
  charts.closes = makeChart("c-closes", "bar", { scales: { x: xAxis(monthYear), y: yAxis(num) },
    plugins: { legend: { display: false }, tooltip: { callbacks: { title: (it) => `Week of ${day(it[0].label)}`, label: (c) => ` ${num(c.raw)} priced closes` } } } });
  charts.spreadq = makeChart("c-spreadq", "line", { scales: { x: xAxis(quarterName, { offset: true }), y: yAxis(pct, { beginAtZero: true }) },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { title: (it) => quarterTitle(it[0].label),
      label: (c) => { const r = c.dataset.rows[c.dataIndex]; return ` ${c.dataset.label}: ${pct(c.raw)} median, n ${num(r[1])}, ${Math.round(r[3])}% report the ask${r[4] != null ? `, ${pct(r[4])} median below it` : ""}`; } } } } });
  charts.rent = makeChart("c-rent", "line", { scales: { x: xAxis((v) => (rentWin === "month" ? monthYear(v) : quarterName(v))),
    y: yAxis(gsM, { beginAtZero: false }), usd: yAxis(usd, { position: "right", beginAtZero: false, display: false, grid: { display: false } }) },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { title: (it) => (rentWin === "month" ? monthYear(it[0].label) : quarterTitle(it[0].label)),
      label: rentLabel } } } });
  charts.series = makeChart("c-series", "line", { scales: { x: xAxis(dayShort, { offset: true }), y: yAxis((v) => seriesFmt()(v), { beginAtZero: false }) },
    plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { title: (it) => day(it[0].label),
      label: (c) => ` ${c.dataset.label}: ${seriesFmt()(c.raw)} (n ${num(c.dataset.ns[c.dataIndex])})` } } } });
}
const lastIndex = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i; return -1; };
// Markers on the latest point and on any point with no neighbour, which a line alone would not draw.
const lineSet = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, tension: 0,
  spanGaps: false, borderJoinStyle: "round", borderCapStyle: "round", pointBackgroundColor: color, pointBorderColor: "#1e1914",
  pointBorderWidth: 2, pointHoverRadius: 5,
  pointRadius: (c) => { const d = c.dataset.data, i = c.dataIndex; return i === lastIndex(d) || (d[i] != null && d[i - 1] == null && d[i + 1] == null) ? 4 : 0; },
  ...extra });
const weeksFrom = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 7)) out.push(d); return out; };
const monthsFrom = (from, to) => { const out = []; for (let y = +from.slice(0, 4), mo = +from.slice(5, 7); `${y}-${String(mo).padStart(2, "0")}` <= to.slice(0, 7); mo === 12 ? (y++, mo = 1) : mo++) out.push(`${y}-${String(mo).padStart(2, "0")}-01`); return out; };
const quarterStart = (iso) => `${iso.slice(0, 4)}-${String(Math.floor((+iso.slice(5, 7) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
const quartersFrom = (from, to) => { const out = []; for (let q = quarterStart(from); q <= to; q = monthsFrom(q, addDays(q, 100))[3]) out.push(q); return out; };
function quarterTitle(q) {
  const from = D.trends.closed_quarterly.from, parts = [quarterName(q)];
  if (quarterStart(from) === q && from > q) parts.push(`from ${dayShort(from)}`);
  if (quarterStart(D.summary.date) === q) parts.push("in progress");
  return parts.join(", ");
}

function renderFlow() {
  const t = D.trends.asking_flow_daily, f = t.markets[S.market];
  charts.flow.data = { labels: t.days, datasets: FLOW.map(([k, label, color]) => ({ label, data: f[k], backgroundColor: color,
    borderColor: "#1e1914", borderWidth: { top: 2, right: 0, bottom: 0, left: 0 }, borderSkipped: false, borderRadius: 2, maxBarThickness: 24 })) };
  charts.flow.update();
  stamp("flow-stamp", false, ` listing events per capture day, all operations, ${day(t.days[0])} to ${day(t.days.at(-1))}. ` +
    `A missing bar means no capture ran that day. The series starts the day after our first capture (${day(D.summary.history_start)}).`);
}
function renderCloses() {
  const op = S.closeOp, t = D.trends, rows = t.closed_weekly.markets[S.market][op];
  const monday = addDays(D.summary.date, -((new Date(D.summary.date + "T00:00:00Z").getUTCDay() + 6) % 7));
  const weeks = weeksFrom(t.closed_weekly.from, monday), byWeek = new Map(rows);
  const total = rows.reduce((a, r) => a + r[1], 0);
  charts.closes.data = { labels: weeks, datasets: [{ data: weeks.map((w) => byWeek.get(w) ?? 0), backgroundColor: GOLD, maxBarThickness: 24, borderRadius: 1 }] };
  charts.closes.update();
  const what = op === "sale" ? "sales" : "rentals";
  empty("c-closes", total ? "" : `No broker-reported ${what} with a price in this market since ${monthYear(t.closed_weekly.from)}`);

  const quarters = quartersFrom(t.closed_quarterly.from, D.summary.date);
  const kinds = ["all", ...(op === "sale" ? ["casa", "departamento", "terreno", "duplex"] : ["departamento", "casa"])];
  const drawn = (id) => kinds.filter((k) => t.closed_quarterly.markets[id][op][k]?.some((x) => x[2] != null));
  const src = borrow((id) => drawn(id).length > 0), lent = src && src.id !== S.market;
  S.borrowed.closes = src?.id ?? S.market;
  const qd = t.closed_quarterly.markets[S.borrowed.closes][op];
  const sets = (src ? drawn(src.id) : []).map((k) => {
    const byQ = new Map(qd[k].map((x) => [x[0], x]));
    return lineSet(`${lent ? `${src.name}: ` : ""}${k === "all" ? "All kinds" : kindName(k)}`, quarters.map((p) => byQ.get(p)?.[2] ?? null),
      k === "all" ? GOLD : KIND_COLOR[k], { rows: quarters.map((p) => byQ.get(p) || null), borderWidth: k === "all" ? 3 : 2, pointRadius: 3 });
  });
  charts.spreadq.data = { labels: quarters, datasets: sets };
  charts.spreadq.update();
  empty("c-spreadq", sets.length ? "" : `No quarter reaches ${D.summary.min_n.spread} same-currency ${what} anywhere`);
  borrowNote("c-spreadq", lent ? `No quarter in ${market().name} reaches ${D.summary.min_n.spread} same-currency ${what}; the lines are ${src.name}'s.` : "");

  const before = D.summary.closes.before[op];
  stamp("closes-stamp", true, ` ${num(total)} priced ${what} from the RE/MAX network since ${day(t.closed_weekly.from)}, by close date; the latest week is in progress. ` +
    (before ? `Before that the feed shows only ${num(before.before)} ${what} back to ${monthYear(before.first)} (country-wide), the closed listings RE/MAX still indexes, so the chart starts where coverage does. ` : "") +
    `Ask-to-close by quarter: same-currency ${what}, lines where a kind has ${D.summary.min_n.spread} or more in the quarter.`);
}
const rentFx = (p) => (rentWin === "month" ? D.trends.closed_rent.fx_monthly[p.slice(0, 7)] : D.trends.closed_rent.fx_quarterly[p.slice(0, 7)]);
function rentLabel(c) {
  const d = c.dataset, n = d.ns[c.dataIndex];
  if (d.cur === "USD") return ` ${d.label}: ${usd(c.raw)} a month (n ${num(n)})`;
  const rate = rentFx(c.label);
  return ` ${d.label}: ${gs(c.raw)} a month (n ${num(n)})${rate ? `, about ${usd(c.raw / rate)} at the ${rentWin}'s average SET rate (FX-converted)` : ""}`;
}
// Quarters, not months: one month holds too few leases of one kind for a steady median. The quarter
// in progress is drawn hollow, with a dashed line into it, so a part-quarter never reads as a full one.
function rentChoice(id) {
  const rc = D.trends.closed_rent.markets[id];
  return { win: "quarter", sets: Object.entries(rc.quarter).filter(([, rows]) => rows.some((x) => x[2] != null)) };
}
const PANEL = "#1e1914";
function renderRent() {
  const src = borrow((id) => rentChoice(id).sets.length > 0), lent = src && src.id !== S.market, from = D.trends.closed_rent.from;
  S.borrowed.rent = src?.id ?? S.market;
  const { win, sets } = rentChoice(S.borrowed.rent);
  rentWin = win;
  const labels = quartersFrom(from, D.summary.date), live = quarterStart(D.summary.date);
  const open = (i) => labels[i] === live;
  const order = ["departamento", "casa", "duplex"];
  const ds = sets.sort((a, b) => order.indexOf(a[0].split("|")[0]) - order.indexOf(b[0].split("|")[0])).map(([key, rows]) => {
    const [kind, cur] = key.split("|"), byP = new Map(rows.map((x) => [x[0], x])), color = KIND_COLOR[kind] || GOLD;
    return lineSet(`${lent ? `${src.name}: ` : ""}${kindName(kind)}${cur === "USD" ? ", settled in USD" : ""}`, labels.map((p) => byP.get(p)?.[2] ?? null),
      color, { ns: labels.map((p) => byP.get(p)?.[1] ?? 0), cur, yAxisID: cur === "USD" ? "usd" : "y", borderDash: cur === "USD" ? [5, 4] : undefined,
        pointBackgroundColor: (c) => (open(c.dataIndex) ? PANEL : color), pointBorderColor: (c) => (open(c.dataIndex) ? color : PANEL),
        segment: { borderDash: (c) => (open(c.p1DataIndex) ? [3, 4] : undefined) } });
  });
  const liveDrawn = ds.some((d) => d.data[labels.indexOf(live)] != null);
  charts.rent.options.scales.usd.display = ds.some((d) => d.cur === "USD");
  charts.rent.options.scales.y.display = ds.some((d) => d.cur === "PYG");
  charts.rent.data = { labels, datasets: ds };
  charts.rent.update();
  const all = Object.entries(D.trends.closed_rent.markets[S.market].month);
  const nCur = (cur) => all.filter(([k]) => k.endsWith(`|${cur}`)).reduce((a, [, rows]) => a + rows.reduce((b, x) => b + x[1], 0), 0);
  const pyg = nCur("PYG"), dollars = nCur("USD");
  empty("c-rent", ds.length ? "" : `No quarter anywhere reaches ${D.summary.min_n.median} rented closes of one kind in one currency`);
  borrowNote("c-rent", lent ? `${market().name} has ${num(pyg + dollars)} rented departamentos, casas and duplexes since ${day(from)}, no quarter at ${D.summary.min_n.median} of one kind; the lines are ${src.name}'s.` : "");
  const liveNote = !ds.length ? "" : liveDrawn
    ? ` The last point, ${quarterName(live)} to ${dayShort(D.summary.date)}, is a quarter in progress: hollow, with a dashed line into it.`
    : ` ${quarterName(live)} so far has fewer than ${D.summary.min_n.median} of one kind, so no point yet.`;
  stamp("rent-stamp", true, ` median monthly rent by quarter, departamentos, casas and duplexes, in the currency each lease settled in, RE/MAX network since ${day(from)}.${liveNote} ` +
    `${lent ? "Here" : "In this market"}: ${num(pyg)} of those rentals settled in guaraníes, ${num(dollars)} in dollars${dollars && !ds.some((d) => d.cur === "USD") && !lent ? ", too few for a dollar line; they are in the table" : ""}. ` +
    `Points need ${D.summary.min_n.median} closes of one kind; closes outside the rent bands are left out (${num(D.summary.rent_closes_out_of_band)} country-wide). The tooltip's USD figure is FX-converted, not a dollar rent.`);
}
const seriesFmt = () => (S.metric === "sale" ? usdK : usd);
function renderSeries() {
  const r = D.trends.asking_remax_daily, min = D.summary.min_n.median;
  const kinds = S.metric === "rent" ? ["departamento", "casa"] : ["casa", "departamento"];
  const src = borrow((id) => kinds.some((k) => r.markets[id]?.[S.metric]?.[k])), lent = src && src.id !== S.market;
  S.borrowed.series = src?.id ?? S.market;
  const rs = r.markets[S.borrowed.series];
  const sets = kinds.filter((k) => rs?.[S.metric]?.[k]).map((k) => lineSet(`${lent ? `${src.name}: ` : ""}${kindName(k)}`,
    rs[S.metric][k].map((x) => x?.[0] ?? null), KIND_COLOR[k], { ns: rs[S.metric][k].map((x) => x?.[1] ?? null) }));
  borrowNote("c-series", lent ? `RE/MAX has fewer than ${min} active ${kinds.map((k) => kindName(k).toLowerCase() + "s").join(" or ")} in ${market().name} on every day; the lines are ${src.name}'s.` : "");
  // A daily median moves a percent or two; an axis hugging the data would draw that as a cliff.
  const vals = sets.flatMap((s) => s.data).filter((v) => v != null);
  Object.assign(charts.series.options.scales.y, vals.length
    ? { suggestedMin: Math.min(...vals) * 0.9, suggestedMax: Math.max(...vals) * 1.1 } : { suggestedMin: undefined, suggestedMax: undefined });
  charts.series.data = { labels: r.days, datasets: sets };
  charts.series.update();
  const what = { sale: "median ask", m2: "median USD per built m2", rent: "median monthly rent" }[S.metric];
  empty("c-series", sets.length ? "" : `RE/MAX has fewer than ${min} active ${kinds.map((k) => kindName(k).toLowerCase() + "s").join(" or ")} on every day anywhere, so no daily median`);
  stamp("series-stamp", false, ` daily ${what} of RE/MAX listings active at each day's end, ${day(r.days[0])} to ${day(r.days.at(-1))}, rebuilt from our captures of the whole RE/MAX panel. ` +
    `Guaraní asks convert at today's SET mid (Gs ${num(r.fx.rate)}) for every day, so exchange-rate moves do not show as price moves. One source on purpose: its moves are its asks and stock, not our crawl. ` +
    `A gap is a day without a capture; a day needs ${min} listings of the kind.`);
}

// Every chart has a table twin, so no value is reachable only by hovering.
const TWINS = {
  flow: () => [[["Date", ...FLOW.map((f) => f[1])], D.trends.asking_flow_daily.days.map((d, i) => [day(d),
    ...FLOW.map(([k]) => D.trends.asking_flow_daily.markets[S.market][k][i] ?? "no capture")])]],
  closes: () => {
    const op = S.closeOp, id = S.borrowed.closes || S.market, qd = D.trends.closed_quarterly.markets[id][op];
    const qRows = Object.entries(qd).flatMap(([k, rs]) => rs.map((r) => [r[0], k === "all" ? "All kinds" : kindName(k), num(r[1]),
      r[2] == null ? `n below ${D.summary.min_n.spread}` : pct(r[2]), r[3] == null ? "-" : `${Math.round(r[3])}%`,
      r[4] == null ? `n ${num(r[5])}` : `${pct(r[4])} (n ${num(r[5])})`])).sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
      .map((r) => [quarterTitle(r[0]), ...r.slice(1)]);
    return [[[`Quarter${id === S.market ? "" : `, ${D.byId.get(id).name}`}`, "Kind", "Closes", "Median spread", "Price identical to ask", "Median below ask"], qRows],
      [["Week of", "Priced closes"], D.trends.closed_weekly.markets[S.market][op].slice().reverse().map((r) => [day(r[0]), num(r[1])])]];
  },
  rent: () => {
    const id = S.borrowed.rent || S.market, rc = D.trends.closed_rent.markets[id][rentWin];
    const rows = Object.entries(rc).flatMap(([key, rs]) => { const [kind, cur] = key.split("|"); return rs.map((r) => [r[0], kindName(kind), cur === "PYG" ? "Guaraníes" : "Dollars", num(r[1]),
      r[2] == null ? `n below ${D.summary.min_n.median}` : money(r[2], cur), cur === "PYG" && r[2] != null && rentFx(r[0]) ? usd(r[2] / rentFx(r[0])) : "-"]); })
      .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)).map((r) => [rentWin === "month" ? monthYear(r[0]) : quarterTitle(r[0]), ...r.slice(1)]);
    return [[[`${rentWin === "month" ? "Month" : "Quarter"}${id === S.market ? "" : `, ${D.byId.get(id).name}`}`, "Kind", "Settled in", "Rented closes", "Median rent", "USD, FX-converted"], rows]];
  },
  series: () => {
    const r = D.trends.asking_remax_daily, id = S.borrowed.series || S.market, rs = r.markets[id]?.[S.metric] || {};
    const rows = [];
    for (let i = r.days.length - 1; i >= 0; i--) for (const [k, arr] of Object.entries(rs)) {
      rows.push([day(r.days[i]), kindName(k), arr[i] == null ? "no capture" : arr[i][0] == null ? `n below ${D.summary.min_n.median}` : seriesFmt()(arr[i][0]), arr[i] == null ? "-" : num(arr[i][1])]);
    }
    return [[[`Date${id === S.market ? "" : `, ${D.byId.get(id).name}`}`, "Kind", "Median", "n"], rows]];
  },
};
function renderTwins() {
  for (const key of Object.keys(TWINS)) {
    const btn = document.querySelector(`[data-table="${key}"]`), panel = btn.closest(".panel");
    panel.querySelectorAll(".twin").forEach((x) => x.remove());
    btn.textContent = S.tables.has(key) ? "Chart only" : "Table";
    btn.setAttribute("aria-pressed", String(S.tables.has(key)));
    if (!S.tables.has(key)) continue;
    const st = panel.querySelector(".stamp");
    for (const [head, rows] of TWINS[key]()) {
      st.before(h("div", { class: "tbl twin", style: "margin-top:10px;max-height:260px" },
        h("table", {}, h("thead", {}, h("tr", {}, head.map((c) => h("th", { text: c })))),
          h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", { text: c }))))))));
    }
  }
}

// ---------- tables ----------
// cols: [label, value(row) for sorting, display(row) or null, numeric?]
function table(boxId, cols, rows, { sort = 0, dir = 1, onRow, current, empty: none = "Nothing to show for this market" } = {}) {
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
  h("button", { type: "button", text: label, onclick: () => { st.dir = st.sort === i ? -st.dir : isNum ? -1 : 1; st.sort = i; table(boxId, cols, rows, { onRow, current, empty: none }); } }))));
  const body = sorted.map((r) => h("tr", { class: `${onRow ? "pickable" : ""}${current?.(r) ? " current" : ""}`, onclick: onRow ? () => onRow(r) : null },
    cols.map(([, val, show, isNum]) => { const out = show ? show(r) : val(r); return h("td", { class: isNum ? "num" : null }, out ?? "-"); })));
  box.replaceChildren(rows.length ? h("table", {}, h("thead", {}, head), h("tbody", {}, body)) : h("div", { class: "empty", style: "padding:14px", text: none }));
}
const distCell = (d, fmt, min) => (!d ? null : d.suppressed ? h("span", { class: "muted", text: nLabel(d, min) })
  : h("span", {}, fmt(d.median ?? d.p50), h("small", { text: `n ${num(d.n)}` })));
const placeCell = (r) => [r.area, r.place].filter(Boolean).join(", ") || "Paraguay";
const srcCell = (r) => h("span", {}, ext(r.url, srcName(r.source), `Open this listing on ${srcName(r.source)} (new tab)`),
  r.brokers > 1 ? h("small", { text: `x${r.brokers}` }) : null);
const usdNote = (amt, cur, usdAmt) => (cur === "PYG" ? h("span", {}, money(amt, cur), h("small", { text: `about ${usdK(usdAmt)}` })) : money(amt, cur));
const reoPlace = (r) => [...new Set([r.area, r.city, r.department].filter(Boolean))].join(", ");
// The median a new listing is measured against: its kind in this market, or the nearest parent.
function kindMedian(mkId, kind) {
  for (let m = D.byId.get(mkId); m; m = D.byId.get(m.parent)) {
    const d = m.asking_usd_per_m2_built[kind];
    if (d && !d.suppressed) return { market: m, median: d.median };
  }
  return null;
}
// The same 30 the builder kept for this market: deepest below its kind median first.
function freshShown() {
  return D.movers.asking_new_7d.filter(here).map((r) => {
    const ref = kindMedian(S.market, r.kind);
    return { ...r, ref, disc: ref ? (r.asking_usd_m2 / ref.median - 1) * 100 : null };
  }).sort((a, b) => (a.disc == null) - (b.disc == null) || (a.disc ?? 0) - (b.disc ?? 0) || a.asking_usd_m2 - b.asking_usd_m2).slice(0, 30);
}
const closesShown = (op) => D.closes.rows.filter((r) => r.op === op && here(r))
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, D.closes.cap);
// The Tekoha estimate wears its own tag and ink wherever it appears (method notes, "The Tekoha estimate").
const estTag = () => h("span", { class: "tag estimate", text: "ESTIMATE" });
const pct1 = (x) => (x == null ? "-" : `${(x * 100).toFixed(1)}%`);
const bandPct = (b) => (b ? `${b[0] > 0 ? "+" : ""}${Math.round(b[0] * 100)}% to ${b[1] > 0 ? "+" : ""}${Math.round(b[1] * 100)}%` : "-");
const segLabel = (key) => { const [k, d] = key.split("|"); return `${kindName(k)}, ${D.byId.get(`d:${d.replace(/ /g, "-")}`)?.name || d}`; };
const estCell = (r) => (r.estimate
  ? h("span", { class: "estv", title: `Tekoha intrinsic estimate of the close price, a model: ${segLabel(r.estimate.segment)} segment, confidence ${r.estimate.confidence}, ${r.estimate.n_comps} comps` },
    usdK(r.estimate.est), h("small", { class: "under", text: `${usdK(r.estimate.low)} to ${usdK(r.estimate.high)}` }))
  : h("span", { class: "muted", title: "No estimate: the listing's segment abstains, or its kind, size or place cannot be read", text: "none" }));
const estNote = " Estimate: the Tekoha intrinsic estimate of the listing's close price with its segment's 80% band, a model and not a price (method notes); none where its segment abstains.";

function renderTables(m) {
  const min = D.summary.min_n.median, excl = exclusionNote();
  const medSrc = D.summary.medians.sources.map(srcName).join(", ").replace(/, ([^,]*)$/, " and $1");
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
  stamp("kinds-stamp", false, ` listings active and ${seenRule()}. Medians need n ${min} and use ${medSrc}. ${excl} Asks and rents in USD at the day's SET mid rate; USD/m2 on built area only, 40 to 800 m2, USD 30,000 to 2,000,000; age from ${D.summary.sources.filter((x) => x.staleness_used).map((x) => srcName(x.code)).join(", ")} only.`);

  const cuts = D.movers.asking_cuts_7d.filter(here);
  table("t-cuts", [["Cut", (r) => r.pct, (r) => h("span", {}, h("span", { class: "cut", text: pct(r.pct) }), newTag(r)), true],
    ["Now", (r) => r.asking_new_usd, (r) => usdNote(r.asking_new, r.currency, r.asking_new_usd), true],
    ["Estimate", (r) => r.estimate?.est, estCell, true],
    ["Was", (r) => r.asking_old, (r) => money(r.asking_old, r.currency), true], ["Place", placeCell], ["Kind", (r) => kindName(r.kind)],
    ["Built m2", (r) => r.m2, (r) => num(r.m2), true], ["Days listed", (r) => r.days_listed, null, true],
    ["Cut on", (r) => r.observed, (r) => dayShort(r.observed)], ["Listing", (r) => srcName(r.source), srcCell]],
  cuts, { sort: 0, dir: 1, empty: "No sale price cuts in this market in the last 7 days" });
  const newNote = D.summary.changed.baseline ? " NEW marks a row not on file at the previous day's build." : "";
  stamp("cuts-stamp", false, ` sale listings cut in the last 7 days, deepest first, ${num(cuts.length)} rows (up to 100 per market). Cuts past -90% are entry corrections and excluded. xN is the same unit repriced by N brokers; the link opens the first.${newNote} ` +
    `Sources here: ${mixText(cuts.reduce((a, r) => ({ ...a, [r.source]: (a[r.source] || 0) + 1 }), {})) || "none"}.${estNote}`);

  const fresh = freshShown();
  table("t-fresh", [["Vs kind median", (r) => r.disc, (r) => (r.disc == null ? h("span", { class: "muted" }, "no kind median", newTag(r))
    : h("span", {}, pct(r.disc), h("small", { text: `${r.ref.market.id === S.market ? "" : `${r.ref.market.name} `}${kindName(r.kind).toLowerCase()} ${usd(r.ref.median)}` }), newTag(r))), true],
    ["USD/m2", (r) => r.asking_usd_m2, (r) => usd(r.asking_usd_m2), true],
    ["Ask", (r) => r.asking_usd, (r) => usdNote(r.asking, r.currency, r.asking_usd), true], ["Estimate", (r) => r.estimate?.est, estCell, true],
    ["Place", placeCell], ["Kind", (r) => kindName(r.kind)],
    ["Built m2", (r) => r.m2, null, true], ["Beds", (r) => r.bedrooms, null, true],
    ["First seen", (r) => r.first_seen, (r) => dayShort(r.first_seen)], ["Listing", (r) => srcName(r.source), srcCell]],
  fresh, { sort: 0, dir: 1, empty: "No new sale listings with a built area in this market this week" });
  stamp("fresh-stamp", false, ` first seen in the last 7 days within a week of the portal's publish date, built area 40 to 800 m2. Ranked by asking USD per built m2 against the median of the same kind in this market ` +
    `(or the nearest larger market that has one, named in the cell), up to 30 per market. An asking price below the median is a claim, not a bargain.${newNote}${estNote}`);

  const spRows = [];
  for (const op of ["sale", "rent"]) {
    const sp = m.closed_ask_to_close[op];
    [["all", sp.all], ...Object.entries(sp.kinds)].forEach(([k, v], i) => spRows.push({ op, kind: k, v, order: (op === "sale" ? 0 : 100) + i }));
  }
  const cell = (fn) => (r) => (r.v.status ? null : fn(r.v));
  table("t-spread", [["Closes", (r) => r.order, (r) => (r.op === "sale" ? "Sales" : "Rentals")], ["Kind", (r) => (r.kind === "all" ? "All kinds" : kindName(r.kind))],
    ["n", (r) => r.v.n, (r) => num(r.v.n), true],
    ["Price identical to ask", (r) => r.v.at_ask_pct, (r) => (r.v.status ? h("span", { class: "muted", text: `${r.v.status}, needs ${D.summary.min_n.spread}` })
      : h("span", {}, `${Math.round(r.v.at_ask_pct)}%`, h("small", { text: num(r.v.at_ask) }))), true],
    ["Median", (r) => r.v.p50, cell((v) => pct(v.p50)), true], ["P25", (r) => r.v.p25, cell((v) => pct(v.p25)), true],
    ["P75", (r) => r.v.p75, cell((v) => pct(v.p75)), true],
    ["Median below ask", (r) => r.v.below_p50, cell((v) => (v.below_p50 == null ? h("span", { class: "muted", text: `n ${num(v.below)}, below ${D.summary.min_n.spread}` }) : h("span", {}, pct(v.below_p50), h("small", { text: `n ${num(v.below)}` })))), true],
    ["Closes from", (r) => r.v.first, (r) => (r.v.first ? `${monthYear(r.v.first)} to ${monthYear(r.v.last)}` : "-")]],
  spRows, { sort: 0, dir: 1 });
  const s0 = m.closed_ask_to_close.sale.all;
  stamp("spread-stamp", true, ` broker-reported price against the last asking price, same currency only, RE/MAX network. Kinds show with ${D.summary.min_n.spread} or more closes. ` +
    (s0.status ? "" : `${Math.round(s0.at_ask_pct)}% of sales here report a price identical to the last ask, so the all-closes median sits near zero; the median of the closes reported below the ask travels beside it. `) +
    "The feed cannot tell a full-price sale from a broker who left the ask in the sold field.");

  const flow = m.asking_flow_30d;
  table("t-flow30", [["Event", (r) => FLOW.indexOf(r), (r) => r[1]], ...["sale", "rent", "all"].map((op) => [op === "all" ? "All" : op === "sale" ? "Sale" : "Rent",
    (r) => flow[op][r[0]], (r) => num(flow[op][r[0]]), true])], FLOW, { sort: 0, dir: 1 });
  stamp("flow30-stamp", false, ` events ${day(D.summary.flow_window.from)} to ${day(D.summary.flow_window.to)}. The All column equals the sum of the daily chart's bars over the same 30 days.`);

  const reo = D.movers.reo_parcels.filter(here);
  table("t-reo", [
    ["Net base", (r) => r.asking_base_net_usd, (r) => (r.asking_base_net_usd == null ? h("span", { class: "muted", text: "not published" }) : h("span", {}, usd(r.asking_base_net_usd), r.price_check ? h("span", { class: "flag", text: "CHECK" }) : null)), true],
    ["Kind", (r) => kindName(r.kind)], ["Lots", (r) => r.items, (r) => (r.items > 1 ? `x${r.items}` : "1"), true], ["Place", reoPlace],
    ["Land m2", (r) => r.land_m2, (r) => num(r.land_m2), true], ["Built m2", (r) => r.built_m2, (r) => num(r.built_m2), true],
    ["Bank", (r) => BANKS[r.bank] || r.bank, (r) => ext(r.url, `${BANKS[r.bank] || r.bank}${r.url && !r.url_is_item ? " list" : ""}`,
      r.url_is_item ? `Open this item on ${BANKS[r.bank] || r.bank} (new tab)` : `Open ${BANKS[r.bank] || r.bank}'s published list (new tab)`)],
    ["Item", (r) => r.item], ["First seen", (r) => r.first_seen, (r) => dayShort(r.first_seen)]],
  reo, { sort: 0, dir: 1, empty: "No bank-owned parcels listed in this market" });
  const parcels = reo.reduce((a, r) => a + r.items, 0);
  stamp("reo-stamp", false, ` ${num(parcels)} active parcels in ${num(reo.length)} rows from ${D.summary.reo.banks} bank lists; identical lots from one bank show once with their count. Base price as published net of 10% IVA. ` +
    `CHECK marks a built property under USD 10,000, likely an entry error at the bank. Itaú items link to their own page; the other banks publish one list (a page or a file), and the link opens it. Last capture ${day(D.summary.reo.last_ok_capture)}.`);
}

// Individual broker-reported closes in the selected market: the comps this market has.
// "Marked sold" in the listing flow dates the flag our capture saw, a close the broker's sale date,
// so the two 30-day counts differ; one sentence says by how much and why.
function flagSentence(op, f) {
  if (!f || (!f.asking_flags && !f.closed_records)) return "";
  const flag = op === "sale" ? "marked sold" : "marked rented";
  const inFlags = f.asking_flags - f.flags_close_before - f.flags_no_close, inCloses = f.closed_records - f.closed_unflagged;
  const carry = (n) => (n === 1 ? "carries" : "carry");
  const before = f.flags_close_before ? `${num(f.flags_close_before)} of them ${carry(f.flags_close_before)} a close dated before this window` : "none of them carries a close dated before this window";
  const unflagged = f.closed_unflagged ? `${num(f.closed_unflagged)} of the ${num(f.closed_records)} close records here ${carry(f.closed_unflagged)} no flag inside it`
    : `all ${num(f.closed_records)} close records here carry a flag inside it`;
  return ` The listing flow's ${num(f.asking_flags)} ${op} listings ${flag} over the same 30 days are dated by our capture's flag, not the deal: ` +
    `${before}${f.flags_no_close ? ` and ${num(f.flags_no_close)} no priced close` : ""}, and ${unflagged}${inFlags === inCloses ? `, which leaves ${num(inFlags)} in both` : ""}.`;
}
function renderRecentCloses() {
  const op = S.recentOp, c = D.closes, what = op === "sale" ? "sales" : "rentals", m = market();
  const [n30, n7, rec30] = c.counts[S.market]?.[op] || [0, 0, 0];
  const rows = closesShown(op), month = op === "rent" ? " a month" : "";
  const muted = (r, text) => h("span", { class: r.entry_check ? "muted" : null, text });
  table("t-closes", [
    ["Closed", (r) => r.date, (r) => h("span", {}, dayShort(r.date), newTag(r))],
    ["Kind", (r) => kindName(r.kind), (r) => h("span", {}, kindName(r.kind), r.records > 1
      ? h("small", { title: `Filed as ${r.records} records (${r.kinds}) by one office on one day at one ask and price; counted once`, text: `x${r.records}` }) : null)],
    ["Place", placeCell, (r) => h("span", { class: "wrapcell", text: placeCell(r) })],
    ["Area", (r) => r.area_m2, (r) => (r.area_m2 == null ? null : h("span", {}, `${num(r.area_m2)} m2`, h("small", { text: r.area_basis }))), true],
    ["Beds", (r) => r.bedrooms, null, true],
    ["Last ask", (r) => r.ask_usd, (r) => money(r.ask, r.ask_currency), true],
    ["Reported price", (r) => r.close_usd, (r) => h("span", {}, h("b", { text: money(r.close, r.close_currency) }),
      r.close_currency === "PYG" ? h("small", { class: "under", text: `${usdK(r.close_usd)} at sale-date rate` }) : null), true],
    [`USD/m2${month}`, (r) => r.close_usd_per_m2, (r) => (r.close_usd_per_m2 == null ? null : h("span", {}, muted(r, usd(r.close_usd_per_m2)),
      r.close_currency !== "USD" && r.close_per_m2 != null ? h("small", { class: "under", text: money(r.close_per_m2, r.close_currency) }) : null)), true],
    ["Spread", (r) => r.spread_pct, (r) => (r.spread_pct == null ? h("span", { class: "muted", text: "no ask" })
      : h("span", { class: r.entry_check ? "muted" : r.spread_pct < 0 ? "cut" : null,
        title: r.entry_check ? "Outside 0.4 to 1.6 times the ask: likely an entry error, left out of ask-to-close" : null },
      pct(r.spread_pct), r.entry_check ? h("span", { class: "flag", text: "CHECK" }) : null,
      r.spread_basis === "same currency" ? null : h("small", { class: "under wrapcell", text: "cross-currency, at sale-date rate" }))), true],
    ["Days to close", (r) => r.days_to_close, (r) => num(r.days_to_close), true],
    ["RE/MAX MLS id", (r) => r.mls || "", (r) => h("span", { title: "RE/MAX takes a listing's page down once it closes" }, r.mls || srcName(r.source))],
  ], rows, { sort: 0, dir: -1, empty: `No broker-reported ${what} with a price in ${m.name} in the last ${c.days} days` });
  const thin = n30 > 0 && n30 < c.min_n ? `Fewer than ${c.min_n} ${what} here in ${c.days} days: read them as single deals, not a price level. ` : "";
  const folded = rec30 > n30 ? ` (${num(rec30)} records: records one office filed on one day at one ask and price are one deal, marked xN)` : "";
  stamp("closes-list-stamp", true, ` ${num(n30)} ${n30 === 1 ? what.slice(0, -1) : what} reported closed in ${m.name} from ${dayShort(c.from)} to ${dayShort(c.to)}${folded}, ${num(n7)} of them in the last ${c.recent_days} days` +
    `${rows.length < n30 ? `; the newest ${num(rows.length)} shown` : ""}. ${thin}Broker-reported prices from the RE/MAX network, newest first. ` +
    `Area is the listing's own, built or land as marked; USD/m2 divides the reported price${op === "rent" ? ", a month," : ""} by it at the SET rate of the close date, with the guaraní figure under it for a deal settled in guaraníes. ` +
    "Spread is the reported price against the last ask in their own currency; a close settled in another currency than its ask is read through both in USD at the close date's SET rate and labeled cross-currency. " +
    "CHECK marks a price outside 0.4 to 1.6 times the ask, likely an entry error, left out of ask-to-close." + flagSentence(op, m.flags_vs_closes_30d?.[op]) +
    " Days to close run from the listing's publish date to the close date, blank when it was published on or after its close date. RE/MAX takes a listing's page down once it closes, so rows carry its MLS id instead of a link. " +
    `Century 21 closed records carry no price and are not listed.${D.summary.changed.baseline ? " NEW marks a deal not on file at the previous day's build." : ""}`);
}

// ---------- the Tekoha estimate ----------
// Per market: how many live listings carry an estimate, the measured holdout error of the segments
// they fall in, the median estimate by kind, and the top of the buy screen. Every figure here is a
// model's, tagged ESTIMATE, and each travels with its error.
function renderEstimate(m) {
  const E = D.estimate, b = S.estBasis;
  if (!E?.available || !E.markets[m.id]) {
    $("est-lede").textContent = "No estimate run is on file for this build; the measured panels above are unaffected.";
    ["t-est-segs", "t-est-kinds", "t-est-under"].forEach((id) => $(id).replaceChildren());
    $("est-stamp").replaceChildren(estTag(), " no estimate run on file.");
    return;
  }
  const me = E.markets[m.id], base = E.bases[b], ov = base.overall, what = b === "sale" ? "close price" : "monthly rent";
  const onMarket = me.counts[b].on_market;
  const segRows = me.segments.filter((s) => s.basis === b).map((s) => {
    const [kind, dept] = s.segment.split("|");
    return { ...s, ...(E.segments[b][s.segment] || { kind, department: D.byId.get(`d:${dept.replace(/ /g, "-")}`)?.name || dept,
      estimate: false, reason: "no training closes in this segment" }) };
  });
  $("est-lede").replaceChildren(h("b", { text: num(me.counts[b].intrinsic) }),
    ` of ${num(me.live[b])} live ${b === "sale" ? "sale" : "rental"} listings of the modeled kinds in ${m.name} carry an intrinsic estimate of their ${what}` +
    `${onMarket ? `, ${num(onMarket)} of them also an on-market estimate built on their ask` : ""}. ` +
    `Across Paraguay, on ${num(ov.intrinsic.n)} held-out ${b === "sale" ? "sales" : "rentals"} closed ${dayShort(base.test.from)} to ${dayShort(base.test.to)}, the intrinsic estimate missed by a median ` +
    `${pct1(ov.intrinsic.mdape)}; the segment's median close per m2 times size missed by ${pct1(ov.baseline_m2.mdape)}. Each segment's own error is in the table.`);

  table("t-est-segs", [
    ["Segment", (s) => `${s.kind}|${s.department}`, (s) => `${kindName(s.kind)}, ${s.department}`],
    ["Live", (s) => s.live, (s) => h("span", {}, num(s.live), h("small", { text: `${num(s.scored)} scored` })), true],
    ["Held out", (s) => s.n_test ?? 0, (s) => (s.n_test == null ? "0" : h("span", {}, num(s.n_test), h("small", { text: `${num(s.n_train)} trained` }))), true],
    ["Median miss", (s) => s.intrinsic?.median_ape, (s) => (s.intrinsic ? pct1(s.intrinsic.median_ape) : null), true],
    ["80% band", (s) => s.intrinsic?.band?.[0], (s) => (s.intrinsic ? bandPct(s.intrinsic.band) : null)],
    ["Per m2 baseline", (s) => s.per_m2_baseline?.median_ape, (s) => (s.per_m2_baseline ? pct1(s.per_m2_baseline.median_ape) : null), true],
    ["Confidence", (s) => s.confidence?.intrinsic, (s) => (s.confidence ? h("span", {}, num(s.confidence.intrinsic),
      s.confidence.on_market != null ? h("small", { text: `on-market ${num(s.confidence.on_market)}` }) : null) : null), true],
    ["Estimate", (s) => (s.estimate ? 0 : 1), (s) => (s.estimate ? "published" : h("span", { class: "muted wrapcell", text: `abstains: ${s.reason}` }))],
  ], segRows, { sort: 1, dir: -1, empty: "No listings of the modeled kinds in this market" });

  table("t-est-kinds", [["Kind", ([k]) => kindName(k)],
    ["Median estimate", ([, d]) => d.median, ([, d]) => (d.suppressed ? h("span", { class: "muted", text: nLabel(d, E.min_n) })
      : h("span", { class: "estv", text: b === "sale" ? usdK(d.median) : `${usd(d.median)} a month` })), true],
    ["Listings", ([, d]) => d.n, ([, d]) => num(d.n), true]],
  Object.entries(me.median_estimate[b]), { sort: 2, dir: -1, empty: "No estimates in this market" });

  table("t-est-under", [["#", (r) => r.rank, null, true],
    ["Ask / estimate", (r) => r.ask / r.est, (r) => (r.ask / r.est).toFixed(2), true],
    ["Asking", (r) => r.ask, (r) => usdNote(r.asking, r.currency, r.ask), true],
    ["Estimate", (r) => r.est, (r) => h("span", { class: "estv" }, usdK(r.est), h("small", { class: "under", text: `${usdK(r.low)} to ${usdK(r.high)}` })), true],
    ["Confidence", (r) => r.confidence, (r) => h("span", {}, num(r.confidence), h("small", { text: `${num(r.n_comps)} comps` })), true],
    ["Place", placeCell], ["Kind", (r) => kindName(r.kind)],
    ["Size", (r) => r.a1, (r) => h("span", {}, `${num(r.a1)} m2`, h("small", { text: r.a1src })), true],
    ["Listed", (r) => r.days_listed ?? r.days_seen, (r) => (r.days_listed != null ? `${num(r.days_listed)}d` : `${num(r.days_seen)}d+`), true],
    ["Listing", (r) => srcName(r.source), (r) => h("span", {}, ext(r.url, srcName(r.source), `Open this listing on ${srcName(r.source)} (new tab)`),
      r.dupes > 1 ? h("small", { text: `x${r.dupes}` }) : null)]],
  me.under_ask.map((r, i) => ({ ...r, rank: i + 1 })), { sort: 0, dir: 1, empty: "No sale listing here asks at or below 90% of its estimate" });

  const sc = E.screen;
  $("est-stamp").replaceChildren(estTag(), ` ${E.run.model_version}, run of ${day(E.run.computed_at)}, USD at Gs ${num(E.run.fx.rate)}, SET mid. A model of the ${what}, ` +
    "fit on broker-reported closes from the RE/MAX network and never on an ask. Each estimate carries its segment's 80% band of misses on the most recent 20% of closes, " +
    "held out of the fit, and a confidence mapped from that band. A segment is one kind in one department, so a city shows its department's segments" +
    `${me.segments_more[b] ? `; ${num(me.segments_more[b])} smaller ones are not shown (estimate_segments.csv has all)` : ""}. ` +
    `The top 10 follow the Monday buy screen: casas, departamentos and duplexes of ${num(sc.rules.minM2)} m2 or more and terrenos with a land-basis area, asking at or below ` +
    `${Math.round(sc.rules.atOrBelow * 100)}% of the estimate, ranked by the gap times the confidence, one row per property (xN listings); ${num(sc.entry_errors)} listings asking under ` +
    `${Math.round(sc.rules.entryError * 100)}% of their estimate, or of their segment's median close per m2 times size, are left out as likely entry errors. ` +
    "d+ counts days since our first sighting where the portal's publish date is missing or a bulk load. An ask under the estimate is a lead to check, not a finding: " +
    "condition, title and finish are not in the model.");
}

function renderMarketsTable() {
  const g = (m, f, k) => m[f][k], min = D.summary.min_n.median, sp = (m) => m.closed_ask_to_close.sale.all;
  table("t-markets", [["Market", (m) => m.name], ["Level", (m) => m.level],
    ["For sale", (m) => m.asking_active.sale_total, (m) => num(m.asking_active.sale_total), true],
    ["Casa ask", (m) => g(m, "asking_price_usd", "casa")?.median, (m) => distCell(g(m, "asking_price_usd", "casa"), usdK, min), true],
    ["Depto ask", (m) => g(m, "asking_price_usd", "departamento")?.median, (m) => distCell(g(m, "asking_price_usd", "departamento"), usdK, min), true],
    ["Depto USD/m2", (m) => g(m, "asking_usd_per_m2_built", "departamento")?.median, (m) => distCell(g(m, "asking_usd_per_m2_built", "departamento"), usd, min), true],
    ["Depto rent", (m) => g(m, "asking_rent_usd_month", "departamento")?.median, (m) => distCell(g(m, "asking_rent_usd_month", "departamento"), usd, min), true],
    ["Sale cuts 30d", (m) => m.asking_flow_30d.sale.cuts, (m) => num(m.asking_flow_30d.sale.cuts), true],
    ["Sales reporting the ask", (m) => sp(m).at_ask_pct, (m) => (sp(m).status ? h("span", { class: "muted", text: `n ${num(sp(m).n)}` }) : h("span", {}, `${Math.round(sp(m).at_ask_pct)}%`, h("small", { text: `n ${num(sp(m).n)}` }))), true],
    ["Ask-to-close", (m) => sp(m).p50, (m) => (sp(m).status ? h("span", { class: "muted", text: `n ${num(sp(m).n)}` }) : h("span", {}, pct(sp(m).p50), h("small", { text: sp(m).below_p50 == null ? "" : `${pct(sp(m).below_p50)} below` }))), true]],
  D.markets, { sort: 2, dir: -1, onRow: (m) => { select(m.id); window.scrollTo({ top: 0, behavior: "smooth" }); }, current: (m) => m.id === S.market });
  stamp("markets-stamp", false, ` medians of active, recently seen listings (asking) except the last two columns, which are closed sales. Cities appear at ${D.summary.city_min_active_sale} active sale listings.`);
}

// ---------- page furniture that does not depend on the market ----------
function estimateFill(E) {
  if (!E?.available) return { est_closes: "no run on file", est_cutoff: "-", est_err: "not available in this build" };
  const [s, r] = [E.bases.sale, E.bases.rent];
  return {
    est_closes: `${num(s.train.n + s.test.n)} sales and ${num(r.train.n + r.test.n)} rentals in the run of ${day(E.run.computed_at)}`,
    est_cutoff: `${day(s.cutoff)} for sales and ${day(r.cutoff)} for rentals`,
    est_err: `${pct1(s.overall.intrinsic.mdape)} on ${num(s.overall.intrinsic.n)} sales, where the segment's median close per m2 times size missed by ` +
      `${pct1(s.overall.baseline_m2.mdape)}, and ${pct1(r.overall.intrinsic.mdape)} on ${num(r.overall.intrinsic.n)} rentals, against ${pct1(r.overall.baseline_m2.mdape)}`,
  };
}
function renderStatic() {
  const s = D.summary;
  const asof = new Date(s.as_of);
  $("asof").textContent = `Data as of ${day(s.as_of)}, ${asof.toISOString().slice(11, 16)} UTC | Gs ${num(s.fx.rate)}/USD, SET | Pipeline ${s.health || "status unknown"}`;
  const up = s.staleness_sources.find((x) => x.code === "uprop"), before = s.closes.before;
  const excluded = s.medians.excluded, rentPy = Object.entries(D.trends.closed_rent.markets.py.month);
  const rentN = (cur) => rentPy.filter(([k]) => !cur || k.endsWith(`|${cur}`)).reduce((a, [, rows]) => a + rows.reduce((b, x) => b + x[1], 0), 0);
  const fxMonths = Object.entries(D.trends.closed_rent.fx_monthly).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const band = s.rent_close_bands;
  const full = counted().find((w) => w.role === "full_universe"), facet = counted().find((w) => w.role === "facet_bounded");
  const fill = {
    closes_sale: num(before.sale?.total), closes_rent: num(before.rent?.total), closes_before_sale: num(before.sale?.before),
    closes_before_rent: num(before.rent?.before), closes_after_sale: num(before.sale && before.sale.total - before.sale.before),
    closes_after_rent: num(before.rent && before.rent.total - before.rent.before), weeks_from: day(s.closes.weeks_from),
    rent_pyg: num(rentN("PYG")), rent_all: num(rentN()), rent_three: num(before.rent?.three_kinds),
    fx_rent_first: fxMonths.length ? `${num(fxMonths[0][1])} (${monthYear(fxMonths[0][0])})` : "-",
    fx_rent_last: fxMonths.length ? `${num(fxMonths.at(-1)[1])} (${monthYear(fxMonths.at(-1)[0])})` : "-",
    rent_bands: `${gs(band.PYG[0])} to ${num(band.PYG[1])} or USD ${num(band.USD[0])} to ${num(band.USD[1])}`,
    fx_rate: num(s.fx.rate), fx_date: day(s.fx.date),
    assign_own: num(s.assignment.own), assign_nearest: num(s.assignment.nearest), assign_city: num(s.assignment.city_label || 0),
    assign_dept: num(s.assignment.nearest_dept), assign_none: num((s.assignment.no_coordinates || 0) + (s.assignment.unassigned || 0)),
    age_sources: andList(s.sources.filter((x) => x.staleness_used).map((x) => srcName(x.code))),
    uprop_week: up ? `${Math.round(up.densest_week_share * 100)}%` : "most", map_placeholder: num(s.map.placeholder),
    map_points: num(s.map.placeholder_points), placeholder_min: num(s.map.placeholder_min),
    seen_full: full ? day(full.since) : "-", seen_facet: facet ? day(facet.since) : "-", active: num(s.active), listed: num(s.listed_active),
    not_seen: num(s.listed_active - s.active), tracked: num(s.tracked), cov_min: `${Math.round(s.medians.coverage_min * 100)}%`,
    med_sources: andList(s.medians.sources.map(srcName)),
    excluded: excluded.length ? excluded.map((x) => `${srcName(x.code)} at ${Math.round(x.priced_share * 100)}%`).join(", ") : "none",
    recon_from: day(s.recon.from), recon_days: num(s.recon.captured_days), rent_out: num(s.rent_closes_out_of_band),
    reo_links: num(s.reo.item_links), city_spread: num(s.city_max_spread_km),
    cities_dropped: s.cities_dropped.length ? s.cities_dropped.map((c) => `${c.city}, ${c.department} (${num(c.spread_km)} km)`).join("; ") : "none today",
    changed_window: `${day(s.changed.since)} ${hhmm(s.changed.since)} to ${day(s.changed.until)} ${hhmm(s.changed.until)} UTC`,
    baseline: s.changed.baseline ? `today, the build of ${day(s.changed.baseline.as_of)} ${hhmm(s.changed.baseline.as_of)} UTC`
      : "today there is none on file, so nothing is tagged",
    deals: `today ${num(s.closes.deals_filed_twice)} deals filed as more than one record, ${num(s.closes.records_folded)} records folded`,
    ...estimateFill(D.estimate),
  };
  document.querySelectorAll("[data-s]").forEach((e) => { e.textContent = fill[e.dataset.s] ?? "-"; });
  const PLACED = { own: "own labels", city_label: "own city label", nearest: "nearest labeled listings", nearest_dept: "department only",
    no_coordinates: "not placed, no coordinates", unassigned: "not placed" };
  const ROLE = { full_universe: "whole panel every run", facet_bounded: "in parts, facet-bounded", closes_only: "partial crawl by hand, counted nowhere" };
  const stock = (x) => x.role !== "closes_only";
  const placed = (x) => { const [k, n] = Object.entries(x.placement || {}).sort((a, b) => b[1] - a[1])[0] || []; return k ? `${PLACED[k] || k}, ${share(n, x.active)}` : "-"; };
  table("t-sources", [["Source", (x) => srcName(x.code)], ["Role", (x) => ROLE[x.role] || "none"],
    ["Tracked", (x) => x.tracked, (x) => num(x.tracked), true],
    ["Listed active", (x) => x.listed, (x) => (stock(x) ? num(x.listed) : h("span", { class: "muted" }, num(x.listed), h("small", { text: "not stock" }))), true],
    ["Seen in window", (x) => x.active, (x) => (stock(x) ? h("span", {}, num(x.active), h("small", { text: `since ${dayShort(x.seen_since)}, ${share(x.active, x.listed)}` }))
      : h("span", { class: "muted", text: "not counted" })), true],
    ["With an ask", (x) => x.priced_share, (x) => (stock(x) ? share(x.priced, x.active) : "-"), true],
    ["In asking medians", (x) => (x.in_medians ? 1 : 0), (x) => (x.in_medians ? "yes"
      : h("span", { class: "muted", text: stock(x) ? `no, under ${Math.round(s.medians.coverage_min * 100)}%` : "no, counted nowhere" }))],
    ["Last good pull", (x) => x.last_ok_pull || x.last_run, (x) => (x.last_ok_pull ? day(x.last_ok_pull) : x.last_run ? `none; last attempt ${day(x.last_run)}` : "none")],
    ["Market from", placed]], s.sources, { sort: 4, dir: -1 });
  $("files").replaceChildren(...s.files.map((f) => h("li", {}, h("a", { href: "data/" + f.file, download: true, text: f.file }),
    ` ${f.description}. ${num(f.rows)} ${f.rows === 1 ? "row" : "rows"}, ${(f.bytes / 1024).toFixed(0)} KB`)));
}

function render() {
  const m = market();
  renderHero(m); renderChanged(m); renderKpis(m); renderMap(m); renderFlow(); renderCloses(); renderRent(); renderSeries(); renderTwins();
  renderTables(m); renderEstimate(m); renderRecentCloses(); renderMarketsTable();
}

function wire() {
  const seg = (id, keyName, after) => $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S[keyName] = b.dataset.v;
    $(id).querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    after();
  });
  seg("cell-kind", "cellKind", () => drawCells(true));
  seg("close-op", "closeOp", () => { renderCloses(); renderTwins(); });
  seg("recent-op", "recentOp", renderRecentCloses);
  seg("series-metric", "metric", () => { renderSeries(); renderTwins(); });
  seg("est-basis", "estBasis", () => renderEstimate(market()));
  const layer = (id, group) => $(id).addEventListener("change", (e) => { if (e.target.checked) { group.addTo(map); raiseDots(); } else group.remove(); });
  layer("lyr-cells", cells); layer("lyr-cuts", cutDots); layer("lyr-reo", reoDots);
  document.querySelectorAll("[data-table]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.table;
    S.tables.has(k) ? S.tables.delete(k) : S.tables.add(k);
    renderTwins();
  }));
  window.addEventListener("hashchange", () => { const id = fromHash(); if (id !== S.market || S.missing) { S.market = id; render(); } });
  window.addEventListener("popstate", () => { const id = fromHash(); if (id !== S.market || S.missing) { S.market = id; render(); } });
  // The font stylesheet loads without blocking the page, so charts drawn before it arrives redraw once it has.
  document.fonts?.addEventListener?.("loadingdone", () => Object.values(charts).forEach((c) => c.update()));
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
