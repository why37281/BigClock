// ============================================================================
// 配置：读写 exe 同目录的 bigclock.toml
//
// 【职责边界】这里只做前端做不到的事 —— 文件系统。
//   · 读文件、写文件
//   · 宽松解析时间（18:40 / 1840 / 全角 18：40 / 跨零点 / 24:00）
//   · 校验（段名空、时间看不懂、区间重叠）
//   · 解析失败时绝不让界面白屏：把错误报出去，由前端决定怎么提示
//
// 不在这里做的事（都搬前端了）：
//   · 热重载监听（notify crate + 防抖 + 跨线程切主线程）→ 前端 1 秒轮询文件文本
//   · 窗口几何、全屏、显示器枚举 → Tauri 官方 JS API
//   · 光标隐藏 → WebView2 自己会处理
// ============================================================================

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- 配置结构

fn d_theme() -> String { "dark".into() }
fn d_mode() -> String { "fullscreen".into() }
fn d_half() -> String { "full".into() }
fn d_contrast() -> String { "A2".into() }
fn d_tint() -> String { "cyan".into() }
fn d_clock_format() -> String { "hm".into() }
fn d_true() -> bool { true }
fn d_false() -> bool { false }

/// 全部主题
const THEMES: &[&str] = &[
    "dark", "light", "indigo", "ocean", "forest", "grape", "sunset", "rose", "paper", "mint",
];
/// 暗基调主题（亮暗切换槽的合法性校验用）
const DARK_THEMES: &[&str] = &["dark", "indigo", "ocean", "forest", "grape", "sunset", "rose"];
/// 亮基调主题
const LIGHT_THEMES: &[&str] = &["light", "paper", "mint"];

/// 自定义边界：左右各最多缩进 70%，且两侧合计不得超过 70%（剩余显示区 ≥ 30%）
const CROP_MAX_SIDE: f64 = 70.0;

/// 浮窗几何的兜底边界（逻辑像素）：小于最小值会被夹上来，防止"拖一下拖没了"
pub const FLOAT_MIN_W: f64 = 210.0;
pub const FLOAT_MIN_H: f64 = 90.0;

fn clamp_float_size(v: f64, min: f64, max: f64) -> f64 {
    if !v.is_finite() || v <= 0.0 {
        return 0.0; // 0 = 未设置，用内置默认
    }
    v.clamp(min, max)
}

/// 默认作息：按用户学校实际晚自习时间表
fn d_periods() -> Vec<Period> {
    vec![
        Period { name: "晚读".into(), start: "18:30".into(), end: "19:00".into() },
        Period { name: "第一节".into(), start: "19:00".into(), end: "19:40".into() },
        Period { name: "第二节".into(), start: "19:50".into(), end: "20:30".into() },
        Period { name: "第三节".into(), start: "20:40".into(), end: "21:30".into() },
    ]
}

fn d_active_plan() -> String { "晚自习".into() }

/// 一套作息方案：名字 + 完整时段表（上午自习、晚自习各一套，随时切换）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Plan {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub periods: Vec<Period>,
}

