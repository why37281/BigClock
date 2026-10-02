// ============================================================================
// 配置：读 exe 同目录的 bigclock.toml + 宽松解析 + 校验 + 写回
//
// 设计原则（按需求）：
//   · 配置文件必须与 exe 同目录，必须是【纯文本、用户可编辑】
//   · 解析失败绝不白屏：保留上一次有效配置，只把错误报到角落
//   · 宽松解析：18:40 / 1840 / 全角 18：40 都认；end 允许 24:00
//   · 写回式设置界面：界面改完直接写回同一个文本文件，存盘即生效
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

// ---------------------------------------------------------------- 配置结构

fn d_theme() -> String { "dark".into() }
fn d_mode() -> String { "fullscreen".into() }
fn d_half() -> String { "full".into() }
fn d_contrast() -> String { "A2".into() }
fn d_tint() -> String { "cyan".into() }
fn d_clock_format() -> String { "hm".into() }
fn d_true() -> bool { true }
fn d_false() -> bool { false }
fn d_periods() -> Vec<Period> {
    // 按用户要求：默认只留一段 18:40–19:00，其余由用户在设置界面自己加
    vec![Period { name: "晚自习".into(), start: "18:40".into(), end: "19:00".into() }]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BarConfig {
    #[serde(default = "d_true")]
    pub enabled: bool,
    #[serde(default = "d_false")]
    pub show_names: bool,
    #[serde(default = "d_true")]
    pub gap_minutes: bool,
}

impl Default for BarConfig {
    fn default() -> Self {
        Self { enabled: true, show_names: false, gap_minutes: true }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Period {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub theme: String,
    pub mode: String,
    pub half: String,
    pub screen: u32,
    pub contrast: String,
    pub tint: String,
    pub clock_format: String,
    pub title: String,
    pub bar: BarConfig,
    pub periods: Vec<Period>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            theme: d_theme(),
            mode: d_mode(),
            half: d_half(),
            screen: 0,
            contrast: d_contrast(),
            tint: d_tint(),
            clock_format: d_clock_format(),
            title: String::new(),
            bar: BarConfig::default(),
            periods: d_periods(),
        }
    }
}

// ---------------------------------------------------------------- 时间解析

/// 宽松解析时间 → 当天分钟数。24:00 视作 1440（一天结束）。
/// 与前端 src/config.ts 的 parseTime 规则保持一致。
pub fn parse_time(raw: &str) -> Option<i64> {
    // 全角数字/冒号 → 半角
    let s: String = raw
        .chars()
        .map(|c| match c {
            '\u{FF10}'..='\u{FF19}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            '\u{FF1A}' => ':',
            _ => c,
        })
        .collect();
    let s = s.trim();
    if s.is_empty() {
        return None;
    }

    let (h, m) = if let Some((a, b)) = s.split_once(':') {
        (a.trim().parse::<i64>().ok()?, b.trim().parse::<i64>().ok()?)
    } else {
        // 纯数字：1830 / 940 / 19
        let d: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        if d.len() != s.len() || d.is_empty() || d.len() > 4 {
            return None;
        }
        if d.len() <= 2 {
            (d.parse::<i64>().ok()?, 0)
        } else {
            let p = format!("{:0>4}", d);
            (p[0..2].parse::<i64>().ok()?, p[2..4].parse::<i64>().ok()?)
        }
    };

    if !(0..=59).contains(&m) {
        return None;
    }
    if h == 24 {
        return if m == 0 { Some(1440) } else { None };
    }
    if !(0..=23).contains(&h) {
        return None;
    }
    Some(h * 60 + m)
}

fn fmt_time(min: i64) -> String {
    let m = min.rem_euclid(1440);
    format!("{:02}:{:02}", m / 60, m % 60)
}

// ---------------------------------------------------------------- 校验/归一

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    /// 对应 periods 下标；-1 表示与具体时段无关
    pub index: i64,
    pub message: String,
}

