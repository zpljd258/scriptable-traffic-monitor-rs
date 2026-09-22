use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{Datelike, Local, NaiveDate, Timelike};
use serde::{Deserialize, Serialize};

// --- 配置结构体 ---
#[derive(Debug, Clone)]
pub struct Config {
    // 流量统计与网络配置
    pub traffic_direction: String,
    pub monthly_traffic_gb: f64,
    pub reset_day: u32,
    pub network_interface: String,
    pub check_interval_seconds: u64,
    pub traffic_data_file: String,
    pub log_file: String,
    pub public_ip: Option<String>,
    pub server_hostname: Option<String>,

    // HTTP API 配置
    pub api_token: String,
    pub api_port: u16,
    pub enable_api: bool,

    // Telegram 通知配置
    pub telegram_bot_token: Option<String>,
    pub telegram_chat_id: Option<String>,
    pub telegram_api_url: Option<String>,
    pub notify_on_startup: bool,
    pub notify_on_reset: bool,

    // 告警阈值与定期报告
    pub thresholds: Vec<f64>,
    pub report_interval_days: u32,
    pub report_hour: u32,

    // 流量超标动作保护（执行自定义关闭命令与新账单周期自动启动）
    pub limit_threshold: f64,          // 0 表示禁用，如 95 或 100（百分比）
    pub stop_command: Option<String>,  // 达到阈值后执行的关闭命令，例如 "systemctl stop hy2"
    pub start_command: Option<String>, // 新账单周期到达后执行的启动命令，例如 "systemctl start hy2"
}

impl Config {
    pub fn from_env() -> Self {
        let traffic_direction = std::env::var("TRAFFIC_DIRECTION")
            .unwrap_or_else(|_| "outbound".to_string())
            .to_lowercase();

        let monthly_traffic_gb = std::env::var("MONTHLY_TRAFFIC_GB")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(1024.0);

        let reset_day = std::env::var("RESET_DAY")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(1);

        let network_interface = std::env::var("NETWORK_INTERFACE")
            .unwrap_or_else(|_| "eth0".to_string());

        let check_interval_seconds = std::env::var("CHECK_INTERVAL_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60);

        let traffic_data_file = std::env::var("TRAFFIC_DATA_FILE")
            .unwrap_or_else(|_| "/data/outbound_traffic.json".to_string());

        let log_file = std::env::var("LOG_FILE")
            .unwrap_or_else(|_| "traffic_monitor.log".to_string());

        let public_ip = std::env::var("PUBLIC_IP")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let server_hostname = std::env::var("SERVER_HOSTNAME")
            .or_else(|_| std::env::var("CUSTOM_HOSTNAME"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let api_token = std::env::var("API_TOKEN")
            .unwrap_or_else(|_| "default_token".to_string());

        let api_port = std::env::var("API_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(5000);

        let enable_api = std::env::var("ENABLE_API")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);

        let telegram_bot_token = std::env::var("TELEGRAM_BOT_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let telegram_chat_id = std::env::var("TELEGRAM_CHAT_ID")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let telegram_api_url = std::env::var("TELEGRAM_API_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let notify_on_startup = std::env::var("NOTIFY_ON_STARTUP")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);

        let notify_on_reset = std::env::var("NOTIFY_ON_RESET")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);

        // 阈值解析，如 "80,90,95" -> [0.80, 0.90, 0.95]
        let thresholds_str = std::env::var("THRESHOLDS").unwrap_or_else(|_| "80,90,95".to_string());
        let mut thresholds: Vec<f64> = thresholds_str
            .split(',')
            .filter_map(|s| s.trim().parse::<f64>().ok())
            .map(|val| if val > 1.0 { val / 100.0 } else { val })
            .filter(|&v| v > 0.0 && v <= 1.0)
            .collect();
        thresholds.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if thresholds.is_empty() {
            thresholds = vec![0.80, 0.90, 0.95];
        }

        // 定期报告周期：支持 DAILY_REPORT / WEEKLY_REPORT 或 REPORT_INTERVAL_DAYS
        let mut report_interval_days = std::env::var("REPORT_INTERVAL_DAYS")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0);

        if std::env::var("DAILY_REPORT").map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false) {
            report_interval_days = 1;
        } else if std::env::var("WEEKLY_REPORT").map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false) {
            report_interval_days = 7;
        }