fn d_plans() -> Vec<Plan> {
    vec![Plan { name: d_active_plan(), periods: d_periods() }]
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

/// 所有字段都带默认值：配置文件里删掉某个字段不该让程序起不来
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub theme: String,
    /// 亮暗切换的两个"槽"：最近使用的暗色主题 / 亮色主题。
    /// 切换按钮在两个槽之间翻，不会把彩色主题顶掉。
    pub theme_dark: String,
    pub theme_light: String,
    pub mode: String,
    pub half: String,
    pub screen: u32,
    pub contrast: String,
    pub tint: String,
    pub clock_format: String,
    pub title: String,
    /// 展示时间的偏移量（秒，可正可负）：学校挂钟/打铃不准时校准用
    pub time_offset: i32,
    /// 多套作息方案（上午自习 / 晚自习各一套，随时切换）
    pub plans: Vec<Plan>,
    /// 当前生效的方案名
    pub active_plan: String,
    /// 旧版单表字段：只为读入旧配置文件时迁移用，保存时不再写出
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periods: Vec<Period>,
    /// 自定义边界（half = "custom" 时生效）：左右各缩进视口宽的百分比 0..70
    pub crop_left: f64,
    pub crop_right: f64,
    /// 浮窗几何。w/h 逻辑像素（0 = 未存，用内置默认）；x/y 物理像素（-1 = 未存）
    pub float_w: f64,
    pub float_h: f64,
    pub float_x: i64,
    pub float_y: i64,
    pub bar: BarConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            theme: d_theme(),
            theme_dark: "dark".into(),
            theme_light: "light".into(),
            mode: d_mode(),
            half: d_half(),
            screen: 0,
            contrast: d_contrast(),
            tint: d_tint(),
            clock_format: d_clock_format(),
            title: String::new(),
            time_offset: 0,
            plans: d_plans(),
            active_plan: d_active_plan(),
            crop_left: 0.0,
            crop_right: 0.0,
            float_w: 0.0,
            float_h: 0.0,
            float_x: -1,
            float_y: -1,
            bar: BarConfig::default(),
            periods: Vec::new(),
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
        let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.len() != s.len() || digits.is_empty() || digits.len() > 4 {
            return None;
        }
        if digits.len() <= 2 {
            (digits.parse::<i64>().ok()?, 0)
        } else {
            let p = format!("{:0>4}", digits);
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

pub fn fmt_time(min: i64) -> String {
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

    // 枚举值兜底：配置文件里写错不该让程序崩
    fn fix(v: &mut String, allowed: &[&str], def: &str, what: &str, w: &mut Vec<String>) {
        if !allowed.contains(&v.as_str()) {
            w.push(format!("{what}「{v}」不认识，已改用「{def}」"));
            *v = def.to_string();
        }
    }
    // 彩色主题：暗色系 6 个 + 亮色系 2 个。对比度约束比初版放宽
    // （实测低一些也没问题），只要别低到看不清。
    fix(&mut cfg.theme, THEMES, "dark", "主题 theme", &mut warnings);
    // 亮暗槽：只认属于自己基调的主题，写错就回默认
    fix(&mut cfg.theme_dark, THEMES, "dark", "暗色槽 theme_dark", &mut warnings);
    if !DARK_THEMES.contains(&cfg.theme_dark.as_str()) {
        cfg.theme_dark = "dark".into();
    }
    fix(&mut cfg.theme_light, THEMES, "light", "亮色槽 theme_light", &mut warnings);
    if !LIGHT_THEMES.contains(&cfg.theme_light.as_str()) {
        cfg.theme_light = "light".into();
    }
    fix(&mut cfg.mode, &["fullscreen", "window", "float"], "fullscreen", "显示模式 mode", &mut warnings);
    fix(&mut cfg.half, &["full", "left", "right", "custom"], "full", "半屏 half", &mut warnings);
    fix(&mut cfg.contrast, &["A", "A2", "B", "C"], "A2", "对比度 contrast", &mut warnings);
    fix(&mut cfg.tint, &["neutral", "cyan", "warm"], "cyan", "底色 tint", &mut warnings);
    fix(&mut cfg.clock_format, &["hm", "hms"], "hm", "时长格式 clock_format", &mut warnings);

    // 对比度档位/底色偏只对暗色主题有意义
    if cfg.theme != "dark" && cfg.contrast != "A2" {
        cfg.contrast = "A2".into();
    }
    if cfg.title.chars().count() > 40 {
        cfg.title = cfg.title.chars().take(40).collect();
        warnings.push("标题过长，已截断到 40 字".into());
    }

    // ---- 自定义边界：两侧缩进各自 0..70%，合计不超过 70%（剩余 ≥ 30%）----
    let clamp_pct = |v: f64| -> f64 {
        if !v.is_finite() || v < 0.0 {
            0.0
        } else {
            v.min(CROP_MAX_SIDE)
        }
    };
    cfg.crop_left = clamp_pct(cfg.crop_left);
    cfg.crop_right = clamp_pct(cfg.crop_right);
    let crop_sum = cfg.crop_left + cfg.crop_right;
    if crop_sum > CROP_MAX_SIDE {
        // 等比收窄两侧，保证剩余显示宽度 ≥ 30%
        if crop_sum > 0.0 {
            let scale = CROP_MAX_SIDE / crop_sum;
            cfg.crop_left *= scale;
            cfg.crop_right *= scale;
        }
        warnings.push("自定义边界太窄，已等比收窄缩进（显示区至少留 30%）".into());
    }

    // ---- 浮窗几何：w/h 逻辑像素，0 = 未存；x/y 物理像素，负数一律视为未存 ----
    cfg.float_w = clamp_float_size(cfg.float_w, FLOAT_MIN_W, 3840.0);
    cfg.float_h = clamp_float_size(cfg.float_h, FLOAT_MIN_H, 2160.0);
    if cfg.float_x < 0 || cfg.float_y < 0 {
        cfg.float_x = -1;
        cfg.float_y = -1;
    }

    // ---- 时间偏移：秒，可正可负，±一天以内 ----
    cfg.time_offset = cfg.time_offset.clamp(-86_400, 86_400);

    // ---- 旧版单表迁移：periods 非空且没有 plans → 包成一套"晚自习"方案 ----
    if cfg.plans.is_empty() && !cfg.periods.is_empty() {
        cfg.plans = vec![Plan { name: "晚自习".into(), periods: std::mem::take(&mut cfg.periods) }];
    }
    cfg.periods.clear(); // 旧字段只读不写

    // ---- 作息方案 ----
    if cfg.plans.is_empty() {
        cfg.plans = d_plans();
        warnings.push("配置里没有任何作息方案，已回退到默认".into());
    }
    // 方案名兜底：空名 → 方案N；重名 → 加序号（下拉按名字索引，必须唯一）
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (i, plan) in cfg.plans.iter_mut().enumerate() {
        let mut name = plan.name.trim().to_string();
        if name.is_empty() {
            name = format!("方案 {}", i + 1);
        }
        let mut candidate = name.clone();
        let mut n = 2;
        while seen.contains(&candidate) {
            candidate = format!("{name} {n}");
            n += 1;
        }
        seen.insert(candidate.clone());
        plan.name = candidate;
    }
    if !cfg.plans.iter().any(|p| p.name == cfg.active_plan) {
        let first = cfg.plans[0].name.clone();
        warnings.push(format!("当前方案「{}」不存在，已改用「{first}」", cfg.active_plan));
        cfg.active_plan = first;
    }

    // ---- 各方案的时段：活跃方案严格校验（issue 会拦保存，界面上能改）；
    //      非活跃方案宽松处理（坏条目直接丢，记 warning）——设置界面编辑不了
    //      非活跃方案，严格拦住会把用户锁死在保存之外 ----
    for plan in cfg.plans.iter_mut() {
        let strict = plan.name == cfg.active_plan;
        let plan_name = plan.name.clone();
        let mut out: Vec<Period> = Vec::new();
        let mut spans: Vec<(i64, i64)> = Vec::new();
        let mut dropped = 0u32;

        for (i, p) in plan.periods.iter().enumerate() {
            let idx = i as i64;
            let name = p.name.trim().to_string();
            let a = parse_time(&p.start);
            let b = parse_time(&p.end);

            // 记一条问题：活跃方案记 issue（拦保存），其余只计数
            macro_rules! report {
                ($msg:expr) => {
                    if strict {
                        issues.push(Issue { index: idx, message: $msg });
                    } else {
                        dropped += 1;
                    }
                };
            }

            if name.is_empty() {
                report!("段名不能为空".into());
            }
            let (Some(a), Some(b)) = (a, b) else {
                report!(format!("时间看不懂：「{}」→「{}」，写成 18:40 或 1840", p.start, p.end));
                continue;
            };

            let b2 = if b <= a { b + 1440 } else { b }; // 跨零点
            if b2 == a {
                report!("开始与结束相同，算不出时长".into());
                continue;
            }

            out.push(Period { name, start: fmt_time(a), end: fmt_time(b2) });
            spans.push((a, b2));
        }

        // 重叠检测（按展开后的区间），同样只对活跃方案报告
        let mut order: Vec<usize> = (0..spans.len()).collect();
        order.sort_by_key(|&i| spans[i].0);
        for k in 1..order.len() {
            let (pi, ci) = (order[k - 1], order[k]);
            if spans[ci].0 < spans[pi].1 {
                let msg = format!(
                    "与「{}」时间重叠",
                    out.get(pi).map(|p| p.name.as_str()).unwrap_or("上一段")
                );
                if strict {
                    issues.push(Issue { index: ci as i64, message: msg });
                } else {
                    dropped += 1;
                }
            }
        }

        if out.is_empty() {
            if strict {
                // 活跃方案不能是空的（进度条至少要有一段）；空了给默认，提示但不拦保存
                plan.periods = d_periods();
                warnings.push(format!("方案「{plan_name}」没有任何可用时段，已回退到默认作息"));
            }
            // 非活跃的空方案保持原样：没有可丢的条目，也不需要提示
        } else {
            plan.periods = out;
            if dropped > 0 && !strict {
                warnings.push(format!("方案「{plan_name}」有 {dropped} 处看不懂/冲突的时段，已忽略"));
            }
        }
    }
    Normalized { config: cfg, warnings, issues }
}

// ---------------------------------------------------------------- 路径

/// 配置路径，按优先级：
///   1. 环境变量 BIGCLOCK_CONFIG（方便测试与多实例）
///   2. exe 同目录/bigclock.toml        ← 需求：与打包后的可执行文件同目录
///   3. 用户配置目录/BigClock/（exe 目录不可写时兜底，例如装在 Program Files）
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
    if let Some(dir) = dirs_config_dir() {
        let d = dir.join("BigClock");
        let _ = fs::create_dir_all(&d);
        return (d.join("bigclock.toml"), false);
    }
    (PathBuf::from("bigclock.toml"), false)
}

/// 不引 dirs crate，直接问系统要 %APPDATA%（这样少一个依赖）
fn dirs_config_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join(".config")))
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

