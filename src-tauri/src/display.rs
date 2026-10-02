// ============================================================================
// Win32 显示控制：枚举显示器 / 整屏 / 左半屏 / 右半屏 / 窗口
//
// 为什么必须走 Win32 而不是只用 Tauri 的窗口 API：
//   · 半屏要精确到【物理像素】，必须用 MonitorFromPoint 拿到显示器矩形，
//     再按物理像素算半边宽度，绕开 HiDPI 逻辑像素的坑。
//   · 全屏要真正盖住任务栏，用 SetWindowPos 到显示器完整矩形最直接。
//   · Tauri 的 window API 仍然保留作为兜底（先退出全屏/还原，再 SetWindowPos）。
// ============================================================================

use serde::Serialize;
use std::ffi::c_void;
use tauri::{AppHandle, Manager, WebviewWindow};

pub type Hwnd = *mut c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Rect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
struct MonitorInfoExW {
    cb_size: u32,
    rc_monitor: Rect,
    rc_work: Rect,
    flags: u32,
    device: [u16; 32],
}

#[link(name = "user32")]
extern "system" {
    fn EnumDisplayMonitors(
        hdc: *mut c_void,
        clip: *const Rect,
        cb: extern "system" fn(*mut c_void, *mut c_void, *mut Rect, isize) -> i32,
        data: isize,
    ) -> i32;
    fn GetMonitorInfoW(hmon: *mut c_void, info: *mut MonitorInfoExW) -> i32;
    fn MonitorFromPoint(pt: Point, flags: u32) -> *mut c_void;
    fn SetWindowPos(
        hwnd: *mut c_void,
        after: *mut c_void,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn SetWindowLongPtrW(hwnd: *mut c_void, index: i32, value: isize) -> isize;
    fn GetWindowLongPtrW(hwnd: *mut c_void, index: i32) -> isize;
    fn ShowWindow(hwnd: *mut c_void, cmd: i32) -> i32;
    fn IsWindowVisible(hwnd: *mut c_void) -> i32;
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct Point {
    x: i32,
    y: i32,
}

const MONITOR_DEFAULTTONEAREST: u32 = 2;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_FRAMECHANGED: u32 = 0x0020;
const SWP_SHOWWINDOW: u32 = 0x0040;
const GWL_STYLE: i32 = -16;
const WS_POPUP: isize = 0x8000_0000u32 as i32 as isize;
const WS_CAPTION: isize = 0x00C0_0000;
const WS_THICKFRAME: isize = 0x0004_0000;
const WS_MINIMIZEBOX: isize = 0x0002_0000;
const WS_MAXIMIZEBOX: isize = 0x0001_0000;
const WS_SYSMENU: isize = 0x0008_0000;
const SW_SHOW: i32 = 5;

#[derive(Debug, Clone, Serialize)]
pub struct Monitor {
    pub index: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

extern "system" fn enum_cb(
    hmon: *mut c_void,
    _hdc: *mut c_void,
    _rect: *mut Rect,
    data: isize,
) -> i32 {
    let list = unsafe { &mut *(data as *mut Vec<(Rect, Rect, String, bool)>) };
    let mut mi: MonitorInfoExW = unsafe { std::mem::zeroed() };
    mi.cb_size = std::mem::size_of::<MonitorInfoExW>() as u32;
    if unsafe { GetMonitorInfoW(hmon, &mut mi) } != 0 {
        let name = String::from_utf16_lossy(
            &mi.device[..mi.device.iter().position(|&c| c == 0).unwrap_or(mi.device.len())],
        );
        let primary = (mi.flags & 1) != 0;
        list.push((mi.rc_monitor, mi.rc_work, name, primary));
    }
    1 // 继续枚举
}

/// 枚举所有显示器，按"主屏优先、然后按 x 坐标"排序，下标即配置里的 screen。
pub fn list_monitors() -> Vec<Monitor> {
    let mut raw: Vec<(Rect, Rect, String, bool)> = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            enum_cb,
            &mut raw as *mut _ as isize,
        );
    }
    let mut list: Vec<Monitor> = raw
        .into_iter()
        .enumerate()
        .map(|(i, (m, _w, name, primary))| Monitor {
            index: i as u32,
            name: if name.is_empty() { format!("显示器 {}", i + 1) } else { name },
            x: m.left,
            y: m.top,
            width: m.right - m.left,
            height: m.bottom - m.top,
            primary,
        })
        .collect();

    list.sort_by_key(|m| (!m.primary, m.x));
    for (i, m) in list.iter_mut().enumerate() {
        m.index = i as u32;
    }
    list
}

fn nth_monitor(screen: u32) -> Option<Monitor> {
    let list = list_monitors();
    if list.is_empty() {
        return None;
    }
    list.get(screen as usize).cloned().or_else(|| list.first().cloned())
}

fn hwnd_of(win: &WebviewWindow) -> Option<Hwnd> {
    win.hwnd().ok().map(|h| h.0 as Hwnd)
}

/// 目标矩形（物理像素）
fn target_rect(mon: &Monitor, half: &str, mode: &str) -> (i32, i32, i32, i32) {
    match (mode, half) {
        ("fullscreen", _) => (mon.x, mon.y, mon.width, mon.height),
        (_, "left") => (mon.x, mon.y, mon.width / 2, mon.height),
        (_, "right") => (mon.x + mon.width / 2, mon.y, mon.width / 2, mon.height),
        _ => {
            // 窗口模式：给一个居中、留边的可缩放窗口
            let w = (mon.width as f64 * 0.62).round() as i32;
            let h = (mon.height as f64 * 0.72).round() as i32;
            (mon.x + (mon.width - w) / 2, mon.y + (mon.height - h) / 2, w, h)
        }
    }
}

/// 应用窗口形态。mode: fullscreen|window, half: full|left|right
pub fn apply_mode(app: &AppHandle, mode: &str, half: &str, screen: u32) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "找不到主窗口".to_string())?;
    let Some(hwnd) = hwnd_of(&win) else {
        return Err("拿不到窗口句柄".into());
    };
    let mon = nth_monitor(screen).ok_or_else(|| "没有可用显示器".to_string())?;
    let (x, y, w, h) = target_rect(&mon, half, mode);

    let full = mode == "fullscreen";
    let is_half = half == "left" || half == "right";
    // 全屏和半屏都必须无边框铺满（半屏时窗口就是那块竖屏，标题栏会破坏排版）
    let frameless = full || is_half;

    unsafe {
        if frameless {
            let mut style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            style &= !(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
            style |= WS_POPUP;
            SetWindowLongPtrW(hwnd, GWL_STYLE, style);
        } else {
            let mut style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            style &= !WS_POPUP;
            style |= WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
            SetWindowLongPtrW(hwnd, GWL_STYLE, style);
        }
    }

    // Tauri 侧先退出"它自己认为的"全屏，避免它随后又把窗口改回去
    let _ = win.set_fullscreen(false);
    let _ = win.set_resizable(!frameless);
    let _ = win.set_decorations(!frameless);

    unsafe {
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            x,
            y,
            w,
            h,
            SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        );
        ShowWindow(hwnd, SW_SHOW);
    }
    let _ = win.set_focus();
    Ok(())
}