        let report_hour = std::env::var("REPORT_HOUR")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(9);

        // 流量超标动作阈值（例如 95 或 98，单位为百分比，0 表示禁用）
        let limit_threshold = std::env::var("LIMIT_THRESHOLD")
            .or_else(|_| std::env::var("LIMIT_ACTION_THRESHOLD"))
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(0.0);

        let stop_command = std::env::var("STOP_COMMAND")
            .or_else(|_| std::env::var("LIMIT_STOP_COMMAND"))
            .or_else(|_| std::env::var("LIMIT_ACTION_STOP_COMMAND"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let start_command = std::env::var("START_COMMAND")
            .or_else(|_| std::env::var("LIMIT_START_COMMAND"))
            .or_else(|_| std::env::var("LIMIT_ACTION_START_COMMAND"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Self {
            traffic_direction,
            monthly_traffic_gb,
            reset_day,
            network_interface,
            check_interval_seconds,
            traffic_data_file,
            log_file,
            public_ip,
            server_hostname,
            api_token,
            api_port,
            enable_api,
            telegram_bot_token,
            telegram_chat_id,
            telegram_api_url,
            notify_on_startup,
            notify_on_reset,
            thresholds,
            report_interval_days,
            report_hour,
            limit_threshold,
            stop_command,
            start_command,
        }
    }
}

// --- 流量记录数据模型 ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonthTraffic {
    pub cumulative_traffic_gb: f64,
    pub last_reset_day: u32,
    #[serde(default)]
    pub sent_thresholds: BTreeMap<String, bool>,
    #[serde(default)]
    pub last_report_date: Option<String>,
    #[serde(default)]
    pub limit_action_active: bool,
}

pub type TrafficData = BTreeMap<String, MonthTraffic>;

// --- 日志与滚动 ---
const LOG_MAX_SIZE_BYTES: u64 = 2 * 1024 * 1024; // 2MB

pub fn log_message(level: &str, msg: &str, log_file: &str) {
    let now = Local::now();
    let formatted = format!("{} - {} - {}", now.format("%Y-%m-%d %H:%M:%S,%3f"), level, msg);
    println!("{}", formatted);

    // 写入日志文件并处理滚动
    if let Ok(metadata) = fs::metadata(log_file) {
        if metadata.len() >= LOG_MAX_SIZE_BYTES {
            let backup = format!("{}.1", log_file);
            let _ = fs::rename(log_file, backup);
        }
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_file) {
        let _ = writeln!(file, "{}", formatted);
    }
}

// --- 计算日期差值辅助函数 ---
fn days_since(date_str: &str, current_date_str: &str) -> Option<i64> {
    let d1 = NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()?;
    let d2 = NaiveDate::parse_from_str(current_date_str, "%Y-%m-%d").ok()?;
    Some((d2 - d1).num_days())
}

// --- 执行自定义 Shell 命令 ---
fn run_shell_command(cmd: &str) -> (bool, String) {
    match std::process::Command::new("sh").arg("-c").arg(cmd).output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let combined = if stderr.is_empty() {
                stdout
            } else if stdout.is_empty() {
                stderr
            } else {
                format!("{}\n{}", stdout, stderr)
            };
            (output.status.success(), combined)
        }
        Err(e) => (false, format!("执行失败: {}", e)),
    }
}

// --- 应用状态 ---
pub struct AppState {
    pub config: Config,
    pub previous_tx_bytes: Mutex<u64>,
    pub previous_rx_bytes: Mutex<u64>,
    pub cached_ip: Mutex<String>,
    pub traffic_lock: Mutex<()>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let initial_tx = read_current_tx_bytes(&config.network_interface).unwrap_or(0);
        let initial_rx = read_current_rx_bytes(&config.network_interface).unwrap_or(0);

        log_message("INFO", "流量监控服务已启动。", &config.log_file);
        log_message(
            "INFO",
            &format!(
                "Initial previous_tx_bytes: {}, previous_rx_bytes: {}",
                initial_tx, initial_rx
            ),
            &config.log_file,
        );

        let initial_ip = config.public_ip.clone().unwrap_or_else(|| "Unknown".to_string());

