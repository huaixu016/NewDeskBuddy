//! 配置持久化：沿用原版 `config.txt` 的 `key=value` 文本格式，
//! 与 Python 版保持读写兼容（同一份文件可以两个程序交替使用）。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::State;

/// 所有配置键及其默认值。新增持久化选项时必须同步维护这张表。
fn default_config() -> BTreeMap<String, String> {
    let entries = [
        ("salary", "0"),
        ("rest_type", "双休"),
        ("custom_rest_days", "0"),
        ("am_start", "09:00"),
        ("am_end", "12:00"),
        ("pm_start", "13:00"),
        ("pm_end", "18:00"),
        // 空的 current_mode 表示默认模式。
        ("current_mode", ""),
        // 默认模式下展示哪套猫：双击角色翻转，重启后沿用。
        ("cat_resting", "false"),
        ("lulu_top_drop", "true"),
        ("key_count_visible", "true"),
        // 调试日志开关：true 时前端 debug_log 调用才写 debug.log，默认关闭。
        ("debug_log", "false"),
        ("work_off_time", "17:00"),
        ("work_payday", "15"),
        ("work_festival_name", ""),
        ("work_festival_date", ""),
        ("work_target_weekday", "5"),
        ("work_earn_mode", "auto"),
        ("work_fixed_earn", "0"),
        // 工作配置是否已保存过：首次切工作模式会弹配置窗，保存过一次就不再打扰。
        ("work_config_initialized", "false"),
        ("work_scale", "0.65"),
        ("work_opacity", "1"),
        ("last_period_start", ""),
        ("cycle_days", "28"),
        ("period_days", "5"),
        ("period_visible", "false"),
    ];
    entries
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// 数值型字段单独容错：个别键非法时回落默认值，不让整份配置重置。
/// 元组第二项为 true 表示浮点，false 表示整数。
const NUMERIC_KEYS: &[(&str, bool)] = &[
    ("salary", true),
    ("custom_rest_days", false),
    ("work_payday", false),
    ("work_target_weekday", false),
    ("work_fixed_earn", true),
    ("work_scale", true),
    ("work_opacity", true),
    ("cycle_days", false),
    ("period_days", false),
];

/// 布尔字段：文本 "true" 判定为真，其余为假。
const BOOL_KEYS: &[&str] = &[
    "lulu_top_drop",
    "key_count_visible",
    "period_visible",
    "cat_resting",
    "debug_log",
    "work_config_initialized",
];

/// 配置在内存中的形态：全部按字符串保存，类型语义由上面的常量表约束。
pub struct ConfigState {
    values: parking_lot::Mutex<BTreeMap<String, String>>,
    path: PathBuf,
}

impl ConfigState {
    pub fn new() -> Self {
        let path = resolve_config_path();
        let mut values = default_config();
        if let Ok(text) = fs::read_to_string(&path) {
            for line in text.lines() {
                if let Some((key, value)) = line.split_once('=') {
                    let key = key.trim().to_string();
                    if key.is_empty() {
                        continue;
                    }
                    values.insert(key, value.trim().to_string());
                }
            }
        }
        normalize(&mut values);
        Self {
            values: parking_lot::Mutex::new(values),
            path,
        }
    }

    /// 调试日志开关（config.txt 的 debug_log=true 时开启）。
    pub fn debug_log_enabled(&self) -> bool {
        self.values
            .lock()
            .get("debug_log")
            .is_some_and(|v| v.eq_ignore_ascii_case("true"))
    }

    /// 调试日志文件位置：跟着配置文件放同一目录。
    pub fn debug_log_path(&self) -> PathBuf {
        self.data_dir()
            .unwrap_or_else(|| Path::new(".").to_path_buf())
            .join("debug.log")
    }

    /// 数据文件目录（memos.json / plans.json 与 config.txt 同目录）。
    pub fn data_dir(&self) -> Option<PathBuf> {
        self.path.parent().map(|p| p.to_path_buf())
    }

    /// 把内存中的配置整体写回 config.txt。
    fn persist(&self) -> std::io::Result<()> {
        let values = self.values.lock();
        let mut text = String::new();
        for (key, value) in values.iter() {
            text.push_str(key);
            text.push('=');
            text.push_str(value);
            text.push('\n');
        }
        fs::write(&self.path, text)
    }
}

/// 探测目录是否可写：试着建一个临时探针文件再删掉。
/// Windows 上目录的只读属性不反映真实写权限，必须实际写一次。
fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(".newdeskbuddy-write-probe");
    let writable = fs::File::create(&probe).is_ok();
    if writable {
        let _ = fs::remove_file(&probe);
    }
    writable
}

