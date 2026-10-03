// ============================================================================
// 显示形态：整屏 / 左半屏 / 右半屏 / 窗口 + 多显示器选择
//
// 为什么半屏要走 Win32 而不是只用 Tauri 的窗口 API：
//   · 半屏必须精确到【物理像素】。用 MonitorFromPoint 拿到显示器矩形后按物理像素
//     取一半，才能真正盖住那半边屏，绕开 HiDPI 逻辑像素的坑。
//   · 全屏要盖住任务栏，直接把窗口摆到显示器完整矩形最直接。
//   Tauri 自己的 set_fullscreen 仍然调用一次作为兜底（先退出它认为的全屏态）。
//
// 句柄通过 win::find_main_window() 按进程号自己找，不经过 tauri 的 hwnd()：
// 这样全程只有 windows-sys 一套类型，不用在 `windows` / `windows-sys` 之间倒腾。
// ============================================================================

use tauri::{AppHandle, Manager};

use crate::win::{self, Monitor, WindowRect};

/// 目标矩形（物理像素）。全屏 = 整个显示器；半屏 = 半个显示器；窗口 = 居中留边。
fn target_rect(mon: &Monitor, mode: &str, half: &str) -> (i32, i32, i32, i32) {
    match (mode, half) {
        ("fullscreen", _) => (mon.x, mon.y, mon.width, mon.height),
        (_, "left") => (mon.x, mon.y, mon.width / 2, mon.height),
        (_, "right") => (mon.x + mon.width / 2, mon.y, mon.width / 2, mon.height),
        _ => {
            // 窗口模式：给一个居中、留边的可缩放窗口，方便在里面改设置
            let w = (mon.width as f64 * 0.62).round().max(960.0) as i32;
            let h = (mon.height as f64 * 0.72).round().max(640.0) as i32;
            let w = w.min(mon.width);
            let h = h.min(mon.height);
            (mon.x + (mon.width - w) / 2, mon.y + (mon.height - h) / 2, w, h)
        }
    }
}

/// 所有显示器（按下标排序，主屏优先）。
/// 类型直接沿用 win::Monitor，不再另包一层 —— 少一个类型就少一处对不上的可能。
pub fn list_monitors() -> Vec<Monitor> {
    win::list_monitors()
}

fn nth_monitor(screen: u32) -> Monitor {
    let list = win::list_monitors();
    list.get(screen as usize).cloned().unwrap_or_else(|| list[0].clone())
}

/// 应用显示形态。mode: fullscreen|window，half: full|left|right
pub fn apply_mode(app: &AppHandle, mode: &str, half: &str, screen: u32) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;

    let hwnd = win::find_main_window()
        .ok_or_else(|| "找不到本进程的窗口句柄".to_string())?;

    let mon = nth_monitor(screen);
    let (x, y, w, h) = target_rect(&mon, mode, half);
    // 全屏和半屏都必须无边框铺满（半屏时窗口本身就是那块竖屏，标题栏会毁掉排版）
    let frameless = mode == "fullscreen" || half == "left" || half == "right";

    // 先让 Tauri 退出它自己维护的全屏/尺寸状态，免得它随后把窗口摆回去
    let _ = window.set_fullscreen(false);
    let _ = window.set_resizable(!frameless);
    let _ = window.set_decorations(!frameless);

    win::set_frameless(hwnd, frameless);
    win::set_window_rect(hwnd, x, y, w, h);

    let _ = window.set_focus();
    Ok(())
}

/// 窗口当前物理矩形 —— 自动化验收脚本读它来核对半屏定位是否精确
pub fn window_rect(_app: &AppHandle) -> Option<WindowRect> {
    win::find_main_window().and_then(win::window_rect)
}
