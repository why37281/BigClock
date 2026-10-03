/* ============================================================================
   配置类型 —— 必须与 Rust 侧 src-tauri/src/config.rs 保持一致。
   前端只做展示与编辑，权威校验在 Rust；这里只做"别把明显错的写出去"的兜底。
   ========================================================================== */

export type Theme = "dark" | "light";
export type Mode = "fullscreen" | "window";
export type Half = "full" | "left" | "right";
export type Contrast = "A" | "A2" | "B" | "C";
export type Tint = "neutral" | "cyan" | "warm";
export type ClockFormat = "hm" | "hms";

export interface Period {
  name: string;
  start: string; // "HH:MM"
  end: string;   // "HH:MM"，允许 "24:00"
}

export interface BarConfig {
  enabled: boolean;
  show_names: boolean;
  gap_minutes: boolean;
}

export interface Config {
  theme: Theme;
  mode: Mode;
  half: Half;
  screen: number;
  contrast: Contrast;
  tint: Tint;
  clock_format: ClockFormat;
  title: string;

  bar: BarConfig;
  periods: Period[];
}

/** 显示器信息（Rust 侧枚举出来给"显示器"下拉用）。
 *  字段必须与 Rust 的 win::Monitor 一致 —— 那边多了 x/y 也没关系，
 *  TS 只取用得到的，但要保证这里不会声明那边没有的字段。 */
export interface MonitorInfo {
  index: number;
  name: string;
  width: number;
  height: number;
  primary: boolean;
}

/** get_config / save_config / reload_config 的返回。
 *  字段必须与 Rust 侧 commands::ConfigPayload 一致。 */
export interface ConfigEnvelope {
  config: Config;
  /** 配置文件到底在哪个路径（exe 同目录） */
  path: string;
  /** 文件当前原文：前端靠它轮询比对，也靠它区分"自己刚写的" */
  raw: string;
  /** 后端归一化时的提示（例如"某字段写错已改用默认值"） */
  warnings: string[];
  /** 校验发现的问题；非空时后端拒绝保存 */
  issues: ValidationIssue[];
  /** 配置文件是这次启动新建出来的 */
  created: boolean;
}

/** 默认配置：作息表按用户要求只留一段 18:40–19:00，其余由用户在设置里自己加。 */
export function defaultConfig(): Config {
  return {
    theme: "dark",
    mode: "fullscreen",
    half: "full",
    screen: 0,
    contrast: "A2",
    tint: "cyan",
    clock_format: "hm",
    title: "",
    bar: { enabled: true, show_names: false, gap_minutes: true },
    periods: [{ name: "晚自习", start: "18:40", end: "19:00" }],
  };
}

/* ---------------------------------------------------------------- 时间解析 */

/**
 * 宽松解析时间，返回当天的分钟数（0..1440）。
 * 认识：`9:5` / `09:05` / `1830` / 全角 `18：30` / `24:00`（=1440）
 * 不认识就返回 null。
 * 注意与 Rust 侧 parse_time 的规则保持一致。
 */
export function parseTime(raw: string): number | null {
  if (typeof raw !== "string") return null;
  // 全角冒号/数字 → 半角
  const s = raw
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF1A]/g, ":")
    .trim();
  if (!s) return null;

  let h: number, m: number;
  const colon = s.match(/^(\d{1,2}):(\d{1,2})$/);
  if (colon) {
    h = Number(colon[1]);
    m = Number(colon[2]);
  } else {
    const digits = s.match(/^(\d{3,4})$/);
    if (!digits) return null;
    const d = digits[1].padStart(4, "0");
    h = Number(d.slice(0, 2));
    m = Number(d.slice(2));
  }
  if (m > 59) return null;
  if (h === 24) {
    // 只允许 24:00 表示一天结束
    return m === 0 ? 1440 : null;
  }
  if (h > 23) return null;
  return h * 60 + m;
}

/** 分钟数 → "HH:MM"（1440 会被写成 "24:00"） */
export function formatTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 把用户输入的任意写法归一化成 "HH:MM"；失败返回 null */
export function normalizeTime(raw: string): string | null {
  const v = parseTime(raw);
  if (v === null) return null;
  if (v === 1440) return "24:00";
  return formatTime(v);
}

/** 时长（分钟），跨零点按 +24h 处理 */
export function durationOf(start: string, end: string): number | null {
  const a = parseTime(start);
  let b = parseTime(end);
  if (a === null || b === null) return null;
  if (b <= a) b += 1440;
  return b - a;
}

/** 时长文本：95 → "1小时35分" */
export function humanDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}小时${m}分`;
  if (h) return `${h}小时`;
  return `${m}分`;
}

/* ------------------------------------------------------------ 前端兜底校验 */

/** 配置校验问题（索引 -1 表示与具体时段无关） */
export interface ValidationIssue {
  index: number;
  message: string;
}

/**
 * 校验作息表。这里【故意宽松】：只拦真正会让界面出错的情况，
 * 不拦"看起来不合理但能正常显示"的输入（比如只有一段、或者时段之间有空档）。
 */
export function validatePeriods(periods: Period[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const spans: { i: number; a: number; b: number }[] = [];

  periods.forEach((p, i) => {
    const name = (p.name ?? "").trim();
    if (!name) issues.push({ index: i, message: "段名不能为空" });

    const a = parseTime(p.start);
    let b = parseTime(p.end);
    if (a === null) issues.push({ index: i, message: `开始时间「${p.start}」看不懂，写成 18:40 或 1840` });
    if (b === null) issues.push({ index: i, message: `结束时间「${p.end}」看不懂，写成 19:00 或 1900` });
    if (a === null || b === null) return;

    if (b <= a) b += 1440; // 跨零点
    if (b === a + 1440) {
      issues.push({ index: i, message: "开始和结束时间相同，时长算不出来" });
      return;
    }
    spans.push({ i, a, b });
  });

  // 重叠检测（跨零点的段也按展开后的区间比）
  const sorted = [...spans].sort((x, y) => x.a - y.a);
  for (let k = 1; k < sorted.length; k++) {
    const prev = sorted[k - 1];
    const cur = sorted[k];
    if (cur.a < prev.b) {
      issues.push({
        index: cur.i,
        message: `与「${(periods[prev.i]?.name ?? "上一段").trim() || "上一段"}」时间重叠`,
      });
    }
  }
  return issues;
}

/** 深拷贝（设置面板"放弃修改"要用） */
export function cloneConfig(c: Config): Config {
  return {
    ...c,
    bar: { ...c.bar },
    periods: c.periods.map((p) => ({ ...p })),
  };
}
