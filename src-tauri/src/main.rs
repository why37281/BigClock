// BigClock —— 教室晚自习大屏时钟
//
// 前端只负责画，配置与窗口形态全部由这边管：
//   config.rs   读 exe 同目录的文本配置 + 宽松解析 + 校验 + 热重载
//   win.rs      Win32 薄封装（显示器枚举、窗口定位、样式、光标）
//   display.rs  整屏 / 左半屏 / 右半屏 / 窗口 形态
//   cursor.rs   鼠标 3 秒不动自动隐藏
//   commands.rs 前端可调指令

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // 发布版不要多弹一个控制台

mod commands;
mod config;
mod cursor;
mod display;
mod single_instance;
mod win;

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};

use config::{Config, Issue, Watcher};
use cursor::CursorState;

/// 全局状态
pub struct AppState {
    pub config: Mutex<Config>,
    pub path: std::path::PathBuf,
    /// 配置路径是来自环境变量 BIGCLOCK_CONFIG 而不是自动推导
    pub explicit_path: bool,
    /// 最近一次成功读到的文件内容哈希 —— 用来区分"自己写的"和"用户在外面改的"。
    /// 没有它的话，每次保存都会触发一次自激重载。
    pub last_hash: Mutex<u64>,
    pub warnings: Mutex<Vec<String>>,
    pub issues: Mutex<Vec<Issue>>,
    /// 设置界面开着时不要藏光标
    pub cursor_hide_enabled: Arc<AtomicBool>,
    pub cursor: CursorState,
    /// 持有 watcher 的生命周期；丢了它热重载就停了
    _watcher: Mutex<Option<Watcher>>,
}

pub fn hash_of(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// 每次推给前端的状态包
#[derive(Clone, serde::Serialize)]
pub struct ConfigPayload {
    pub config: Config,
    pub path: String,
    pub explicit_path: bool,
    pub monitors: Vec<win::Monitor>,
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
    // ---------- 单实例：抢一个命名互斥体，已经有实例就直接退出 ----------
    // 进程退出时句柄自动释放，不存在"崩溃后残留锁文件"的问题。
    if single_instance::acquire().is_none() {
        eprintln!("[bigclock] 已经有一个 BigClock 在运行了，这次启动直接退出。");
        return;
    }

    // ---------- 配置路径与首次读取 ----------
    let (path, explicit_path) = config::resolve_config_path();
    let (cfg, raw, warnings, issues) = match config::load_or_create(&path) {
        Ok(l) => (l.config, l.raw, l.warnings, l.issues),
        Err(e) => {
            // 读不出来也【绝不白屏】：用默认配置跑起来，把错误挂到角落提示里
            let n = config::normalize(Config::default());
            (n.config, String::new(), vec![format!("{e}（正在使用默认配置）")], n.issues)
        }
    };

    let cursor = CursorState::new();
    let hide_enabled = Arc::new(AtomicBool::new(true));

    let initial_mode = cfg.mode.clone();
    let initial_half = cfg.half.clone();
    let initial_screen = cfg.screen;
    let initial_title = cfg.title.clone();

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
            // handle 是 AppHandle（内部 Arc），克隆给各处用，别把同一个绑定移来移去
            let handle = app.handle().clone();

            // 按配置摆好窗口形态
            if let Err(e) = display::apply_mode(&handle, &initial_mode, &initial_half, initial_screen)
            {
                eprintln!("[bigclock] 设置窗口形态失败：{e}");
            }
            if let Some(window) = handle.get_webview_window("main") {
                if !initial_title.is_empty() {
                    let _ = window.set_title(&format!("BigClock —— {initial_title}"));
                }
                let _ = window.show();
            }

            // 光标自动隐藏
            {
                let st = handle.state::<AppState>();
                st.cursor.spawn(hide_enabled.clone());
            }

            // ---------- 配置文件热重载 ----------
            let cfg_path = path.clone();
            let watcher_handle = handle.clone();
            let watcher = config::watch(&cfg_path, move || {
                // 回调跑在独立线程上，碰 UI / 发事件必须切回主线程
                let app = watcher_handle.clone();
                let _ = app.clone().run_on_main_thread(move || {
                    reload_from_disk(&app);
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

/// 从磁盘重读配置。自己刚写过的那一份会被哈希挡掉，不会自激。
/// 解析失败时【保留上一次有效配置】，只把错误报出去 —— 绝不让大屏白屏。
pub fn reload_from_disk(app: &tauri::AppHandle) {
    let st = app.state::<AppState>();

    let Ok(text) = std::fs::read_to_string(&st.path) else {
        return;
    };
    let h = hash_of(&text);
    if *st.last_hash.lock().unwrap() == h {
        return; // 就是我们自己刚写的，忽略
    }

    match toml::from_str::<Config>(&text) {
        Ok(parsed) => {
            let n = config::normalize(parsed);
            *st.config.lock().unwrap() = n.config;
            *st.last_hash.lock().unwrap() = h;
            *st.warnings.lock().unwrap() = n.warnings;
            *st.issues.lock().unwrap() = n.issues;
            let _ = app.emit("config-changed", st.payload());
        }
        Err(e) => {
            let msg = format!("配置文件格式有误，仍在使用上一次的有效配置：{e}");
            eprintln!("[bigclock] {msg}");
            *st.warnings.lock().unwrap() = vec![msg.clone()];
            let _ = app.emit(
                "config-error",
                serde_json::json!({ "message": msg, "fatal": false }),
            );
        }
    }
}
