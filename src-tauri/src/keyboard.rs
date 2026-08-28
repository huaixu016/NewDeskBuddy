//! Windows 全局键盘监听：WH_KEYBOARD_LL 低级钩子统计按键次数。
//!
//! 与 Python 版同一套规则：每个物理按键从抬起到再次按下只计一次，
//! 长按产生的系统自动重复不计数。钩子运行在独立线程的消息循环里，
//! 每次计数通过 Tauri 事件 `key-pressed` 推给前端。
//!
//! 监听器进程内只有一个，共享状态直接放在模块级静态上。

use std::ffi::c_void;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicI64, AtomicPtr, AtomicU32, Ordering};
use std::sync::OnceLock;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
    TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
    WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

static APP: OnceLock<AppHandle> = OnceLock::new();
static COUNT: AtomicI64 = AtomicI64::new(0);
/// 按下的虚拟键码集合：长按产生的自动重复因此只计一次。
static PRESSED: Mutex<Vec<u32>> = Mutex::new(Vec::new());
static HOOK: AtomicPtr<c_void> = AtomicPtr::new(null_mut());
static THREAD_ID: AtomicU32 = AtomicU32::new(0);
static THREAD: Mutex<Option<std::thread::JoinHandle<()>>> = Mutex::new(None);

unsafe extern "system" fn keyboard_proc(n_code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
    if n_code >= 0 {
        let data = &*(l_param.0 as *const KBDLLHOOKSTRUCT);
        match w_param.0 as u32 {
            WM_KEYDOWN | WM_SYSKEYDOWN => {
                let mut pressed = PRESSED.lock();
                if !pressed.contains(&data.vkCode) {
                    pressed.push(data.vkCode);
                    let value = COUNT.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(app) = APP.get() {
                        let _ = app.emit("key-pressed", value);
                    }
                }
            }
            WM_KEYUP | WM_SYSKEYUP => {
                PRESSED.lock().retain(|&code| code != data.vkCode);
            }
            _ => {}
        }
    }
    // 必须把事件继续传给下一个钩子，否则可能阻断整个系统的键盘输入。
    let hook = HHOOK(HOOK.load(Ordering::SeqCst));
    CallNextHookEx(hook, n_code, w_param, l_param)
}

/// 启动监听线程。重复调用是幂等的：已在运行就直接返回。
pub fn spawn(app: AppHandle) {
    if APP.set(app).is_ok() {
        let handle = std::thread::spawn(|| unsafe {
            let module = GetModuleHandleW(PCWSTR::null()).unwrap_or_default();
            let instance = HINSTANCE(module.0);
            THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);

            let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), instance, 0) {
                Ok(hook) => hook,
                Err(_) => {
                    THREAD_ID.store(0, Ordering::SeqCst);
                    return;
                }
            };
            HOOK.store(hook.0, Ordering::SeqCst);

            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }

            let _ = UnhookWindowsHookEx(hook);
            HOOK.store(null_mut(), Ordering::SeqCst);
            PRESSED.lock().clear();
            THREAD_ID.store(0, Ordering::SeqCst);
        });
        *THREAD.lock() = Some(handle);
    }
}

/// 停止监听：向钩子线程投递 WM_QUIT 唤醒消息循环，再等待线程退出。
pub fn stop() {
    let handle = THREAD.lock().take();
    let thread_id = THREAD_ID.load(Ordering::SeqCst);
    if thread_id != 0 {
        unsafe {
            let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    if let Some(handle) = handle {
        let _ = handle.join();
    }
}

/// 前端命令入口：启动全局键盘监听。
#[tauri::command]
pub fn start_keyboard_listener(app: AppHandle) {
    spawn(app);
}

/// 前端命令入口：停止全局键盘监听（退出程序前调用）。
#[tauri::command]
pub fn stop_keyboard_listener() {
    stop();
}
