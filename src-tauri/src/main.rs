// BigClock —— 教室晚自习大屏时钟
//
// 【架构】Rust 侧刻意保持极小，只做前端做不到的事：
//   config.rs          读写 exe 同目录的文本配置 + 宽松解析 + 校验
//   single_instance.rs 命名互斥体，防止开两份
//   commands.rs        配置文件读写 / 打开所在文件夹 / 退出
//   startup_log.rs     启动日志 + panic 捕获（打包后没有控制台，全靠它留证据）
//   dialog.rs          WebView2 起不来时唯一还能用的原生错误框
//   debug_server.rs    仅测试时开启的只读自省端口
//
// 其余全部在前端：时钟、进度条、字号自适应、主题、设置界面、
// 整屏/半屏切换（CSS width+translateX）、热重载（轮询文件文本）、
// 全屏与窗口形态（Tauri 官方 JS API）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // 发布版不要多弹一个控制台

mod commands;
mod config;
mod debug_server;
mod dialog;
mod single_instance;
mod startup_log;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use config::{Config, Issue};

/// 全局状态：就一份配置 + 它的原始文本
pub struct AppState {
    pub config: Mutex<Config>,
    /// 最近一次读/写到的文件原文。前端靠它轮询比对，也靠它区分"自己写的"
    pub raw: Mutex<String>,
    pub path: PathBuf,
    pub warnings: Mutex<Vec<String>>,
    pub issues: Mutex<Vec<Issue>>,
    /// 自检回传（仅调试用）：webview 把 window.__selfcheck 等内容发回来存这里
    pub selfcheck: Mutex<serde_json::Value>,
}

/// 创建窗口最多试几次。
///
/// WebView2 报 "请求的资源在使用中"（0x800700AA）多半是瞬时的：杀毒软件正在
/// 扫描刚解压出来的 exe，或者上一次运行残留的 msedgewebview2.exe 还没退干净。
/// 等一会儿再试通常就过了，所以这里给它 4 次机会（累计等待约 7 秒）。
const WINDOW_ATTEMPTS: u32 = 4;

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

    // 单实例：已经有实例在跑就直接退出。
    // 这是唯一一种"静默退出"是正确行为的情况 —— 用户本来就是想开一份。
    if single_instance::acquire().is_none() {
        startup_log::log("已有实例在运行，本次启动退出");
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

    if let Err(e) = run(exe_dir.clone(), path, cfg, raw, warnings, issues) {
        // 走到这里说明 Tauri 连事件循环都没建起来（窗口创建失败的路径在 setup 里
        // 已经弹过框并 exit 了，不会走到这里）。
        startup_log::log(format!("启动失败：{e}"));
        dialog::fatal("BigClock 启动失败", &fatal_hint(&e, exe_dir.as_deref()));
    }
}

