// ============================================================================
// 前端能调的指令。全部很薄：状态在 AppState 里，窗口控制在 display.rs 里。
// ============================================================================

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::{self, Config};
use crate::display;
use crate::{hash_of, AppState, ConfigPayload};

/// 前端启动时拉一次全量状态（配置 + 文件路径 + 显示器列表 + 警告）
#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> ConfigPayload {
    state.payload()
}

/// 设置界面保存：校验 → 归一化 → 写回同目录文本文件 → 通知界面刷新
#[tauri::command]
pub fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: Config,
) -> Result<ConfigPayload, String> {
    let n = config::normalize(config);

    // 有明显错误就不写盘 —— 宁可让用户改对，也不要写进去一个坏文件
    if !n.issues.is_empty() {
        let msg = n
            .issues
            .iter()
            .map(|i| if i.index >= 0 { format!("第 {} 段：{}", i.index + 1, i.message) } else { i.message.clone() })
            .collect::<Vec<_>>()
            .join("；");
        return Err(msg);
    }

    let text = config::save(&state.path, &n.config)?;

    *state.config.lock().unwrap() = n.config.clone();
    *state.last_hash.lock().unwrap() = hash_of(&text);
    *state.warnings.lock().unwrap() = n.warnings;
    *state.issues.lock().unwrap() = n.issues;

    // 显示形态相关的变化立刻生效
    display::apply_mode(&app, &n.config.mode, &n.config.half, n.config.screen)?;

    let payload = state.payload();
    let _ = app.emit("config-changed", payload.clone());
    Ok(payload)
}

/// 外部改了文件之后手动重新读一遍
#[tauri::command]
pub fn reload_config(app: AppHandle, state: State<'_, AppState>) -> Result<ConfigPayload, String> {
    let text = std::fs::read_to_string(&state.path).map_err(|e| format!("读配置失败：{e}"))?;
    let parsed: Config = toml::from_str(&text).map_err(|e| format!("配置格式有误：{e}"))?;
    let n = config::normalize(parsed);

    *state.config.lock().unwrap() = n.config.clone();
    *state.last_hash.lock().unwrap() = hash_of(&text);
    *state.warnings.lock().unwrap() = n.warnings;
    *state.issues.lock().unwrap() = n.issues;

    let payload = state.payload();
    let _ = app.emit("config-changed", payload.clone());
    Ok(payload)
}

#[tauri::command]
pub fn list_monitors() -> Vec<crate::win::Monitor> {
    display::list_monitors()
}

/// 改显示形态（整屏 / 左半屏 / 右半屏 / 窗口）
#[tauri::command]
pub fn apply_display(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
    half: String,
    screen: u32,
) -> Result<(), String> {
    // 快捷键直接改形态时，也要把配置同步过去，免得两边不一致
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.mode = mode.clone();
        cfg.half = half.clone();
        cfg.screen = screen;
    }
    display::apply_mode(&app, &mode, &half, screen)
}

/// 键盘快捷键用：只切"整屏 ⇄ 窗口"，全屏时按 Esc 也走这里
#[tauri::command]
pub fn set_fullscreen(app: AppHandle, state: State<'_, AppState>, on: bool) -> Result<(), String> {
    let (mode, half, screen) = {
        let cfg = state.config.lock().unwrap();
        (cfg.mode.clone(), cfg.half.clone(), cfg.screen)
    };
    let mode = if on { "fullscreen" } else { "window" }.to_string();
    let half = if on { half } else { "full".to_string() };
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.mode = mode.clone();
        cfg.half = half.clone();
    }
    display::apply_mode(&app, &mode, &half, screen)
}

/// 窗口当前物理矩形 —— 实测验收用（自动化脚本读它来核对半屏定位）
#[tauri::command]
pub fn window_rect(app: AppHandle) -> Option<display::WindowRect> {
    display::window_rect(&app)
}

/// 设置界面开着时别藏光标；关掉就恢复自动隐藏
#[tauri::command]
pub fn set_cursor_hidden(state: State<'_, AppState>, enabled: bool) {
    state.cursor_hide_enabled.store(enabled, Ordering::Relaxed);
    if !enabled {
        state.cursor.show();
    }
}

/// 打开配置文件所在文件夹（并在可能的情况下选中它）
#[tauri::command]
pub fn reveal_config(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = state.path.clone();
    if !path.exists() {
        return Err(format!("配置文件不存在：{}", path.display()));
    }
    // 优先用资源管理器选中该文件；失败就退化成打开所在目录
    if cfg!(windows) {
        let sel = std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn();
        if sel.is_ok() {
            return Ok(());
        }
    }
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or(path);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 退出程序（快捷键用）
#[tauri::command]
pub fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    state.cursor.show();
    app.exit(0);
}
