# Scriptable Traffic Monitor (Rust Edition) 🦀⚡

[![GitHub Release](https://img.shields.io/github/v/release/zpljd258/scriptable-traffic-monitor-rs)](https://github.com/zpljd258/scriptable-traffic-monitor-rs/releases)
[![Original Scriptable Repo](https://img.shields.io/badge/Original%20Repo-Scriptable%20Widget-blue)](https://github.com/zpljd258/scriptable-TrafficMonitor)
[![Original Telegram Bot Repo](https://img.shields.io/badge/Original%20Repo-Telegram%20Bot-blue)](https://github.com/zpljd258/traffic-monitor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Memory Usage](https://img.shields.io/badge/Memory%20RSS-%3C1.8MB-success)](https://github.com/zpljd258/scriptable-traffic-monitor-rs)
[![Docker Image Size](https://img.shields.io/badge/Docker%20Image-10.6MB-brightgreen)](https://github.com/zpljd258/scriptable-traffic-monitor-rs)

> 🔗 **双仓库融合重构**：本项目是原 Python 版本 **[zpljd258/scriptable-TrafficMonitor](https://github.com/zpljd258/scriptable-TrafficMonitor)**（iOS 桌面小组件）与 **[zpljd258/traffic-monitor](https://github.com/zpljd258/traffic-monitor)**（Telegram 告警机器人）的**合二为一全新 Rust 重构版**。
> 
> 在 100% 保持小组件 API 兼容的同时，集成了 Telegram 阈值告警、定期日报/周报、账单日重置推送，并独创了**流量超标自动执行自定义关闭命令（如停止代理服务）并在下个账单日自动执行启动命令拉起恢复**的熔断保护机制！常驻物理内存仅需 **~1.4MB**（较原两套 Python 服务节省 95% 以上）。

---

## 📌 这是什么？解决什么问题？

很多云厂商（如**阿里云 CDT** 每月 200GB 免费出站流量，腾讯云轻量、Oracle Cloud、搬瓦工等 VPS 均有固定月配额）。一旦流量超标，往往会产生昂贵账单或遭遇高额扣费。

**Scriptable Traffic Monitor** 是一款专为**流量计费云服务器**打造的全功能监控防护卫士：

1. **底层物理网卡静默守护**：直接读取 Linux 内核网卡真实物理流量计数，按月精准累加，每月账单日自动清零。
2. **多端联动展示 (iOS Scriptable 小组件)**：对外暴露携带 Token 认证的极速 HTTP API，配合配套脚本（[`scriptable.js`](./scriptable.js)），在 iPhone / iPad 负一屏与桌面上优雅聚合展示多台 VPS 的实时用量与彩色进度条。
3. **Telegram 机器人全自动通知**：到达阈值（如 80%、90%、95%）即时推送告警、每日/每周定时发送用量报告、新账单周期开始时发送重置总结。
4. **自定义服务熔断与次月自动复活**：当流量达到指定红线阈值（如 95%）时，自动执行用户配置的关闭命令（如 `systemctl stop hy2` 或 `docker stop vpn`）防止天价账单产生；到了下个月账单日，自动执行启动命令恢复服务并归零计数，实现真正全无人值守。

---

## ✨ 核心功能

*   **🤖 Telegram 机器人全场景通知**：
    *   **多阶阈值告警**：自定义多级用量阈值（如 `THRESHOLDS=80,90,95`），达到对应比例立即推送 Telegram HTML 富文本告警，当月绝不重复骚扰。
    *   **定期汇报（日报 / 周报）**：支持开启每日（`DAILY_REPORT`）或每周（`WEEKLY_REPORT`）在指定整点（`REPORT_HOUR`）发送当前配额用量概况。
    *   **服务启动与重置归档通知**：服务启动即报、每月重置日自动发送上月流量归档与清零汇报。
*   **🛡️ 流量超标保护与新账单周期自动拉起恢复**：
    *   **用户自定义关闭命令**：达到红线阈值（如 `LIMIT_THRESHOLD=95`）时，自动执行用户配置的 Shell 命令（如 `systemctl stop hy2` 或 `docker stop vpn`），无需粗暴掐断整机网络，保护 SSH 远程管理不失联。
    *   **新周期自动拉起复活**：在账单日到达清零流量时，程序自动执行 `START_COMMAND`（如 `systemctl start hy2`），无缝恢复网络服务，全流程自动化闭环。
    *   **跨重启状态记忆**：断网/关服动作状态持久化存储于 JSON 中，即使服务器中途重启也不会遗漏恢复。
*   **📱 优雅的 iOS 小组件展示**：
    *   **多服务器聚合**：支持单个小组件同时监控多台服务器（推荐 2 ~ 6 台，最多可支持 12 台）。
    *   **Apple 原生设计风格**：精心设计的进度条与排版，支持暗黑模式，信息清晰不拥挤。
    *   **弹性自适应布局**：根据配置的服务器数量自动切换最佳网格与信息显示。
*   **📊 精准物理网卡统计**：
    *   直接读取 Linux 内核 `/sys/class/net/{interface}/statistics`，避开复杂上层代理软件，反映最真实的物理接口损耗。
    *   **流量方向自由选择**：支持单向出站统计（`outbound`，契合阿里云 CDT 等仅收出站费用的场景）与进出双向统计（`bidirectional`）。
*   **🔄 每月自动重置与持久化**：
    *   支持自定义每月重置日（`RESET_DAY`，如每月 1 号自动清零）。
    *   本地 JSON 历史月份累积存储，持久保存过往月份记录，服务器重启或服务升级**数据绝不丢失**。
*   **🔒 Token 鉴权保护**：
    *   所有 API 查询均需要匹配 `API_TOKEN`，杜绝未授权扫描或隐私泄露。
*   **🌐 智能主机名与公网 IP 嗅探**：
    *   自动从 `/etc/hostname` 读取机器名；
    *   内置多源并发回退嗅探（`ipify` / `icanhazip` / `ipw.cn` / `aws`），并提供非阻塞后台缓存，API 请求毫秒级极速响应。
*   **⚡ 极致内存与性能（Rust 赋能）**：
    *   彻底摒弃重量级运行时，仅用纯 Rust 标准库打造，常驻物理内存仅需 **1.4MB**，CPU 占用趋近 0%。
    *   提供原子文件写入机制（`.tmp` 写入后原子换名），杜绝突发掉电或崩溃造成 JSON 数据文件损坏。
    *   内置自动日志滚动（单文件上限 2MB），杜绝日志撑爆硬盘。

---

## 📊 性能对比 (Python 原版 vs Rust 新版)

实测于 512MB 内存云服务器（标准 512MB VPS），监控同一套真实业务流量：

| 评估指标 | 原 Python 版本 (Flask) | 🦀 Rust 版本 (本仓库) | 优化幅度 |
| :--- | :--- | :--- | :--- |
| **内存占用 (RSS)** | **~28.64 MiB** (占系统 6.58%) | **~1.36 ~ 1.76 MiB** (占系统 0.4%) | **内存节省 95% 以上 🚀** |
| **若使用 Docker (含 Shim)** | ~36.5 MiB | ~10.3 MiB | **节省 72%** |
| **Docker 镜像体积** | **~62.4 MB** | **~10.6 MB** | **缩小 83%** |
| **独立静态二进制** | 依赖 Python 运行时与 pip 依赖包 | **1.9 MB** (单文件 musl 静态链接) | 随时直接运行 |
| **公网 IP 嗅探** | 单点依赖（遇 DNS/SSL 异常变为 `Unknown`） | 多源智能回退 + 后台非阻塞缓存 | 极速响应，永不超时 |
| **数据持久化安全** | 直接写入（若异常关机存在损坏风险） | 原子替换写入 (`.tmp` 换名) | 工业级安全，零丢数 |
| **API 响应耗时** | 100ms ~ 500ms | **< 1ms** | 瞬时返回 |

---

## 🚀 部署方法

本项目提供**三种运行方式**。对于追求极致低内存的小鸡（如 512MB 内存 VPS），强烈推荐**方案一（Systemd）**或**方案二（OpenRC）**；如果你习惯使用 Docker，也可以选用**方案三**。

### 方案一：独立二进制 + Systemd 托管（推荐，Debian / Ubuntu / CentOS 等）

无需安装 Docker，直接运行预编译的单个二进制，整机开销仅需 **~1.4MB**。

#### 1. 下载静态二进制文件
```bash
sudo curl -sSL -o /usr/local/bin/scriptable-traffic-monitor \
  https://github.com/zpljd258/scriptable-traffic-monitor-rs/releases/latest/download/scriptable-traffic-monitor

sudo chmod +x /usr/local/bin/scriptable-traffic-monitor
sudo mkdir -p /var/lib/scriptable-traffic-monitor
```

#### 2. 配置 Systemd 服务
创建 `/etc/systemd/system/scriptable-traffic-monitor.service`：
```ini
[Unit]
Description=Scriptable Traffic Monitor (Rust Edition)
After=network.target

[Service]
Type=simple
User=root
# 环境变量配置
Environment=API_TOKEN=your_secret_token
Environment=API_PORT=5000
Environment=ENABLE_API=True
Environment=TRAFFIC_DIRECTION=outbound
Environment=MONTHLY_TRAFFIC_GB=200
Environment=RESET_DAY=1
Environment=NETWORK_INTERFACE=eth0
Environment=TRAFFIC_DATA_FILE=/var/lib/scriptable-traffic-monitor/outbound_traffic.json
Environment=LOG_FILE=/var/log/scriptable-traffic-monitor.log

ExecStart=/usr/local/bin/scriptable-traffic-monitor
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### 3. 启动并设置开机自启
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scriptable-traffic-monitor

# 检查运行状态与内存
sudo systemctl status scriptable-traffic-monitor
```

---

### 方案二：独立二进制 + OpenRC 托管（推荐，Alpine Linux 用户）

Alpine Linux 默认使用 OpenRC。结合内置的 `supervise-daemon`，后台总守护开销不到 **1.8MB**。

#### 1. 下载静态二进制
```bash
curl -sSL -o /usr/local/bin/scriptable-traffic-monitor \
  https://github.com/zpljd258/scriptable-traffic-monitor-rs/releases/latest/download/scriptable-traffic-monitor

chmod +x /usr/local/bin/scriptable-traffic-monitor
mkdir -p /var/lib/scriptable-traffic-monitor
```

#### 2. 配置环境变量
创建 `/etc/conf.d/scriptable-traffic-monitor`：
```sh
export API_TOKEN="your_secret_token"
export API_PORT="5000"
export ENABLE_API="True"
export TRAFFIC_DIRECTION="outbound"
export MONTHLY_TRAFFIC_GB="200"
export RESET_DAY="1"
export NETWORK_INTERFACE="eth0"
export TRAFFIC_DATA_FILE="/var/lib/scriptable-traffic-monitor/outbound_traffic.json"
export LOG_FILE="/var/log/scriptable-traffic-monitor.log"
```

#### 3. 创建 OpenRC 服务脚本
创建 `/etc/init.d/scriptable-traffic-monitor` 并赋予执行权限：
```sh
cat << "EOF" > /etc/init.d/scriptable-traffic-monitor
#!/sbin/openrc-run

supervisor=supervise-daemon
name="scriptable-traffic-monitor"
description="Scriptable Traffic Monitor (Rust Edition)"

command="/usr/local/bin/scriptable-traffic-monitor"
command_args="${TRAFFIC_MONITOR_OPTS}"

output_log="/var/log/scriptable-traffic-monitor.log"
error_log="/var/log/scriptable-traffic-monitor.err"

depend() {
	need net
	after firewall
}
EOF

chmod +x /etc/init.d/scriptable-traffic-monitor
```

#### 4. 启动服务与开机自启
```bash
rc-service scriptable-traffic-monitor start
rc-update add scriptable-traffic-monitor default

# 检查服务状态
rc-service scriptable-traffic-monitor status
```

---

### 💡 进阶技巧：单机多网卡 / 多 IP 双端口独立监控

部分云服务器配有多张弹性网卡（ENI），每张网卡拥有独立的内网与公网 IP（如 `ens5` 和 `ens6`）。此时可在一台机器上启动两个服务实例，分别监听不同端口（例如 5000 与 5001）进行独立统计：

1. **创建实例 1 服务 (`scriptable-traffic-monitor-ens5.service`)**：
   - `API_PORT=5000`
   - `NETWORK_INTERFACE=ens5`
   - `SERVER_HOSTNAME=Server-IP1`
   - `PUBLIC_IP=198.51.100.1`
   - `TRAFFIC_DATA_FILE=/var/lib/scriptable-traffic-monitor/outbound_traffic_ens5.json`

2. **创建实例 2 服务 (`scriptable-traffic-monitor-ens6.service`)**：
   - `API_PORT=5001`
   - `NETWORK_INTERFACE=ens6`
   - `SERVER_HOSTNAME=Server-IP2`
   - `PUBLIC_IP=198.51.100.2`
   - `TRAFFIC_DATA_FILE=/var/lib/scriptable-traffic-monitor/outbound_traffic_ens6.json`

在 iOS Scriptable 小组件的 `servers` 数组中同时添加 `5000` 和 `5001` 两个 URL，即可在主屏幕上分别展示两张网卡的流量进度卡片！两个 Rust 实例合并常驻物理内存**不到 2.5MB**。

---

### 方案三：使用 Docker Compose 部署

如果你更习惯使用 Docker 容器纳管：

1. 创建 `docker-compose.yml`：
```yaml
services:
  scriptable-traffic-monitor:
    image: scriptable-traffic-monitor:latest
    # 或在本地直接构建：build: .
    environment:
      API_TOKEN: your_secret_token       # ⚠️ 必填：用于鉴权的 API Token
      API_PORT: 5000                   # API 监听端口
      ENABLE_API: "True"               # 是否启动 HTTP API
      TRAFFIC_DIRECTION: outbound       # 流量方向：outbound（出站单向）或 bidirectional（双向）
      MONTHLY_TRAFFIC_GB: 200          # 每月流量额度（GB）
      RESET_DAY: 1                     # 流量重置日（每月 1 号）
      NETWORK_INTERFACE: eth0         # 统计网卡名称（通常为 eth0）
      # PUBLIC_IP: 1.2.3.4             # 可选：手动覆盖公网 IP 显示
    volumes:
      - /opt/docker/scriptable-trafficmonitor/data:/data  # 持久化流量数据目录
      - /etc/hostname:/etc/host_hostname:ro             # 挂载宿主机名
    restart: always
    container_name: scriptable-traffic-monitor
    network_mode: host                 # 必须为 host 网络模式以统计物理网卡流量
```

2. 启动容器：
```bash
docker compose up -d
```

---

## ⚙️ 环境变量配置说明

### 基础统计与 HTTP API 配置
| 环境变量 | 默认值 | 详细说明 |
| :--- | :--- | :--- |
| `API_TOKEN` | `default_token` | **必须修改**。访问 `/traffic?token=...` 时必须携带的安全认证令牌。 |
| `API_PORT` | `5000` | HTTP Web API 监听的端口。 |
| `ENABLE_API` | `True` | 是否启动 HTTP 服务；若设为 `"False"`，则仅在后台每 60 秒持久化记录流量与处理 Telegram 通知。 |
| `TRAFFIC_DIRECTION` | `outbound` | 流量统计方向：`outbound`（仅计算出站，如阿里云 CDT 计费）或 `bidirectional`（计算出站+入站双向）。 |
| `MONTHLY_TRAFFIC_GB` | `1024` | 每月可用流量总额度（单位：GB）。 |
| `RESET_DAY` | `1` | 每月流量统计重置的日期（1 ~ 31）。 |
| `NETWORK_INTERFACE` | `eth0` | 统计的物理网卡名称，多网卡服务器请填写对应公网网卡名（如 `ens5`）。 |
| `SERVER_HOSTNAME` | 从系统读取 | 可选。自定义小组件与 Telegram 消息中显示的主机名称（别名 `CUSTOM_HOSTNAME`）。 |
| `PUBLIC_IP` | 自动探测 | 可选。手动固定显示的公网 IPv4 地址；未填时程序会自动多源探测并缓存。 |
| `TRAFFIC_DATA_FILE` | `/data/outbound_traffic.json` | 流量数据存储文件路径，容器部署请确保挂载卷对齐。 |
| `LOG_FILE` | `traffic_monitor.log` | 本地日志路径（内置 2MB 自动切分备份）。 |

### Telegram 机器人通知配置（可选）
| 环境变量 | 默认值 | 详细说明 |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | 无 | Telegram Bot Token（向 [@BotFather](https://t.me/BotFather) 申请获得）。未配置则不启用 Telegram 推送。 |
| `TELEGRAM_CHAT_ID` | 无 | 接收推送通知的 Telegram 用户 ID 或群组 ID。 |
| `TELEGRAM_API_URL` | `https://api.telegram.org` | Telegram API 反代地址（国内机器可填自建反代如 `https://tg-proxy.example.com`）。 |
| `THRESHOLDS` | `80,90,95` | 触发告警的用量百分比列表（英文逗号隔开）。当月达到后仅发送一次，避免刷屏。 |
| `DAILY_REPORT` | `false` | 是否开启每日用量报告（设为 `true` 开启）。 |
| `WEEKLY_REPORT` | `false` | 是否开启每周用量报告（设为 `true` 开启）。 |
| `REPORT_HOUR` | `9` | 定期报告每日发送的整点时间（0 ~ 23，默认早晨 9:00）。 |
| `NOTIFY_ON_STARTUP` | `true` | 服务启动时是否发送初始化通知（展示当前机器名、IP、月配额）。 |
| `NOTIFY_ON_RESET` | `true` | 到达账单重置日时是否发送上月流量用量总结通知。 |

### 流量超标保护与新周期自动拉起（可选）
| 环境变量 | 默认值 | 详细说明 |
| :--- | :--- | :--- |
| `LIMIT_THRESHOLD` | `0` | 触发保护动作的红线用量百分比（如 `95` 或 `98`，单位 %；设为 `0` 表示禁用）。 |
| `STOP_COMMAND` | 无 | 达到红线阈值后自动执行的关闭命令（如 `systemctl stop hy2` 或 `docker stop vpn`）。 |
| `START_COMMAND` | 无 | 到达新账单周期（重置日）清零后自动执行的拉起恢复命令（如 `systemctl start hy2`）。 |

---

## 📡 API 验证

在浏览器或终端中访问：
```bash
curl "http://your_server_ip:5000/traffic?token=your_secret_token"
```

#### 正常响应示例 (HTTP 200)

```json
{
  "hostname": "my-server-01",
  "ip": "198.51.100.1",
  "max_traffic_gb": "200.00",
  "total_usage_gb": "9.00",
  "usage_percentage": "4.50"
}
```

#### 鉴权失败示例 (HTTP 403)

```json
{
  "error": "Invalid token"
}
```

---

## 📱 iOS Scriptable 小组件配置与使用

1. 在 iPhone / iPad 上前往 App Store 安装 **[Scriptable](https://scriptable.app/)**。
2. 打开 Scriptable，点击右上角 `+` 新建一个脚本。
3. 将本项目仓库中的 [`scriptable.js`](./scriptable.js) 代码全选复制，并粘贴到新建的脚本中。
4. 在脚本顶部的 `servers` 数组中填入你的服务器信息：

```javascript
const servers = [
    {
        url: "http://your_server_ip_1:5000/traffic?token=your_secret_token_1", // 服务器 1 API 地址
        color: "#4CAF50" // 自定义彩色进度条颜色（十六进制 Hex）
    },
    {
        url: "http://your_server_ip_2:5000/traffic?token=your_secret_token_2", // 服务器 2
        color: "#2196F3"
    },
    // 可继续添加更多服务器...
];
```

5. 点击右下角保存，然后在 iOS 主屏幕上长按空白处，点击左上角 `+` 添加 **Scriptable** 小组件，长按小组件选择刚刚创建的脚本即可！

> 💡 **小组件使用技巧**：
> * **主机名命名**：建议修改服务器 `/etc/hostname`，使其简明扼要（如 `Node-HK`、`Node-US`）。小组件中建议长度在 15 字符以内以获得最佳视觉效果。
> * **服务器数量**：小组件支持自适应排版，单卡片推荐配置 **2 ~ 6 台** 服务器，视觉效果与信息呈现最为均衡。

---

## 🔨 从源码构建

本项目采用标准 Rust / Cargo 构建，支持编译为完全静态的 musl 二进制：

```bash
# 克隆仓库
git clone https://github.com/zpljd258/scriptable-traffic-monitor-rs.git
cd scriptable-traffic-monitor-rs

# 编译 Release 生产优化版本
cargo build --release

# 编译产物位于：
./target/release/scriptable-traffic-monitor
```

---

## 🙏 致谢与生态

*   **原项目**：感谢原 Python 版 **[zpljd258/scriptable-TrafficMonitor](https://github.com/zpljd258/scriptable-TrafficMonitor)** 提供的核心设计思路与初始实现。
*   **[Scriptable](https://scriptable.app/)**：强大的 iOS 自动化与桌面小组件平台。
*   **Rust 生态**：感谢 `serde`、`chrono` 与 `ureq` 等优秀的轻量化标准生态支持。

---

## 📝 License

本项目遵循 [MIT License](./LICENSE)。