/// 建 Tauri 应用并进入事件循环。正常退出返回 Ok。
///
/// 注意：setup 阶段抛出的 panic 不会变成这里的 Err，而是直接展开到 main。
/// 那种情况由 startup_log 的 panic hook 弹框兜底。
fn run(
    exe_dir: Option<PathBuf>,
    path: PathBuf,
    cfg: Config,
    raw: String,
    warnings: Vec<String>,
    issues: Vec<Issue>,
) -> Result<(), String> {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            config: Mutex::new(cfg),
            raw: Mutex::new(raw),
            path,
            warnings: Mutex::new(warnings),
            issues: Mutex::new(issues),
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
        .setup(move |app| {
            startup_log::log("setup: 开始");

            if let Err(e) = create_main_window(app) {
                startup_log::log(format!("setup: 窗口创建失败：{e}"));
                // ★ 绝不让用户面对"转圈然后没了"：说清原因，然后正常退出。
                dialog::fatal("BigClock 启动失败", &fatal_hint(&e, exe_dir.as_deref()));
                std::process::exit(1);
            }

            if debug_server::maybe_start(app.handle().clone()) {
                startup_log::log("setup: 自省端口已开启");
            }
            startup_log::log("setup: 完成");
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|e| e.to_string())
}

/// 自己建主窗口，而不是让 Tauri 在 setup 里按配置自动建。
///
/// 【这是这次修复的核心 · 别再改回去】
///
/// Tauri 默认会在 setup 阶段按 tauri.conf.json 的 windows 数组自动建窗口。
/// 建失败时它的做法是：
///
///     panic!("Failed to setup app: {e}");     // tauri/src/app.rs，事件循环回调里
///
/// 也就是说【错误根本不会从 Builder::run() 返回】。外面无论怎么 match Err、
/// 怎么 for 循环重试，都拦不到这个失败 —— 之前那版"重试 3 次"就是这么变成
/// 死代码的。打包后是 windows_subsystem = "windows"，没有控制台，panic 一发生
/// 进程就没了，用户看到的就是"转一圈，然后什么都不发生"。
///
/// 所以 tauri.conf.json 里把窗口改成 "create": false，在这里自己建：
/// WebviewWindowBuilder::build() 是【真的返回 Err】的，可以重试，也可以提示。
fn create_main_window<R: tauri::Runtime>(app: &mut tauri::App<R>) -> Result<(), String> {
    let cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or_else(|| "tauri.conf.json 里找不到 label = \"main\" 的窗口配置".to_string())?;

    // 把 Tauri 默认用的 WebView2 数据目录先记下来 —— 报 0x800700AA 时
    // 第一个要看的就是它到底在哪、有没有被别人占着。
    let identifier = app.config().identifier.clone();
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        let p = PathBuf::from(base).join(&identifier).join("EBWebView");
        startup_log::log(format!("默认 WebView2 数据目录 {}", p.display()));
    }

    let mut last_err = String::new();

    for attempt in 1..=WINDOW_ATTEMPTS {
        if let Some(e) = simulated_failure(attempt) {
            last_err = e;
            startup_log::log(format!(
                "第 {attempt}/{WINDOW_ATTEMPTS} 次创建窗口失败：{last_err}"
            ));
        } else {
            let mut builder = match tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg) {
                Ok(b) => b,
                Err(e) => return Err(e.to_string()),
            };

            // 第 1 次用默认目录：它有缓存，启动最快。
            // 一旦失败就不再干等 —— 经验是占用方（杀软扫描 / 搜索索引器）能持住
            // 几十秒，而退避只有几秒，等不起。从第 2 次起直接换干净目录：
            // 宁可丢缓存多花 300ms，也不要起不来。
            if attempt >= 2 {
                match fallback_data_dir() {
                    Ok(dir) => {
                        startup_log::log(format!(
                            "第 {attempt} 次改用备用数据目录 {}",
                            dir.display()
                        ));
                        builder = builder.data_directory(dir);
                    }
                    Err(e) => startup_log::log(format!(
                        "备用数据目录一个都建不出来（继续用默认目录）：{e}"
                    )),
                }
            }

            match builder.build() {
                Ok(window) => {
                    startup_log::log(format!("第 {attempt} 次创建窗口成功"));
                    match window.show() {
                        Ok(_) => startup_log::log("窗口已显示"),
                        Err(e) => startup_log::log(format!("显示窗口失败（通常不影响使用）：{e}")),
                    }
                    return Ok(());
                }
                Err(e) => {
                    last_err = e.to_string();
                    startup_log::log(format!(
                        "第 {attempt}/{WINDOW_ATTEMPTS} 次创建窗口失败：{last_err}"
                    ));
                }
            }
        }

        if attempt < WINDOW_ATTEMPTS {
            // 退避等一等，给占用方（杀软 / 残留 WebView2 子进程）释放的时间
            let wait = Duration::from_millis(1_200 * attempt as u64);
            startup_log::log(format!("{} ms 后重试…", wait.as_millis()));
            std::thread::sleep(wait);
        }
    }

    Err(last_err)
}