/// 解析 config.txt 的落点，按以下顺序：
/// 1. 当前目录已有 config.txt —— 开发期沿用（CWD 是 src-tauri），
///    与 Python 版共用同一份文件的场景也在这里命中；
/// 2. exe 所在目录（可写时）—— 打包后从开始菜单/开机自启启动时，
///    CWD 可能是 System32 之类的地方，exe 旁边才是稳定位置；
/// 3. 当前目录（可写时）；
/// 4. 以上都不可写（如装进 Program Files）—— 回落到 %APPDATA%\NewDeskBuddy。
fn resolve_config_path() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if cwd.join("config.txt").is_file() {
        return cwd.join("config.txt");
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if dir != cwd && dir_writable(dir) {
                return dir.join("config.txt");
            }
        }
    }
    if dir_writable(&cwd) {
        return cwd.join("config.txt");
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let dir = PathBuf::from(appdata).join("NewDeskBuddy");
        if fs::create_dir_all(&dir).is_ok() {
            return dir.join("config.txt");
        }
    }
    cwd.join("config.txt")
}

/// 补齐缺失键、按类型转换并容错；数值字段非法时回落默认值。
fn normalize(values: &mut BTreeMap<String, String>) {
    for (key, value) in default_config() {
        values.entry(key).or_insert(value);
    }
    let snapshot = values.clone();
    for (key, is_float) in NUMERIC_KEYS {
        let fallback = default_config()
            .get(*key)
            .cloned()
            .unwrap_or_default();
        let parsed = snapshot
            .get(*key)
            .and_then(|raw| {
                if *is_float {
                    raw.parse::<f64>().ok().map(|v| format_number(v))
                } else {
                    raw.parse::<i64>().ok().map(|v| v.to_string())
                }
            });
        match parsed {
            Some(text) => {
                values.insert(key.to_string(), text);
            }
            None => {
                values.insert(key.to_string(), fallback);
            }
        }
    }
    for key in BOOL_KEYS {
        if let Some(raw) = snapshot.get(*key) {
            let as_bool = raw.eq_ignore_ascii_case("true");
            values.insert(key.to_string(), as_bool.to_string());
        }
    }
}

/// 整数就直接输出；浮点去掉多余的尾零（1.0 存成 1，0.65 保持 0.65），
/// 与 Python 版 str() 落盘的形态一致。
fn format_number(value: f64) -> String {
    if (value - value.round()).abs() < f64::EPSILON {
        format!("{}", value.round() as i64)
    } else {
        format!("{}", value)
    }
}

/// 返回前端可直接使用的完整配置（键到字符串值）。
#[tauri::command]
pub fn load_config(state: State<ConfigState>) -> BTreeMap<String, String> {
    state.values.lock().clone()
}

/// 前端提交增量的键值变更，合并、收敛后整体落盘。
#[tauri::command]
pub fn save_config(
    state: State<'_, ConfigState>,
    changes: BTreeMap<String, String>,
) -> Result<(), String> {
    {
        let mut values = state.values.lock();
        for (key, value) in changes {
            values.insert(key, value);
        }
        normalize(&mut values);
    }
    state
        .persist()
        .map_err(|e| format!("保存配置失败: {e}"))
}