/// 默认配置文件内容（带中文注释，用户可以直接拿记事本改）。
///
/// ★ 这段文本必须能被 toml 解析成 Config。
///   历史 bug：这里曾经把 theme / mode / … / float_y 整整写了两遍（复制粘贴
///   留下的），而 TOML 不允许同一个键出现两次。于是"删掉配置文件让它重新生成"
///   反而启动报错 —— 老配置文件是旧版本用 serde 写出来的、没有重复键，所以能用；
///   一旦删掉，新生成的就是一份语法错误文件。现在的写法只有一遍键，
///   末尾的单元测试 `default_config_text_parses` 会守住这条底线。
pub fn default_config_text() -> String {
    let base = Config::default();
    let mut s = String::new();
    s.push_str("# ============================================================\n");
    s.push_str("# BigClock 配置文件\n");
    s.push_str("# 这个文件就在 BigClock.exe 旁边，可以直接用记事本改，\n");
    s.push_str("# 存盘后 1 秒内界面自动更新，不用重启。\n");
    s.push_str("# 也可以在程序里按 F1 打开设置界面改，改完会写回这个文件。\n");
    s.push_str("# 这个文件带 Windows「隐藏」属性：资源管理器里勾上「显示隐藏的项目」才看得到。\n");
    s.push_str("# ============================================================\n\n");

    s.push_str("# ---------- 显示 ----------\n");
    s.push_str("# theme   : dark（晚自习）/ light（白天开灯）/ 彩色主题：\n");
    s.push_str("#           indigo 靛蓝 / ocean 深海 / forest 森林 / grape 葡萄\n");
    s.push_str("#           sunset 落日 / rose 玫瑰 / paper 宣纸（亮）/ mint 薄荷（亮）\n");
    s.push_str("# theme_dark / theme_light : 亮暗切换的两个\"槽\"（最近用的暗色/亮色主题），\n");
    s.push_str("#           切换按钮在这两个之间翻，不会把彩色主题顶掉；程序自动维护\n");
    s.push_str("# mode    : fullscreen（全屏展示）/ window（窗口配置）/ float（浮窗·置顶小窗）\n");
    s.push_str("#           —— 只记\"上一次的形态\"：启动时 window 会强制回全屏，float 会保留\n");
    s.push_str("# half    : full（整屏）/ left（左半屏）/ right（右半屏）/ custom（自定义边界）\n");
    s.push_str("#           —— 黑板挡哪边选哪边；custom 时用 crop_left / crop_right 微调\n");
    s.push_str("#           窗口始终铺满整块屏，半屏只是把内容挪到那一半，另一半留黑\n");
    s.push_str("# screen  : 第几块显示器，0 = 主屏\n");
    s.push_str("# contrast: A | A2 | B | C —— 只对暗色主题有效，越往后越柔\n");
    s.push_str("#           A 最清晰 19.5:1 / A2 推荐 15.7:1 / B 13.9:1 / C 最柔 12.3:1\n");
    s.push_str("# tint    : neutral（中性）/ cyan（偏青，与语义色同族）/ warm（偏暖）\n");
    s.push_str("#           只对暗色 / 亮色两个基础主题有效\n");
    s.push_str("# crop_left / crop_right : 自定义边界（half = custom 时生效），\n");
    s.push_str("#           左右各缩进屏宽的百分比，0 = 不缩；两侧合计 ≤ 70\n");
    s.push_str("# float_w / float_h : 浮窗大小（逻辑像素），0 = 用默认（640×260）\n");
    s.push_str("# float_x / float_y : 浮窗位置（物理像素），-1 = 不指定\n");
    s.push_str("# clock_format: hm（19:29）/ hms（19:29:53）\n");
    s.push_str("# time_offset : 展示时间的偏移量（秒，可正可负，允许超过 ±60）\n");
    s.push_str("#           —— 学校挂钟/打铃不准时校准用，按自己学校实测的差改\n");
    s.push_str("# title   : 顶部标题，留空则不显示\n\n");
    s.push_str(&format!("theme        = \"{}\"\n", base.theme));
    s.push_str(&format!("theme_dark   = \"{}\"\n", base.theme_dark));
    s.push_str(&format!("theme_light  = \"{}\"\n", base.theme_light));
    s.push_str(&format!("mode         = \"{}\"\n", base.mode));
    s.push_str(&format!("half         = \"{}\"\n", base.half));
    s.push_str(&format!("screen       = {}\n", base.screen));
    s.push_str(&format!("contrast     = \"{}\"\n", base.contrast));
    s.push_str(&format!("tint         = \"{}\"\n", base.tint));
    s.push_str(&format!("crop_left    = {}\n", base.crop_left));
    s.push_str(&format!("crop_right   = {}\n", base.crop_right));
    s.push_str(&format!("float_w      = {}\n", base.float_w));
    s.push_str(&format!("float_h      = {}\n", base.float_h));
    s.push_str(&format!("float_x      = {}\n", base.float_x));
    s.push_str(&format!("float_y      = {}\n", base.float_y));
    s.push_str(&format!("clock_format = \"{}\"\n", base.clock_format));
    s.push_str(&format!("time_offset  = {}\n", base.time_offset));
    s.push_str(&format!("title        = \"{}\"\n\n", base.title));

    // ★ active_plan 是【顶层】键，必须写在第一个表头（[bar]）之前。
    //   TOML 里一个表头之后的所有键都归那张表，写在 [bar] 后面的
    //   active_plan 会变成 bar.active_plan —— serde 不认识就静默丢掉，
    //   于是"多套方案里当前生效的那套"永远退回默认值。
    s.push_str("# ---------- 作息方案 ----------\n");
    s.push_str("# 可以有多套方案（上午自习 / 晚自习各一套），在设置界面里随时切换。\n");
    s.push_str("# active_plan 指当前生效的方案名（按 name 匹配）。\n");
    s.push_str("# 进度条按每段的真实时长分配宽度（长课长胶囊，课间短胶囊）。\n");
    s.push_str("# 时间写法很宽松：18:40 / 1840 / 全角 18：40 都认；\n");
    s.push_str("# 跨零点也支持，例如 start = \"23:30\", end = \"00:10\"。\n");
    s.push_str("# 空档如果开了 gap_minutes，会自动补成「课间」。\n");
    s.push_str("# 在设置界面里改完保存，这个文件会被重写（注释会丢，属正常）。\n\n");
    s.push_str(&format!("active_plan = \"{}\"\n\n", base.active_plan));

    s.push_str("# ---------- 进度条 ----------\n");
    s.push_str("# enabled    : 是否显示进度条\n");
    s.push_str("# show_names : 是否在当前段里显示段名\n");
    s.push_str("# gap_minutes: 两个时段之间的空档是否自动补成「课间」段\n");
    s.push_str("[bar]\n");
    s.push_str(&format!("enabled     = {}\n", base.bar.enabled));
    s.push_str(&format!("show_names  = {}\n", base.bar.show_names));
    s.push_str(&format!("gap_minutes = {}\n\n", base.bar.gap_minutes));

    for plan in &base.plans {
        s.push_str("[[plans]]\n");
        s.push_str(&format!("name = \"{}\"\n", plan.name));
        for p in &plan.periods {
            s.push_str("\n[[plans.periods]]\n");
            s.push_str(&format!("name  = \"{}\"\n", p.name));
            s.push_str(&format!("start = \"{}\"\n", p.start));
            s.push_str(&format!("end   = \"{}\"\n", p.end));
        }
        s.push('\n');
    }
    s
}

