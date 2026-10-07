// Traffic Monitor 27 for Scriptable
// Designed for iPhone/iPad widgets with high-density multi-server traffic monitoring.
// Visual language: iOS 27 frosted glass — milky, matte translucent panels with soft
// hairline edges over a diffused, blurred-looking backdrop; no glossy highlights.
// Current server API: {baseURL}/traffic?token=TOKEN
// baseURL preserves the configured scheme exactly (http:// or https://).
// API fields: hostname, ip, max_traffic_gb, total_usage_gb, usage_percentage

const APP_NAME = "Traffic Monitor 27";
const VERSION = "3.0.0";
const fm = FileManager.local();
const DOCS = fm.documentsDirectory();
const CONFIG_PATH = fm.joinPath(DOCS, "traffic_monitor_27.json");
const CACHE_PATH = fm.joinPath(DOCS, "traffic_monitor_27_cache.json");
const KEY_PREFIX = "traffic-monitor-27-token-";

const C = {
  primary: Color.dynamic(new Color("#0B0C10"), new Color("#FFFFFF")),
  secondary: Color.dynamic(new Color("#3C3F48", 0.78), new Color("#EBEBF5", 0.72)),
  tertiary: Color.dynamic(new Color("#3C3F48", 0.52), new Color("#EBEBF5", 0.45)),
  green: new Color("#30D158"),
  orange: new Color("#FF9F0A"),
  red: new Color("#FF453A"),
  blue: new Color("#0A84FF"),
  gray: new Color("#8E8E93"),
};

// Frosted glass material. Widgets cannot blur, so frost is emulated with a milky,
// almost uniform translucent fill (only a whisper of vertical falloff), a soft
// hairline edge and no specular shine — matte rather than glossy.
const GLASS = {
  top: Color.dynamic(new Color("#FFFFFF", 0.58), new Color("#FFFFFF", 0.105)),
  bottom: Color.dynamic(new Color("#FFFFFF", 0.46), new Color("#FFFFFF", 0.075)),
  rim: Color.dynamic(new Color("#FFFFFF", 0.62), new Color("#FFFFFF", 0.09)),
};

const ACCENTS = [
  ["#64D2FF", "#64D2FF"], // cyan
  ["#0A84FF", "#0A84FF"], // blue
  ["#BF5AF2", "#BF5AF2"], // purple
  ["#FF375F", "#FF375F"], // pink
  ["#30D158", "#30D158"], // mint/green
  ["#FF9F0A", "#FF9F0A"], // orange
];

function uid() {
  return UUID.string().replace(/-/g, "").slice(0, 12).toLowerCase();
}

function defaultConfig() {
  return {
    version: VERSION,
    servers: [],
    sortMode: "usage", // usage | manual | name
    refreshMinutes: 30,
    warningPercent: 80,
    dangerPercent: 95,
    maxPerSize: {
      small: 4,
      medium: 6,
      large: 16,
      extraLarge: 24,
    },
  };
}

function safeReadJSON(path, fallback) {
  try {
    if (!fm.fileExists(path)) return fallback;
    return JSON.parse(fm.readString(path));
  } catch (_) {
    return fallback;
  }
}

function loadConfig() {
  const d = defaultConfig();
  const raw = safeReadJSON(CONFIG_PATH, {});
  const cfg = Object.assign({}, d, raw || {});
  cfg.maxPerSize = Object.assign({}, d.maxPerSize, raw.maxPerSize || {});
  if (!Array.isArray(cfg.servers)) cfg.servers = [];
  cfg.servers = cfg.servers.map((s) => ({
    id: s.id || uid(),
    name: String(s.name || "未命名"),
    domain: String(s.domain || ""),
    group: String(s.group || ""),
  }));
  return cfg;
}

function saveConfig(cfg) {
  const clean = JSON.parse(JSON.stringify(cfg));
  clean.version = VERSION;
  // Tokens are intentionally stored in Keychain, never in the JSON config file.
  clean.servers = (clean.servers || []).map(({ id, name, domain, group }) => ({ id, name, domain, group }));
  fm.writeString(CONFIG_PATH, JSON.stringify(clean, null, 2));
}

function tokenKey(id) {
  return KEY_PREFIX + id;
}

function getToken(id) {
  try {
    return Keychain.contains(tokenKey(id)) ? Keychain.get(tokenKey(id)) : "";
  } catch (_) {
    return "";
  }
}

function setToken(id, value) {
  try {
    const key = tokenKey(id);
    if (value) Keychain.set(key, value);
    else if (Keychain.contains(key)) Keychain.remove(key);
  } catch (_) {}
}

function deleteToken(id) {
  try {
    const key = tokenKey(id);
    if (Keychain.contains(key)) Keychain.remove(key);
  } catch (_) {}
}

function loadCache() {
  const c = safeReadJSON(CACHE_PATH, {});
  return c && typeof c === "object" ? c : {};
}

function saveCache(cache) {
  try {
    fm.writeString(CACHE_PATH, JSON.stringify(cache));
  } catch (_) {}
}

function baseURL(domain) {
  // The protocol is part of the server configuration. Never silently upgrade HTTP to HTTPS.
  let v = String(domain || "").trim();
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) return "";
  return v.replace(/\/+$/, "");
}

function trafficURL(server, token) {
  const b = baseURL(server.domain);
  if (!b) return "";

  // Allow either a base URL (http://host:port) or one already ending in /traffic.
  // Token is always supplied using the repository's current ?token=... contract.
  let endpoint = /\/traffic$/i.test(b) ? b : b + "/traffic";
  return endpoint + "?token=" + encodeURIComponent(token);
}

async function requestJSON(url) {
  const req = new Request(url);
  req.timeoutInterval = 8;
  try {
    const text = await req.loadString();
    const status = req.response && req.response.statusCode ? req.response.statusCode : 200;
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { ok: status >= 200 && status < 300 && !!json, status, json, error: json ? null : "返回内容不是 JSON" };
  } catch (e) {
    const status = req.response && req.response.statusCode ? req.response.statusCode : 0;
    return { ok: false, status, json: null, error: String(e) };
  }
}

function num(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : (fallback == null ? 0 : fallback);
}

function normalizeData(json) {
  if (!json || typeof json !== "object") return null;
  const used = num(json.total_usage_gb, NaN);
  const limit = num(json.max_traffic_gb, NaN);
  let pct = num(json.usage_percentage, NaN);
  if (!Number.isFinite(pct) && Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    pct = used / limit * 100;
  }
  if (!Number.isFinite(used) || !Number.isFinite(limit) || !Number.isFinite(pct)) return null;
  return {
    hostname: String(json.hostname || ""),
    ip: String(json.ip || ""),
    used,
    limit,
    pct,
    fetchedAt: Date.now(),
    stale: false,
  };
}

async function fetchServer(server, cfg, cache) {
  const token = getToken(server.id);
  if (!server.domain || !token) {
    const cached = cache[server.id];
    return cached ? Object.assign({}, cached, { stale: true, error: "配置不完整" }) : { stale: true, error: "配置不完整" };
  }

  const url = trafficURL(server, token);
  if (!url) {
    const cached = cache[server.id];
    return cached ? Object.assign({}, cached, { stale: true, error: "地址必须包含 http:// 或 https://" }) : { stale: true, error: "地址必须包含 http:// 或 https://" };
  }

  const r = await requestJSON(url);
  const normalized = r.ok ? normalizeData(r.json) : null;

  if (normalized) {
    cache[server.id] = normalized;
    return normalized;
  }

  const cached = cache[server.id];
  if (cached) return Object.assign({}, cached, { stale: true, error: "本次请求失败" });
  return { stale: true, error: "无法获取" };
}

async function fetchPairs(servers, cfg) {
  const cache = loadCache();
  const result = [];
  const batchSize = 6;
  for (let i = 0; i < servers.length; i += batchSize) {
    const batch = servers.slice(i, i + batchSize);
    const data = await Promise.all(batch.map((s) => fetchServer(s, cfg, cache)));
    for (let j = 0; j < batch.length; j++) result.push({ server: batch[j], data: data[j] });
  }
  saveCache(cache);
  return result;
}

function parseWidgetParameter(raw) {
  const p = String(raw || "all").trim();
  if (!p || p.toLowerCase() === "all") return { type: "all" };
  const ix = p.indexOf(":");
  if (ix < 0) return { type: "all" };
  const type = p.slice(0, ix).trim().toLowerCase();
  const value = p.slice(ix + 1).trim();
  if (["top", "group", "server"].includes(type)) return { type, value };
  return { type: "all" };
}

