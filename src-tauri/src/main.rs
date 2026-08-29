mod config;
mod keyboard;
mod store;

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
    memo_count: Option<i64>,
    plan_count: Option<i64>,
) -> Result<(), String> {
    // 备忘录 / 计划条数只在工作模式下有意义（菜单项也只在那时出现），
    // 宠物窗口打开菜单时不传。
    let payload = serde_json::json!({
        "mode": mode,
        "keyCountVisible": key_count_visible,
        "memoCount": memo_count.unwrap_or(0),
        "planCount": plan_count.unwrap_or(0),
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
            store::load_memos,
            store::save_memos,
            store::next_memo_id,
            store::load_plans,
            store::save_plans,
            store::next_plan_id,
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

            // 工作模式面板窗：与菜单窗同样常驻隐藏，进入工作模式时由前端
            // 布局好尺寸再显示。启动即创建，保证切换时页面早已就绪。
            if app.get_webview_window("work").is_none() {
                let _ = tauri::WebviewWindowBuilder::new(
                    &*app,
                    "work",
                    tauri::WebviewUrl::App("work.html".into()),
                )
                .title("DeskBuddy Work")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .visible(false)
                .shadow(false)
                .inner_size(480.0, 320.0)
                .build();
            }

            // 弹窗窗（工作配置 / 备忘录 / 计划 / 生理期共用）：
            // 同样常驻隐藏，由 `dialog-state` 事件驱动内容与位置。
            if app.get_webview_window("dialog").is_none() {
                let _ = tauri::WebviewWindowBuilder::new(
                    &*app,
                    "dialog",
                    tauri::WebviewUrl::App("dialog.html".into()),
                )
                .title("DeskBuddy Dialog")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(false)
                .visible(false)
                .shadow(false)
                .inner_size(420.0, 420.0)
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
            // 关闭宠物 / 工作面板 / 弹窗窗口（如 Alt+F4）即退出程序：
            // 托盘图标尚未实现，只停钩子不退出事件循环的话，进程会带着
            // 隐藏的常驻窗口僵在后台。
            if let tauri::WindowEvent::Destroyed = event {
                if matches!(window.label(), "pet" | "work" | "dialog") {
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
