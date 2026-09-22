// --- 环境守护与版本标识 ---
const __TM_VERSION__ = 'TM-Settings-1.3.2';
const __scriptable_runtime_ok__ = (
  typeof Alert !== 'undefined' &&
  typeof Prompt !== 'undefined' &&
  typeof UITable !== 'undefined' &&
  typeof Request !== 'undefined' &&
  typeof ListWidget !== 'undefined'
);
if (!__scriptable_runtime_ok__) {
  if (typeof console !== 'undefined') {
    console.log('请在 Scriptable App 内运行脚本');
  }
  // 不抛异常，保留日志，避免误杀 Scriptable 内执行
}

// 缓存内置构造器，避免全局名被污染
const SAlert = (typeof Alert !== 'undefined') ? Alert : null;
const STable = (typeof UITable !== 'undefined') ? UITable : null;
const SRequest = (typeof Request !== 'undefined') ? Request : null;
const SListWidget = (typeof ListWidget !== 'undefined') ? ListWidget : null;

// --- 配置与存储 ---
const CONFIG_FILE = FileManager.local().joinPath(FileManager.local().documentsDirectory(), 'traffic_monitor_config.json');

function loadConfig() {
  try {
    const fm = FileManager.local();
    if (!fm.fileExists(CONFIG_FILE)) {
      const init = { servers: [] };
      fm.writeString(CONFIG_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const raw = fm.readString(CONFIG_FILE);
    const parsed = JSON.parse(raw);
    if (!parsed.servers || !Array.isArray(parsed.servers)) {
      parsed.servers = [];
    }
    return parsed;
  } catch (e) {
    console.error('loadConfig error:', e);
    return { servers: [] };
  }
}

function saveConfig(config) {
  try {
    const fm = FileManager.local();
    fm.writeString(CONFIG_FILE, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('saveConfig error:', e);
  }
}

async function promptText(title, message, placeholder, value) {
  const a = new SAlert();
  a.title = title;
  a.message = message || '';
  a.addTextField(placeholder || '', value || '');
  a.addAction('确定');
  a.addCancelAction('取消');
  const r = await a.present();
  if (r === -1) return null;
  return a.textFieldValue(0);
}

async function promptServer(server) {
  // 小向导：名称 / URL / 颜色 / 完成
  const draft = {
    name: server?.name || '',
    url: server?.url || '',
    color: server?.color || '#4CAF50',
  };
  let pendingAction = null; // { type: 'add'|'edit'|'delete', index?: number }
  while (true) {
    const a = new SAlert();
    a.title = server ? '编辑服务器' : '新增服务器';
    a.message = `${draft.name || '(未命名)'}\n${draft.url || '(未设置URL)'}\n颜色: ${draft.color}`;
    a.addAction('编辑名称');
    a.addAction('编辑 URL');
    a.addAction('选择颜色');
    a.addAction('测试 URL');
    a.addAction('完成');
    a.addCancelAction('取消');
    const idx = await a.present();
    if (idx === -1) return null;
    if (idx === 0) {
      const v = await promptText('备注名称', '例如 Tokyo', '名称', draft.name);
      if (v !== null) draft.name = v;
    } else if (idx === 1) {
      let v = await promptText('服务器URL', '包含 token 的完整接口地址', 'URL', draft.url);
      if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v; // 轻校验与补全
      if (v !== null) draft.url = v;
    } else if (idx === 2) {
      // 颜色预设 + 自定义
      const c = new SAlert();
      c.title = '选择颜色';
      const presets = [
        ['蓝', '#2196F3'],
        ['绿', '#4CAF50'],
        ['橙', '#FF9800'],
        ['紫', '#9C27B0'],
        ['红', '#F44336'],
        ['青', '#00BCD4'],
        ['自定义…', null],
      ];
      presets.forEach(p => c.addAction(p[0]));
      c.addCancelAction('取消');
      const cidx = await c.present();
      if (cidx === -1) {
        // no-op
      } else if (presets[cidx][1]) {
        draft.color = presets[cidx][1];
      } else {
        const v = await promptText('自定义颜色', '十六进制，如 #2196F3', '颜色', draft.color);
        if (v !== null) draft.color = v;
      }
    } else if (idx === 3) {
      if (!draft.url) {
        const warn = new SAlert();
        warn.title = '请输入 URL 再测试';
        warn.addAction('好的');
        await warn.present();
        continue;
      }
      try {
        const r = new SRequest(draft.url);
        r.timeoutInterval = 8;
        const j = await r.loadJSON();
        const ok = j && (j.ip || j.usage_percentage || j.max_traffic_gb);
        const done = new SAlert();
        done.title = ok ? '连接成功' : '已连接，但返回不完整';
        done.message = ok ? '接口看起来工作正常' : '请检查接口格式是否匹配脚本预期';
        done.addAction('好的');
        await done.present();
      } catch (e) {
        const err = new SAlert();
        err.title = '连接失败';
        err.message = String(e);
        err.addAction('知道了');
        await err.present();
      }
    } else if (idx === 4) {
      if (!draft.url) {
        const warn = new SAlert();
        warn.title = 'URL 必填';
        warn.message = '请设置服务器 URL';
        warn.addAction('好的');
        await warn.present();
        continue;
      }
      return draft;
    }
  }
}

async function openSettings(config) {
  // 小工具样式：紧凑分组、图标化按钮与开关
  const makeHeader = (title, subtitle) => {
    const r = new UITableRow();
    r.isHeader = true;
    const t = r.addText(title, subtitle || '');
    t.titleFont = Font.boldSystemFont(16);
    t.subtitleFont = Font.systemFont(12);
    return r;
  };

  const makeIconRow = (emoji, title, subtitle) => {
    const r = new UITableRow();
    r.height = 48;
    r.addText(`${emoji}  ${title}`, subtitle || '');
    return r;
  };

  let pendingAction = null; // 延迟动作：add/edit/delete
  while (true) {
    const table = new STable();
    table.showSeparators = true;
    table.removeAllRows();

    // 顶部
    table.addRow(makeHeader('Traffic Monitor 配置', '管理服务器与显示'));

    // 服务器分组
    table.addRow(makeHeader('服务器', `${config.servers.length} 台`));

    if (config.servers.length === 0) {
      const tip = makeIconRow('ℹ️', '还没有服务器', '点击下方“新增服务器”进行配置');
      table.addRow(tip);
    }

    for (let i = 0; i < config.servers.length; i++) {
      const s = config.servers[i];
      const row = makeIconRow('🖥️', s.name || '(未命名)', s.url);
      row.onSelect = () => { pendingAction = { type: 'edit', index: i }; };
      table.addRow(row);

      const ops = new UITableRow();
      ops.height = 40;
      const up = ops.addButton('⬆️ 上移');
      const down = ops.addButton('⬇️ 下移');
      const del = ops.addButton('🗑 删除');
      up.onTap = () => {
        if (i > 0) {
          const tmp = config.servers[i - 1];
          config.servers[i - 1] = config.servers[i];
          config.servers[i] = tmp;
          saveConfig(config);
        }
      };
      down.onTap = () => {
        if (i < config.servers.length - 1) {
          const tmp = config.servers[i + 1];
          config.servers[i + 1] = config.servers[i];
          config.servers[i] = tmp;
          saveConfig(config);
        }
      };
      del.onTap = () => { pendingAction = { type: 'delete', index: i }; };
      table.addRow(ops);
    }

    // 新增服务器
    const addRow = makeIconRow('➕', '新增服务器', '添加新的监控端点');
    addRow.onSelect = () => { pendingAction = { type: 'add' }; };
    table.addRow(addRow);

    // 显示设置
    table.addRow(makeHeader('显示', '排序、数量与字段'));

    // 排序方式
    config.sortBy = config.sortBy || 'usage';
    const sortRow = makeIconRow('🔀', '排序方式', config.sortBy === 'usage' ? '使用率(降序)' : '名称(升序)');
    sortRow.onSelect = async () => {
      const p = new SAlert();
      p.title = '选择排序方式';
      p.addAction('使用率(降序)');
      p.addAction('名称(升序)');
      p.addCancelAction('取消');
      const idx = await p.present();
      if (idx === 0) config.sortBy = 'usage';
      else if (idx === 1) config.sortBy = 'name';
      saveConfig(config);
    };
    table.addRow(sortRow);

    // 每尺寸显示数量
    config.maxPerSize = config.maxPerSize || { small: 2, medium: 6, large: 12 };
    const countRow = makeIconRow('📐', '显示数量 (小/中/大)', `${config.maxPerSize.small}/${config.maxPerSize.medium}/${config.maxPerSize.large}`);
    countRow.onSelect = async () => {
      const small = await promptText('Small 显示数量', '建议 1-2', '数量', String(config.maxPerSize.small));
      if (small === null) return;
      const medium = await promptText('Medium 显示数量', '建议 4-6', '数量', String(config.maxPerSize.medium));
      if (medium === null) return;
      const large = await promptText('Large 显示数量', '建议 9-12', '数量', String(config.maxPerSize.large));
      if (large === null) return;
      const toInt = (v, d) => Math.max(0, parseInt(v || d, 10) || d);
      config.maxPerSize = { small: toInt(small, 2), medium: toInt(medium, 6), large: toInt(large, 12) };
      saveConfig(config);
    };
    table.addRow(countRow);

    // Small 字段选择（用伪开关展示）
    config.smallFields = config.smallFields || { showIP: false, showUsage: false };
    const smallIP = new UITableRow();
    smallIP.height = 44;
    smallIP.addText('Small 显示 IP', config.smallFields.showIP ? '✓ 开启' : '— 关闭');
    smallIP.onSelect = () => {
      config.smallFields.showIP = !config.smallFields.showIP;
      saveConfig(config);
    };
    table.addRow(smallIP);

    const smallUsage = new UITableRow();
    smallUsage.height = 44;
    smallUsage.addText('Small 显示用量', config.smallFields.showUsage ? '✓ 开启' : '— 关闭');
    smallUsage.onSelect = () => {
      config.smallFields.showUsage = !config.smallFields.showUsage;
      saveConfig(config);
    };
    table.addRow(smallUsage);

    // 尾部操作
    const doneRow = new UITableRow();
    const doneBtn = doneRow.addButton('完成并退出');
    let shouldExit = false;
    doneBtn.onTap = () => {
      shouldExit = true;
      // 给出即时反馈，并提示下拉关闭
      table.removeAllRows();
      const tip = new UITableRow();
      tip.isHeader = true;
      tip.addText('设置已保存', '下拉或点左上角 Close 退出');
      table.addRow(tip);
      table.showSeparators = false;
    };
    table.addRow(doneRow);

    await table.present();

    // 若点击了完成，优先退出，不再处理挂起动作
    if (shouldExit) return true; // 仅在点击完成时返回 true

    // 处理延迟动作（执行后必须清空）
    if (pendingAction) {
      if (pendingAction.type === 'add') {
        const created = await promptServer();
        if (created) {
          config.servers.push(created);
          saveConfig(config);
        }
      } else if (pendingAction.type === 'edit' && pendingAction.index != null) {
        const s = config.servers[pendingAction.index];
        if (s) {
          const edited = await promptServer(s);
          if (edited) {
            config.servers[pendingAction.index] = edited;
            saveConfig(config);
          }
        }
      } else if (pendingAction.type === 'delete' && pendingAction.index != null) {
        const s = config.servers[pendingAction.index];
        const a = new SAlert();
        a.title = '确认删除';
        a.message = `删除“${s?.name || ''}”？`;
        a.addAction('删除');
        a.addCancelAction('取消');
        const idx = await a.present();
        if (idx === 0) {
          config.servers.splice(pendingAction.index, 1);
          saveConfig(config);
        }
      }
      // 执行完动作后清空并继续下一轮渲染
      pendingAction = null;
      continue;
    }

  }
}

// --- 函数定义 ---
/**
* 获取流量数据
*/
async function fetchData(url) {
    try {
        const req = new SRequest(url);
        const json = await req.loadJSON();
        return json;
    } catch (error) {
        console.error(`Error fetching data from ${url}: ${error}`);
        return null;
    }
}

/**
* 绘制圆形进度图，返回 Image
*/
function createCircularProgressImage(percentage, size, color) {
  const d = Math.max(10, Math.floor(size));
  const ctx = new DrawContext();
  ctx.size = new Size(d, d);
  ctx.respectScreenScale = true;
  ctx.opaque = false;

  const cx = d / 2;
  const cy = d / 2;
  const radius = d / 2 - 3;
  const lineWidth = Math.max(3, Math.floor(d * 0.12));

  // 背景圆环（使用 Path 构建）
  const bg = new Path();
  if (typeof bg.addEllipse === 'function') {
    bg.addEllipse(new Rect(cx - radius, cy - radius, radius * 2, radius * 2));
  } else if (typeof bg.addRoundedRect === 'function') {
    // 兼容旧版本：用大圆角近似圆
    const d2 = radius * 2;
    bg.addRoundedRect(new Rect(cx - radius, cy - radius, d2, d2), radius, radius);
  }
  ctx.setStrokeColor(new Color('#444444', 0.25));
  ctx.setLineWidth(lineWidth);
  ctx.addPath(bg);
  ctx.strokePath();

  // 进度弧
  const pct = Math.max(0, Math.min(1, percentage / 100));
  if (pct > 0) {
    const start = -Math.PI / 2;
    const end = start + pct * 2 * Math.PI;
    const fg = new Path();
    if (typeof fg.addArc === 'function') {
      fg.addArc(new Point(cx, cy), radius, start, end, false);
      ctx.setStrokeColor(new Color(color));
      ctx.setLineWidth(lineWidth);
      ctx.addPath(fg);
      ctx.strokePath();
    } else {
      // 最兜底：用多段小线段近似圆弧
      const steps = Math.max(6, Math.floor(pct * 64));
      const step = (end - start) / steps;
      for (let i = 0; i < steps; i++) {
        const a1 = start + i * step;
        const a2 = start + (i + 1) * step;
        const x1 = cx + Math.cos(a1) * radius;
        const y1 = cy + Math.sin(a1) * radius;
        const x2 = cx + Math.cos(a2) * radius;
        const y2 = cy + Math.sin(a2) * radius;
        const seg = new Path();
        if (typeof seg.move === 'function' && typeof seg.addLine === 'function') {
          seg.move(new Point(x1, y1));
          seg.addLine(new Point(x2, y2));
          ctx.setStrokeColor(new Color(color));
          ctx.setLineWidth(lineWidth);
          ctx.addPath(seg);
          ctx.strokePath();
        }
      }
    }
  }

  // 百分比文字
  const pTxt = Math.round(Math.max(0, Math.min(100, percentage))) + '%';
  const fontSize = Math.max(8, Math.floor(d * 0.34));
  ctx.setFont(Font.mediumSystemFont(fontSize));
  ctx.setTextAlignedCenter();
  ctx.setTextColor(Color.white());
  ctx.drawTextInRect(pTxt, new Rect(0, (d - fontSize) / 2 - 1, d, fontSize + 2));

  return ctx.getImage();
}

// 兼容保留：条形进度（备用）
function createRoundedProgressBar(stack, percentage, width, height, color, usageText, percentageText) {
  const container = stack.addStack();
  container.layoutVertically();
  const barBg = container.addStack();
  barBg.size = new Size(width, height);
  barBg.backgroundColor = new Color('#444444', 0.3);
  barBg.cornerRadius = height/2;

  const bar = barBg.addStack();
  bar.size = new Size(Math.max(0, Math.floor(width * Math.max(0, Math.min(percentage,100))/100)), height);
  bar.backgroundColor = new Color(color);
  bar.cornerRadius = height/2;

  const info = container.addText(`${usageText} ${percentageText}`.trim());
  info.textColor = Color.white();
  info.font = Font.systemFont(Math.max(6, height - 2));
  info.lineLimit = 1;
}

/**
* 创建单个服务器信息块
*/
function createServerBlock(columnStack, server, data, fontSize, cardWidth, circleSize) {
  const card = columnStack.addStack();
  card.layoutHorizontally();
  card.centerAlignContent();
  card.backgroundColor = new Color('#000000', 0.15);
  card.cornerRadius = 8;
  card.setPadding(6, 6, 6, 6);
  card.spacing = 8;
  // 固定卡片宽度，避免文本被挤压或遮挡
  card.size = new Size(cardWidth, circleSize + 18);

  const pct = data && data.usage_percentage ? parseFloat(data.usage_percentage) : 0;
  const circle = createCircularProgressImage(pct, circleSize, server.color);
  const circleImg = card.addImage(circle);
  circleImg.imageSize = new Size(circleSize, circleSize);
  circleImg.cornerRadius = circleSize/2;

  const right = card.addStack();
  right.layoutVertically();
  right.spacing = 2;
  right.size = new Size(Math.max(60, cardWidth - circleSize - 16), 0);

  const nameTxt = right.addText(server.name);
  nameTxt.textColor = Color.white();
  nameTxt.font = Font.boldSystemFont(Math.max(10, fontSize - 1));
  nameTxt.lineLimit = 1;

  const subTxt = right.addText(data && data.ip ? String(data.ip) : '无法获取');
  subTxt.textColor = data ? new Color('#DDDDDD') : Color.red();
  subTxt.font = Font.systemFont(Math.max(8, fontSize - 2));
  subTxt.lineLimit = 1;

  const usageText = (data && data.total_usage_gb && data.max_traffic_gb)
    ? `${data.total_usage_gb}GB / ${data.max_traffic_gb}GB`
    : 'N/A';
  const usage = right.addText(usageText);
  usage.textColor = new Color('#BBBBBB');
  usage.font = Font.systemFont(Math.max(7, fontSize - 3));
  usage.lineLimit = 1;
}

/**
* 创建小组件
*/
async function createWidget() {
    const widget = new SListWidget();
    widget.backgroundColor = new Color("#222222", 0.8);

    const widgetFamily = config.widgetFamily || 'medium'; // 预览时默认按 medium 布局
    if (widgetFamily === 'small') {
      widget.setPadding(4, 8, 4, 8);
    } else {
      widget.useDefaultPadding();
    }
    let rows, cols, fontSize, barWidth, barHeight, maxServers, spacing;
    const allServers = (loadConfig().servers || []).slice();

    // --- 根据尺寸和服务器数量设置布局参数 ---
    switch (widgetFamily) { // 使用 widgetFamily
        case 'small':
            maxServers = Math.max(1, Math.min(allServers.length, (loadConfig().maxPerSize?.small) || 2));
            rows = maxServers;
            cols = 1;
            fontSize = 12;
            barWidth = 130;
            barHeight = 8;
            spacing = 6;
            break;

        case "medium":
            maxServers = (loadConfig().maxPerSize?.medium) || 6;
            fontSize = 11;
            barHeight = 9;
            spacing = 12;

            if (allServers.length <= 3) {
                rows = 1;
                cols = allServers.length;
            } else if (allServers.length === 4) {
                rows = 2;
                cols = 2;
            } else {
                rows = 2;
                cols = 3;
            }

            // 根据尺寸估算 barWidth
            if (widgetFamily === 'medium') {
              barWidth = Math.floor((169 * 2 - (cols - 1) * spacing) / cols); // 使用估算的宽度 338 (169*2)
            } else if (widgetFamily === 'large') {
              barWidth = Math.floor((360 * 2 - (cols - 1) * spacing) / cols); // 使用估算的宽度 720 (360*2)
            }


            break;

        case 'large':
            maxServers = (loadConfig().maxPerSize?.large) || 12;
            rows = 4;
            cols = 3;
            fontSize = 11;
            barHeight = 8;
            spacing = 5;
             // 根据尺寸估算 barWidth
            if (widgetFamily === 'medium') {
              barWidth = Math.floor((169 * 2- (cols - 1) * spacing) / cols); // 使用估算的宽度
            } else if (widgetFamily === 'large') {
              barWidth = Math.floor((360 * 2 - (cols - 1) * spacing) / cols); // 使用估算的宽度
            }

            break;

        default:
            maxServers = 1;
            rows = 1;
            cols = 1;
            fontSize = 12;
            barWidth = 100;
            barHeight = 10;
            spacing = 5;
            break;
    }

     // --- 单服务器或 small 模式紧凑卡片 ---
      if (widgetFamily === 'small') {
        const cfg = loadConfig();
        const smallShowIP = !!cfg.smallFields?.showIP;
        const smallShowUsage = !!cfg.smallFields?.showUsage;

        // 获取数据（按排序策略挑选前 N 个）
        let list = allServers.slice();
        const sortBy = (cfg.sortBy || 'usage');
        if (sortBy === 'name') {
          list.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
        }
        const displayed = list.slice(0, maxServers);
        const results = await Promise.all(displayed.map(s => fetchData(s.url)));

        const container = widget.addStack();
        container.layoutVertically();
        container.spacing = 3;
        const circleSize = displayed.length > 1 ? 48 : 58;
        for (let i=0;i<displayed.length;i++){
          const row = container.addStack();
          row.layoutHorizontally();
          row.spacing = 8;
          row.centerAlignContent();

          const pct = results[i]?.usage_percentage ? parseFloat(results[i].usage_percentage) : 0;
          const img = row.addImage(createCircularProgressImage(pct, circleSize, displayed[i].color));
          img.imageSize = new Size(circleSize, circleSize);

          const right = row.addStack();
          right.layoutVertically();
          right.spacing = 1;

          const name = right.addText(displayed[i].name);
          name.textColor = Color.white();
          name.font = Font.boldSystemFont(11);
          name.lineLimit = 1;

          // 小型挂件：始终显示用量（替换 IP）
          const f1 = (v)=> {
            const n = parseFloat(v);
            if (isNaN(n)) return v;
            return (Math.round(n*10)/10).toFixed(1);
          };
          const usageText = (results[i]?.total_usage_gb && results[i]?.max_traffic_gb)
            ? `${f1(results[i].total_usage_gb)}GB / ${f1(results[i].max_traffic_gb)}GB`
            : (results[i]?.usage_percentage ? `${Math.round(parseFloat(results[i].usage_percentage))}%` : '');
          if (usageText) {
            const usage = right.addText(usageText);
            usage.textColor = new Color('#BBBBBB');
            usage.font = Font.systemFont(8);
            usage.lineLimit = 1;
          }
        }
        return widget;
      }


    // --- 多服务器布局 ---
    // 排序与截断（中/大）：数据驱动按使用率排序
    const cfg = loadConfig();
    const sortBy = (cfg.sortBy || 'usage');
    let baseList = allServers.slice();
    if (sortBy === 'name') {
      baseList.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
    }

    // 如果按使用率排序，先请求全部再排序
    let resultsAll = [];
    if (sortBy === 'usage') {
      resultsAll = await Promise.all(baseList.map(s => fetchData(s.url)));
      baseList = baseList
        .map((s, idx) => ({ s, d: resultsAll[idx] }))
        .sort((a, b) => {
          const pa = a.d && a.d.usage_percentage ? parseFloat(a.d.usage_percentage) : -1;
          const pb = b.d && b.d.usage_percentage ? parseFloat(b.d.usage_percentage) : -1;
          return pb - pa; // 降序
        })
        .map(x => x.s);
    }

    const displayedServers = baseList.slice(0, Math.min(baseList.length, maxServers));
    const results = sortBy === 'usage'
      ? resultsAll.slice(0, displayedServers.length)
      : await Promise.all(displayedServers.map(s => fetchData(s.url)));

    // 根据实际数量动态设置行列（避免使用启动时的 servers 快照）
    const n = displayedServers.length;
    if (widgetFamily === 'medium') {
      if (n <= 3) { rows = 1; cols = Math.max(1, n); }
      else if (n === 4) { rows = 2; cols = 2; }
      else { rows = 2; cols = 3; }
      barWidth = Math.floor((169 * 2 - (cols - 1) * spacing) / Math.max(1, cols));
    } else if (widgetFamily === 'large') {
      cols = 3;
      rows = Math.max(1, Math.min(4, Math.ceil(n / cols)));
      barWidth = Math.floor((360 * 2 - (cols - 1) * spacing) / cols);
    }

    const mainVerticalStack = widget.addStack();
    mainVerticalStack.layoutVertically();
    mainVerticalStack.spacing = spacing;

    const targetCardWidth = Math.max(130, Math.min(180, barWidth || 160));
    const circleSize = widgetFamily === 'large' ? 52 : 48;

    for (let i = 0; i < rows; i++) {
        const rowStack = mainVerticalStack.addStack();
        rowStack.layoutHorizontally();
        rowStack.spacing = spacing;
        rowStack.topAlignContent();

        for (let j = 0; j < cols; j++) {
            const serverIndex = i * cols + j;
            if (serverIndex < displayedServers.length) {
                const server = displayedServers[serverIndex];
                const data = results[serverIndex];

                const columnStack = rowStack.addStack();
                columnStack.layoutVertically();
                createServerBlock(columnStack, server, data, fontSize, targetCardWidth, circleSize);
            } else {
                const emptyStack = rowStack.addStack();
                emptyStack.size = new Size(targetCardWidth, circleSize + 16);
            }
        }
    }

    return widget;
}

// --- 主程序 ---
const { servers } = loadConfig();

if (config.runsInWidget) {
  const widget = await createWidget();
  Script.setWidget(widget);
  Script.complete();
} else {
  // 在 App 内打开：进入设置面板
  const cfg = loadConfig();
  const shouldPreview = await openSettings(cfg);
  if (shouldPreview) {
    // 完成后提供一个简单的预览
    const widget = await createWidget();
    await widget.presentMedium();
  }
  Script.complete();
}
