// ============================================================================
// 启动日志与 panic 捕获
//
// 为什么需要它：
//   打包成 windows_subsystem = "windows" 之后没有控制台，release 版还开了
//   strip，一旦启动阶段 panic，用户看到的就是"双击 → 转圈 → 什么都没发生"。
//   事件日志里只有一句 0xc0000409（__fastfail），没有任何线索。
//
//   所以这里做两件事：
//     1. 挂一个 panic hook，把 panic 的信息（含位置）写进 exe 同目录的
//        startup.log —— 出问题让用户直接把那个文件发过来就行
//     2. 在关键节点记一行，这样"卡在哪一步"一目了然
//
// 日志文件放在 exe 同目录，和 bigclock.toml 一起，方便找。
// 每次启动覆盖写（只保留最后一次启动的过程）。
// ============================================================================

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static START: OnceLock<std::time::Instant> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

/// 由 main 在最早的时候调用：确定日志路径并挂上 panic hook
pub fn init(exe_dir: Option<PathBuf>) {
    let path = exe_dir
        .unwrap_or_else(|| PathBuf::from("."))
        .join("startup.log");
    let _ = LOG_PATH.set(path);
    let _ = START.set(std::time::Instant::now());

    // 覆盖写：只保留最近一次启动
    if let Some(p) = LOG_PATH.get() {
        let _ = std::fs::write(p, b"");
    }

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".into());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".into());
        log(format!("!!! PANIC at {loc}: {msg}"));
        log("!!! 进程即将退出；把 startup.log 发给我即可定位");
        // 仍然跑一遍默认 hook，方便带控制台运行时能看到
        default_hook(info);
    }));
}

/// 记一行日志。失败也不抛（日志本身不该成为崩溃源）。
pub fn log(msg: impl AsRef<str>) {
    let elapsed = START.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
    let line = format!("[{elapsed:>6}ms] {}\n", msg.as_ref());

    // 串行化写入，避免多线程交错
    let _guard = LOCK.lock();
    let Some(path) = LOG_PATH.get() else { return };
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
        let _ = f.flush();
    }
    // 带控制台运行时（cargo run / 命令行启动）也顺便打一份
    if cfg!(debug_assertions) {
        eprint!("{line}");
    }
}