// ---------------------------------------------------------------- 读写

pub struct Loaded {
    pub config: Config,
    pub raw: String,
    pub warnings: Vec<String>,
    pub issues: Vec<Issue>,
}

/// 读配置。文件不存在就生成一份带注释的默认配置。
pub fn load_or_create(path: &Path) -> Result<Loaded, String> {
    if !path.exists() {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        // ★ 兜底：模板万一又被写坏（重复键 / 引号不配对），也不能让用户
        //   "删掉配置文件之后反而起不来"。解析不过就退化成 serde 直接序列化的
        //   无注释版本 —— 难看，但一定能用。
        let template = default_config_text();
        let text = if toml::from_str::<Config>(&template).is_ok() {
            template
        } else {
            crate::startup_trace::log("默认配置模板无法解析，退回无注释版本");
            toml::to_string_pretty(&Config::default())
                .map_err(|e| format!("生成默认配置失败：{e}"))?
        };
        fs::write(path, text).map_err(|e| format!("写默认配置失败：{e}"))?;
    }

    // 每次启动都补一次隐藏属性：老版本留下的文件、用户自己取消隐藏的、
    // 以及恢复备份时带进来的，都会在这里被重新设成隐藏。
    hide_in_explorer(path);

    let raw = fs::read_to_string(path).map_err(|e| format!("读配置失败：{e}"))?;
    let parsed: Config = toml::from_str(&raw).map_err(|e| format!("配置格式有误：{e}"))?;
    let n = normalize(parsed);
    Ok(Loaded { config: n.config, raw, warnings: n.warnings, issues: n.issues })
}

