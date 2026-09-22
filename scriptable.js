// Traffic Monitor 27 for Scriptable
// Designed for iPhone/iPad widgets with high-density multi-server traffic monitoring.
// Current server API: {baseURL}/traffic?token=TOKEN
// baseURL preserves the configured scheme exactly (http:// or https://).
// API fields: hostname, ip, max_traffic_gb, total_usage_gb, usage_percentage

const APP_NAME = "Traffic Monitor 27";
const VERSION = "2.3.0";
const fm = FileManager.local();
const DOCS = fm.documentsDirectory();
const CONFIG_PATH = fm.joinPath(DOCS, "traffic_monitor_27.json");
const CACHE_PATH = fm.joinPath(DOCS, "traffic_monitor_27_cache.json");
const KEY_PREFIX = "traffic-monitor-27-token-";

const C = {
  bg: Color.dynamic(new Color("#F7F8FC"), new Color("#0C0D11")),
  card: Color.dynamic(new Color("#FFFFFF", 0.76), new Color("#202127", 0.72)),
  primary: Color.dynamic(new Color("#111318"), new Color("#F7F7FA")),
  secondary: Color.dynamic(new Color("#656A73"), new Color("#B3B4BC")),
  tertiary: Color.dynamic(new Color("#8B9099"), new Color("#777982")),
  track: Color.dynamic(new Color("#D7DAE0", 0.72), new Color("#34363E", 0.78)),
  green: new Color("#30D158"),
  orange: new Color("#FF9F0A"),
  red: new Color("#FF453A"),
  blue: new Color("#0A84FF"),
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

function accentFor(server, pct, cfg, stale) {
  if (stale || !Number.isFinite(pct)) {
    return { solid: C.tertiary, soft: Color.dynamic(new Color("#8E8E93", 0.12), new Color("#8E8E93", 0.16)) };
  }
  if (pct >= cfg.dangerPercent) {
    return { solid: C.red, soft: new Color("#FF453A", 0.16) };
  }
  if (pct >= cfg.warningPercent) {
    return { solid: C.orange, soft: new Color("#FF9F0A", 0.16) };
  }
  const item = ACCENTS[stableHash(server && (server.id || server.name)) % ACCENTS.length];
  return { solid: new Color(item[0]), soft: new Color(item[1], 0.15) };
}

function statusColor(pct, cfg, stale) {
  if (stale) return C.tertiary;
  if (!Number.isFinite(pct)) return C.tertiary;
  if (pct >= cfg.dangerPercent) return C.red;
  if (pct >= cfg.warningPercent) return C.orange;
  return C.green;
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
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(2);
}

function usageLine(d) {
  if (!d || !Number.isFinite(d.used) || !Number.isFinite(d.limit)) return "暂无数据";
  // Most monitored quotas are GB-based. Keep the unit visually explicit so a
  // compact widget still answers the important question: how many GB are used?
  if (d.used < 1024 && d.limit < 1024) return `${gbNumber(d.used)} / ${gbNumber(d.limit)} GB`;
  return fmtGB(d.used) + " / " + fmtGB(d.limit);
}

function createProgressImage(pct, width, height, color, trackColor) {
  // Draw the complete track into one bitmap. Scriptable's nested Stack layout can
  // center a very short child stack on some widget sizes; drawing into a bitmap
  // guarantees that the filled portion always starts at x = 0.
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const ratio = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 0;

  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const trackPath = new Path();
  trackPath.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  ctx.addPath(trackPath);
  ctx.setFillColor(trackColor || C.track);
  ctx.fillPath();

  if (ratio > 0) {
    // Do not force a minimum width of `height`: at 1-2% usage that would visually
    // exaggerate the actual quota. One physical point is enough to remain visible.
    const fillW = Math.max(1, Math.round(w * ratio));
    const fillPath = new Path();
    fillPath.addRoundedRect(new Rect(0, 0, fillW, h), h / 2, h / 2);
    ctx.addPath(fillPath);
    ctx.setFillColor(color);
    ctx.fillPath();
  }

  return ctx.getImage();
}

function addProgress(parent, pct, width, height, color, trackColor) {
  const img = parent.addImage(createProgressImage(pct, width, height, color, trackColor));
  img.imageSize = new Size(width, height);
  img.leftAlignImage();
  return img;
}

function addText(stack, text, size, color, weight) {
  const t = stack.addText(String(text));
  t.textColor = color || C.primary;
  if (weight === "bold") t.font = Font.boldSystemFont(size);
  else if (weight === "medium") t.font = Font.mediumSystemFont(size);
  else t.font = Font.systemFont(size);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.72;
  return t;
}

function addHeader(widget, visible, total, param) {
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  const left = row.addStack();
  left.layoutVertically();
  addText(left, param.type === "group" ? param.value : "服务器流量", 13, C.primary, "bold");
  row.addSpacer();
  const right = row.addStack();
  right.layoutVertically();
  const countText = visible < total ? `${visible}/${total} 台` : `${total} 台`;
  const ct = addText(right, countText, 9, C.secondary, "medium");
  ct.rightAlignText();
  const tm = new DateFormatter();
  tm.dateFormat = "HH:mm";
  const ut = addText(right, tm.string(new Date()), 8, C.tertiary);
  ut.rightAlignText();
}

function addDenseRow(parent, pair, cfg, width, showUsage, compactLevel) {
  const s = pair.server;
  const d = pair.data || {};
  const pct = Number.isFinite(d.pct) ? d.pct : NaN;
  const accent = accentFor(s, pct, cfg, !!d.stale);
  const tight = compactLevel === "tight";

  const block = parent.addStack();
  block.layoutVertically();
  block.spacing = tight ? 2 : 3;

  const line = block.addStack();
  line.layoutHorizontally();
  line.centerAlignContent();

  const dot = line.addStack();
  dot.size = new Size(tight ? 5 : 6, tight ? 5 : 6);
  dot.cornerRadius = tight ? 2.5 : 3;
  dot.backgroundColor = accent.solid;
  line.addSpacer(tight ? 5 : 6);

  const name = addText(line, (d.stale ? "· " : "") + s.name, tight ? 9.5 : 10.5, C.primary, "medium");
  name.minimumScaleFactor = 0.62;
  line.addSpacer(4);

  if (showUsage && Number.isFinite(d.used)) {
    const u = addText(line, usageLine(d), tight ? 7.5 : 8, C.secondary, "medium");
    u.rightAlignText();
    line.addSpacer(5);
  }

  const pill = line.addStack();
  pill.backgroundColor = accent.soft;
  pill.cornerRadius = tight ? 5 : 6;
  pill.setPadding(tight ? 1 : 2, 5, tight ? 1 : 2, 5);
  const p = addText(pill, fmtPct(pct), tight ? 8.5 : 9.5, accent.solid, "bold");
  p.rightAlignText();

  // In Small we always show the absolute GB value on its own line; on larger
  // widgets showUsage already places it on the title line to save height.
  if (!showUsage) {
    const usage = addText(block, usageLine(d), tight ? 7.5 : 8.5, C.secondary, "medium");
    usage.minimumScaleFactor = 0.66;
  }

  addProgress(block, pct, width, tight ? 3 : 4, accent.solid, accent.soft);
  return block;
}

function addCompactCard(parent, pair, cfg, barWidth, detail) {
  const s = pair.server;
  const d = pair.data || {};
  const pct = Number.isFinite(d.pct) ? d.pct : NaN;
  const accent = accentFor(s, pct, cfg, !!d.stale);
  const color = accent.solid;

  const card = parent.addStack();
  card.layoutVertically();
  card.backgroundColor = C.card;
  card.cornerRadius = 12;
  card.setPadding(8, 9, 8, 9);
  card.spacing = 4;

  const top = card.addStack();
  top.layoutHorizontally();
  top.centerAlignContent();
  addText(top, (d.stale ? "· " : "") + s.name, detail ? 12 : 10, C.primary, "bold");
  top.addSpacer(4);
  const p = addText(top, fmtPct(pct), detail ? 16 : 11, color, "bold");
  p.rightAlignText();

  const usage = addText(card, usageLine(d), detail ? 10 : 8, C.secondary, "medium");
  usage.minimumScaleFactor = 0.7;
  addProgress(card, pct, barWidth, detail ? 6 : 4, color, accent.soft);

  if (detail) {
    const remain = Number.isFinite(d.limit) && Number.isFinite(d.used) ? Math.max(0, d.limit - d.used) : NaN;
    const info = card.addStack();
    info.layoutHorizontally();
    addText(info, Number.isFinite(remain) ? "剩余 " + fmtGB(remain) : "", 8, C.tertiary);
    info.addSpacer();
    if (d.ip) {
      const ip = addText(info, d.ip, 8, C.tertiary);
      ip.rightAlignText();
    }
  }
  return card;
}

function emptyWidget(widget, text) {
  widget.addSpacer();
  const center = widget.addStack();
  center.layoutVertically();
  center.centerAlignContent();
  const icon = SFSymbol.named("server.rack");
  icon.applyFont(Font.systemFont(24));
  const img = center.addImage(icon.image);
  img.tintColor = C.tertiary;
  img.imageSize = new Size(25, 25);
  center.addSpacer(7);
  const t = addText(center, text || "暂无服务器", 11, C.secondary, "medium");
  t.centerAlignText();
  widget.addSpacer();
}

function renderSmall(widget, pairs, cfg) {
  const n = pairs.length;
  widget.setPadding(8, 9, 8, 9);
  if (n === 0) return emptyWidget(widget, "运行脚本添加服务器");

  if (n === 1) {
    const s = pairs[0].server;
    const d = pairs[0].data || {};
    const pct = Number.isFinite(d.pct) ? d.pct : NaN;
    const accent = accentFor(s, pct, cfg, !!d.stale);
    const top = widget.addStack();
    top.layoutHorizontally();
    top.centerAlignContent();
    const dot = top.addStack();
    dot.size = new Size(7, 7);
    dot.cornerRadius = 3.5;
    dot.backgroundColor = accent.solid;
    top.addSpacer(6);
    addText(top, s.name, 12, C.primary, "bold");
    top.addSpacer();
    const pill = top.addStack();
    pill.backgroundColor = accent.soft;
    pill.cornerRadius = 7;
    pill.setPadding(2, 6, 2, 6);
    addText(pill, fmtPct(pct), 12, accent.solid, "bold");

    widget.addSpacer(9);
    addText(widget, usageLine(d), 13, C.primary, "bold");
    widget.addSpacer(4);
    const remain = Number.isFinite(d.limit) && Number.isFinite(d.used) ? Math.max(0, d.limit - d.used) : NaN;
    addText(widget, Number.isFinite(remain) ? `剩余 ${fmtGB(remain)}` : "", 8.5, C.secondary, "medium");
    widget.addSpacer(10);
    addProgress(widget, pct, 132, 7, accent.solid, accent.soft);
    widget.addSpacer(7);
    if (d.ip) addText(widget, d.ip, 8, C.tertiary);
    if (d.stale) addText(widget, "缓存数据", 8, C.tertiary);
    return;
  }

  if (n === 2) {
    for (let i = 0; i < n; i++) {
      addCompactCard(widget, pairs[i], cfg, 124, false);
      if (i < n - 1) widget.addSpacer(6);
    }
    return;
  }

  // 3-4 servers: use the full Small widget height. Each row shows server name,
  // percentage, absolute GB usage and a thin tinted progress bar.
  const container = widget.addStack();
  container.layoutVertically();
  container.spacing = n >= 4 ? 4 : 6;
  const tight = n >= 4 ? "tight" : "normal";
  const barWidth = 134;
  for (let i = 0; i < Math.min(4, n); i++) addDenseRow(container, pairs[i], cfg, barWidth, false, tight);
}

function renderMedium(widget, pairs, cfg, total, param) {
  widget.setPadding(10, 12, 10, 12);
  if (pairs.length === 0) return emptyWidget(widget, "暂无匹配的服务器");
  addHeader(widget, pairs.length, total, param);
  widget.addSpacer(7);

  if (pairs.length === 1) {
    const row = widget.addStack();
    row.layoutHorizontally();
    addCompactCard(row, pairs[0], cfg, 284, true);
    return;
  }

  if (pairs.length === 2) {
    const row = widget.addStack();
    row.layoutHorizontally();
    row.spacing = 8;
    addCompactCard(row, pairs[0], cfg, 132, true);
    addCompactCard(row, pairs[1], cfg, 132, true);
    return;
  }

  const rows = Math.ceil(Math.min(6, pairs.length) / 2);
  const main = widget.addStack();
  main.layoutVertically();
  main.spacing = 7;
  for (let r = 0; r < rows; r++) {
    const line = main.addStack();
    line.layoutHorizontally();
    line.spacing = 10;
    for (let c = 0; c < 2; c++) {
      const ix = r * 2 + c;
      if (ix < pairs.length) {
        const col = line.addStack();
        col.layoutVertically();
        addDenseRow(col, pairs[ix], cfg, 137, true, "tight");
      } else {
        line.addSpacer(137);
      }
    }
  }
}

function renderLarge(widget, pairs, cfg, total, param) {
  widget.setPadding(12, 13, 12, 13);
  if (pairs.length === 0) return emptyWidget(widget, "暂无匹配的服务器");
  addHeader(widget, pairs.length, total, param);
  widget.addSpacer(9);

  if (pairs.length === 1) {
    addCompactCard(widget, pairs[0], cfg, 300, true);
    return;
  }

  if (pairs.length <= 4) {
    const main = widget.addStack();
    main.layoutVertically();
    main.spacing = 9;
    for (let r = 0; r < Math.ceil(pairs.length / 2); r++) {
      const row = main.addStack();
      row.layoutHorizontally();
      row.spacing = 9;
      for (let c = 0; c < 2; c++) {
        const ix = r * 2 + c;
        if (ix < pairs.length) addCompactCard(row, pairs[ix], cfg, 139, true);
        else row.addSpacer(157);
      }
    }
    return;
  }

  const rows = Math.ceil(Math.min(16, pairs.length) / 2);
  const main = widget.addStack();
  main.layoutVertically();
  main.spacing = 7;
  for (let r = 0; r < rows; r++) {
    const row = main.addStack();
    row.layoutHorizontally();
    row.spacing = 12;
    for (let c = 0; c < 2; c++) {
      const ix = r * 2 + c;
      if (ix < pairs.length) {
        const col = row.addStack();
        col.layoutVertically();
        addDenseRow(col, pairs[ix], cfg, 137, true, "tight");
      } else {
        row.addSpacer(145);
      }
    }
  }
}

function renderExtraLarge(widget, pairs, cfg, total, param) {
  widget.setPadding(14, 16, 14, 16);
  if (pairs.length === 0) return emptyWidget(widget, "暂无匹配的服务器");
  addHeader(widget, pairs.length, total, param);
  widget.addSpacer(10);

  const cols = pairs.length <= 4 ? 2 : 3;
  const width = cols === 2 ? 260 : 190;
  const rows = Math.ceil(Math.min(24, pairs.length) / cols);
  const main = widget.addStack();
  main.layoutVertically();
  main.spacing = 8;
  for (let r = 0; r < rows; r++) {
    const row = main.addStack();
    row.layoutHorizontally();
    row.spacing = 12;
    for (let c = 0; c < cols; c++) {
      const ix = r * cols + c;
      if (ix < pairs.length) {
        const col = row.addStack();
        col.layoutVertically();
        addDenseRow(col, pairs[ix], cfg, width, true, "tight");
      } else {
        row.addSpacer(width);
      }
    }
  }
}

async function buildWidget(cfg, forcedFamily) {
  const family = forcedFamily || config.widgetFamily || "medium";
  const param = parseWidgetParameter(args.widgetParameter);
  const candidates = filterServers(cfg.servers, param);
  let pairs = await fetchPairs(candidates, cfg);
  pairs = sortPairs(pairs, cfg, param);
  const total = pairs.length;
  const limit = familyLimit(family, cfg);
  pairs = pairs.slice(0, limit);

  const w = new ListWidget();
  const bg = new LinearGradient();
  bg.colors = [
    Color.dynamic(new Color("#FAFBFF"), new Color("#0A0B0F")),
    Color.dynamic(new Color("#F0F3FF"), new Color("#15121D")),
  ];
  bg.locations = [0, 1];
  w.backgroundGradient = bg;
  w.refreshAfterDate = new Date(Date.now() + Math.max(10, cfg.refreshMinutes || 30) * 60 * 1000);

  if (family === "small") renderSmall(w, pairs, cfg);
  else if (family === "large") renderLarge(w, pairs, cfg, total, param);
  else if (family === "extraLarge") renderExtraLarge(w, pairs, cfg, total, param);
  else renderMedium(w, pairs, cfg, total, param);
  return w;
}

function escapeHTML(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function panelHTML(cfg) {
  const payload = {
    servers: cfg.servers.map((s) => ({
      id: s.id,
      name: s.name,
      domain: s.domain,
      token: getToken(s.id),
      group: s.group || "",
    })),
    sortMode: cfg.sortMode,
    refreshMinutes: cfg.refreshMinutes,
    warningPercent: cfg.warningPercent,
    dangerPercent: cfg.dangerPercent,
    maxPerSize: cfg.maxPerSize,
  };
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
:root{color-scheme:light dark;--bg:#f2f2f7;--card:rgba(255,255,255,.72);--text:#111;--sub:#6e6e73;--line:rgba(60,60,67,.18);--blue:#007aff;--red:#ff3b30;--field:rgba(118,118,128,.12)}
@media(prefers-color-scheme:dark){:root{--bg:#000;--card:rgba(44,44,46,.72);--text:#fff;--sub:#98989d;--line:rgba(84,84,88,.65);--blue:#0a84ff;--field:rgba(118,118,128,.24)}}
*{box-sizing:border-box} body{margin:0;background:var(--bg);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color:var(--text);padding:18px 14px 44px} .wrap{max-width:760px;margin:auto}
.hero{padding:8px 4px 14px}.hero h1{font-size:28px;letter-spacing:-.6px;margin:0 0 5px}.hero p{font-size:13px;color:var(--sub);margin:0;line-height:1.45}
.section-title{font-size:13px;color:var(--sub);text-transform:uppercase;margin:18px 5px 7px}.card{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden;backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}
.server{padding:12px;border-bottom:1px solid var(--line)} .server:last-child{border-bottom:0}.grid{display:grid;grid-template-columns:minmax(86px,.85fr) minmax(120px,1.5fr) minmax(88px,1fr) 36px;gap:7px;align-items:center}
input,select{width:100%;border:0;outline:none;background:var(--field);color:var(--text);border-radius:10px;padding:10px 9px;font-size:13px;min-width:0} input::placeholder{color:var(--sub)}
.token-wrap{position:relative}.token-wrap input{padding-right:29px}.eye{position:absolute;right:5px;top:50%;transform:translateY(-50%);border:0;background:transparent;color:var(--sub);font-size:13px;padding:5px}
.subrow{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:8px;align-items:center}.group{font-size:12px}.order{display:flex;gap:6px}.iconbtn,.addbtn{border:0;border-radius:10px;background:var(--field);color:var(--blue);height:34px;min-width:34px;font-size:15px}.delete{color:var(--red)}
.add{padding:12px}.addbtn{width:100%;font-size:14px;font-weight:600;background:rgba(0,122,255,.11)}
.settings .row{display:grid;grid-template-columns:1fr 120px;gap:12px;align-items:center;padding:11px 13px;border-bottom:1px solid var(--line)}.settings .row:last-child{border-bottom:0}.label b{font-size:14px}.label span{display:block;color:var(--sub);font-size:11px;margin-top:2px;line-height:1.3}.settings input,.settings select{padding:8px}
.switch{display:flex;justify-content:flex-end;align-items:center}.switch input{width:44px;height:26px;accent-color:var(--blue)}
.tip{font-size:12px;color:var(--sub);line-height:1.55;padding:2px 5px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--text)}
.footer{position:sticky;bottom:10px;margin-top:18px;padding:10px 12px;border-radius:16px;background:rgba(118,118,128,.16);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);font-size:12px;color:var(--sub);text-align:center}
@media(max-width:420px){body{padding-left:10px;padding-right:10px}.grid{grid-template-columns:92px minmax(0,1fr) 94px 34px;gap:5px}.server{padding:10px 8px}input{font-size:12px;padding:9px 7px}.hero h1{font-size:25px}}
</style></head>
<body><div class="wrap"><div class="hero"><h1>${APP_NAME}</h1><p>名称、服务器地址、Token 在同一行管理。地址必须明确填写 http:// 或 https://；脚本会原样保留协议。Token 保存到 iOS Keychain。</p></div>
<div class="section-title">服务器</div><div class="card" id="servers"></div>
<div class="section-title">Widget 设置</div><div class="card settings">
<div class="row"><div class="label"><b>排序</b><span>风险优先会把使用率最高的服务器放前面</span></div><select id="sortMode"><option value="usage">风险优先</option><option value="manual">手动顺序</option><option value="name">名称</option></select></div>
<div class="row"><div class="label"><b>刷新间隔</b><span>iOS 只把它作为最早可刷新时间</span></div><input id="refreshMinutes" type="number" min="10" max="360" inputmode="numeric"></div>
<div class="row"><div class="label"><b>警告阈值</b><span>达到后显示橙色</span></div><input id="warningPercent" type="number" min="1" max="100" inputmode="decimal"></div>
<div class="row"><div class="label"><b>危险阈值</b><span>达到后显示红色</span></div><input id="dangerPercent" type="number" min="1" max="300" inputmode="decimal"></div>
<div class="row"><div class="label"><b>Small / Medium</b><span>最多显示服务器数</span></div><div style="display:flex;gap:5px"><input id="maxSmall" type="number" min="1" max="4"><input id="maxMedium" type="number" min="1" max="6"></div></div>
<div class="row"><div class="label"><b>Large / Extra Large</b><span>Large 建议 16；Extra Large 预留 24</span></div><div style="display:flex;gap:5px"><input id="maxLarge" type="number" min="1" max="16"><input id="maxExtra" type="number" min="1" max="24"></div></div>
</div>
<div class="section-title">Widget Parameter</div><div class="tip"><span class="mono">all</span> 全部 · <span class="mono">top:4</span> 使用率最高 4 台 · <span class="mono">group:gcp</span> 指定分组 · <span class="mono">server:东京GCP</span> 指定单台。<br>当前接口固定为 <span class="mono">GET {baseURL}/traffic?token=TOKEN</span>。服务器地址示例：<span class="mono">http://1.2.3.4:5000</span> 或 <span class="mono">https://traffic.example.com</span>。</div>
<div class="footer">编辑完成后点右上角「完成 / Done」关闭；脚本会自动保存。</div></div>
<script>
const state=${json};
const $=id=>document.getElementById(id);
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function render(){
 const root=$('servers'); root.innerHTML='';
 state.servers.forEach((s,i)=>{
  const el=document.createElement('div'); el.className='server';
  el.innerHTML='<div class="grid">'+
   '<input data-k="name" data-i="'+i+'" value="'+esc(s.name)+'" placeholder="名称">'+
   '<input data-k="domain" data-i="'+i+'" value="'+esc(s.domain)+'" placeholder="http://domain:5000" autocapitalize="none" autocomplete="off" spellcheck="false">'+
   '<div class="token-wrap"><input id="tok'+i+'" type="password" data-k="token" data-i="'+i+'" value="'+esc(s.token)+'" placeholder="Token" autocapitalize="none" autocomplete="off" spellcheck="false"><button class="eye" type="button" onclick="toggleToken('+i+')">◉</button></div>'+
   '<button class="iconbtn delete" type="button" onclick="removeServer('+i+')">−</button></div>'+
   '<div class="subrow"><input class="group" data-k="group" data-i="'+i+'" value="'+esc(s.group||'')+'" placeholder="分组（可选，如 gcp）"><div class="order"><button class="iconbtn" onclick="move('+i+',-1)">↑</button><button class="iconbtn" onclick="move('+i+',1)">↓</button></div></div>';
  root.appendChild(el);
 });
 const add=document.createElement('div'); add.className='add'; add.innerHTML='<button class="addbtn" onclick="addServer()">＋ 添加服务器</button>'; root.appendChild(add);
 document.querySelectorAll('input[data-k]').forEach(inp=>inp.addEventListener('input',e=>{const i=+e.target.dataset.i;state.servers[i][e.target.dataset.k]=e.target.value;}));
}
function addServer(){state.servers.push({id:'',name:'',domain:'',token:'',group:''});render();}
function removeServer(i){state.servers.splice(i,1);render();}
function move(i,d){const j=i+d;if(j<0||j>=state.servers.length)return;const t=state.servers[i];state.servers[i]=state.servers[j];state.servers[j]=t;render();}
function toggleToken(i){const e=$('tok'+i);e.type=e.type==='password'?'text':'password';}
$('sortMode').value=state.sortMode||'usage'; $('refreshMinutes').value=state.refreshMinutes||30; $('warningPercent').value=state.warningPercent||80; $('dangerPercent').value=state.dangerPercent||95;
$('maxSmall').value=state.maxPerSize?.small||4; $('maxMedium').value=state.maxPerSize?.medium||6; $('maxLarge').value=state.maxPerSize?.large||16; $('maxExtra').value=state.maxPerSize?.extraLarge||24;
window.__collectConfig=()=>({
 servers:state.servers,
 sortMode:$('sortMode').value,
 refreshMinutes:+$('refreshMinutes').value||30,
 warningPercent:+$('warningPercent').value||80,
 dangerPercent:+$('dangerPercent').value||95,
 maxPerSize:{small:+$('maxSmall').value||4,medium:+$('maxMedium').value||6,large:+$('maxLarge').value||16,extraLarge:+$('maxExtra').value||24}
});
render();
</script></body></html>`;
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
  const lines = pairs.map(({server, data}) => {
    if (Number.isFinite(data.pct)) return `${data.stale ? "△" : "✓"} ${server.name}   ${fmtPct(data.pct)}   ${usageLine(data)}`;
    return `× ${server.name}   ${data.error || "失败"}`;
  });
  const a = new Alert();
  a.title = "连接测试";
  a.message = lines.join("\n");
  a.addAction("好");
  await a.present();
}

async function afterPanel(cfg) {
  const a = new Alert();
  a.title = "配置已保存";
  a.message = `${cfg.servers.length} 台服务器 · ${VERSION}`;
  a.addAction("测试全部");
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
