// ============================================================================
// 前端可调的指令 —— 只有"前端做不到的事"才在这里
//
//   配置文件读写（前端碰不到 exe 同目录的文件系统）
//   打开配置文件所在文件夹
//   退出程序
//
// 不在这里的（都搬前端了）：
//   全屏/窗口形态 / 显示器枚举 → Tauri 官方 JS API
//   热重载                    → 前端轮询配置文件文本
//   光标隐藏                  → WebView2 自己会处理
// ============================================================================

use tauri::{AppHandle, State};

use crate::config::{self, Config, Issue};
use crate::AppState;

/// 推给前端的配置包：配置本身 + 它存在哪个文件里 + 提示与校验问题
#[derive(Clone, serde::Serialize)]
pub struct ConfigPayload {
    pub config: Config,
    pub path: String,
    /// 配置文件里读到/写出的原始文本，前端靠它做轮询比对与自写判定
    pub raw: String,
    pub warnings: Vec<String>,
    pub issues: Vec<Issue>,
    /// 配置文件是这次启动新建出来的
    pub created: bool,
}

/// 前端启动时拉一次
#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> ConfigPayload {
    let cfg = state.config.lock().unwrap().clone();
    ConfigPayload {
        config: cfg,
        path: state.path.to_string_lossy().to_string(),
        raw: state.raw.lock().unwrap().clone(),
        warnings: state.warnings.lock().unwrap().clone(),
        issues: state.issues.lock().unwrap().clone(),
        created: state.created,
    }
}

/// 设置界面保存：校验 → 归一化 → 写回同目录文本文件
#[tauri::command]
pub fn save_config(state: State<'_, AppState>, config: Config) -> Result<ConfigPayload, String> {
    let n = config::normalize(config);

    // 有明显错误就不写盘 —— 宁可让用户改对，也不要写进去一个坏文件
    if !n.issues.is_empty() {
        let msg = n
            .issues
            .iter()
            .map(|i| {
                if i.index >= 0 {
                    format!("第 {} 段：{}", i.index + 1, i.message)
                } else {
                    i.message.clone()
                }
            })
            .collect::<Vec<_>>()
            .join("；");
        return Err(msg);
    }

    config::save(&state.path, &n.config)?;
    let raw = std::fs::read_to_string(&state.path).unwrap_or_default();

    *state.config.lock().unwrap() = n.config.clone();
    *state.raw.lock().unwrap() = raw.clone();
    *state.warnings.lock().unwrap() = n.warnings.clone();
    *state.issues.lock().unwrap() = n.issues.clone();

    Ok(ConfigPayload {
        config: n.config,
        path: state.path.to_string_lossy().to_string(),
        raw,
        warnings: n.warnings,
        issues: n.issues,
        created: false,
    })
}

/// 只读回配置文件的原文。前端每秒轮询它来判断"文件被外部改了吗" ——
/// 比读整个配置包轻，也避免每次轮询都触发一次解析。
#[tauri::command]
pub fn raw_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(&state.path).map_err(|e| format!("读配置失败：{e}"))?;
    Ok(serde_json::json!({ "raw": text }))
}

/// 前端看到文件变了（轮询发现文本不同）之后调它，拿到解析结果
#[tauri::command]
pub fn reload_config(state: State<'_, AppState>) -> Result<ConfigPayload, String> {
    let raw = std::fs::read_to_string(&state.path).map_err(|e| format!("读配置失败：{e}"))?;

    match toml::from_str::<Config>(&raw) {
        Ok(parsed) => {
            let n = config::normalize(parsed);
            *state.config.lock().unwrap() = n.config.clone();
            *state.raw.lock().unwrap() = raw.clone();
            *state.warnings.lock().unwrap() = n.warnings.clone();
            *state.issues.lock().unwrap() = n.issues.clone();
            Ok(ConfigPayload {
                config: n.config,
                path: state.path.to_string_lossy().to_string(),
                raw,
                warnings: n.warnings,
                issues: n.issues,
                created: false,
            })
        }
        Err(e) => {
            // 解析失败：保留上一次有效配置，只把错误报给前端
            let msg = format!("配置文件格式有误，仍在使用上一次的有效配置：{e}");
            *state.warnings.lock().unwrap() = vec![msg.clone()];
            Err(msg)
        }
    }
}

/// 打开配置文件所在文件夹（并尽量选中它）
#[tauri::command]
pub fn reveal_config(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let path = state.path.clone();
    if !path.exists() {
        return Err(format!("配置文件不存在：{}", path.display()));
    }
    if cfg!(windows) {
        // 优先用资源管理器选中该文件
        if std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or(path);
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 退出程序
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 自检回传（仅调试用）。
/// webview 那边没法直接把 eval 的返回值交出来，所以让它 invoke 这个命令，
/// 把 window.__selfcheck 之类的内容存进状态，再用 /selfcheck 读出来。
/// 这是排查"前端整块没跑起来"的关键手段：能区分"module 没加载"与"抛异常"。
#[tauri::command]
pub fn selfcheck_report(state: State<'_, AppState>, data: serde_json::Value) {
    *state.selfcheck.lock().unwrap() = data;
}