function filterServers(servers, param) {
  if (param.type === "group") {
    const q = param.value.toLowerCase();
    return servers.filter((s) => String(s.group || "").toLowerCase() === q);
  }
  if (param.type === "server") {
    const q = param.value.toLowerCase();
    return servers.filter((s) => s.id.toLowerCase() === q || String(s.name || "").toLowerCase() === q);
  }
  return servers.slice();
}

function sortPairs(pairs, cfg, param) {
  let out = pairs.slice();
  if (param.type === "top") {
    out.sort((a, b) => num(b.data.pct, -1) - num(a.data.pct, -1));
    const n = Math.max(1, parseInt(param.value, 10) || 4);
    return out.slice(0, n);
  }
  if (cfg.sortMode === "usage") {
    out.sort((a, b) => num(b.data.pct, -1) - num(a.data.pct, -1));
  } else if (cfg.sortMode === "name") {
    out.sort((a, b) => String(a.server.name).localeCompare(String(b.server.name)));
  }
  return out;
}

function familyLimit(family, cfg) {
  if (family === "small") return Math.max(1, cfg.maxPerSize.small || 4);
  if (family === "medium") return Math.max(1, cfg.maxPerSize.medium || 6);
  if (family === "extraLarge") return Math.max(1, cfg.maxPerSize.extraLarge || 24);
  return Math.max(1, cfg.maxPerSize.large || 16);
}

function stableHash(text) {
  const str = String(text || "");
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}


// ───────────────────────────── Status & formatting ─────────────────────────────

function accentFor(server, pct, cfg, stale) {
  let hex;
  if (stale || !Number.isFinite(pct)) hex = "#8E8E93";
  else if (pct >= cfg.dangerPercent) hex = "#FF453A";
  else if (pct >= cfg.warningPercent) hex = "#FF9F0A";
  else hex = ACCENTS[stableHash(server && (server.id || server.name)) % ACCENTS.length][0];
  return {
    hex,
    solid: new Color(hex),
    soft: Color.dynamic(new Color(hex, 0.16), new Color(hex, 0.22)),
  };
}

function fmtGB(v) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1000) return (v / 1024).toFixed(v >= 10240 ? 0 : 1) + "T";
  if (v >= 100) return v.toFixed(0) + "G";
  if (v >= 10) return v.toFixed(1) + "G";
  if (v >= 1) return v.toFixed(2) + "G";
  return Math.round(v * 1024) + "M";
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 100) return Math.round(v) + "%";
  return v >= 10 ? Math.round(v) + "%" : v.toFixed(1) + "%";
}

function gbNumber(v) {
  if (!Number.isFinite(v)) return "—";
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function usageLine(d) {
  if (!d || !Number.isFinite(d.used) || !Number.isFinite(d.limit)) return "暂无数据";
  // Keep the unit explicit so a compact widget still answers: how many GB are used?
  if (d.used < 1024 && d.limit < 1024) return `${gbNumber(d.used)} / ${gbNumber(d.limit)} GB`;
  return fmtGB(d.used) + " / " + fmtGB(d.limit);
}

function shortUsage(d) {
  if (!d || !Number.isFinite(d.used) || !Number.isFinite(d.limit)) return "";
  return fmtGB(d.used) + "/" + fmtGB(d.limit);
}

function remainOf(d) {
  return d && Number.isFinite(d.limit) && Number.isFinite(d.used) ? Math.max(0, d.limit - d.used) : NaN;
}

function timeText(ts) {
  const f = new DateFormatter();
  f.dateFormat = "HH:mm";
  return f.string(ts ? new Date(ts) : new Date());
}

function summarize(pairs, cfg) {
  const s = { danger: 0, warning: 0, offline: 0, used: 0, limit: 0 };
  for (const { data } of pairs) {
    const d = data || {};
    if (!Number.isFinite(d.pct) || d.stale) s.offline++;
    else if (d.pct >= cfg.dangerPercent) s.danger++;
    else if (d.pct >= cfg.warningPercent) s.warning++;
    if (Number.isFinite(d.used)) s.used += d.used;
    if (Number.isFinite(d.limit)) s.limit += d.limit;
  }
  return s;
}

// ───────────────────────────── Widget primitives ─────────────────────────────

function font(size, weight, rounded) {
  const names = rounded
    ? { regular: "regularRoundedSystemFont", medium: "mediumRoundedSystemFont", semibold: "semiboldRoundedSystemFont", bold: "boldRoundedSystemFont", heavy: "heavyRoundedSystemFont" }
    : { regular: "regularSystemFont", medium: "mediumSystemFont", semibold: "semiboldSystemFont", bold: "boldSystemFont", heavy: "heavySystemFont" };
  const fn = Font[names[weight || "regular"]];
  if (typeof fn === "function") return fn.call(Font, size);
  return weight && weight !== "regular" ? Font.boldSystemFont(size) : Font.systemFont(size);
}

function addText(stack, text, size, color, weight, rounded) {
  const t = stack.addText(String(text));
  t.textColor = color || C.primary;
  t.font = font(size, weight, rounded);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.7;
  return t;
}

function addSymbol(stack, name, size, color, fallback) {
  let sym = SFSymbol.named(name);
  if (!sym && fallback) sym = SFSymbol.named(fallback);
  if (!sym) return null;
  sym.applyFont(Font.semiboldSystemFont(size));
  const img = stack.addImage(sym.image);
  img.imageSize = new Size(size, size);
  img.tintColor = color || C.primary;
  return img;
}

function glassGradient(tintHex) {
  const g = new LinearGradient();
  g.colors = tintHex
    ? [Color.dynamic(new Color(tintHex, 0.16), new Color(tintHex, 0.17)), Color.dynamic(new Color(tintHex, 0.1), new Color(tintHex, 0.1))]
    : [GLASS.top, GLASS.bottom];
  g.locations = [0, 1];
  try {
    g.startPoint = new Point(0.5, 0);
    g.endPoint = new Point(0.5, 1);
  } catch (_) {}
  return g;
}

function applyGlass(stack, radius, tintHex) {
  stack.backgroundGradient = glassGradient(tintHex);
  stack.cornerRadius = radius;
  stack.borderWidth = 1;
  stack.borderColor = GLASS.rim;
  return stack;
}

// Diffused, desaturated backdrop — reads like light seen through frosted glass.
function frostedBackground() {
  const g = new LinearGradient();
  g.colors = [
    Color.dynamic(new Color("#D3DAE8"), new Color("#1A1D25")),
    Color.dynamic(new Color("#E2DCE9"), new Color("#1F1B26")),
    Color.dynamic(new Color("#DCE3EA"), new Color("#181D22")),
    Color.dynamic(new Color("#D6DEE6"), new Color("#15191F")),
  ];
  g.locations = [0, 0.4, 0.75, 1];
  try {
    g.startPoint = new Point(0, 0);
    g.endPoint = new Point(1, 1);
  } catch (_) {}
  return g;
}

// Approximate widget point sizes so bars/rings fit exactly on every device
// instead of overflowing on narrow phones.
function widgetWidth(family) {
  let medium = 338;
  try {
    const sw = Math.min(Device.screenSize().width, Device.screenSize().height);
    if (Device.isPad()) medium = 330;
    else if (sw >= 428) medium = 364;
    else if (sw >= 414) medium = 360;
    else if (sw >= 390) medium = 338;
    else if (sw >= 375) medium = 329;
    else medium = 292;
  } catch (_) {}
  if (family === "small") return Math.round(medium * 0.465);
  if (family === "extraLarge") return medium * 2 + 20;
  return medium;
}

function createProgressImage(pct, width, height, hex) {
  // One bitmap for the whole track guarantees the fill starts at x = 0 (nested
  // stacks can center a very short child). Matte fill, no highlight.
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const ratio = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 0;

  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  ctx.addPath(track);
  ctx.setFillColor(new Color(hex, 0.16));
  ctx.fillPath();

  if (ratio > 0) {
    const fillW = Math.max(1, Math.round(w * ratio));
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, fillW, h), h / 2, h / 2);
    ctx.addPath(fill);
    ctx.setFillColor(new Color(hex, 0.92));
    ctx.fillPath();
  }
  return ctx.getImage();
}

function addProgress(parent, pct, width, height, hex) {
  const img = parent.addImage(createProgressImage(pct, width, height, hex));
  img.imageSize = new Size(Math.round(width), Math.round(height));
  img.leftAlignImage();
  return img;
}

