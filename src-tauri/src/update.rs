//! 更新检查：每日一次，触发时刻取工作配置的上午上班时间（am_start）。
//!
//! 数据源为 GitHub Releases；检测到的远端版本号写进 config.txt
//! （update_latest_version / update_checked_date），右键菜单据此显示
//! 红点角标——仅当远端版本 > 本地版本，非强制升级，点菜单项打开
//! Releases 页面由用户自行决定。

use std::time::Duration;

use chrono::{Local, NaiveTime};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::config::ConfigState;const RELEASES_API: &str = "https://api.github.com/repos/huaixu016/NewDeskBuddy/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/huaixu016/NewDeskBuddy/releases/latest";

/// 本地版本（Cargo.toml 的 package.version，与 tauri.conf.json 保持一致）。
const LOCAL_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 平时轮询间隔：一分钟足够精确地命中上班时刻。
const POLL_DELAY: Duration = Duration::from_secs(60);
/// 失败重试间隔：GitHub 不可达时不能每分钟打一次。
const RETRY_DELAY: Duration = Duration::from_secs(600);

/// "v0.2.1" → [0, 2, 1]，解析不了的段按 0 处理。
fn parse_version(text: &str) -> Vec<u64> {
    text.trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| part.trim().parse::<u64>().unwrap_or(0))
        .collect()
}

/// 远端版本 > 本地版本才算有更新（相等或更低都不提示）。
pub fn update_available(latest: &str) -> bool {
    let remote = parse_version(latest);
    if remote.is_empty() || remote.iter().all(|&v| v == 0) {
        return false;
    }
    remote > parse_version(LOCAL_VERSION)
}

/// 拉取 GitHub Releases 的最新 tag（如 "v0.2.1"）。
fn fetch_latest_version() -> Result<String, String> {
    let response = ureq::get(RELEASES_API)
        .set("User-Agent", "NewDeskBuddy-UpdateCheck")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|err| format!("请求失败: {err}"))?;
    let text = response
        .into_string()
        .map_err(|err| format!("读取失败: {err}"))?;
    let json: Value =
        serde_json::from_str(&text).map_err(|err| format!("解析失败: {err}"))?;
    json.get("tag_name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "响应缺少 tag_name".to_string())
}

/// 执行一次检测并把结果落盘。成功才记日期，失败由调用方稍后重试。
fn run_check(state: &ConfigState) -> Result<(), String> {
    let latest = fetch_latest_version()?;
    state.set("update_latest_version", &latest);
    let today = Local::now().format("%Y-%m-%d").to_string();
    state.set("update_checked_date", &today);
    Ok(())
}

/// 检查线程：到点（am_start 及以后）且今日未查过 → 拉一次 Releases。
/// 应用在上班时刻之后才启动的，首轮轮询就会补上当天的检测。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        let delay = {
            let state = app.state::<ConfigState>();
            let today = Local::now().format("%Y-%m-%d").to_string();
            let checked = state.get("update_checked_date").unwrap_or_default();
            if !checked.is_empty() && checked == today {
                // 今天已经查过，等明天。
                POLL_DELAY
            } else {
                let am_start = NaiveTime::parse_from_str(
                    &state.get("am_start").unwrap_or_else(|| "09:00".into()),
                    "%H:%M",
                )
                .unwrap_or_else(|_| NaiveTime::from_hms_opt(9, 0, 0).expect("9:00 合法"));
                if Local::now().time() >= am_start {
                    if run_check(&state).is_ok() {
                        POLL_DELAY
                    } else {
                        RETRY_DELAY
                    }
                } else {
                    POLL_DELAY
                }
            }
        };
        std::thread::sleep(delay);
    });
}

/// 打开默认浏览器到 Releases 页面（仅提示，不强制升级）。
#[tauri::command]
pub fn open_release_page() {
    // 空标题参数不可省：URL 含 & 等字符时会被 start 当参数分隔。
    let _ = std::process::Command::new("cmd")
        .args(["/C", "start", "", RELEASES_PAGE])
        .spawn();
}

/// 下载指定 URL 到本地文件（GitHub 资产链接会 302 到 CDN，ureq 自动跟随）。
fn download_file(url: &str, path: &std::path::Path) -> Result<(), String> {
    let response = ureq::get(url)
        .set("User-Agent", "NewDeskBuddy-UpdateCheck")
        .timeout(Duration::from_secs(60))
        .call()
        .map_err(|err| format!("下载请求失败: {err}"))?;
    let mut reader = response.into_reader();
    let mut file =
        std::fs::File::create(path).map_err(|err| format!("创建临时文件失败: {err}"))?;
    std::io::copy(&mut reader, &mut file).map_err(|err| format!("写入失败: {err}"))?;
    Ok(())
}

/// 找到最新 Release 的 NSIS 安装包（形如 NewDeskBuddy_0.2.0_x64-setup.exe），
/// 下载到临时目录并启动安装向导。返回 Ok(false) 表示仓库里没有安装包资产。
fn download_and_run_setup() -> Result<bool, String> {
    let response = ureq::get(RELEASES_API)
        .set("User-Agent", "NewDeskBuddy-UpdateCheck")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|err| format!("请求失败: {err}"))?;
    let text = response
        .into_string()
        .map_err(|err| format!("读取失败: {err}"))?;
    let json: Value =
        serde_json::from_str(&text).map_err(|err| format!("解析失败: {err}"))?;
    let assets = json
        .get("assets")
        .and_then(Value::as_array)
        .ok_or_else(|| "响应缺少资产列表".to_string())?;
    // NSIS 构建产物名以 -setup.exe 结尾；没有就找任意 exe 资产兜底。
    let setup = assets
        .iter()
        .find_map(|asset| find_setup(asset, "-setup.exe"))
        .or_else(|| assets.iter().find_map(|asset| find_setup(asset, ".exe")));
    let Some((name, url)) = setup else {
        return Ok(false);
    };
    let path = std::env::temp_dir().join(format!("NewDeskBuddy-{name}"));
    download_file(&url, &path)?;
    // 启动安装向导（常规 UI）：装不装最终由用户在向导里点，
    // 保持「非强制」语义。子进程独立于父进程，随后应用退出不影响它。
    std::process::Command::new(&path)
        .spawn()
        .map_err(|err| format!("启动安装程序失败: {err}"))?;
    Ok(true)
}

/// 资产名以指定后缀结尾时返回 (文件名, 下载链接)。
fn find_setup(asset: &Value, suffix: &str) -> Option<(String, String)> {
    let name = asset.get("name")?.as_str()?;
    let url = asset.get("browser_download_url")?.as_str()?;
    if name.to_lowercase().ends_with(suffix) {
        Some((name.to_string(), url.to_string()))
    } else {
        None
    }
}

/// 直接下载最新版安装包并启动安装。
/// 仓库没有安装包资产或下载失败时回退为打开 Releases 页面（不返回 Err，
/// 前端无需区分失败原因）。下载完成后应用自动退出给安装让路。
/// async command 跑在运行时线程上，阻塞下载不会卡住主线程 UI。
#[tauri::command]
pub async fn download_and_update(app: AppHandle) -> Result<bool, String> {
    let started = match download_and_run_setup() {
        Ok(started) => started,
        Err(err) => {
            eprintln!("[update] 直接更新失败，回退浏览器: {err}");
            false
        }
    };
    if !started {
        open_release_page();
        return Ok(false);
    }
    // 安装器已启动：停键盘钩子并退出，程序文件还开着的话安装会失败。
    crate::keyboard::stop();
    app.exit(0);
    Ok(true)
}