pub struct Normalized {
    pub config: Config,
    pub warnings: Vec<String>,
    pub issues: Vec<Issue>,
}

/// 归一化 + 校验。宽松：能修的自动修（时间写法、排序、空名），
/// 修不了的记成 issue 交给界面显示，但绝不让配置整体失效。
pub fn normalize(mut cfg: Config) -> Normalized {
    let mut warnings = Vec::new();
    let mut issues = Vec::new();

    // ---- 枚举值兜底（配置文件里写错不该让程序崩）----
    let fix = |v: &mut String, allowed: &[&str], def: &str, what: &str, w: &mut Vec<String>| {
        if !allowed.contains(&v.as_str()) {
            w.push(format!("{what}「{}」不认识，已改用「{def}」", v));
            *v = def.to_string();
        }
    };
    fix(&mut cfg.theme, &["dark", "light"], "dark", "主题 theme", &mut warnings);
    fix(&mut cfg.mode, &["fullscreen", "window"], "fullscreen", "显示模式 mode", &mut warnings);
    fix(&mut cfg.half, &["full", "left", "right"], "full", "半屏 half", &mut warnings);
    fix(&mut cfg.contrast, &["A", "A2", "B", "C"], "A2", "对比度 contrast", &mut warnings);
    fix(&mut cfg.tint, &["neutral", "cyan", "warm"], "cyan", "底色 tint", &mut warnings);
    fix(&mut cfg.clock_format, &["hm", "hms"], "hm", "时长格式 clock_format", &mut warnings);
    // 亮色主题没有对比度档位（那套值只对暗色有意义）
    if cfg.theme == "light" && cfg.contrast != "A2" {
        cfg.contrast = "A2".into();
    }
    if cfg.title.chars().count() > 40 {
        cfg.title = cfg.title.chars().take(40).collect();
        warnings.push("标题过长，已截断到 40 字".into());
    }

    // ---- 时段 ----
    let had_periods = !cfg.periods.is_empty();
    let mut out: Vec<Period> = Vec::new();
    let mut spans: Vec<(i64, i64)> = Vec::new();

    for (i, p) in cfg.periods.iter().enumerate() {
        let idx = i as i64;
        let name = p.name.trim().to_string();
        let a = parse_time(&p.start);
        let b = parse_time(&p.end);

        if name.is_empty() {
            issues.push(Issue { index: idx, message: "段名不能为空".into() });
        }
        let (Some(a), Some(b)) = (a, b) else {
            issues.push(Issue {
                index: idx,
                message: format!("时间看不懂：「{}」→「{}」，写成 18:40 或 1840", p.start, p.end),
            });
            continue;
        };

        let b2 = if b <= a { b + 1440 } else { b }; // 跨零点
        if b2 == a {
            issues.push(Issue { index: idx, message: "开始与结束相同，算不出时长".into() });
            continue;
        }

        out.push(Period { name, start: fmt_time(a), end: fmt_time(b2) });
        spans.push((a, b2));
        let _ = idx;
    }

    // 重叠检测（按展开后的区间）
    let mut order: Vec<usize> = (0..spans.len()).collect();
    order.sort_by_key(|&i| spans[i].0);
    for k in 1..order.len() {
        let (pi, ci) = (order[k - 1], order[k]);
        if spans[ci].0 < spans[pi].1 {
            issues.push(Issue {
                index: ci as i64,
                message: format!("与「{}」时间重叠", out.get(pi).map(|p| p.name.as_str()).unwrap_or("上一段")),
            });
        }
    }

    if out.is_empty() {
        if had_periods {
            warnings.push("作息表里没有任何可用时段，已回退到默认的 18:40–19:00".into());
        }
        out = d_periods();
    }

    cfg.periods = out;
    Normalized { config: cfg, warnings, issues }
}

// ---------------------------------------------------------------- 路径

