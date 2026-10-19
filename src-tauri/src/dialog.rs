// ============================================================================
// 原生错误对话框
//
// 为什么需要它：WebView2 建不起来的时候，进程里一个窗口都没有，前端根本没跑
// 起来 —— 任何"页面内的提示"（toast / 角落提示 / 白屏文字）都显示不出来。
// 这时唯一还能用的就是系统 MessageBox。
//
// 只弹一次：启动失败路径和 panic hook 都可能触发，panic 还可能连续发生。
// 不加上这个去重，用户会被一串对话框埋掉，反而看不到真正的原因。
// ============================================================================

use std::sync::atomic::{AtomicBool, Ordering};

static SHOWN: AtomicBool = AtomicBool::new(false);

/// 弹一个阻塞式错误框。重复调用只会弹第一个，后面的直接丢弃。
pub fn fatal(title: &str, body: &str) {
    if SHOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    // 弹不出来也不该再 panic —— 对话框是最后的兜底，不能自己变成新的崩溃源
    let _ = tinyfiledialogs::message_box_ok(title, body, tinyfiledialogs::MessageBoxIcon::Error);
}