/// 当前窗口位置尺寸（物理像素），用于实测验收
#[derive(Debug, Clone, Serialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub visible: bool,
}

#[link(name = "user32")]
extern "system" {
    fn GetWindowRect(hwnd: *mut c_void, rect: *mut Rect) -> i32;
}

pub fn window_rect(app: &AppHandle) -> Option<WindowRect> {
    let win = app.get_webview_window("main")?;
    let hwnd = hwnd_of(&win)?;
    let mut r = Rect::default();
    let ok = unsafe { GetWindowRect(hwnd, &mut r) };
    if ok == 0 {
        return None;
    }
    Some(WindowRect {
        x: r.left,
        y: r.top,
        width: r.right - r.left,
        height: r.bottom - r.top,
        visible: unsafe { IsWindowVisible(hwnd) } != 0,
    })
}

/// 让窗口落在某个点所在的显示器上（配置里 screen 越界时的兜底）
#[allow(dead_code)]
pub fn monitor_at_point(x: i32, y: i32) -> Option<Monitor> {
    let hmon = unsafe { MonitorFromPoint(Point { x, y }, MONITOR_DEFAULTTONEAREST) };
    if hmon.is_null() {
        return None;
    }
    let mut mi: MonitorInfoExW = unsafe { std::mem::zeroed() };
    mi.cb_size = std::mem::size_of::<MonitorInfoExW>() as u32;
    if unsafe { GetMonitorInfoW(hmon, &mut mi) } == 0 {
        return None;
    }
    Some(Monitor {
        index: 0,
        name: String::from_utf16_lossy(
            &mi.device[..mi.device.iter().position(|&c| c == 0).unwrap_or(mi.device.len())],
        ),
        x: mi.rc_monitor.left,
        y: mi.rc_monitor.top,
        width: mi.rc_monitor.right - mi.rc_monitor.left,
        height: mi.rc_monitor.bottom - mi.rc_monitor.top,
        primary: (mi.flags & 1) != 0,
    })
}
