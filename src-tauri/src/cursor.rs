// ============================================================================
// 光标自动隐藏（大屏展示必备）
//
// 不用 SetWindowsHookEx —— 装全局钩子既重又容易被安全软件拦。
// 改用 250ms 轮询 GetCursorPos：位置变了就重新计时，3 秒不动就隐藏。
// 轮询开销可以忽略，而且完全不侵入别人的消息循环。
// ============================================================================

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq)]
struct Point {
    x: i32,
    y: i32,
}

#[link(name = "user32")]
extern "system" {
    fn GetCursorPos(pt: *mut Point) -> i32;
    fn ShowCursor(show: i32) -> i32;
}

const IDLE_AFTER: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(250);

/// 显示状态：ShowCursor 是【计数式】的，多隐藏几次就得显示同样多次，
/// 所以这里自己记住当前是不是隐藏着，保证 hide/show 严格配对。
pub struct CursorState {
    hidden: Arc<AtomicBool>,
}

impl CursorState {
    pub fn new() -> Self {
        Self { hidden: Arc::new(AtomicBool::new(false)) }
    }

    /// 启动后台轮询线程。`enabled` 为 false 时（比如设置界面开着）不隐藏。
    pub fn spawn(&self, enabled: Arc<AtomicBool>) {
        let hidden = self.hidden.clone();
        std::thread::spawn(move || {
            let mut last_pos = Point::default();
            let mut last_move = Instant::now();
            unsafe {
                GetCursorPos(&mut last_pos);
            }

            loop {
                std::thread::sleep(POLL);

                let mut p = Point::default();
                let ok = unsafe { GetCursorPos(&mut p) } != 0;
                if ok && p != last_pos {
                    last_pos = p;
                    last_move = Instant::now();
                }

                let should_hide = enabled.load(Ordering::Relaxed)
                    && ok
                    && last_move.elapsed() >= IDLE_AFTER;

                let is_hidden = hidden.load(Ordering::Relaxed);
                if should_hide && !is_hidden {
                    unsafe { ShowCursor(0) };
                    hidden.store(true, Ordering::Relaxed);
                } else if !should_hide && is_hidden {
                    unsafe { ShowCursor(1) };
                    hidden.store(false, Ordering::Relaxed);
                }
                if !should_hide {
                    last_move = Instant::now();
                }
            }
        });
    }

    /// 强制把光标显示出来（退出前、打开设置时用）
    pub fn show(&self) {
        if self.hidden.swap(false, Ordering::Relaxed) {
            unsafe { ShowCursor(1) };
        }
    }
}

/// 后台线程要用的空指针类型别名，避免 unused 警告
#[allow(dead_code)]
type Raw = *mut c_void;
