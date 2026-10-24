// ============================================================================
// 启动轨迹（内存里的环形缓冲，【不落盘】）
//
// 【为什么不再写 startup.log】
//   这是个便携程序：整个文件夹会被拷到 U 盘、拷到别的电脑、拷到只读目录里跑。
//   上一版每启动一次就在 exe 旁边写一个 startup.log —— 用户看到的只是
//   "怎么又多了个文件"。垃圾文件的代价比它带来的便利大。
//
// 【为什么还留着这套东西】
//   打包后是 windows_subsystem = "windows"，没有控制台。启动阶段一旦 panic，
//   用户看到的就是"双击 → 转圈 → 什么都没发生"。这条轨迹留在内存里，
//   由两处把它打出来：
//     · panic hook    → 「BigClock 崩溃了」对话框里带最后几行
//     · 启动失败路径  → 「BigClock 启动失败」对话框里带最后几行
//   用户截个图就能定位，不用去找文件，也不会留下垃圾。
//
// 【需要落盘时】
//   真要录一份给维护者，设环境变量 BIGCLOCK_TRACE=<文件路径> 即可。
//   不设的话这里一个字节都不写 —— 默认行为是"零副作用"。
// ============================================================================

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// 对话框里带几行轨迹：够看出来卡在哪，又不至于把框撑满
pub const TAIL_IN_DIALOG: usize = 12;

/// 最多留多少行。够看清"卡在哪一步"，又不会撑爆一个对话框。
const CAP: usize = 200;

static LINES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static START: OnceLock<std::time::Instant> = OnceLock::new();
/// 环境变量指定的落盘路径（不设就是 None）
static FILE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 由 main 在最早的时候调用：起表、读 BIGCLOCK_TRACE、挂 panic hook
pub fn init() {
    let _ = START.set(std::time::Instant::now());

    let path = std::env::var_os("BIGCLOCK_TRACE")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty());
    let _ = FILE.set(path);

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
        // 仍然跑一遍默认 hook，方便带控制台运行时能看到
        default_hook(info);

        // 打包后既没有控制台也没有窗口，panic 就等于"程序闪一下没了"。
        // 这里补一个系统对话框，把轨迹一起带出来 —— 任何 panic 都不会是无声的。
        // 调试构建有控制台，就不弹框了，免得打断 cargo run。
        if !cfg!(debug_assertions) {
            crate::dialog::fatal(
                "BigClock 崩溃了",
                &format!(
                    "{msg}\n\n出问题的位置：{loc}\n\n启动轨迹（最后 {} 行）：\n{}",
                    TAIL_IN_DIALOG,
                    tail(TAIL_IN_DIALOG)
                ),
            );
        }
    }));
}

/// 记一行。失败也不抛（记录本身不该成为崩溃源）。
pub fn log(msg: impl AsRef<str>) {
    let elapsed = START.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
    let line = format!("[{elapsed:>6}ms] {}", msg.as_ref());

    {
        // 串行化写入，避免多线程交错；锁中毒也照写不误
        let mut buf = LINES.lock().unwrap_or_else(|e| e.into_inner());
        if buf.len() >= CAP {
            buf.pop_front();
        }
        buf.push_back(line.clone());
    }

    // 只有显式设了 BIGCLOCK_TRACE 才落盘
    if let Some(Some(path)) = FILE.get() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "{line}");
        }
    }

    // 带控制台运行时（cargo run / 命令行启动）也顺便打一份
    if cfg!(debug_assertions) {
        eprintln!("{line}");
    }
}

/// 取最后 n 行，给对话框用
pub fn tail(n: usize) -> String {
    let buf = LINES.lock().unwrap_or_else(|e| e.into_inner());
    let from = buf.len().saturating_sub(n);
    let lines: Vec<String> = buf.iter().skip(from).cloned().collect();
    if lines.is_empty() {
        return "（无）".into();
    }
    lines.join("\n")
}