/// 写盘串行化：前端可能同时发起两笔保存（设置面板的即时保存 + 浮窗几何），
/// 两笔 truncate+write 同一个文件如果交错，内容会拼坏。
static SAVE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 写配置。
///
/// ★ 就地覆盖【同一个文件】，不删、不新建。
///   以前的写法是写一个 bigclock.toml.tmp 再 rename 成正式文件 —— 语义上等于
///   "把旧文件删掉、换个新文件"。文件标识（File ID、创建时间）因此每次都变，
///   资源管理器按修改时间排序时它会跳到别的位置，隐藏属性、ACL 也得重新补，
///   某些同步盘/杀软会把它当成"新文件"再扫一遍。
///   现在直接 truncate + write，文件从头到尾都是同一个。
///
///   代价：写到一半断电会留下半截文件（下一次启动会报"配置格式有误"并用默认值
///   跑起来，不会白屏）。配置随时能重建，这个代价可以接受。
pub fn save(path: &Path, cfg: &Config) -> Result<(), String> {
    let text = toml::to_string_pretty(cfg).map_err(|e| format!("序列化配置失败：{e}"))?;
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }

    // 锁中毒也照写（写入本身不该因为别人的 panic 而失效）
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|e| format!("打开配置文件失败：{e}"))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("写配置失败：{e}"))?;
        f.flush().map_err(|e| format!("写配置失败：{e}"))?;
        // 拖浮窗时 onMoved 会频繁触发保存，不 sync 的话内容可能还压在系统缓存里
        f.sync_all().map_err(|e| format!("写配置失败：{e}"))?;
    }

    // 就地覆盖不会丢属性位，但用户可能手动取消过隐藏，还是补一次（幂等）
    hide_in_explorer(path);
    Ok(())
}

