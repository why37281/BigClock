// BigClock —— 教室晚自习大屏时钟
//
// 【架构】Rust 侧刻意保持极小，只做前端做不到的事：
//   config.rs          读写 exe 同目录的文本配置 + 宽松解析 + 校验
//   single_instance.rs 命名互斥体，防止开两份
//   commands.rs        配置文件读写 / 打开所在文件夹 / 退出
//   debug_server.rs    仅测试时开启的只读自省端口
//
// 其余全部在前端：时钟、进度条、字号自适应、主题、设置界面、
// 整屏/半屏切换（CSS width+translateX）、热重载（轮询文件文本）、
// 全屏与窗口形态（Tauri 官方 JS API）。
//
// 这样做的好处：窗口几何不再需要跟系统的最大化/边框/DPI 打架，
// 少三个依赖（windows-sys / notify / dirs），代码量少一个数量级。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // 发布版不要多弹一个控制台

mod commands;
mod config;
mod debug_server;
mod single_instance;

use std::sync::Mutex;

use tauri::Manager;

use config::{Config, Issue};

/// 全局状态：就一份配置 + 它的原始文本
pub struct AppState {
    pub config: Mutex<Config>,
    /// 最近一次读/写到的文件原文。前端靠它轮询比对，也靠它区分"自己写的"
    pub raw: Mutex<String>,
    pub path: std::path::PathBuf,
    pub warnings: Mutex<Vec<String>>,
    pub issues: Mutex<Vec<Issue>>,
    pub created: bool,
    /// 自检回传（仅调试用）：webview 把 window.__selfcheck 等内容发回来存这里
    pub selfcheck: Mutex<serde_json::Value>,
}

fn main() {
    // 单实例：已经有实例在跑就直接退出
    if single_instance::acquire().is_none() {
        eprintln!("[bigclock] 已经有一个 BigClock 在运行了，这次启动直接退出。");
        return;
    }

    // 配置路径与首次读取
    let (path, _explicit) = config::resolve_config_path();
    let (cfg, raw, warnings, issues, created) = match config::load_or_create(&path) {
        Ok(l) => (l.config, l.raw, l.warnings, l.issues, l.created),
        Err(e) => {
            // 读不出来也【绝不白屏】：用默认配置跑起来，把错误挂到角落提示里
            let n = config::normalize(Config::default());
            (
                n.config,
                String::new(),
                vec![format!("{e}（正在使用默认配置）")],
                n.issues,
                false,
            )
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            config: Mutex::new(cfg),
            raw: Mutex::new(raw),
            path,
            warnings: Mutex::new(warnings),
            issues: Mutex::new(issues),
            created,
            selfcheck: Mutex::new(serde_json::Value::Null),
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::reload_config,
            commands::raw_config,
            commands::reveal_config,
            commands::quit_app,
            commands::selfcheck_report,
        ])
        .setup(|app| {
            // 窗口先藏起来，等前端拿到配置、按配置摆好形态再显示，
            // 避免用户看到"先小窗后全屏"的跳动。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
            }
            // 仅测试时开启的只读自省端口
            debug_server::maybe_start(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("BigClock 启动失败");
}