/// 候选路径（按优先级）：
///   1. 环境变量 BIGCLOCK_CONFIG（方便测试和多实例）
///   2. exe 同目录/bigclock.toml        ← 需求：与打包后的可执行文件同目录
///   3. 工作目录/bigclock.toml
///   4. 用户配置目录/BigClock/bigclock.toml（exe 目录不可写时的兜底，例如装在 Program Files）
pub fn resolve_config_path() -> (PathBuf, bool) {
    if let Ok(p) = std::env::var("BIGCLOCK_CONFIG") {
        if !p.trim().is_empty() {
            return (PathBuf::from(p), true);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("bigclock.toml");
            if p.exists() || dir_writable(dir) {
                return (p, false);
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("bigclock.toml");
        if p.exists() || dir_writable(&cwd) {
            return (p, false);
        }
    }
    if let Some(dir) = dirs::config_dir() {
        let d = dir.join("BigClock");
        let _ = fs::create_dir_all(&d);
        return (d.join("bigclock.toml"), false);
    }
    (PathBuf::from("bigclock.toml"), false)
}

fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(".bigclock-write-test");
    match fs::write(&probe, b"") {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 默认配置文件内容。periods 段单独拼，保证空表也能正确生成。
pub fn default_config_text() -> String {
    let base = Config::default();
    let mut s = String::new();
    s.push_str("# ============================================================\n");
    s.push_str("# BigClock 配置文件\n");
    s.push_str("# 这个文件就在 BigClock.exe 旁边，可以直接用记事本改，\n");
    s.push_str("# 存盘后 1 秒内界面自动更新，不用重启。\n");
    s.push_str("# 也可以在程序里按 F1 打开设置界面改，改完会写回这个文件。\n");
    s.push_str("# ============================================================\n\n");

    s.push_str("# ---------- 显示 ----------\n");
    s.push_str("# theme   : dark（晚自习）/ light（白天开灯）\n");
    s.push_str("# mode    : fullscreen（全屏展示）/ window（窗口配置）\n");
    s.push_str("# half    : full（整屏）/ left（左半屏）/ right（右半屏）—— 黑板挡哪边选哪边\n");
    s.push_str("# screen  : 第几块显示器，0 = 主屏\n");
    s.push_str("# contrast: A | A2 | B | C —— 只对暗色主题有效，越往后越柔\n");
    s.push_str("#           A 最清晰 19.5:1 / A2 推荐 15.7:1 / B 13.9:1 / C 最柔 12.3:1\n");
    s.push_str("# tint    : neutral（中性）/ cyan（偏青，与语义色同族）/ warm（偏暖）\n");
    s.push_str("# clock_format: hm（19:29）/ hms（19:29:53）\n");
    s.push_str("# title   : 顶部标题，留空则不显示\n\n");
    s.push_str(&format!("theme        = \"{}\"\n", base.theme));
    s.push_str(&format!("mode         = \"{}\"\n", base.mode));
    s.push_str(&format!("half         = \"{}\"\n", base.half));
    s.push_str(&format!("screen       = {}\n", base.screen));
    s.push_str(&format!("contrast     = \"{}\"\n", base.contrast));
    s.push_str(&format!("tint         = \"{}\"\n", base.tint));
    s.push_str(&format!("clock_format = \"{}\"\n", base.clock_format));
    s.push_str(&format!("title        = \"{}\"\n\n", base.title));

    s.push_str("# ---------- 进度条 ----------\n");
    s.push_str("# enabled    : 是否显示进度条\n");
    s.push_str("# show_names : 是否在当前段里显示段名\n");
    s.push_str("# gap_minutes: 两个时段之间的空档是否自动补成「课间」段\n");
    s.push_str("[bar]\n");
    s.push_str(&format!("enabled     = {}\n", base.bar.enabled));
    s.push_str(&format!("show_names  = {}\n", base.bar.show_names));
    s.push_str(&format!("gap_minutes = {}\n\n", base.bar.gap_minutes));

    s.push_str("# ---------- 作息表 ----------\n");
    s.push_str("# 进度条按每段的真实时长分配宽度（长课长胶囊，课间短胶囊）。\n");
    s.push_str("# 时间写法很宽松：18:40 / 1840 / 全角 18：40 都认；\n");
    s.push_str("# 跨零点也支持，例如 start = \"23:30\", end = \"00:10\"。\n");
    s.push_str("# 空档如果开了 gap_minutes，会自动补成「课间」。\n");
    s.push_str("# 在设置界面里改完保存，这里会被自动重写（注释会丢，属正常）。\n\n");
    for p in &base.periods {
        s.push_str("[[periods]]\n");
        s.push_str(&format!("name  = \"{}\"\n", p.name));
        s.push_str(&format!("start = \"{}\"\n", p.start));
        s.push_str(&format!("end   = \"{}\"\n\n", p.end));
    }
    s
}

// ---------------------------------------------------------------- 读写

pub struct Loaded {
    pub config: Config,
    pub raw: String,
    pub warnings: Vec<String>,
    pub issues: Vec<Issue>,
    /// 本次是"文件不存在，新建了默认配置"
    pub created: bool,
}

/// 读配置。文件不存在就生成一份带注释的默认配置。
pub fn load_or_create(path: &Path) -> Result<Loaded, String> {
    if !path.exists() {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let text = default_config_text();
        fs::write(path, &text).map_err(|e| format!("写默认配置失败：{e}"))?;
        let n = normalize(Config::default());
        return Ok(Loaded {
            config: n.config,
            raw: text,
            warnings: n.warnings,
            issues: n.issues,
            created: true,
        });
    }

    let raw = fs::read_to_string(path).map_err(|e| format!("读配置失败：{e}"))?;
    let parsed: Config = toml::from_str(&raw).map_err(|e| format!("配置格式有误：{e}"))?;
    let n = normalize(parsed);
    Ok(Loaded { config: n.config, raw, warnings: n.warnings, issues: n.issues, created: false })
}

/// 写配置。先写临时文件再原子改名，避免"存盘存到一半"被读走。
/// 返回写回的文本内容（热重载要拿它做自写判定）。
pub fn save(path: &Path, cfg: &Config) -> Result<String, String> {
    let text = toml::to_string_pretty(cfg).map_err(|e| format!("序列化配置失败：{e}"))?;
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, &text).map_err(|e| format!("写临时文件失败：{e}"))?;
    match fs::rename(&tmp, path) {
        Ok(_) => {}
        Err(_) => {
            // 某些情况下（目标被占用/跨盘）改名会失败，直接覆盖写
            fs::write(path, &text).map_err(|e| format!("写配置失败：{e}"))?;
            let _ = fs::remove_file(&tmp);
        }
    }
    Ok(text)
}

// ---------------------------------------------------------------- 热重载

pub struct Watcher {
    _inner: Option<notify::RecommendedWatcher>,
}

/// 监听配置文件所在目录（监听文件本身在"编辑器原子改名"时会丢事件）。
/// 回调在【独立线程】上被调用，调用方自己负责切回主线程。
pub fn watch<F>(path: &Path, mut on_change: F) -> Watcher
where
    F: FnMut() + Send + 'static,
{
    use notify::{RecursiveMode, Watcher as _};

    let dir = match path.parent() {
        Some(d) => d.to_path_buf(),
        None => return Watcher { _inner: None },
    };

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = tx.send(());
        }
    });

    let mut watcher = match watcher {
        Ok(w) => w,
        Err(_) => return Watcher { _inner: None },
    };
    if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
        return Watcher { _inner: None };
    }

    std::thread::spawn(move || {
        // 500ms 防抖：编辑器存盘常常连续触发好几个事件
        while rx.recv().is_ok() {
            std::thread::sleep(Duration::from_millis(500));
            while rx.try_recv().is_ok() {}
            on_change();
        }
    });

    Watcher { _inner: Some(watcher) }
}
