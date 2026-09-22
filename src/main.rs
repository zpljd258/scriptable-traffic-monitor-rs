use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{Datelike, Local};
use serde::{Deserialize, Serialize};

// --- 配置结构体 ---
#[derive(Debug, Clone)]
pub struct Config {
    pub traffic_direction: String,
    pub monthly_traffic_gb: f64,
    pub reset_day: u32,
    pub network_interface: String,
    pub api_token: String,
    pub api_port: u16,
    pub enable_api: bool,
    pub traffic_data_file: String,
    pub log_file: String,
    pub public_ip: Option<String>,
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

        let api_token = std::env::var("API_TOKEN")
            .unwrap_or_else(|_| "default_token".to_string());

        let api_port = std::env::var("API_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(5000);

        let enable_api = std::env::var("ENABLE_API")
            .map(|v| v.eq_ignore_ascii_case("true"))
            .unwrap_or(true);

        let traffic_data_file = std::env::var("TRAFFIC_DATA_FILE")
            .unwrap_or_else(|_| "/data/outbound_traffic.json".to_string());

        let log_file = std::env::var("LOG_FILE")
            .unwrap_or_else(|_| "traffic_monitor.log".to_string());

        let public_ip = std::env::var("PUBLIC_IP")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Self {
            traffic_direction,
            monthly_traffic_gb,
            reset_day,
            network_interface,
            api_token,
            api_port,
            enable_api,
            traffic_data_file,
            log_file,
            public_ip,
        }
    }
}

// --- 流量记录数据模型 ---
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonthTraffic {
    pub cumulative_traffic_gb: f64,
    pub last_reset_day: u32,
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

    // 计算当前流量并更新数据文件
    pub fn calculate_current_traffic(&self) -> Option<f64> {
        let _guard = self.traffic_lock.lock().unwrap();

        let now = Local::now();
        let current_month = now.format("%Y-%m").to_string();
        let current_day = now.day();

        let mut traffic_data = self.load_traffic_data();

        if !traffic_data.contains_key(&current_month) {
            traffic_data.insert(
                current_month.clone(),
                MonthTraffic {
                    cumulative_traffic_gb: 0.0,
                    last_reset_day: 0,
                },
            );
            self.log_info(&format!("为 {} 创建新的流量记录。", current_month));
        }

        let entry = traffic_data.get_mut(&current_month).unwrap();

        // 流量重置逻辑
        if current_day == self.config.reset_day && entry.last_reset_day != current_day {
            entry.cumulative_traffic_gb = 0.0;
            entry.last_reset_day = current_day;
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

    // 启动后台工作线程：定时同步流量与周期性刷新公网 IP
    let state_bg = Arc::clone(&state);
    std::thread::Builder::new()
        .name("traffic-bg-worker".into())
        .stack_size(256 * 1024)
        .spawn(move || {
            let mut iteration: u32 = 0;
            loop {
                // 每小时（或启动初期）刷新一次公网 IP
                if iteration % 60 == 0 {
                    state_bg.refresh_public_ip();
                }

                if !state_bg.config.enable_api {
                    state_bg.calculate_current_traffic();
                }

                std::thread::sleep(Duration::from_secs(60));
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
        state.log_info("API 服务已禁用，仅运行后台流量监控。");
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }
}