/// 读文件原文。与 save() 共用一把锁 —— 保存是"截断 + 写"，前端每秒轮询
/// 文件原文如果正好撞进写盘中间，会读到半截内容、被误判成"配置格式有误"。
pub fn read_text(path: &Path) -> Result<String, String> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    fs::read_to_string(path).map_err(|e| format!("读配置失败：{e}"))
}

// ---------------------------------------------------------------- 隐藏属性

/// 把配置文件设成 Windows 的「隐藏」属性：资源管理器里默认看不见，
/// 勾上「显示隐藏的文件」才看得到 —— 正是要的那个程度。
///
/// 只动属性位：不改内容、不改权限、不碰所有者。
///
/// 【每次写盘后都要调】虽然现在 save() 是就地覆盖、属性位本来就不会丢，
/// 但用户可能手动取消过隐藏，补一次是幂等的。
#[cfg(windows)]
pub fn hide_in_explorer(path: &Path) {
    use std::os::windows::ffi::OsStrExt;

    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: wide 是以 NUL 结尾的合法 UTF-16 串，指针只在调用期间使用。
    unsafe {
        let attrs = GetFileAttributesW(wide.as_ptr());
        if attrs == INVALID_FILE_ATTRIBUTES || attrs & FILE_ATTRIBUTE_HIDDEN != 0 {
            return; // 读不到（文件还没生成）或本来就是隐藏的，无需处理
        }
        let _ = SetFileAttributesW(wide.as_ptr(), attrs | FILE_ATTRIBUTE_HIDDEN);
    }
}