function arcPoints(cx, cy, r, from, to, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + (to - from) * (i / steps);
    pts.push(new Point(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return pts;
}

function createRingImage(pct, size, lineWidth, hex, trackAlpha) {
  const s = Math.max(8, Math.round(size));
  const lw = lineWidth;
  const ctx = new DrawContext();
  ctx.size = new Size(s, s);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const r = (s - lw) / 2;
  const c = s / 2;
  ctx.setLineWidth(lw);
  ctx.setStrokeColor(new Color(hex, trackAlpha == null ? 0.16 : trackAlpha));
  ctx.strokeEllipse(new Rect(lw / 2, lw / 2, s - lw, s - lw));

  const ratio = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 0;
  if (ratio > 0) {
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * ratio;
    const steps = Math.max(4, Math.ceil(160 * ratio));

    const arc = new Path();
    arc.addLines(arcPoints(c, c, r, start, end, steps));
    ctx.addPath(arc);
    ctx.setStrokeColor(new Color(hex));
    ctx.setLineWidth(lw);
    ctx.strokePath();

    // Round caps (Path has no line-cap control).
    ctx.setFillColor(new Color(hex));
    for (const a of [start, end]) {
      ctx.fillEllipse(new Rect(c + r * Math.cos(a) - lw / 2, c + r * Math.sin(a) - lw / 2, lw, lw));
    }
  }
  return ctx.getImage();
}

function addRing(parent, pct, size, lineWidth, accent, labelSize, caption) {
  const st = parent.addStack();
  st.size = new Size(size, size);
  st.backgroundImage = createRingImage(pct, size, lineWidth, accent.hex);
  st.layoutVertically();
  st.centerAlignContent();
  st.addSpacer();
  const t = addText(st, fmtPct(pct), labelSize, C.primary, "bold", true);
  t.centerAlignText();
  t.minimumScaleFactor = 0.5;
  if (caption) {
    const cap = addText(st, caption, Math.max(7, labelSize * 0.42), C.secondary, "semibold");
    cap.centerAlignText();
  }
  st.addSpacer();
  return st;
}

function addDot(stack, size, color) {
  const dot = stack.addStack();
  dot.size = new Size(size, size);
  dot.cornerRadius = size / 2;
  dot.backgroundColor = color;
  return dot;
}

function addPctPill(stack, pct, accent, size) {
  const pill = stack.addStack();
  pill.backgroundColor = accent.soft;
  pill.cornerRadius = size;
  pill.borderWidth = 0.5;
  pill.borderColor = new Color(accent.hex, 0.35);
  pill.setPadding(1.5, 5, 1.5, 5);
  addText(pill, fmtPct(pct), size, accent.solid, "bold", true);
  return pill;
}

function addName(stack, server, data, size, weight) {
  const t = addText(stack, server.name, size, data && data.stale ? C.secondary : C.primary, weight || "semibold");
  t.minimumScaleFactor = 0.62;
  return t;
}

// ───────────────────────────── Widget blocks ─────────────────────────────

function addHeader(widget, pairs, allPairs, cfg, param) {
  const sum = summarize(allPairs, cfg);
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const icon = row.addStack();
  icon.size = new Size(24, 24);
  applyGlass(icon, 12);
  icon.centerAlignContent();
  addSymbol(icon, "gauge.with.dots.needle.67percent", 12, C.blue, "speedometer");
  row.addSpacer(7);

  const titles = row.addStack();
  titles.layoutVertically();
  addText(titles, param.type === "group" ? param.value : "服务器流量", 13, C.primary, "bold");
  const count = pairs.length < allPairs.length ? `${pairs.length}/${allPairs.length} 台` : `${allPairs.length} 台`;
  const totals = sum.limit > 0 ? ` · 合计 ${fmtGB(sum.used)}/${fmtGB(sum.limit)}` : "";
  addText(titles, `${count}${totals} · ${timeText()}`, 8.5, C.secondary, "medium");

  row.addSpacer();

  let label = "全部正常", hex = "#30D158", sym = "checkmark.circle.fill";
  if (sum.danger) { label = `${sum.danger} 超限`; hex = "#FF453A"; sym = "exclamationmark.octagon.fill"; }
  else if (sum.warning) { label = `${sum.warning} 预警`; hex = "#FF9F0A"; sym = "exclamationmark.triangle.fill"; }
  else if (sum.offline) { label = `${sum.offline} 离线`; hex = "#8E8E93"; sym = "icloud.slash.fill"; }
  const pill = row.addStack();
  applyGlass(pill, 11, hex);
  pill.setPadding(4, 8, 4, 8);
  pill.centerAlignContent();
  addSymbol(pill, sym, 9, new Color(hex));
  pill.addSpacer(4);
  addText(pill, label, 9.5, new Color(hex), "bold", true);
}

function addDenseRow(parent, pair, cfg, width, showUsage, tight) {
  const s = pair.server;
  const d = pair.data || {};
  const pct = Number.isFinite(d.pct) ? d.pct : NaN;
  const accent = accentFor(s, pct, cfg, !!d.stale);

  const block = parent.addStack();
  block.layoutVertically();
  block.spacing = tight ? 2.5 : 3.5;

  const line = block.addStack();
  line.layoutHorizontally();
  line.centerAlignContent();
  addDot(line, tight ? 5 : 6, accent.solid);
  line.addSpacer(tight ? 5 : 6);
  addName(line, s, d, tight ? 10 : 11);
  if (d.stale) {
    line.addSpacer(3);
    addSymbol(line, "icloud.slash", tight ? 7.5 : 8.5, C.tertiary);
  }
  line.addSpacer();
  if (showUsage && Number.isFinite(d.used)) {
    const u = addText(line, shortUsage(d), tight ? 8 : 9, C.secondary, "semibold", true);
    u.minimumScaleFactor = 0.6;
    line.addSpacer(4);
  }
  addPctPill(line, pct, accent, tight ? 8.5 : 9.5);

  if (!showUsage) addText(block, usageLine(d), tight ? 8 : 9, C.secondary, "medium", true);
  addProgress(block, pct, width, tight ? 4 : 5, accent.hex);
  return block;
}

function addDenseGrid(widget, pairs, cfg, innerWidth, cols, maxCount) {
  const panel = widget.addStack();
  panel.layoutVertically();
  applyGlass(panel, 18);
  panel.setPadding(10, 10, 10, 10);

  const colSpacing = 12;
  const colWidth = Math.floor((innerWidth - 20 - colSpacing * (cols - 1)) / cols);
  const list = pairs.slice(0, maxCount);
  const rows = Math.ceil(list.length / cols);
  for (let r = 0; r < rows; r++) {
    // Fixed + flexible spacer: rows never touch, and spread out to fill the
    // panel's full height when there is room.
    if (r > 0) { panel.addSpacer(5); panel.addSpacer(); }
    const row = panel.addStack();
    row.layoutHorizontally();
    row.spacing = colSpacing;
    for (let c = 0; c < cols; c++) {
      const ix = r * cols + c;
      const col = row.addStack();
      col.layoutVertically();
      col.size = new Size(colWidth, 0);
      if (ix < list.length) addDenseRow(col, list[ix], cfg, colWidth, true, true);
    }
  }
}

// Glass card with a small ring on the left — used for 2–4 servers.
function addRingCard(parent, pair, cfg, width, opts) {
  const o = opts || {};
  const s = pair.server;
  const d = pair.data || {};
  const pct = Number.isFinite(d.pct) ? d.pct : NaN;
  const accent = accentFor(s, pct, cfg, !!d.stale);
  const pad = 10;
  const ringSize = o.ring || 44;

  const card = parent.addStack();
  card.layoutVertically();
  card.size = new Size(width, 0);
  applyGlass(card, 18, pct >= cfg.dangerPercent && !d.stale ? accent.hex : null);
  card.setPadding(pad, pad, pad, pad);
  card.spacing = 7;

  const top = card.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  addRing(top, pct, ringSize, Math.max(4, ringSize * 0.12), accent, ringSize * 0.25);
  top.addSpacer(9);
  const info = top.addStack();
  info.layoutVertically();
  info.spacing = 2;
  const nameRow = info.addStack();
  nameRow.centerAlignContent();
  addName(nameRow, s, d, 12, "bold");
  if (d.stale) {
    nameRow.addSpacer(3);
    addSymbol(nameRow, "icloud.slash", 9, C.tertiary);
  }
  addText(info, usageLine(d), 10, C.primary, "semibold", true);
  const remain = remainOf(d);
  addText(info, Number.isFinite(remain) ? `剩余 ${fmtGB(remain)}` : (d.error || "暂无数据"), 8.5, C.secondary, "medium");
  top.addSpacer();

  addProgress(card, pct, width - pad * 2 - 2, 5, accent.hex);
  if (o.showIp && d.ip) addText(card, d.ip, 8, C.tertiary, "medium", true);
  return card;
}

// Large hero card for a single server.
function addHeroCard(parent, pair, cfg, width, ringSize) {
  const s = pair.server;
  const d = pair.data || {};
  const pct = Number.isFinite(d.pct) ? d.pct : NaN;
  const accent = accentFor(s, pct, cfg, !!d.stale);
  const pad = 12;

  const card = parent.addStack();
  card.layoutHorizontally();
  card.centerAlignContent();
  card.size = new Size(width, 0);
  applyGlass(card, 22, pct >= cfg.warningPercent && !d.stale ? accent.hex : null);
  card.setPadding(pad, pad, pad, pad);

  addRing(card, pct, ringSize, Math.max(6, ringSize * 0.11), accent, ringSize * 0.24, "已使用");
  card.addSpacer(14);

  const info = card.addStack();
  info.layoutVertically();
  info.spacing = 3;
  const nameRow = info.addStack();
  nameRow.centerAlignContent();
  addDot(nameRow, 7, accent.solid);
  nameRow.addSpacer(5);
  addName(nameRow, s, d, 14, "bold");
  addText(info, usageLine(d), ringSize >= 100 ? 20 : 16, C.primary, "bold", true);
  const remain = remainOf(d);
  const meta = [Number.isFinite(remain) ? `剩余 ${fmtGB(remain)}` : "", d.ip || ""].filter(Boolean).join(" · ");
  addText(info, meta || (d.error || "暂无数据"), 9, C.secondary, "medium", true);
  info.addSpacer(4);
  addProgress(info, pct, Math.max(40, width - pad * 2 - ringSize - 16), 6, accent.hex);
  if (d.stale) {
    info.addSpacer(3);
    addText(info, `缓存数据 · ${d.fetchedAt ? timeText(d.fetchedAt) : "—"}`, 8, C.tertiary, "medium");
  }
  card.addSpacer();
  return card;
}

function emptyWidget(widget, text) {
  widget.addSpacer();
  const center = widget.addStack();
  center.layoutHorizontally();
  center.addSpacer();
  const box = center.addStack();
  box.layoutVertically();
  box.centerAlignContent();
  const bubble = box.addStack();
  bubble.size = new Size(44, 44);
  applyGlass(bubble, 22);
  bubble.centerAlignContent();
  addSymbol(bubble, "server.rack", 20, C.secondary);
  box.addSpacer(8);
  const t = addText(box, text || "暂无服务器", 11, C.secondary, "semibold");
  t.centerAlignText();
  center.addSpacer();
  widget.addSpacer();
}

// ───────────────────────────── Families ─────────────────────────────

function renderSmall(widget, pairs, cfg) {
  const n = pairs.length;
  const W = widgetWidth("small");
  widget.setPadding(12, 12, 12, 12);
  const inner = W - 24;
  if (n === 0) return emptyWidget(widget, "点击添加服务器");

  if (n === 1) {
    const s = pairs[0].server;
    const d = pairs[0].data || {};
    const pct = Number.isFinite(d.pct) ? d.pct : NaN;
    const accent = accentFor(s, pct, cfg, !!d.stale);

    const top = widget.addStack();
    top.centerAlignContent();
    addDot(top, 7, accent.solid);
    top.addSpacer(5);
    addName(top, s, d, 12.5, "bold");
    top.addSpacer();
    addSymbol(top, d.stale ? "icloud.slash" : "antenna.radiowaves.left.and.right", 10, C.tertiary);

    widget.addSpacer();
    const mid = widget.addStack();
    mid.centerAlignContent();
    const ringSize = Math.min(66, Math.round(inner * 0.5));
    addRing(mid, pct, ringSize, 7, accent, 15);
    mid.addSpacer(9);
    const col = mid.addStack();
    col.layoutVertically();
    col.spacing = 1;
    addText(col, "已用", 8, C.secondary, "semibold");
    addText(col, fmtGB(d.used), 14, C.primary, "bold", true);
    col.addSpacer(3);
    addText(col, "剩余", 8, C.secondary, "semibold");
    addText(col, fmtGB(remainOf(d)), 14, accent.solid, "bold", true);
    widget.addSpacer();

    const foot = widget.addStack();
    foot.centerAlignContent();
    addText(foot, `总量 ${fmtGB(d.limit)}`, 8.5, C.secondary, "medium", true);
    foot.addSpacer();
    addText(foot, d.stale ? `缓存 ${d.fetchedAt ? timeText(d.fetchedAt) : ""}` : timeText(), 8.5, C.tertiary, "medium", true);
    return;
  }

  if (n === 2) {
    for (let i = 0; i < n; i++) {
      const s = pairs[i].server;
      const d = pairs[i].data || {};
      const pct = Number.isFinite(d.pct) ? d.pct : NaN;
      const accent = accentFor(s, pct, cfg, !!d.stale);
      const card = widget.addStack();
      card.layoutVertically();
      card.size = new Size(inner, 0);
      applyGlass(card, 16, pct >= cfg.dangerPercent && !d.stale ? accent.hex : null);
      card.setPadding(8, 9, 8, 9);
      card.spacing = 4;
      const top = card.addStack();
      top.centerAlignContent();
      addName(top, s, d, 11, "bold");
      top.addSpacer(4);
      addText(top, fmtPct(pct), 13, accent.solid, "heavy", true);
      addText(card, usageLine(d), 8.5, C.secondary, "medium", true);
      addProgress(card, pct, inner - 18, 5, accent.hex);
      if (i < n - 1) widget.addSpacer(7);
    }
    return;
  }

  // 3–4 servers: dense rows on the aurora background, each with its own glossy bar.
  const list = widget.addStack();
  list.layoutVertically();
  list.spacing = n >= 4 ? 5 : 8;
  for (let i = 0; i < Math.min(4, n); i++) addDenseRow(list, pairs[i], cfg, inner, false, n >= 4);
}

function renderMedium(widget, pairs, allPairs, cfg, param) {
  const W = widgetWidth("medium");
  widget.setPadding(12, 13, 12, 13);
  const inner = W - 26;
  if (pairs.length === 0) return emptyWidget(widget, "暂无匹配的服务器");
  addHeader(widget, pairs, allPairs, cfg, param);
  widget.addSpacer(8);

  if (pairs.length === 1) {
    addHeroCard(widget, pairs[0], cfg, inner, 72);
    return;
  }
  if (pairs.length === 2) {
    const row = widget.addStack();
    row.spacing = 8;
    const w = Math.floor((inner - 8) / 2);
    addRingCard(row, pairs[0], cfg, w, { ring: 40 });
    addRingCard(row, pairs[1], cfg, w, { ring: 40 });
    return;
  }
  addDenseGrid(widget, pairs, cfg, inner, 2, 6);
}

function renderLarge(widget, pairs, allPairs, cfg, param) {
  const W = widgetWidth("large");
  widget.setPadding(14, 14, 14, 14);
  const inner = W - 28;
  if (pairs.length === 0) return emptyWidget(widget, "暂无匹配的服务器");
  addHeader(widget, pairs, allPairs, cfg, param);
  widget.addSpacer(10);

  if (pairs.length === 1) {
    addHeroCard(widget, pairs[0], cfg, inner, 110);
    widget.addSpacer();
    const d = pairs[0].data || {};
    const tiles = widget.addStack();
    tiles.spacing = 8;
    const tw = Math.floor((inner - 16) / 3);
    for (const [label, value] of [["已用", fmtGB(d.used)], ["剩余", fmtGB(remainOf(d))], ["总量", fmtGB(d.limit)]]) {
      const t = tiles.addStack();
      t.layoutVertically();
      t.size = new Size(tw, 0);
      applyGlass(t, 16);
      t.setPadding(9, 10, 9, 10);
      addText(t, label, 9, C.secondary, "semibold");
      addText(t, value, 18, C.primary, "bold", true);
    }
    return;
  }

  if (pairs.length === 2) {
    addHeroCard(widget, pairs[0], cfg, inner, 86);
    widget.addSpacer(10);
    widget.addSpacer();
    addHeroCard(widget, pairs[1], cfg, inner, 86);
    return;
  }

  if (pairs.length <= 4) {
    const w = Math.floor((inner - 10) / 2);
    for (let r = 0; r < Math.ceil(pairs.length / 2); r++) {
      if (r > 0) { widget.addSpacer(10); widget.addSpacer(); }
      const row = widget.addStack();
      row.spacing = 10;
      for (let c = 0; c < 2; c++) {
        const ix = r * 2 + c;
        if (ix < pairs.length) addRingCard(row, pairs[ix], cfg, w, { ring: 50, showIp: true });
        else row.addSpacer(w);
      }
    }
    return;
  }

  addDenseGrid(widget, pairs, cfg, inner, 2, 16);
}

function renderExtraLarge(widget, pairs, allPairs, cfg, param) {
  const W = widgetWidth("extraLarge");
  widget.setPadding(16, 16, 16, 16);
  const inner = W - 32;
  if (pairs.length === 0) return emptyWidget(widget, "暂无匹配的服务器");
  addHeader(widget, pairs, allPairs, cfg, param);
  widget.addSpacer(10);
  if (pairs.length <= 4) {
    const w = Math.floor((inner - 10) / 2);
    const main = widget.addStack();
    main.layoutVertically();
    main.spacing = 10;
    for (let r = 0; r < Math.ceil(pairs.length / 2); r++) {
      const row = main.addStack();
      row.spacing = 10;
      for (let c = 0; c < 2; c++) {
        const ix = r * 2 + c;
        if (ix < pairs.length) addRingCard(row, pairs[ix], cfg, w, { ring: 56, showIp: true });
      }
    }
    widget.addSpacer();
  } else {
    addDenseGrid(widget, pairs, cfg, inner, 3, 24);
  }
}

// Lock Screen / StandBy accessory widgets. The system renders these in a
// vibrant monochrome style, so they use white glyphs and rely on opacity.
function renderAccessory(widget, family, pairs, cfg) {
  const top = pairs.slice().sort((a, b) => num(b.data.pct, -1) - num(a.data.pct, -1));
  const white = Color.white();

  if (family === "accessoryInline") {
    if (!top.length) { widget.addText("流量 · 未配置"); return; }
    const d = top[0].data || {};
    const sum = summarize(pairs, cfg);
    const flag = sum.danger ? "⚠︎ " : "";
    widget.addText(`${flag}${top[0].server.name} ${fmtPct(d.pct)} · ${pairs.length} 台`);
    return;
  }

  if (family === "accessoryCircular") {
    widget.addAccessoryWidgetBackground = true;
    if (!top.length) { addSymbol(widget, "server.rack", 18, white); return; }
    const d = top[0].data || {};
    widget.backgroundImage = createRingImage(d.pct, 64, 6, "#FFFFFF", 0.25);
    const col = widget.addStack();
    col.layoutVertically();
    col.centerAlignContent();
    const p = addText(col, fmtPct(d.pct), 14, white, "bold", true);
    p.centerAlignText();
    const n = addText(col, top[0].server.name, 7.5, new Color("#FFFFFF", 0.75), "semibold");
    n.centerAlignText();
    return;
  }

  // accessoryRectangular
  widget.setPadding(2, 4, 2, 4);
  if (!top.length) { addText(widget, "运行脚本添加服务器", 12, white, "semibold"); return; }
  const list = top.slice(0, 3);
  const stack = widget.addStack();
  stack.layoutVertically();
  stack.spacing = list.length >= 3 ? 2 : 4;
  for (const { server, data } of list) {
    const d = data || {};
    const row = stack.addStack();
    row.centerAlignContent();
    addText(row, server.name, 11, white, "semibold");
    row.addSpacer();
    addText(row, fmtPct(d.pct), 11, white, "bold", true);
    addProgress(stack, d.pct, 150, 3, "#FFFFFF");
  }
}

async function buildWidget(cfg, forcedFamily) {
  const family = forcedFamily || config.widgetFamily || "medium";
  const param = parseWidgetParameter(args.widgetParameter);
  const candidates = filterServers(cfg.servers, param);
  let allPairs = await fetchPairs(candidates, cfg);
  allPairs = sortPairs(allPairs, cfg, param);

  const w = new ListWidget();
  w.refreshAfterDate = new Date(Date.now() + Math.max(10, cfg.refreshMinutes || 30) * 60 * 1000);
  try { w.url = URLScheme.forRunningScript(); } catch (_) {}

  if (String(family).startsWith("accessory")) {
    renderAccessory(w, family, allPairs, cfg);
    return w;
  }

  const pairs = allPairs.slice(0, familyLimit(family, cfg));
  w.backgroundGradient = frostedBackground();

  if (family === "small") renderSmall(w, pairs, cfg);
  else if (family === "large") renderLarge(w, pairs, allPairs, cfg, param);
  else if (family === "extraLarge") renderExtraLarge(w, pairs, allPairs, cfg, param);
  else renderMedium(w, pairs, allPairs, cfg, param);
  return w;
}

// ───────────────────────────── Control panel (WebView) ─────────────────────────────

function panelHTML(cfg) {
  const cache = loadCache();
  const payload = {
    servers: cfg.servers.map((s) => {
      const c = cache[s.id];
      return {
        id: s.id,
        name: s.name,
        domain: s.domain,
        token: getToken(s.id),
        group: s.group || "",
        usage: c && Number.isFinite(c.pct) ? { pct: c.pct, text: usageLine(c), at: c.fetchedAt ? timeText(c.fetchedAt) : "" } : null,
      };
    }),
    sortMode: cfg.sortMode,
    refreshMinutes: cfg.refreshMinutes,
    warningPercent: cfg.warningPercent,
    dangerPercent: cfg.dangerPercent,
    maxPerSize: cfg.maxPerSize,
  };
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<style>
:root{color-scheme:light dark;
 --text:#0b0c10;--sub:rgba(60,60,67,.66);--faint:rgba(60,60,67,.38);
 --base:#e4e8f0;--b1:#8fb0ff;--b2:#d7a8ff;--b3:#8fe0f5;--b4:#ffc1d6;
 --frost:rgba(250,251,253,.52);--edge:rgba(255,255,255,.55);--grain:.07;
 --shadow:0 10px 40px rgba(30,40,70,.10),0 1px 3px rgba(30,40,70,.05);
 --field:rgba(255,255,255,.42);--field-edge:rgba(255,255,255,.5);--sep:rgba(60,60,67,.10);
 --blue:#007aff;--green:#34c759;--orange:#ff9500;--red:#ff3b30}
@media(prefers-color-scheme:dark){:root{
 --text:#fff;--sub:rgba(235,235,245,.62);--faint:rgba(235,235,245,.32);
 --base:#0c0e14;--b1:#2c4fd8;--b2:#7a34d0;--b3:#0f8fae;--b4:#c23a72;
 --frost:rgba(38,40,48,.50);--edge:rgba(255,255,255,.08);--grain:.10;
 --shadow:0 14px 44px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.3);
 --field:rgba(255,255,255,.05);--field-edge:rgba(255,255,255,.06);--sep:rgba(255,255,255,.07);
 --blue:#0a84ff;--green:#30d158;--orange:#ff9f0a;--red:#ff453a}}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;min-height:100%}
body{background:var(--base);color:var(--text);font:15px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;padding:calc(env(safe-area-inset-top) + 18px) 16px calc(env(safe-area-inset-bottom) + 110px);overflow-x:hidden}
.aurora{position:fixed;inset:-20%;z-index:-1;pointer-events:none;filter:blur(90px);opacity:.9}
.aurora i{position:absolute;border-radius:50%;animation:drift 22s ease-in-out infinite alternate}
.aurora i:nth-child(1){width:55vw;height:55vw;left:5%;top:2%;background:var(--b1)}
.aurora i:nth-child(2){width:50vw;height:50vw;right:0;top:20%;background:var(--b2);animation-duration:28s}
.aurora i:nth-child(3){width:60vw;height:60vw;left:15%;top:55%;background:var(--b3);animation-duration:32s}
.aurora i:nth-child(4){width:40vw;height:40vw;right:10%;top:75%;background:var(--b4);animation-duration:26s}
@keyframes drift{to{transform:translate(6vw,-5vh) scale(1.12)}}
@media(prefers-reduced-motion:reduce){.aurora i{animation:none}}
.wrap{max-width:720px;margin:0 auto}
.glass{position:relative;isolation:isolate;background:var(--frost);-webkit-backdrop-filter:blur(40px) saturate(150%);backdrop-filter:blur(40px) saturate(150%);border-radius:26px;border:.5px solid var(--edge);box-shadow:var(--shadow)}
.glass::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:-1;opacity:var(--grain);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 .5 0 0 0 0 .5 0 0 0 0 .5 0 0 0 1 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");background-size:160px}
.hero{display:flex;align-items:center;gap:14px;padding:6px 4px 20px}
.hero .logo{width:54px;height:54px;border-radius:18px;display:grid;place-items:center;flex:none}
.hero .logo svg{width:28px;height:28px;color:var(--blue)}
.hero h1{font-size:30px;line-height:1.1;letter-spacing:-.6px;margin:0;font-weight:800}
.hero p{margin:3px 0 0;color:var(--sub);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:6px}
.stat{padding:12px 14px;border-radius:22px}
.stat b{display:block;font:700 22px/1.1 ui-rounded,-apple-system,sans-serif;letter-spacing:-.4px}
.stat span{font-size:11px;color:var(--sub);font-weight:600}
.section{display:flex;align-items:baseline;justify-content:space-between;margin:24px 8px 10px}
.section h2{font-size:20px;letter-spacing:-.3px;margin:0;font-weight:700}
.section small{color:var(--sub);font-size:12px}
.server{padding:14px;margin-bottom:12px;animation:pop .35s cubic-bezier(.2,.9,.3,1.2) both}
@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.98)}}
.srv-head{display:flex;align-items:center;gap:11px}
.ring{--p:0;--c:var(--faint);width:46px;height:46px;border-radius:50%;flex:none;display:grid;place-items:center;background:conic-gradient(var(--c) calc(var(--p)*1%),color-mix(in srgb,var(--c) 18%,transparent) 0);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 6px),#000 calc(100% - 5.5px));mask:radial-gradient(farthest-side,transparent calc(100% - 6px),#000 calc(100% - 5.5px))}
.ring-wrap{position:relative;flex:none;width:46px;height:46px}
.ring-wrap em{position:absolute;inset:0;display:grid;place-items:center;font:700 11px ui-rounded,-apple-system,sans-serif;font-style:normal;color:var(--text)}
.name{flex:1;min-width:0;font-size:17px;font-weight:700;background:transparent;border:0;outline:0;color:var(--text);padding:4px 0;letter-spacing:-.2px}
.name::placeholder{color:var(--faint)}
.meta{font-size:12px;color:var(--sub);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.titlecol{flex:1;min-width:0}
.actions{display:flex;gap:6px;flex:none}
.cbtn{width:34px;height:34px;border-radius:50%;border:.5px solid var(--field-edge);display:grid;place-items:center;color:var(--text);background:var(--field);transition:transform .15s}
.cbtn:active{transform:scale(.88)}
.cbtn svg{width:16px;height:16px}
.cbtn.del{color:var(--red)}
.cbtn.del.armed{width:auto;padding:0 12px;border-radius:17px;background:var(--red);color:#fff;font-size:13px;font-weight:700}
.bar{height:6px;border-radius:3px;background:color-mix(in srgb,var(--c) 15%,transparent);margin:12px 2px 2px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:3px;background:var(--c);opacity:.9}
.fields{margin-top:12px;border-radius:16px;background:var(--field);border:.5px solid var(--field-edge);overflow:hidden}
.f{display:flex;align-items:center;gap:10px;padding:0 12px;min-height:46px;border-bottom:1px solid var(--sep)}
.f:last-child{border-bottom:0}
.f label{width:46px;flex:none;font-size:13px;color:var(--sub);font-weight:600}
.f input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--text);font-size:15px;padding:12px 0}
.f input::placeholder{color:var(--faint)}
.f .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px}
.eye{border:0;background:transparent;color:var(--sub);padding:6px;display:grid;place-items:center}
.eye svg{width:18px;height:18px}
.err{display:none;color:var(--red);font-size:12px;margin:8px 6px 0;font-weight:600}
.server.invalid .err{display:block}
.empty{padding:28px 20px;text-align:center;color:var(--sub);font-size:14px}
.empty b{display:block;color:var(--text);font-size:17px;margin-bottom:4px}
.settings{padding:4px 0}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--sep)}
.row:last-child{border-bottom:0}
.row .l b{font-size:15px;font-weight:600;display:block}
.row .l span{font-size:12px;color:var(--sub)}
.seg{position:relative;display:flex;padding:3px;border-radius:999px;background:var(--field);border:.5px solid var(--field-edge);margin:12px 16px 4px}
.seg button{position:relative;z-index:1;flex:1;border:0;background:transparent;color:var(--text);font-size:13px;font-weight:600;padding:8px 0;border-radius:999px}
.seg .thumb{position:absolute;z-index:0;top:3px;bottom:3px;left:3px;border-radius:999px;background:rgba(255,255,255,.78);box-shadow:0 2px 8px rgba(0,0,0,.08);transition:transform .35s cubic-bezier(.3,1.3,.5,1)}
@media(prefers-color-scheme:dark){.seg .thumb{background:rgba(255,255,255,.14);box-shadow:0 2px 8px rgba(0,0,0,.3)}}
.step{display:flex;align-items:center;border-radius:999px;background:var(--field);border:.5px solid var(--field-edge);flex:none}
.step button{width:34px;height:34px;border:0;background:transparent;color:var(--blue);font-size:20px;font-weight:500;line-height:1}
.step input{width:46px;border:0;outline:0;background:transparent;text-align:center;color:var(--text);font:600 15px ui-rounded,-apple-system,sans-serif;font-variant-numeric:tabular-nums;-moz-appearance:textfield}
.step input::-webkit-inner-spin-button,.step input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.zones{position:relative;height:8px;margin:2px 16px 14px;border-radius:4px;overflow:hidden;opacity:.85}
.zones-legend{display:flex;justify-content:space-between;margin:-8px 16px 12px;font-size:11px;color:var(--sub);font-variant-numeric:tabular-nums}
.sizes{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:12px 16px 14px}
.size{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:11px;color:var(--sub);font-weight:600}
.size .step input{width:30px}
.size .step button{width:24px}
.chips{display:flex;flex-wrap:wrap;gap:8px;padding:0 4px}
.chip{border:0;color:var(--text);padding:9px 13px;border-radius:999px;font-size:13px;text-align:left}
.chip code{font-family:ui-monospace,Menlo,monospace;font-weight:700;color:var(--blue)}
.chip span{color:var(--sub);margin-left:6px}
.tip{color:var(--sub);font-size:12px;line-height:1.6;padding:12px 8px 0}
.tip code{font-family:ui-monospace,Menlo,monospace;color:var(--text)}
.dock{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom) + 14px);transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:7px;border-radius:999px;width:min(440px,calc(100% - 32px));z-index:5}
.dock{background:color-mix(in srgb,var(--base) 72%,transparent)}
.dock .add{flex:1;height:46px;border:0;border-radius:999px;color:#fff;font-size:16px;font-weight:700;background:color-mix(in srgb,var(--blue) 88%,transparent);transition:transform .15s}
.dock .add:active{transform:scale(.96)}
.dock .hint{font-size:11.5px;color:var(--sub);padding:0 10px 0 6px;line-height:1.25;max-width:120px}
.toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 14px);transform:translate(-50%,-30px);opacity:0;padding:10px 18px;border-radius:999px;font-size:13px;font-weight:600;transition:all .35s cubic-bezier(.3,1.3,.5,1);z-index:9}
.toast.show{transform:translate(-50%,0);opacity:1}
</style></head>
<body><div class="aurora"><i></i><i></i><i></i><i></i></div>
<div class="wrap">
 <div class="hero"><div class="logo glass"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4-5"/><circle cx="12" cy="15" r="1.4" fill="currentColor"/><path d="M5 19h14"/></svg></div>
 <div><h1>流量监控</h1><p>${escapeHTML(APP_NAME)} · v${VERSION}</p></div></div>
 <div class="stats" id="stats"></div>
 <div class="section"><h2>服务器</h2><small id="count"></small></div>
 <div id="servers"></div>
 <div class="section"><h2>小组件</h2></div>
 <div class="glass settings">
  <div class="row" style="border:0;padding-bottom:0"><div class="l"><b>排序方式</b><span>风险优先：使用率高的排在前面</span></div></div>
  <div class="seg" id="seg"><div class="thumb" id="thumb"></div><button data-v="usage">风险优先</button><button data-v="manual">手动顺序</button><button data-v="name">名称</button></div>
  <input type="hidden" id="sortMode">
  <div class="row" style="margin-top:6px"><div class="l"><b>刷新间隔</b><span>分钟 · iOS 视为最早刷新时间</span></div><div class="step"><button data-s="refreshMinutes" data-d="-5">−</button><input id="refreshMinutes" type="number" inputmode="numeric" min="10" max="360"><button data-s="refreshMinutes" data-d="5">+</button></div></div>
  <div class="row"><div class="l"><b>预警阈值</b><span>达到后显示橙色</span></div><div class="step"><button data-s="warningPercent" data-d="-5">−</button><input id="warningPercent" type="number" inputmode="decimal" min="1" max="100"><button data-s="warningPercent" data-d="5">+</button></div></div>
  <div class="row" style="border:0"><div class="l"><b>超限阈值</b><span>达到后显示红色</span></div><div class="step"><button data-s="dangerPercent" data-d="-5">−</button><input id="dangerPercent" type="number" inputmode="decimal" min="1" max="300"><button data-s="dangerPercent" data-d="5">+</button></div></div>
  <div class="zones" id="zones"></div>
  <div class="zones-legend"><span>0%</span><span id="zw"></span><span id="zd"></span><span>100%</span></div>
 </div>
 <div class="section"><h2>显示数量</h2><small>每种尺寸最多显示的服务器</small></div>
 <div class="glass sizes">
  <div class="size">Small<div class="step"><button data-s="maxSmall" data-d="-1">−</button><input id="maxSmall" type="number" min="1" max="4"><button data-s="maxSmall" data-d="1">+</button></div></div>
  <div class="size">Medium<div class="step"><button data-s="maxMedium" data-d="-1">−</button><input id="maxMedium" type="number" min="1" max="6"><button data-s="maxMedium" data-d="1">+</button></div></div>
  <div class="size">Large<div class="step"><button data-s="maxLarge" data-d="-1">−</button><input id="maxLarge" type="number" min="1" max="16"><button data-s="maxLarge" data-d="1">+</button></div></div>
  <div class="size">XL<div class="step"><button data-s="maxExtra" data-d="-1">−</button><input id="maxExtra" type="number" min="1" max="24"><button data-s="maxExtra" data-d="1">+</button></div></div>
 </div>
 <div class="section"><h2>Widget Parameter</h2><small>轻点复制</small></div>
 <div class="chips">
  <button class="chip glass" data-copy="all"><code>all</code><span>全部</span></button>
  <button class="chip glass" data-copy="top:4"><code>top:4</code><span>用量最高 4 台</span></button>
  <button class="chip glass" data-copy="group:gcp"><code>group:gcp</code><span>指定分组</span></button>
  <button class="chip glass" data-copy="server:东京GCP"><code>server:名称</code><span>指定单台</span></button>
 </div>
 <div class="tip">接口：<code>GET {baseURL}/traffic?token=TOKEN</code><br>地址示例：<code>http://1.2.3.4:5000</code> 或 <code>https://traffic.example.com</code>。协议会原样保留，Token 仅保存在 iOS 钥匙串。</div>
