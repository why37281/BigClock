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
mod startup_log;

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
    /// 自检回传（仅调试用）：webview 把 window.__selfcheck 等内容发回来存这里
    pub selfcheck: Mutex<serde_json::Value>,
}

fn main() {
    // ★ 最早做两件事：定位日志位置、挂 panic hook。
    // 打包后没有控制台，panic 一旦发生就是"静默死亡"，必须留下痕迹。
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    startup_log::init(exe_dir.clone());
    startup_log::log(format!(
        "启动 v{}  pid={}  exe_dir={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        exe_dir
            .as_ref()
            .map(|d| d.display().to_string())
            .unwrap_or_else(|| "?".into())
    ));

    // 单实例：已经有实例在跑就直接退出
    if single_instance::acquire().is_none() {
        startup_log::log("已有实例在运行，本次启动退出");
        eprintln!("[bigclock] 已经有一个 BigClock 在运行了，这次启动直接退出。");
        return;
    }
    startup_log::log("单实例检查通过");

    // 配置路径与首次读取
    let (path, _explicit) = config::resolve_config_path();
    startup_log::log(format!("配置路径 {}", path.display()));
    let (cfg, raw, warnings, issues) = match config::load_or_create(&path) {
        Ok(l) => (l.config, l.raw, l.warnings, l.issues),
        Err(e) => {
            // 读不出来也【绝不白屏】：用默认配置跑起来，把错误挂到角落提示里
            let n = config::normalize(Config::default());
            startup_log::log(format!("读配置失败，改用默认值：{e}"));
            (
                n.config,
                String::new(),
                vec![format!("{e}（正在使用默认配置）")],
                n.issues,
            )
        }
    };
    startup_log::log(format!(
        "配置就绪 mode={} half={} theme={} 时段数={}",
        cfg.mode,
        cfg.half,
        cfg.theme,
        cfg.periods.len()
    ));

    // ★ WebView2 创建失败要能自救重试。
    //
    // 实测过一个真实故障：create webview 返回
    //   HRESULT(0x800700AA) "请求的资源在使用中"
    // （ERROR_BUSY —— WebView2 的用户数据目录被占用：常见的元凶是上一次运行
    //   残留的 msedgewebview2.exe 子进程、杀软正在扫描刚写出的 profile、
    //   或者虚拟显示器/远程控制类软件）。
    // 这种占用往往是【瞬时】的，等一下就好，所以这里重试 3 次再认输。
    let mut last_err: Option<String> = None;
    for attempt in 1..=3 {
        match tauri::Builder::default()
            .plugin(tauri_plugin_opener::init())
            .manage(AppState {
                config: Mutex::new(cfg.clone()),
                raw: Mutex::new(raw.clone()),
                path: path.clone(),
                warnings: Mutex::new(warnings.clone()),
                issues: Mutex::new(issues.clone()),
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
                startup_log::log("setup: 开始");
                if let Some(w) = app.get_webview_window("main") {
                    match w.show() {
                        Ok(_) => startup_log::log("setup: 窗口已显示"),
                        Err(e) => startup_log::log(format!("setup: 显示窗口失败 {e}")),
                    }
                } else {
                    startup_log::log("setup: 找不到 main 窗口！");
                }
                if debug_server::maybe_start(app.handle().clone()) {
                    startup_log::log("setup: 自省端口已开启");
                }
                startup_log::log("setup: 完成");
                Ok(())
            })
            .run(tauri::generate_context!())
        {
            Ok(_) => {
                startup_log::log("主循环已退出（正常结束）");
                return;
            }
            Err(e) => {
                let msg = e.to_string();
                startup_log::log(format!("第 {attempt} 次启动失败：{msg}"));
                last_err = Some(msg);
                if attempt < 3 {
                    // 给占用方一点时间释放（杀软扫完 / 子进程退干净）
                    std::thread::sleep(std::time::Duration::from_millis(700 * attempt as u64));
                    startup_log::log("稍等后重试…");
                }
            }
        }
    }

    // ---------- 三次都失败：必须让用户看见原因，不能静默退出 ----------
    let err = last_err.unwrap_or_else(|| "未知错误".into());
    let log_path = exe_dir
        .as_ref()
        .map(|d| d.join("startup.log").display().to_string())
        .unwrap_or_else(|| "startup.log".into());
    let hint = if err.contains("0x800700AA") || err.contains("在使用中") {
        "看起来是 WebView2 的用户数据目录被占用了。\n\
         常见原因：上一次运行残留了 msedgewebview2.exe 子进程，\n\
         或者杀毒软件正在扫描它。\n\n\
         可以试：\n\
         1) 等十几秒再双击一次\n\
         2) 打开任务管理器，结束所有 msedgewebview2.exe 后重试\n\
         3) 重启电脑"
    } else if err.contains("WebView2") {
        "看起来这台机器缺少 WebView2 运行时（或版本过旧）。\n\
         去微软官网搜 \"WebView2 Runtime\" 免费下载安装即可。\n\
         Windows 11 一般自带，Windows 10 可能需要装一次。"
    } else {
        "请把下面的详细日志发给我。"
    };

    startup_log::log("!!! 三次重试均失败，弹出错误提示后退出");
    let _ = tinyfiledialogs::message_box_ok(
        "BigClock 启动失败",
        &format!("{err}\n\n{hint}\n\n详细日志：\n{log_path}"),
        tinyfiledialogs::MessageBoxIcon::Error,
    );
}