#[cfg(not(windows))]
pub fn hide_in_explorer(_path: &Path) {}

// 只是为了给文件加一个属性位，不值得为它引入 windows-sys
// （Cargo.toml 里"刻意保持极简"那段写明了为什么删掉它）。
// 直接声明 kernel32 的这两个函数，零依赖。
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetFileAttributesW(lp_file_name: *const u16) -> u32;
    fn SetFileAttributesW(lp_file_name: *const u16, dw_file_attributes: u32) -> i32;
}

// ---------------------------------------------------------------- 单元测试

#[cfg(test)]
mod tests {
    use super::*;

    /// ★ 守着"删掉配置文件之后反而起不来"那个 bug：
    ///   默认模板必须能被 toml 解析，而且归一化后不该有任何提示或校验问题。
    #[test]
    fn default_config_text_parses() {
        let text = default_config_text();
        let parsed: Config =
            toml::from_str(&text).expect("默认配置模板不是合法 TOML（重复键 / 语法错误）");
        let n = normalize(parsed);
        assert!(n.warnings.is_empty(), "默认配置不该产生提示：{:?}", n.warnings);
        let issues: Vec<&str> = n.issues.iter().map(|i| i.message.as_str()).collect();
        assert!(issues.is_empty(), "默认配置不该产生校验问题：{issues:?}");
        assert_eq!(n.config.active_plan, "晚自习");
        assert_eq!(n.config.plans.len(), 1);
        assert_eq!(n.config.plans[0].periods.len(), 4);
        assert_eq!(n.config.time_offset, 0);
    }

