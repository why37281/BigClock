// ============================================================================
// 调试自省通道 —— 仅当设置了环境变量 BIGCLOCK_DEBUG_PORT 时才启动
//
// 用途：端到端验收脚本要能【确定性地】问"你现在生效的配置是什么""文件里
// 那段文本是什么""窗口是不是全屏"。光看窗口截图没法判断热重载有没有真的生效。
// 这里开一个只监听 127.0.0.1 的极简只读 HTTP 服务，把状态以 JSON 吐出来。
//
// 默认完全不启动：不设那个环境变量时这套代码一行都不跑，端口也不存在，
// 所以它不会成为普通用户机器上的攻击面。
// ============================================================================

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

use tauri::{AppHandle, Manager};

use crate::AppState;

/// 如果环境变量给了端口就启动，返回是否启动
pub fn maybe_start(app: AppHandle) -> bool {
    let Some(port) = std::env::var("BIGCLOCK_DEBUG_PORT")
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
    else {
        return false;
    };

    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[bigclock] 调试端口 {port} 绑定失败：{e}");
            return false;
        }
    };
    eprintln!("[bigclock] 调试自省端口已开启：http://127.0.0.1:{port}/");

    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            std::thread::spawn(move || handle(stream, app));
        }
    });
    true
}

fn handle(mut stream: TcpStream, app: AppHandle) {
    let mut buf = [0u8; 2048];
    let n = stream.read(&mut buf).unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let path = req
        .split_whitespace()
        .nth(1)
        .unwrap_or("/")
        .split('?')
        .next()
        .unwrap_or("/")
        .to_string();

    let body = match path.as_str() {
        "/state" => state_json(&app),
        "/config" => {
            let st = app.state::<AppState>();
            let cfg = st.config.lock().unwrap().clone();
            serde_json::to_string(&cfg).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
        }
        // 当前生效的配置 + 文件原文。验收脚本靠 raw 判断"我写进去的东西
        // 有没有被程序读进来并归一化"。
        "/raw" => {
            let st = app.state::<AppState>();
            serde_json::json!({ "raw": st.raw.lock().unwrap().clone() }).to_string()
        }
        // 窗口是不是全屏 —— 现在窗口只分全屏/窗口，半屏由前端 CSS 负责
        "/window" => match app.get_webview_window("main") {
            Some(w) => serde_json::json!({
                "fullscreen": w.is_fullscreen().unwrap_or(false),
                "maximized": w.is_maximized().unwrap_or(false),
                "visible": w.is_visible().unwrap_or(false),
                "size": w.outer_size().ok().map(|s| serde_json::json!({"w": s.width, "h": s.height})),
                "position": w.outer_position().ok().map(|p| serde_json::json!({"x": p.x, "y": p.y})),
            })
            .to_string(),
            None => "null".to_string(),
        },
        "/monitors" => match app.get_webview_window("main") {
            Some(w) => {
                let ms: Vec<serde_json::Value> = w
                    .available_monitors()
                    .unwrap_or_default()
                    .iter()
                    .enumerate()
                    .map(|(i, m)| {
                        serde_json::json!({
                            "index": i,
                            "name": m.name().map(|s| s.to_string()).unwrap_or_default(),
                            "width": m.size().width,
                            "height": m.size().height,
                            "x": m.position().x,
                            "y": m.position().y,
                            "scale": m.scale_factor(),
                        })
                    })
                    .collect();
                serde_json::to_string(&ms).unwrap_or_else(|_| "[]".into())
            }
            None => "[]".to_string(),
        },
        // 页面自检：让 webview 把 window.__selfcheck 与关键 DOM 状态回传。
        // 用 eval 的返回值 + 异步回调通道（Tauri 的 eval 本身不回传返回值，
        // 得靠 window.__TAURI_INTERNALS__.invoke 把结果送回来）。
        // 排查"前端整块没跑起来"就靠它区分"module 没加载"和"代码抛异常"。
        "/page" => match app.get_webview_window("main") {
            Some(w) => {
                let script = r#"
                  (function(){
                    var info = {
                      url: location.href,
                      readyState: document.readyState,
                      selfcheck: (window.__selfcheck || []),
                      hasTauri: !!window.__TAURI_INTERNALS__,
                      hasInvoke: !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke),
                      clockHTML: (document.getElementById('clock')||{}).innerHTML || null,
                      scriptSrcs: [].map.call(document.querySelectorAll('script'), function(s){return s.src;}),
                      linkHrefs: [].map.call(document.querySelectorAll('link'), function(l){return l.href;})
                    };
                    try {
                      window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
                        event: '__selfcheck_report', payload: info
                      });
                    } catch (e) {
                      return 'emit failed: ' + e.message;
                    }
                    return 'reported';
                  })()
                "#;
                match w.eval(script) {
                    Ok(_) => "{\"eval\":\"ok\"}".to_string(),
                    Err(e) => serde_json::json!({ "eval_error": e.to_string() }).to_string(),
                }
            }
            None => "null".to_string(),
        },
        // ★ 真正的诊断入口。
        // 注意 Windows 上 eval() 是【不回传返回值】的（Tauri 文档明确说 exception
        // 会被忽略），所以之前几种"靠 eval 拿结果"的做法全都拿不到东西。
        // 这里用 eval_with_callback：结果序列化成 JSON 通过回调送回，
        // 再用 channel 同步取出来。一次就能看清：
        //   · webview 到底停在哪个 URL
        //   · 内联自检脚本收集到了什么错误（含资源加载失败）
        //   · 页面里实际引用了哪些 script/link
        "/why" => match app.get_webview_window("main") {
            Some(w) => {
                let url = w.url().map(|u| u.to_string()).unwrap_or_else(|e| format!("<err {e}>"));
                let (tx, rx) = std::sync::mpsc::channel::<String>();
                let script = r#"
                  (function(){
                    try {
                      var info = {
                        href: location.href,
                        origin: location.origin,
                        readyState: document.readyState,
                        selfcheck: (window.__selfcheck || []),
                        hasTauri: !!window.__TAURI_INTERNALS__,
                        hasInvoke: !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke),
                        clockHTML: (document.getElementById('clock') || {}).innerHTML || null,
                        scriptSrcs: [].map.call(document.querySelectorAll('script[src]'), function(s){ return s.src; }),
                        linkHrefs: [].map.call(document.querySelectorAll('link[href]'), function(l){ return l.href; })
                      };
                      return JSON.stringify(info);
                    } catch (e) {
                      return JSON.stringify({ selfError: String(e) });
                    }
                  })()
                "#;
                let sent = tx.clone();
                let eval_ok = w
                    .eval_with_callback(script, move |result| {
                        let _ = sent.send(result);
                    })
                    .is_ok();
                if !eval_ok {
                    serde_json::json!({ "url": url, "eval_error": "eval_with_callback failed" })
                        .to_string()
                } else {
                    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
                        Ok(r) => serde_json::json!({ "url": url, "report": r }).to_string(),
                        Err(_) => serde_json::json!({ "url": url, "report": "<timeout>" }).to_string(),
                    }
                }
            }
            None => "null".to_string(),
        },
        "/selfcheck" => {
            let st = app.state::<AppState>();
            let v = st.selfcheck.lock().unwrap().clone();
            serde_json::to_string(&v).unwrap_or_else(|_| "null".into())
        }
        _ => "{\"endpoints\":[\"/state\",\"/config\",\"/raw\",\"/window\",\"/monitors\",\"/page\"]}"
            .to_string(),
    };

    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

fn state_json(app: &AppHandle) -> String {
    let st = app.state::<AppState>();
    let cfg = st.config.lock().unwrap().clone();
    let fullscreen = app
        .get_webview_window("main")
        .and_then(|w| w.is_fullscreen().ok())
        .unwrap_or(false);
    // 页面把自检结果写在 document.title 上（前端若跑起来会改它）
    let page_title = app
        .get_webview_window("main")
        .and_then(|w| w.title().ok())
        .unwrap_or_default();
    serde_json::json!({
        "config_path": st.path.to_string_lossy(),
        "pid": std::process::id(),
        "created": st.created,
        "fullscreen": fullscreen,
        "page_title": page_title,
        "raw_len": st.raw.lock().unwrap().len(),
        "config": cfg,
        "warnings": st.warnings.lock().unwrap().clone(),
        "issues": st.issues.lock().unwrap().clone(),
    })
    .to_string()
}
