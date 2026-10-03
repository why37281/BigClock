// ============================================================================
// 一层很薄的 Win32 封装 —— 全部走 windows-sys 官方绑定，不手写 extern 声明。
//
// 为什么坚持用官方绑定而不是自己写 `extern "system"`：
//   手写声明看着省事，但矩形/句柄这些结构体一旦和系统 ABI 有一点出入，
//   编译器不一定报错，而是在运行时悄悄读到垃圾数据 —— 这类 bug 极难查。
//   windows-sys 的 RECT / POINT / HWND 与真实的 Win32 完全同构，不用赌。
//
// 窗口句柄从 tauri 那边拿会引入 `windows` 与 `windows-sys` 两个 crate 的类型
// 互相转换问题（HWND 到底是 *mut c_void 还是 NonNull<c_void>，各版本还不一样）。
// 这里干脆绕开：按【进程号】枚举本进程的顶层窗口自己找，类型全程统一。
// ============================================================================

use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongPtrW, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
    SetWindowLongPtrW, SetWindowPos, ShowWindow,
};

// ---- SetWindowPos 的 flags ----
pub const SWP_NOZORDER: u32 = 0x0004;
pub const SWP_FRAMECHANGED: u32 = 0x0020;
pub const SWP_SHOWWINDOW: u32 = 0x0040;

// ---- 窗口样式 ----
const GWL_STYLE: i32 = -16;
const WS_CAPTION: isize = 0x00C0_0000;
const WS_THICKFRAME: isize = 0x0004_0000;
const WS_MINIMIZEBOX: isize = 0x0002_0000;
const WS_MAXIMIZEBOX: isize = 0x0001_0000;
const WS_SYSMENU: isize = 0x0008_0000;
const WS_POPUP: isize = 0x8000_0000u32 as i32 as isize;
const SW_SHOW: i32 = 5;

/// 一个显示器的信息（坐标尺寸都是【物理像素】）
#[derive(Debug, Clone, serde::Serialize)]
pub struct Monitor {
    pub index: u32,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

/// 窗口当前矩形（物理像素）
#[derive(Debug, Clone, serde::Serialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub visible: bool,
}

// ============================================================ 显示器

struct MonitorCollector {
    list: Vec<Monitor>,
}

extern "system" fn monitor_cb(
    hmon: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> i32 {
    // SAFETY: data 是 monitor_cb 的唯一调用方传进来的 &mut MonitorCollector，
    // 且 EnumDisplayMonitors 是同步调用，回调期间这个引用一直有效。
    let collector = unsafe { &mut *(data as *mut MonitorCollector) };

    let mut info: MONITORINFOEXW = unsafe { std::mem::zeroed() };
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;

    if unsafe { GetMonitorInfoW(hmon, &mut info) } != 0 {
        let device = &info.szDevice;
        let len = device.iter().position(|&c| c == 0).unwrap_or(device.len());
        let name = String::from_utf16_lossy(&device[..len]);
        let rc = info.monitorInfo.rcMonitor;
        collector.list.push(Monitor {
            index: 0, // 排完序再编号
            name: if name.is_empty() { "显示器".to_string() } else { name },
            x: rc.left,
            y: rc.top,
            width: rc.right - rc.left,
            height: rc.bottom - rc.top,
            primary: (info.monitorInfo.dwFlags & 1) != 0, // MONITORINFOF_PRIMARY
        });
    }
    1 // 继续枚举
}

/// 枚举所有显示器。排序后下标即配置里的 `screen`：主屏优先，其余按 x 排。
pub fn list_monitors() -> Vec<Monitor> {
    let mut collector = MonitorCollector { list: Vec::new() };
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(monitor_cb),
            &mut collector as *mut MonitorCollector as LPARAM,
        );
    }
    let mut list = collector.list;
    list.sort_by_key(|m| (!m.primary, m.x));
    for (i, m) in list.iter_mut().enumerate() {
        m.index = i as u32;
    }
    if list.is_empty() {
        // 理论上不会发生，但宁可给一个兜底也不要让上层拿到空列表
        list.push(Monitor {
            index: 0,
            name: "主显示器".into(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            primary: true,
        });
    }
    list
}

// ============================================================ 找窗口

struct WindowCollector {
    pid: u32,
    handles: Vec<HWND>,
}

extern "system" fn enum_windows_cb(hwnd: HWND, data: LPARAM) -> i32 {
    // SAFETY: 同 monitor_cb，data 指向调用期间一直有效的 WindowCollector。
    let collector = unsafe { &mut *(data as *mut WindowCollector) };
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    if pid == collector.pid {
        collector.handles.push(hwnd);
    }
    1
}

/// 找出本进程的顶层窗口句柄。
/// 优先返回可见的那个（WebView2 可能在本进程里再建辅助窗口，不可见的要跳过）。
pub fn find_main_window() -> Option<HWND> {
    let mut collector = WindowCollector { pid: std::process::id(), handles: Vec::new() };
    unsafe {
        EnumWindows(
            Some(enum_windows_cb),
            &mut collector as *mut WindowCollector as LPARAM,
        );
    }
    let handles = collector.handles;
    handles
        .iter()
        .copied()
        .find(|&h| unsafe { IsWindowVisible(h) } != 0)
        .or_else(|| handles.first().copied())
}

// ============================================================ 窗口操作

/// 按窗口矩形设置位置尺寸（物理像素）
pub fn set_window_rect(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
    unsafe {
        SetWindowPos(hwnd, std::ptr::null_mut(), x, y, w, h, SWP_NOZORDER | SWP_SHOWWINDOW);
    }
}

/// 切换无边框（全屏/半屏用）与常规带标题栏窗口。
/// 改完样式要再 SetWindowPos 一次并带 SWP_FRAMECHANGED，否则边框不会立刻生效。
pub fn set_frameless(hwnd: HWND, frameless: bool) {
    unsafe {
        let mut style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if frameless {
            style &= !(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU);
            style |= WS_POPUP;
        } else {
            style &= !WS_POPUP;
            style |= WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
        }
        SetWindowLongPtrW(hwnd, GWL_STYLE, style);
        // 触发一次非客户区重算
        let r = window_rect(hwnd).unwrap_or(WindowRect { x: 0, y: 0, width: 0, height: 0, visible: true });
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            r.x,
            r.y,
            r.width.max(1),
            r.height.max(1),
            SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
        );
        ShowWindow(hwnd, SW_SHOW);
    }
}

/// 窗口当前矩形
pub fn window_rect(hwnd: HWND) -> Option<WindowRect> {
    let mut r: RECT = unsafe { std::mem::zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut r) } == 0 {
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