        Self {
            config,
            previous_tx_bytes: Mutex::new(initial_tx),
            previous_rx_bytes: Mutex::new(initial_rx),
            cached_ip: Mutex::new(initial_ip),
            traffic_lock: Mutex::new(()),
        }
    }

    pub fn log_info(&self, msg: &str) {
        log_message("INFO", msg, &self.config.log_file);
    }

    pub fn log_warn(&self, msg: &str) {
        log_message("WARNING", msg, &self.config.log_file);
    }

    pub fn log_error(&self, msg: &str) {
        log_message("ERROR", msg, &self.config.log_file);
    }

    // 发送 Telegram 消息
    pub fn send_telegram(&self, html_text: &str) {
        let token = match &self.config.telegram_bot_token {
            Some(t) if !t.is_empty() => t,
            _ => return,
        };
        let chat_id = match &self.config.telegram_chat_id {
            Some(id) if !id.is_empty() => id,
            _ => return,
        };

        let base = self.config.telegram_api_url.as_deref().unwrap_or("https://api.telegram.org");
        let url = format!("{}/bot{}/sendMessage", base.trim_end_matches('/'), token);

        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": html_text,
            "parse_mode": "HTML"
        });
        let body_str = body.to_string();

        match ureq::post(&url)
            .timeout(Duration::from_secs(8))
            .set("Content-Type", "application/json")
            .send_string(&body_str)
        {
            Ok(_) => {
                self.log_info("Telegram 通知已发送");
            }
            Err(e) => {
                self.log_error(&format!("发送 Telegram 消息失败: {}", e));
            }
        }
    }

    // 计算当前流量并更新数据文件
    pub fn calculate_current_traffic(&self) -> Option<f64> {
        let _guard = self.traffic_lock.lock().unwrap();

        let now = Local::now();
        let current_month = now.format("%Y-%m").to_string();
        let current_day = now.day();
        let current_date_str = now.format("%Y-%m-%d").to_string();

        let mut traffic_data = self.load_traffic_data();

        if !traffic_data.contains_key(&current_month) {
            traffic_data.insert(
                current_month.clone(),
                MonthTraffic {
                    cumulative_traffic_gb: 0.0,
                    last_reset_day: 0,
                    sent_thresholds: BTreeMap::new(),
                    last_report_date: None,
                    limit_action_active: false,
                },
            );
            self.log_info(&format!("为 {} 创建新的流量记录。", current_month));
        }

        let hostname = self.get_hostname();
        let public_ip = self.get_public_ip();

        let entry = traffic_data.get_mut(&current_month).unwrap();

        // 流量重置逻辑（到达账单日）
        if current_day == self.config.reset_day && entry.last_reset_day != current_day {
            // 如果上个周期触发了保护关闭命令，新账单周期自动执行恢复启动命令
            if entry.limit_action_active {
                if let Some(ref start_cmd) = self.config.start_command {
                    self.log_info(&format!("新账单周期到达，正在执行恢复启动命令: {}", start_cmd));
                    let (ok, out) = run_shell_command(start_cmd);
                    let status_text = if ok { "执行成功" } else { "执行异常" };
                    let recovery_msg = format!(
                        "🟢 <b>新账单周期到达 (已自动执行恢复启动命令)</b>\n\
                         ━━━━━━━━━━━━━━━\n\
                         🖥 <b>主机名</b>: {}\n\
                         🌐 <b>公网 IP</b>: {}\n\
                         📅 <b>新账单周期</b>: {}\n\
                         ⚙️ <b>启动命令</b>: <code>{}</code>\n\
                         📋 <b>执行状态</b>: {}\n\
                         ✨ 流量配额已重置，相关程序已自动拉起恢复正常运行！",
                        hostname, public_ip, current_month, start_cmd, status_text
                    );
                    self.send_telegram(&recovery_msg);
                    self.log_info(&format!("启动命令执行完毕 ({}): {}", status_text, out));
                }
                entry.limit_action_active = false;
            }

            // 发送 Telegram 重置总结
            if self.config.notify_on_reset {
                let usage_pct = if self.config.monthly_traffic_gb > 0.0 {
                    (entry.cumulative_traffic_gb / self.config.monthly_traffic_gb) * 100.0
                } else {
                    0.0
                };
                let reset_msg = format!(
                    "🔄 <b>新账单周期流量已重置</b>\n\
                     ━━━━━━━━━━━━━━━\n\
                     🖥 <b>主机名</b>: {}\n\
                     🌐 <b>公网 IP</b>: {}\n\
                     📅 <b>归档周期</b>: {}\n\
                     📈 <b>上月总用量</b>: {:.2} GB / {:.2} GB ({:.1}%)\n\
                     ✨ 本月计数已归零，继续为您精准护航。",
                    hostname, public_ip, current_month, entry.cumulative_traffic_gb, self.config.monthly_traffic_gb, usage_pct
                );
                self.send_telegram(&reset_msg);
            }

            entry.cumulative_traffic_gb = 0.0;
            entry.last_reset_day = current_day;
            entry.sent_thresholds.clear();
            entry.last_report_date = None;
            self.log_info(&format!("{} 流量计数已重置。", current_month));
        }

        let current_tx = read_current_tx_bytes(&self.config.network_interface);
        let current_rx = if self.config.traffic_direction == "bidirectional" {
            read_current_rx_bytes(&self.config.network_interface)
        } else {
            None
        };

        match current_tx {
            Some(tx) => {
                let current_usage_gb = self.calculate_usage_gb(tx, current_rx);
                let total_usage_gb = entry.cumulative_traffic_gb + current_usage_gb;
                entry.cumulative_traffic_gb = total_usage_gb;

                let max_traffic_gb = self.config.monthly_traffic_gb;
                let usage_percentage = if max_traffic_gb > 0.0 {
                    (total_usage_gb / max_traffic_gb) * 100.0
                } else {
                    0.0
                };
                let remain_gb = if max_traffic_gb > total_usage_gb {
                    max_traffic_gb - total_usage_gb
                } else {
                    0.0
                };

                // 1. 阈值告警检查 (如 80%, 90%, 95%)
                for &threshold in &self.config.thresholds {
                    let th_pct = threshold * 100.0;
                    let th_key = format!("{:.0}%", th_pct);
                    if usage_percentage >= th_pct {
                        let already_sent = entry.sent_thresholds.get(&th_key).copied().unwrap_or(false);
                        if !already_sent {
                            let alert_msg = format!(
                                "⚠️ <b>流量阈值告警 ({})</b>\n\
                                 ━━━━━━━━━━━━━━━\n\
                                 🖥 <b>主机名</b>: {}\n\
                                 🌐 <b>公网 IP</b>: {}\n\
                                 📈 <b>已用流量</b>: {:.2} GB / {:.2} GB\n\
                                 📊 <b>当前使用率</b>: {:.2}%\n\
                                 💡 <b>剩余流量</b>: {:.2} GB\n\
                                 📅 <b>重置日</b>: 每月 {} 号",
                                th_key, hostname, public_ip, total_usage_gb, max_traffic_gb, usage_percentage, remain_gb, self.config.reset_day
                            );
                            self.send_telegram(&alert_msg);
                            entry.sent_thresholds.insert(th_key, true);
                        }
                    }
                }

                // 2. 定期报告检查（每日 / 每周）
                if self.config.report_interval_days > 0 && now.hour() >= self.config.report_hour {
                    let should_report = match &entry.last_report_date {
                        None => true,
                        Some(last_date) => {
                            days_since(last_date, &current_date_str)
                                .map(|d| d >= self.config.report_interval_days as i64)
                                .unwrap_or(true)
                        }
                    };

                    if should_report {
                        let period_name = if self.config.report_interval_days == 1 {
                            "每日报告"
                        } else if self.config.report_interval_days == 7 {
                            "每周报告"
                        } else {
                            "定期报告"
                        };

                        let report_msg = format!(
                            "📊 <b>流量监控{}</b>\n\
                             ━━━━━━━━━━━━━━━\n\
                             🖥 <b>主机名</b>: {}\n\
                             🌐 <b>公网 IP</b>: {}\n\
                             📈 <b>已用流量</b>: {:.2} GB / {:.2} GB ({:.1}%)\n\
                             💡 <b>剩余额度</b>: {:.2} GB\n\
                             📅 <b>重置日</b>: 每月 {} 号",
                            period_name, hostname, public_ip, total_usage_gb, max_traffic_gb, usage_percentage, remain_gb, self.config.reset_day
                        );
                        self.send_telegram(&report_msg);
                        entry.last_report_date = Some(current_date_str);
                    }
                }

                // 3. 流量超标保护检查（执行用户指定的关闭命令）
                if self.config.limit_threshold > 0.0
                    && usage_percentage >= self.config.limit_threshold
                    && !entry.limit_action_active
                {
                    let stop_cmd_desc = self.config.stop_command.as_deref().unwrap_or("未设置关闭命令");
                    self.log_warn(&format!(
                        "流量达到超标保护阈值 {:.1}%，正在执行关闭命令: {}",
                        self.config.limit_threshold, stop_cmd_desc
                    ));

                    let cmd_result_str = if let Some(ref stop_cmd) = self.config.stop_command {
                        let (ok, out) = run_shell_command(stop_cmd);
                        format!("{}: {}", if ok { "执行成功" } else { "执行失败" }, out)
                    } else {
                        "跳过（未配置 STOP_COMMAND）".to_string()
                    };

                    let alert_msg = format!(
                        "🚨 <b>触发流量超标保护 (已执行关闭命令)</b>\n\
                         ━━━━━━━━━━━━━━━\n\
                         🖥 <b>主机名</b>: {}\n\
                         🌐 <b>公网 IP</b>: {}\n\
                         🔌 <b>网卡</b>: {}\n\
                         ⚠️ <b>触发阈值</b>: {:.1}%\n\
                         📈 <b>当前已用</b>: {:.2} GB / {:.2} GB ({:.1}%)\n\
                         ⚙️ <b>关闭命令</b>: <code>{}</code>\n\
                         📋 <b>命令结果</b>: {}\n\
                         ⏳ <b>计划恢复</b>: 将在下个账单周期 (每月 {} 号) 自动执行启动命令恢复。",
                        hostname,
                        public_ip,
                        self.config.network_interface,
                        self.config.limit_threshold,
                        total_usage_gb,
                        max_traffic_gb,
                        usage_percentage,
                        stop_cmd_desc,
                        cmd_result_str,
                        self.config.reset_day
                    );

                    self.send_telegram(&alert_msg);
                    entry.limit_action_active = true;
                }

                self.save_traffic_data(&traffic_data);
                self.log_info(&format!(
                    "[{}] 本次流量: {:.6} GB, 总流量: {:.2} GB",
                    now.format("%Y-%m-%d %H:%M:%S"),
                    current_usage_gb,
                    total_usage_gb
                ));
                Some(total_usage_gb)
            }
            None => {
                self.log_warn("无法获取流量数据，跳过本次检查。");
                None
            }
        }
    }

    fn calculate_usage_gb(&self, current_tx: u64, current_rx: Option<u64>) -> f64 {
        let mut prev_tx = self.previous_tx_bytes.lock().unwrap();
        let tx_diff = if current_tx >= *prev_tx {
            current_tx - *prev_tx
        } else {
            0
        };
        *prev_tx = current_tx;

        let rx_diff = if let Some(rx) = current_rx {
            let mut prev_rx = self.previous_rx_bytes.lock().unwrap();
            let diff = if rx >= *prev_rx { rx - *prev_rx } else { 0 };
            *prev_rx = rx;
            diff
        } else {
            0
        };

        const BYTES_PER_GB: f64 = 1024.0 * 1024.0 * 1024.0;
        if self.config.traffic_direction == "bidirectional" {
            (tx_diff + rx_diff) as f64 / BYTES_PER_GB
        } else {
            tx_diff as f64 / BYTES_PER_GB
        }
    }

    fn load_traffic_data(&self) -> TrafficData {
        let path = &self.config.traffic_data_file;
        match fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<TrafficData>(&content) {
                Ok(data) => data,
                Err(e) => {
                    self.log_error(&format!("解码流量数据文件时出错: {}，将使用新的数据。", e));
                    TrafficData::new()
                }
            },
            Err(_) => {
                self.log_info("流量数据文件未找到，初始化新文件。");
                TrafficData::new()
            }
        }
    }

    fn save_traffic_data(&self, data: &TrafficData) {
        let path = &self.config.traffic_data_file;
        if let Some(parent) = Path::new(path).parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json_str) = serde_json::to_string_pretty(data) {
            let tmp_path = format!("{}.tmp", path);
            if fs::write(&tmp_path, json_str).is_ok() {
                let _ = fs::rename(&tmp_path, path);
            }
        }
    }

    pub fn get_hostname(&self) -> String {
        // 0. 优先从环境变量 SERVER_HOSTNAME / CUSTOM_HOSTNAME 读取
        if let Some(ref custom) = self.config.server_hostname {
            return custom.clone();
        }

        // 1. 优先从 /etc/host_hostname 读取
        if let Ok(content) = fs::read_to_string("/etc/host_hostname") {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }

        // 2. 从 /etc/hostname 读取
        if let Ok(content) = fs::read_to_string("/etc/hostname") {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }

        // 3. 从 /proc/sys/kernel/hostname 读取
        if let Ok(content) = fs::read_to_string("/proc/sys/kernel/hostname") {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }

        // 4. 从环境变量 HOSTNAME 读取
        if let Ok(env_host) = std::env::var("HOSTNAME") {
            let trimmed = env_host.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }

        "Unknown".to_string()
    }

    pub fn get_public_ip(&self) -> String {
        let cache = self.cached_ip.lock().unwrap();
        cache.clone()
    }

    pub fn refresh_public_ip(&self) {
        if self.config.public_ip.is_some() {
            return;
        }

        let ip_providers = [
            "http://api.ipify.org",
            "http://icanhazip.com",
            "https://4.ipw.cn",
            "https://api.ipify.org",
            "http://checkip.amazonaws.com",
        ];

        for url in &ip_providers {
            if let Ok(resp) = ureq::get(url).timeout(Duration::from_secs(3)).call() {
                if let Ok(body) = resp.into_string() {
                    let trimmed = body.trim();
                    if !trimmed.is_empty()
                        && trimmed.len() <= 45
                        && (trimmed.contains('.') || trimmed.contains(':'))
                    {
                        let mut cache = self.cached_ip.lock().unwrap();
                        *cache = trimmed.to_string();
                        self.log_info(&format!("公网 IP 获取成功: {}", trimmed));
                        return;
                    }
                }
            }
        }

        let cache = self.cached_ip.lock().unwrap();
        if *cache == "Unknown" {
            self.log_warn("刷新公网 IP 时外部接口未响应");
        }
    }
}