    /// ★ 守着另一个模板 bug：顶层键写到了某个表头后面。
    ///   TOML 里 [bar] 之后的所有键都归 bar 表，写在它后面的 active_plan
    ///   会变成 bar.active_plan —— serde 静默忽略，于是"当前生效的方案"
    ///   永远退回默认值（多套作息方案时表现为切换了却还是原来那套）。
    #[test]
    fn default_config_text_has_top_level_keys() {
        let doc: toml::Value = toml::from_str(&default_config_text()).expect("模板不是合法 TOML");
        for key in ["theme", "mode", "half", "time_offset", "active_plan"] {
            assert!(
                doc.get(key).is_some(),
                "顶层缺少键 {key}（是不是写到某个 [表头] 后面去了？）"
            );
        }
        let bar = doc
            .get("bar")
            .and_then(|v| v.as_table())
            .expect("缺少 [bar] 表");
        assert!(!bar.contains_key("active_plan"), "active_plan 被写进 [bar] 里了");
        assert!(
            doc.get("plans").map(|v| v.is_array()).unwrap_or(false),
            "缺少 [[plans]] 数组"
        );
    }

    /// 就地覆盖写盘：两次保存内容一致、文件里没有残留的临时文件、
    /// 写出来的东西永远能被读回来。
    #[test]
    fn save_roundtrip_in_place() {
        let dir = std::env::temp_dir().join(format!("bigclock-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("bigclock.toml");
        let cfg = normalize(Config::default()).config;

        save(&path, &cfg).expect("第一次保存失败");
        let first = fs::read_to_string(&path).expect("读不回来");
        assert!(toml::from_str::<Config>(&first).is_ok(), "写出来的不是合法 TOML");

        save(&path, &cfg).expect("第二次保存失败");
        let second = fs::read_to_string(&path).expect("读不回来");
        assert_eq!(first, second, "同一份配置连续保存两次，内容不一致");

        let leftovers: Vec<String> = fs::read_dir(&dir)
            .expect("列目录失败")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "bigclock.toml")
            .collect();
        assert!(leftovers.is_empty(), "就地保存不该留下多余文件：{leftovers:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 删掉配置文件后重新生成这条路（历史 bug 的现场）：
    /// 生成出来的文件本身必须是合法 TOML，而且能立刻被读回来。
    #[test]
    fn load_or_create_writes_parsable_default() {
        let dir = std::env::temp_dir()
            .join(format!("bigclock-test-fresh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("建临时目录失败");
        let path = dir.join("bigclock.toml");
        assert!(!path.exists(), "前置条件：配置文件不存在");

        let loaded = load_or_create(&path).expect("首次启动应该能生成并读回默认配置");
        assert_eq!(loaded.config.plans.len(), 1);
        assert_eq!(loaded.config.plans[0].periods.len(), 4);

        let text = fs::read_to_string(&path).expect("读不回来");
        assert!(text.contains("BigClock 配置文件"), "新生成的文件应该带注释");
        assert!(
            toml::from_str::<Config>(&text).is_ok(),
            "删掉配置文件后重新生成的内容必须是合法 TOML"
        );

        // 第二次读同一个文件也必须成功（不该再走"重新生成"）
        let again = load_or_create(&path).expect("第二次读配置失败");
        assert_eq!(again.config.time_offset, 0);

        let _ = fs::remove_dir_all(&dir);
    }
}
