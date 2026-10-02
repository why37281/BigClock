// BigClock —— 教室晚自习大屏时钟
// 前端只负责画，配置与窗口形态全部由这边管。

mod commands;
mod config;
mod cursor;
mod display;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

use config::{Config, Issue, Watcher};
use cursor::CursorState;

/// 全局状态
pub struct AppState {
    pub config: Mutex<Config>,
    pub path: std::path::PathBuf,
    pub explicit_path: bool,
    /// 最近一次成功读到的文件内容哈希 —— 用来区分"自己写的"和"用户在外面改的"，
    /// 不然保存一次就会触发一次自激重载。
    pub last_hash: Mutex<u64>,
    pub warnings: Mutex<Vec<String>>,
    pub issues: Mutex<Vec<Issue>>,
    /// 设置界面开着的时候不要藏光标
    pub cursor_hide_enabled: Arc<AtomicBool>,
    pub cursor: CursorState,
    _watcher: Mutex<Option<Watcher>>,
}

pub fn hash_of(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

#[derive(Clone, serde::Serialize)]
pub struct ConfigPayload {
    pub config: Config,
    pub path: String,
    pub explicit_path: bool,
    pub monitors: Vec<display::Monitor>,
    pub warnings: Vec<String>,
    pub issues: Vec<Issue>,
}

impl AppState {
    pub fn payload(&self) -> ConfigPayload {
        ConfigPayload {
            config: self.config.lock().unwrap().clone(),
            path: self.path.to_string_lossy().to_string(),
            explicit_path: self.explicit_path,
            monitors: display::list_monitors(),
            warnings: self.warnings.lock().unwrap().clone(),
            issues: self.issues.lock().unwrap().clone(),
        }
    }
}

fn main() {
    // ---------- 单实例：抢一个命名互斥体；已经有实例就直接退出 ----------
    let Some(_guard) = single_instance::acquire() else {
        if let Ok(exe) = std::env::current_exe() {
            // 把已有实例的窗口叫到前面来，然后自己退出
            let _ = exe;
        }
        return;
    };

    // ---------- 配置路径与首次读取 ----------
    let (path, explicit_path) = config::resolve_config_path();
    let (cfg, raw, warnings, issues) = match config::load_or_create(&path) {
        Ok(l) => (l.config, l.raw, l.warnings, l.issues),
        Err(e) => {
            // 读不出来也绝不白屏：用默认配置跑起来，错误挂到角落里
            let n = config::normalize(Config::default());
            (n.config, String::new(), vec![format!("{e}（正在使用默认配置）")], n.issues)
        }
    };

    let cursor = CursorState::new();
    let hide_enabled = Arc::new(AtomicBool::new(true));
    let initial_mode = cfg.mode.clone();
    let initial_half = cfg.half.clone();
    let initial_screen = cfg.screen;
    let title = cfg.title.clone();

    let state = AppState {
        last_hash: Mutex::new(hash_of(&raw)),
        config: Mutex::new(cfg),
        path: path.clone(),
        explicit_path,
        warnings: Mutex::new(warnings),
        issues: Mutex::new(issues),
        cursor_hide_enabled: hide_enabled.clone(),
        cursor,
        _watcher: Mutex::new(None),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::reload_config,
            commands::list_monitors,
            commands::apply_display,
            commands::set_fullscreen,
            commands::window_rect,
            commands::quit_app,
            commands::set_cursor_hidden,
            commands::reveal_config,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // 启动时按配置摆好窗口形态
            if let Err(e) = display::apply_mode(&handle, &initial_mode, &initial_half, initial_screen) {
                eprintln!("[bigclock] 应用窗口形态失败：{e}");
            }
            if let Some(win) = handle.get_webview_window("main") {
                if !title.is_empty() {
                    let _ = win.set_title(&format!("BigClock —— {title}"));
                }
                let _ = win.show();
            }

            // 光标自动隐藏
            {
                let st = handle.state::<AppState>();
                st.cursor.spawn(hide_enabled.clone());
            }

            // 配置文件热重载
            let cfg_path = path.clone();
            let h2 = handle.clone();
            let watcher = config::watch(&cfg_path, move || {
                let app = h2.clone();
                // 回调在独立线程上，UI 操作必须切回主线程
                let _ = app.clone().run_on_main_thread(move || {
                    let st = app.state::<AppState>();
                    let Ok(text) = std::fs::read_to_string(&st.path) else { return };
                    let h = hash_of(&text);
                    if *st.last_hash.lock().unwrap() == h {
                        return; // 就是我们自己刚写的那份，忽略
                    }
                    match toml::from_str::<Config>(&text) {
                        Ok(parsed) => {
                            let n = config::normalize(parsed);
                            *st.config.lock().unwrap() = n.config.clone();
                            *st.last_hash.lock().unwrap() = h;
                            *st.warnings.lock().unwrap() = n.warnings;
                            *st.issues.lock().unwrap() = n.issues;
                            let _ = app.emit("config-changed", st.payload());
                        }
                        Err(e) => {
                            // 解析失败：保留上一次有效配置，只报错
                            let msg = format!("配置文件格式有误，仍在使用上一次的有效配置：{e}");
                            *st.warnings.lock().unwrap() = vec![msg];
                            let _ = app.emit(
                                "config-error",
                                serde_json::json!({ "message": e.to_string(), "fatal": false }),
                            );
                        }
                    }
                });
            });
            {
                let st = handle.state::<AppState>();
                *st._watcher.lock().unwrap() = Some(watcher);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("BigClock 启动失败");
}

// ============================================================================
// 单实例：命名互斥体
// 用 CreateMutexW + ERROR_ALREADY_EXISTS 判断，句柄在进程退出时自动释放，
// 不存在"崩溃后残留锁文件"的问题。
// ============================================================================
mod single_instance {
    use std::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(attr: *mut c_void, initial_owner: i32, name: *const u16) -> *mut c_void;
        fn GetLastError() -> u32;
    }
    const ERROR_ALREADY_EXISTS: u32 = 183;

    pub struct Guard(#[allow(dead_code)] *mut c_void);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn acquire() -> Option<Guard> {
        let name = wide("Local\\BigClock.SingleInstance.v1");
        let h = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
        if h.is_null() {
            return Some(Guard(h)); // 建不出来就别拦着用户启动
        }
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            return None;
        }
        Some(Guard(h))
    }
}
