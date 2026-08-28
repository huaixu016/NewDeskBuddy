mod config;
mod keyboard;

use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

/// 待展示的菜单状态：右键时存一份，菜单窗口加载完成后取走——
/// 覆盖「右键发生在菜单窗口加载完成之前」的事件丢失场景。
#[derive(Default)]
struct PendingMenu(Mutex<Option<Value>>);

/// 打开独立菜单悬浮窗：在指定屏幕坐标附近显示。
/// 菜单内容（现代样式 DOM）由前端渲染，选中项经 `menu-action`
/// 事件回传给宠物窗口分发。窗口常驻隐藏，右键时重新定位显示。
#[tauri::command]
fn open_menu_window(
    app: AppHandle,
    pending: State<PendingMenu>,
    x: f64,
    y: f64,
    mode: String,
    key_count_visible: bool,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "mode": mode,
        "keyCountVisible": key_count_visible,
        "x": x,
        "y": y,
    });
    // 存一份兜底，再尝试直接推给已就绪的菜单窗口。
    *pending.0.lock() = Some(payload.clone());

    if let Some(window) = app.get_webview_window("menu") {
        let _ = window.emit("menu-state", payload);
    }
    Ok(())
}

/// 菜单窗口加载完成时取走积压的菜单请求。
#[tauri::command]
fn take_pending_menu(pending: State<PendingMenu>) -> Option<Value> {
    pending.0.lock().take()
}

/// 退出整个程序：先停键盘钩子，再退出事件循环。
/// 菜单窗口常驻隐藏，win.close() 只关一个窗口会让进程残留。
#[tauri::command]
fn exit_app(app: AppHandle) {
    keyboard::stop();
    app.exit(0);
}

/// 调试日志：config.txt 里 debug_log=true 才写文件（debug.log 与
/// config.txt 同目录），默认关闭，正式使用不产生日志文件。
#[tauri::command]
fn debug_log(msg: String, state: State<crate::config::ConfigState>) {
    if !state.debug_log_enabled() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.debug_log_path())
    {
        let _ = writeln!(f, "{} {}", std::time::SystemTime::now().elapsed().unwrap_or_default().as_millis(), msg);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(config::ConfigState::new())
        .manage(PendingMenu::default())
        .invoke_handler(tauri::generate_handler![
            config::load_config,
            config::save_config,
            keyboard::start_keyboard_listener,
            keyboard::stop_keyboard_listener,
            open_menu_window,
            take_pending_menu,
            exit_app,
            debug_log,
        ])
        .setup(|app| {
            // 启动即开始统计全局键盘输入，计数从本次运行开始、不持久化。
            keyboard::spawn(app.handle().clone());

            // 菜单悬浮窗：常驻隐藏，右键时由前端重新定位并显示。
            // 启动即创建，保证右键时页面早已加载完毕。
            if app.get_webview_window("menu").is_none() {
                let _ = tauri::WebviewWindowBuilder::new(
                    &*app,
                    "menu",
                    tauri::WebviewUrl::App("menu.html".into()),
                )
                .title("DeskBuddy Menu")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .visible(false)
                .shadow(false)
                .inner_size(230.0, 200.0)
                .build();
            }

            // 窗口尺寸由前端按当前模式的雪碧图尺寸动态调整，
            // 这里只负责把宠物窗口放到屏幕右下角附近（与 Python 版一致）。
            if let Some(window) = app.get_webview_window("pet") {
                if let Ok(Some(monitor)) = window.current_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    let _ = window.set_position(tauri::PhysicalPosition::new(
                        (size.width as f64 - 220.0 * scale) as i32,
                        (size.height as f64 - 320.0 * scale) as i32,
                    ));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 菜单窗口失焦即隐藏：点窗口外任意处收起菜单。
            if window.label() == "menu" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
            // 关闭宠物窗口（如 Alt+F4）即退出程序：托盘图标尚未实现，
            // 只停钩子不退出事件循环的话，进程会带着隐藏的菜单窗口僵在后台。
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "pet" {
                    keyboard::stop();
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run()
}
