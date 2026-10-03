// ============================================================================
// 光标自动隐藏（大屏展示必备）
//
// 不用 SetWindowsHookEx —— 装全局钩子既重又容易被安全软件拦。
// 改用 250ms 轮询 GetCursorPos：位置变了就重新计时，3 秒不动就隐藏。
// 轮询本身开销可以忽略，而且完全不侵入别人的消息循环。
//
// ShowCursor 是【计数式】的：多隐藏几次就得显示同样多次才能真正显示出来。
// 所以这里自己记住当前状态，保证 hide / show 严格配对，不会把计数搞乱。
// ============================================================================

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, ShowCursor};

/// 鼠标静止多久之后隐藏
const IDLE_AFTER: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(250);

pub struct CursorState {
    hidden: Arc<AtomicBool>,
}

impl CursorState {
    pub fn new() -> Self {
        Self { hidden: Arc::new(AtomicBool::new(false)) }
    }

    /// 启动后台轮询线程。`enabled` 为 false 时（例如设置界面开着）不隐藏。
    pub fn spawn(&self, enabled: Arc<AtomicBool>) {
        let hidden = self.hidden.clone();
        std::thread::spawn(move || {
            let mut last = POINT { x: 0, y: 0 };
            let got = unsafe { GetCursorPos(&mut last) } != 0;
            let mut last_move = Instant::now();
            let _ = got;

            loop {
                std::thread::sleep(POLL);

                let mut p = POINT { x: 0, y: 0 };
                let ok = unsafe { GetCursorPos(&mut p) } != 0;
                if ok && (p.x != last.x || p.y != last.y) {
                    last = p;
                    last_move = Instant::now();
                }

                // 拿不到坐标、或鼠标刚动过，都当作"不该隐藏"，顺便把计时重置
                let should_hide =
                    enabled.load(Ordering::Relaxed) && ok && last_move.elapsed() >= IDLE_AFTER;

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

    /// 强制把光标显示出来（打开设置、退出程序时用）
    pub fn show(&self) {
        if self.hidden.swap(false, Ordering::Relaxed) {
            unsafe { ShowCursor(1) };
        }
    }
}
