// ============================================================================
// 单实例
//
// 用命名互斥体 + ERROR_ALREADY_EXISTS 判断：进程退出时句柄由系统自动释放，
// 不存在"程序崩了残留一把锁、之后就再也打不开"的问题。
//
// 句柄故意泄漏不关闭 —— 它必须活到进程结束，提前关掉就等于把锁放开了。
// ============================================================================

use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::Threading::CreateMutexW;

pub struct Guard {
    /// 句柄要保持存活到进程结束，所以只存不用
    _handle: *mut core::ffi::c_void,
}

// 句柄本身只是个不透明指针，跨线程传递是安全的（这里也没真的跨线程用）
unsafe impl Send for Guard {}
unsafe impl Sync for Guard {}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 抢到锁返回 Some(Guard)，已有实例在跑返回 None。
pub fn acquire() -> Option<Guard> {
    // 用 Local\ 前缀：只在本登录会话内互斥。
    // 同一台机器上不同用户各开一份是合理的，不该被拦。
    let name = wide("Local\\BigClock.SingleInstance.v1");
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };

    if handle.is_null() {
        // 建不出来（极罕见）就别拦着用户启动，宁可多开也不要打不开
        eprintln!("[bigclock] 创建互斥体失败，跳过单实例检查");
        return Some(Guard { _handle: std::ptr::null_mut() });
    }

    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return None;
    }

    Some(Guard { _handle: handle })
}