</div>
<div class="dock glass"><button class="add" id="addBtn">＋ 添加服务器</button><div class="hint">编辑后点「完成」<br>自动保存</div></div>
<div class="toast glass" id="toast"></div>
<script>
var state=${json};
var $=function(id){return document.getElementById(id);};
var ICON={
 up:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
 down:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
 trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
 eye:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
 eyeoff:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
};
var PALETTE=['#64D2FF','#0A84FF','#BF5AF2','#FF375F','#30D158','#FF9F0A'];
function hash(t){t=String(t||'');var h=2166136261;for(var i=0;i<t.length;i++){h^=t.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function esc(v){return String(v==null?'':v).replace(/[&<>'"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c];});}
function warn(){return +$('warningPercent').value||80;}
function danger(){return +$('dangerPercent').value||95;}
function colorFor(s){var u=s.usage;if(!u)return 'var(--faint)';if(u.pct>=danger())return 'var(--red)';if(u.pct>=warn())return 'var(--orange)';return PALETTE[hash(s.id||s.name)%PALETTE.length];}
function validDomain(v){return !v||/^https?:\\/\\//i.test(String(v).trim());}
function toast(msg){var t=$('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show');},1600);}
function fmtPct(p){return p>=10?Math.round(p)+'%':p.toFixed(1)+'%';}
function renderStats(){
 var n=state.servers.length,w=0,d=0;
 state.servers.forEach(function(s){if(!s.usage)return;if(s.usage.pct>=danger())d++;else if(s.usage.pct>=warn())w++;});
 $('stats').innerHTML='<div class="stat glass"><b>'+n+'</b><span>服务器</span></div>'+
  '<div class="stat glass"><b style="color:var(--orange)">'+w+'</b><span>预警</span></div>'+
  '<div class="stat glass"><b style="color:var(--red)">'+d+'</b><span>超限</span></div>';
 $('count').textContent=n?('共 '+n+' 台'):'';
}
function render(){
 var root=$('servers');root.innerHTML='';
 if(!state.servers.length){root.innerHTML='<div class="glass empty"><b>还没有服务器</b>点击下方「添加服务器」，填写地址与 Token 即可开始监控。</div>';}
 state.servers.forEach(function(s,i){
  var c=colorFor(s),u=s.usage;
  var el=document.createElement('div');el.className='glass server'+(validDomain(s.domain)?'':' invalid');el.style.animationDelay=(i*40)+'ms';
  el.innerHTML='<div class="srv-head">'+
   '<div class="ring-wrap"><div class="ring" style="--p:'+(u?Math.min(100,u.pct):0)+';--c:'+c+'"></div><em>'+(u?fmtPct(u.pct):'—')+'</em></div>'+
   '<div class="titlecol"><input class="name" data-k="name" data-i="'+i+'" value="'+esc(s.name)+'" placeholder="服务器名称">'+
   '<div class="meta">'+(u?esc(u.text)+(u.at?' · '+esc(u.at):''):(s.id?'尚无缓存数据':'新服务器'))+(s.group?' · '+esc(s.group):'')+'</div></div>'+
   '<div class="actions"><button class="cbtn" data-act="up" data-i="'+i+'" aria-label="上移">'+ICON.up+'</button><button class="cbtn" data-act="down" data-i="'+i+'" aria-label="下移">'+ICON.down+'</button><button class="cbtn del" data-act="del" data-i="'+i+'" aria-label="删除">'+ICON.trash+'</button></div></div>'+
   (u?'<div class="bar" style="--c:'+c+'"><i style="width:'+Math.max(1,Math.min(100,u.pct))+'%"></i></div>':'')+
   '<div class="fields">'+
    '<div class="f"><label>地址</label><input class="mono" data-k="domain" data-i="'+i+'" value="'+esc(s.domain)+'" placeholder="http://1.2.3.4:5000" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" inputmode="url"></div>'+
    '<div class="f"><label>Token</label><input class="mono" id="tok'+i+'" type="password" data-k="token" data-i="'+i+'" value="'+esc(s.token)+'" placeholder="访问令牌" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false"><button class="eye" type="button" data-act="eye" data-i="'+i+'">'+ICON.eye+'</button></div>'+
    '<div class="f"><label>分组</label><input data-k="group" data-i="'+i+'" value="'+esc(s.group||'')+'" placeholder="可选，如 gcp" autocapitalize="none"></div>'+
   '</div><div class="err">地址需以 http:// 或 https:// 开头</div>';
  root.appendChild(el);
 });
 renderStats();
}
document.addEventListener('input',function(e){
 var k=e.target.dataset&&e.target.dataset.k;if(!k)return;
 var i=+e.target.dataset.i;state.servers[i][k]=e.target.value;
 if(k==='domain')e.target.closest('.server').classList.toggle('invalid',!validDomain(e.target.value));
});
document.addEventListener('click',function(e){
 var b=e.target.closest('[data-act]');
 if(b){
  var i=+b.dataset.i,a=b.dataset.act;
  if(a==='eye'){var t=$('tok'+i);var show=t.type==='password';t.type=show?'text':'password';b.innerHTML=show?ICON.eyeoff:ICON.eye;return;}
  if(a==='up'||a==='down'){var j=i+(a==='up'?-1:1);if(j<0||j>=state.servers.length)return;var tmp=state.servers[i];state.servers[i]=state.servers[j];state.servers[j]=tmp;render();return;}
  if(a==='del'){
   if(!b.classList.contains('armed')){b.classList.add('armed');b.textContent='删除';clearTimeout(b._h);b._h=setTimeout(function(){b.classList.remove('armed');b.innerHTML=ICON.trash;},2500);return;}
   state.servers.splice(i,1);render();toast('已删除');return;
  }
 }
 var st=e.target.closest('[data-s]');
 if(st){var inp=$(st.dataset.s);var v=(+inp.value||0)+(+st.dataset.d);v=Math.max(+inp.min||0,Math.min(+inp.max||999,v));inp.value=v;inp.dispatchEvent(new Event('change'));return;}
 var sg=e.target.closest('#seg button');
 if(sg){setSort(sg.dataset.v);return;}
 var cp=e.target.closest('[data-copy]');
 if(cp){var txt=cp.dataset.copy;try{navigator.clipboard.writeText(txt).then(function(){toast('已复制 '+txt);},function(){toast(txt);});}catch(_){toast(txt);}}
});
$('addBtn').addEventListener('click',function(){
 state.servers.push({id:'',name:'',domain:'',token:'',group:'',usage:null});render();
 var cards=document.querySelectorAll('.server');var last=cards[cards.length-1];
 if(last){last.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(function(){var n=last.querySelector('.name');if(n)n.focus();},350);}
});
function setSort(v){
 var btns=Array.prototype.slice.call(document.querySelectorAll('#seg button'));var ix=Math.max(0,btns.findIndex(function(b){return b.dataset.v===v;}));
 $('sortMode').value=btns[ix].dataset.v;var w=btns[0].offsetWidth;$('thumb').style.width=w+'px';$('thumb').style.transform='translateX('+(ix*w)+'px)';
}
function renderZones(){
 var w=Math.min(100,warn()),d=Math.min(100,Math.max(w,danger()));
 $('zones').style.background='linear-gradient(90deg,var(--green) 0,var(--green) '+w+'%,var(--orange) '+w+'%,var(--orange) '+d+'%,var(--red) '+d+'%,var(--red) 100%)';
 $('zw').textContent='预警 '+warn()+'%';$('zd').textContent='超限 '+danger()+'%';
 renderStats();
 document.querySelectorAll('.server').forEach(function(el,i){var s=state.servers[i];if(!s)return;var c=colorFor(s);var r=el.querySelector('.ring');if(r)r.style.setProperty('--c',c);var bar=el.querySelector('.bar');if(bar)bar.style.setProperty('--c',c);});
}
['warningPercent','dangerPercent'].forEach(function(id){$(id).addEventListener('change',renderZones);$(id).addEventListener('input',renderZones);});
$('refreshMinutes').value=state.refreshMinutes||30;$('warningPercent').value=state.warningPercent||80;$('dangerPercent').value=state.dangerPercent||95;
var mp=state.maxPerSize||{};$('maxSmall').value=mp.small||4;$('maxMedium').value=mp.medium||6;$('maxLarge').value=mp.large||16;$('maxExtra').value=mp.extraLarge||24;
render();renderZones();
requestAnimationFrame(function(){setSort(state.sortMode||'usage');});
window.addEventListener('resize',function(){setSort($('sortMode').value);});
window.__collectConfig=function(){return{
 servers:state.servers.map(function(s){return{id:s.id,name:s.name,domain:s.domain,token:s.token,group:s.group};}),
 sortMode:$('sortMode').value||'usage',
 refreshMinutes:+$('refreshMinutes').value||30,
 warningPercent:+$('warningPercent').value||80,
 dangerPercent:+$('dangerPercent').value||95,
 maxPerSize:{small:+$('maxSmall').value||4,medium:+$('maxMedium').value||6,large:+$('maxLarge').value||16,extraLarge:+$('maxExtra').value||24}
};};
</script></body></html>`;
}

function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function openControlPanel(cfg) {
  const web = new WebView();
  await web.loadHTML(panelHTML(cfg));
  await web.present(true);
  let raw = null;
  try { raw = await web.evaluateJavaScript("JSON.stringify(window.__collectConfig())"); } catch (_) {}
  if (!raw) return cfg;

  let incoming;
  try { incoming = JSON.parse(raw); } catch (_) { return cfg; }
  const oldIds = new Set(cfg.servers.map((s) => s.id));
  const nextServers = [];
  for (const item of incoming.servers || []) {
    if (!item.name && !item.domain && !item.token) continue;
    const id = item.id || uid();
    nextServers.push({ id, name: String(item.name || "未命名").trim() || "未命名", domain: String(item.domain || "").trim(), group: String(item.group || "").trim() });
    setToken(id, String(item.token || "").trim());
    oldIds.delete(id);
  }
  for (const deletedId of oldIds) deleteToken(deletedId);

  cfg.servers = nextServers;
  cfg.sortMode = ["usage", "manual", "name"].includes(incoming.sortMode) ? incoming.sortMode : "usage";
  cfg.refreshMinutes = Math.max(10, Math.min(360, parseInt(incoming.refreshMinutes, 10) || 30));
  cfg.warningPercent = Math.max(1, Math.min(100, num(incoming.warningPercent, 80)));
  cfg.dangerPercent = Math.max(cfg.warningPercent, Math.min(300, num(incoming.dangerPercent, 95)));
  cfg.maxPerSize = {
    small: Math.max(1, Math.min(4, parseInt(incoming.maxPerSize && incoming.maxPerSize.small, 10) || 4)),
    medium: Math.max(1, Math.min(6, parseInt(incoming.maxPerSize && incoming.maxPerSize.medium, 10) || 6)),
    large: Math.max(1, Math.min(16, parseInt(incoming.maxPerSize && incoming.maxPerSize.large, 10) || 16)),
    extraLarge: Math.max(1, Math.min(24, parseInt(incoming.maxPerSize && incoming.maxPerSize.extraLarge, 10) || 24)),
  };
  saveConfig(cfg);
  return cfg;
}

async function testAll(cfg) {
  if (!cfg.servers.length) {
    const a = new Alert(); a.title = "没有服务器"; a.message = "请先添加服务器。"; a.addAction("好"); await a.present(); return;
  }
  const pairs = await fetchPairs(cfg.servers, cfg);
  const table = new UITable();
  table.showSeparators = true;

  const head = new UITableRow();
  head.isHeader = true;
  head.height = 64;
  const sum = summarize(pairs, cfg);
  const okCount = pairs.filter(({ data }) => Number.isFinite(data.pct) && !data.stale).length;
  const title = head.addText("连接测试", `${okCount}/${pairs.length} 在线 · 合计 ${fmtGB(sum.used)} / ${fmtGB(sum.limit)}`);
  title.titleFont = Font.boldSystemFont(22);
  title.subtitleFont = Font.mediumSystemFont(13);
  title.subtitleColor = Color.gray();
  table.addRow(head);

  for (const { server, data } of pairs) {
    const d = data || {};
    const ok = Number.isFinite(d.pct);
    const accent = accentFor(server, d.pct, cfg, !!d.stale);
    const row = new UITableRow();
    row.height = 60;

    const symName = !ok ? "xmark.circle.fill" : d.stale ? "exclamationmark.circle.fill" : "checkmark.circle.fill";
    const sym = SFSymbol.named(symName);
    if (sym) {
      sym.applyFont(Font.semiboldSystemFont(20));
      const ic = row.addImage(sym.image);
      ic.widthWeight = 10;
      ic.centerAligned();
    }
    const info = row.addText(server.name, ok ? `${usageLine(d)}${d.stale ? " · 缓存（" + (d.error || "请求失败") + "）" : ""}` : (d.error || "失败"));
    info.widthWeight = 64;
    info.titleFont = Font.semiboldSystemFont(16);
    info.subtitleFont = Font.systemFont(12);
    info.subtitleColor = Color.gray();
    const pct = row.addText(fmtPct(d.pct));
    pct.widthWeight = 26;
    pct.rightAligned();
    pct.titleFont = font(20, "bold", true);
    pct.titleColor = accent.solid;
    table.addRow(row);
  }
  await table.present(false);
}

async function afterPanel(cfg) {
  const a = new Alert();
  a.title = "✓ 配置已保存";
  a.message = `${cfg.servers.length} 台服务器 · v${VERSION}`;
  a.addAction("连接测试");
  a.addAction("预览 Small");
  a.addAction("预览 Medium");
  a.addAction("预览 Large");
  const canPreviewExtraLarge = typeof Device !== "undefined" && typeof Device.isPad === "function" && Device.isPad() && typeof ListWidget.prototype.presentExtraLarge === "function";
  if (canPreviewExtraLarge) a.addAction("预览 Extra Large");
  a.addCancelAction("完成");
  const ix = await a.present();
  if (ix === -1) return;
  if (ix === 0) return await testAll(cfg);
  const family = [null, "small", "medium", "large", "extraLarge"][ix];
  const w = await buildWidget(cfg, family);
  if (family === "small") await w.presentSmall();
  else if (family === "large") await w.presentLarge();
  else if (family === "extraLarge" && typeof w.presentExtraLarge === "function") await w.presentExtraLarge();
  else await w.presentMedium();
}

let cfg = loadConfig();
saveConfig(cfg);

if (config.runsInWidget) {
  const widget = await buildWidget(cfg);
  Script.setWidget(widget);
  Script.complete();
} else {
  cfg = await openControlPanel(cfg);
  await afterPanel(cfg);
  Script.complete();
}