/// 备用 WebView2 数据目录。
///
/// 默认目录 `%LOCALAPPDATA%\<identifier>\EBWebView` 被占住时（0x800700AA），
/// 新建 WebView2 环境会直接失败。占用方通常不是另一个 WebView2 进程，而是
/// 杀软实时扫描 / Windows 搜索索引器临时持有这个目录里的文件句柄 —— 它们不出现在
/// `--user-data-dir` 里，等它们扫完就自己好了，但可能持续几十秒。
///
/// 所以这里准备几个候选目录，挨个试着建，第一个能用的就用。
/// 【注意】失败原因必须说出来 —— 上一版这里用 `.ok()?` 把错误吞了，
/// 结果降级逻辑静默失效，日志只留一句"没拿到备用数据目录"，白查了很久。
fn fallback_data_dir() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(base).join("BigClock").join("WebView2"));
    }
    if let Some(tmp) = std::env::var_os("TEMP") {
        candidates.push(PathBuf::from(tmp).join("BigClock-WebView2"));
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        candidates.push(dir.join(".webview2"));
    }

    if candidates.is_empty() {
        return Err("LOCALAPPDATA / TEMP 都读不到，也拿不到 exe 目录".to_string());
    }

    let mut errors: Vec<String> = Vec::new();
    for dir in candidates {
        match std::fs::create_dir_all(&dir) {
            Ok(_) => return Ok(dir),
            Err(e) => errors.push(format!("{} → {e}", dir.display())),
        }
    }
    Err(errors.join("；"))
}

/// 测试开关：强制窗口创建失败，用来验证三条平时碰不到的路径。
///
///   BIGCLOCK_FORCE_WEBVIEW_ERROR=1      → 前 1 次失败（验证重试能救回来）
///   BIGCLOCK_FORCE_WEBVIEW_ERROR=2      → 前 2 次失败（第 3 次会切到备用数据目录）
///   BIGCLOCK_FORCE_WEBVIEW_ERROR=all    → 每次都失败（验证弹框 + 日志 + 退出）
///   不设 / 0 / false                    → 正常启动
///
/// 不设这个变量时代码一行都不跑，对普通用户没有任何影响。
fn simulated_failure(attempt: u32) -> Option<String> {
    let raw = std::env::var("BIGCLOCK_FORCE_WEBVIEW_ERROR").ok()?;
    let v = raw.trim().to_ascii_lowercase();
    if v.is_empty() || v == "0" || v == "false" {
        return None;
    }
    let limit = if v == "first" {
        1
    } else if v == "all" {
        u32::MAX
    } else {
        v.parse::<u32>().unwrap_or(u32::MAX)
    };
    if attempt > limit {
        return None;
    }
    Some(format!(
        "模拟的 WebView2 创建失败（BIGCLOCK_FORCE_WEBVIEW_ERROR={v}）"
    ))
}

/// 把错误翻成人话 + 给出可操作的建议 + 指明日志在哪
fn fatal_hint(err: &str, exe_dir: Option<&Path>) -> String {
    let log = exe_dir
        .map(|d| d.join("startup.log").display().to_string())
        .unwrap_or_else(|| "startup.log".into());

    let lower = err.to_lowercase();
    let reason = if err.contains("0x800700AA")
        || err.contains("在使用中")
        || lower.contains("in use")
    {
        "WebView2 的用户数据目录被占用了。\n\
         （程序已经自动换过备用目录试过，还是不行，说明两个目录都被占着。）\n\
         常见原因：杀毒软件正在扫描刚解压出来的程序，\n\
         或者上一次运行残留的 msedgewebview2.exe 还没退干净。"
    } else if err.contains("0x8007") || err.contains("WebView2") {
        "WebView2 运行时报错。最常见的原因是这台机器缺少 WebView2 运行时，\n\
         或者版本太旧。去微软官网搜 “WebView2 Runtime” 免费安装即可。\n\
         Windows 11 一般自带；Windows 10 可能需要装一次。"
    } else {
        "具体原因见上面这行报错。"
    };

    format!(
        "{err}\n\n\
         {reason}\n\n\
         可以按顺序试：\n\
         1) 关掉这个提示，等十几秒再双击一次\n\
         2) 任务管理器 → 详细信息 → 结束所有 msedgewebview2.exe，再重试\n\
         3) 把整个文件夹换到别的目录（例如 D:\\BigClock\\）再试\n\
         4) 重启电脑\n\n\
         详细日志（把它发给我就能定位）：\n{log}"
    )
}