// --- 读取网络接口字节统计 ---
fn read_current_tx_bytes(interface: &str) -> Option<u64> {
    let path = format!("/sys/class/net/{}/statistics/tx_bytes", interface);
    match fs::read_to_string(&path) {
        Ok(s) => s.trim().parse::<u64>().ok(),
        Err(_) => None,
    }
}

fn read_current_rx_bytes(interface: &str) -> Option<u64> {
    let path = format!("/sys/class/net/{}/statistics/rx_bytes", interface);
    match fs::read_to_string(&path) {
        Ok(s) => s.trim().parse::<u64>().ok(),
        Err(_) => None,
    }
}

// --- HTTP 请求处理 ---
fn handle_connection(mut stream: TcpStream, state: &Arc<AppState>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));

    let mut buffer = [0u8; 4096];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let request_str = String::from_utf8_lossy(&buffer[..bytes_read]);
    let first_line = match request_str.lines().next() {
        Some(line) => line,
        None => return,
    };

    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        send_response(&mut stream, 400, "Bad Request", r#"{"error":"Bad Request"}"#);
        return;
    }

    let method = parts[0];
    let full_path = parts[1];

    if method != "GET" {
        send_response(&mut stream, 405, "Method Not Allowed", r#"{"error":"Method Not Allowed"}"#);
        return;
    }

    let mut path_parts = full_path.splitn(2, '?');
    let path = path_parts.next().unwrap_or("");
    let query = path_parts.next().unwrap_or("");

    if path != "/traffic" {
        send_response(&mut stream, 404, "Not Found", r#"{"error":"Not Found"}"#);
        return;
    }

    // 检查 Token
    let mut provided_token = None;
    for param in query.split('&') {
        let mut kv = param.splitn(2, '=');
        if let (Some(k), Some(v)) = (kv.next(), kv.next()) {
            if k == "token" {
                provided_token = Some(v);
                break;
            }
        }
    }

    if provided_token != Some(&state.config.api_token[..]) {
        send_response(&mut stream, 403, "Forbidden", r#"{"error":"Invalid token"}"#);
        return;
    }

    // 计算流量
    let total_usage_gb = match state.calculate_current_traffic() {
        Some(total) => total,
        None => {
            send_response(
                &mut stream,
                500,
                "Internal Server Error",
                r#"{"error":"Failed to get traffic data"}"#,
            );
            return;
        }
    };

    let max_traffic_gb = state.config.monthly_traffic_gb;
    let usage_percentage = if max_traffic_gb > 0.0 {
        (total_usage_gb / max_traffic_gb) * 100.0
    } else {
        0.0
    };

    let hostname = state.get_hostname();
    let public_ip = state.get_public_ip();

    let response_body = serde_json::json!({
        "hostname": hostname,
        "ip": public_ip,
        "total_usage_gb": format!("{:.2}", total_usage_gb),
        "max_traffic_gb": format!("{:.2}", max_traffic_gb),
        "usage_percentage": format!("{:.2}", usage_percentage),
    });

    send_response(&mut stream, 200, "OK", &response_body.to_string());
}

fn send_response(stream: &mut TcpStream, status_code: u16, status_text: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {} {}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {}",
        status_code,
        status_text,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn main() {
    let config = Config::from_env();
    let state = Arc::new(AppState::new(config));

    // 预热获取公网 IP 并在启动时发送 Telegram 启动通知
    let state_startup = Arc::clone(&state);
    std::thread::Builder::new()
        .name("traffic-startup".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            state_startup.refresh_public_ip();
            if state_startup.config.notify_on_startup && state_startup.config.telegram_bot_token.is_some() {
                let hostname = state_startup.get_hostname();
                let public_ip = state_startup.get_public_ip();
                let startup_msg = format!(
                    "🚀 <b>流量监控服务已启动</b>\n\
                     ━━━━━━━━━━━━━━━\n\
                     🖥 <b>主机名</b>: {}\n\
                     🌐 <b>公网 IP</b>: {}\n\
                     🔌 <b>网卡</b>: {}\n\
                     📦 <b>月额度</b>: {:.2} GB\n\
                     🔄 <b>重置日</b>: 每月 {} 号\n\
                     ⚡ <b>超标保护</b>: {}\n\
                     ✨ 正在为您静默监控月度流量。",
                    hostname,
                    public_ip,
                    state_startup.config.network_interface,
                    state_startup.config.monthly_traffic_gb,
                    state_startup.config.reset_day,
                    if state_startup.config.limit_threshold > 0.0 {
                        format!("{:.1}% (自动执行关闭命令)", state_startup.config.limit_threshold)
                    } else {
                        "未开启".to_string()
                    }
                );
                state_startup.send_telegram(&startup_msg);
            }
        })
        .ok();

    // 启动后台工作线程：定时同步流量、检查告警/超标动作并周期性刷新公网 IP
    let state_bg = Arc::clone(&state);
    std::thread::Builder::new()
        .name("traffic-bg-worker".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            let mut iteration: u64 = 0;
            let check_interval = state_bg.config.check_interval_seconds;
            loop {
                // 每小时刷新一次公网 IP
                let iterations_per_hour = (3600 / check_interval).max(1);
                if iteration % iterations_per_hour == 0 {
                    state_bg.refresh_public_ip();
                }

                // 定时执行流量计算、阈值告警检查与超标保护
                state_bg.calculate_current_traffic();

                std::thread::sleep(Duration::from_secs(check_interval));
                iteration = iteration.wrapping_add(1);
            }
        })
        .expect("Failed to spawn background worker thread");

    if state.config.enable_api {
        let addr = format!("0.0.0.0:{}", state.config.api_port);
        let listener = match TcpListener::bind(&addr) {
            Ok(l) => {
                state.log_info(&format!("API 服务监听于 http://{}", addr));
                l
            }
            Err(e) => {
                state.log_error(&format!("无法绑定端口 {}: {}", addr, e));
                std::process::exit(1);
            }
        };

        for stream_res in listener.incoming() {
            match stream_res {
                Ok(stream) => {
                    let state_clone = Arc::clone(&state);
                    let _ = std::thread::Builder::new()
                        .name("http-worker".into())
                        .stack_size(128 * 1024)
                        .spawn(move || {
                            handle_connection(stream, &state_clone);
                        });
                }
                Err(e) => {
                    state.log_warn(&format!("接收连接失败: {}", e));
                }
            }
        }
    } else {
        state.log_info("API 服务已禁用，仅运行后台流量监控与通知。");
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
}
