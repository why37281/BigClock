/* ============================================================================
   配置类型 —— 必须与 Rust 侧 src-tauri/src/config.rs 保持一致。
   前端只做展示与编辑，权威校验在 Rust；这里只做"别把明显错的写出去"的兜底。
   ========================================================================== */

export type Theme =
  | "dark" | "light"          // 基础双主题（灰阶 + 对比度/底色档位）
  | "indigo" | "ocean" | "forest" | "grape" | "sunset" | "rose"   // 彩色·暗
  | "paper" | "mint";         // 彩色·亮
export type Mode = "fullscreen" | "window" | "float";
export type Half = "full" | "left" | "right" | "custom";
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

/** 一套作息方案：名字 + 完整时段表（上午自习 / 晚自习各一套，随时切换） */
export interface Plan {
  name: string;
  periods: Period[];
}

export interface Config {
  theme: Theme;
  /** 亮暗切换的两个"槽"：最近使用的暗色 / 亮色主题。切换按钮在两槽之间翻，
   *  不会把彩色主题顶掉；applyTheme 在每次主题变化时更新对应槽。 */
  theme_dark: Theme;
  theme_light: Theme;
  mode: Mode;
  half: Half;
  screen: number;
  contrast: Contrast;
  tint: Tint;
  clock_format: ClockFormat;
  title: string;
  /** 展示时间的偏移量（秒，可正可负）：学校挂钟/打铃不准时校准用 */
  time_offset: number;

  /** 自定义边界（half = "custom"）：左右各缩进视口宽的百分比 0..70 */
  crop_left: number;
  crop_right: number;
  /** 浮窗大小（逻辑像素），0 = 未存，用内置默认 */
  float_w: number;
  float_h: number;
  /** 浮窗位置（物理像素），-1 = 未存 */
  float_x: number;
  float_y: number;

  bar: BarConfig;
  /** 多套作息方案 + 当前生效的方案名（按 name 匹配） */
  plans: Plan[];
  active_plan: string;
  /** 旧版单表字段（后端只为迁移读入，前端一律用 plans） */
  periods: Period[];
}

/** 取某配置当前生效的时段表（方案名失配时退回第一个方案） */
export function activePeriods(c: Config): Period[] {
  const plan = c.plans.find((p) => p.name === c.active_plan) ?? c.plans[0];
  return plan ? plan.periods : [];
}

/** 彩色主题列表（设置面板下拉用） */
export const COLORFUL_THEMES: { value: Theme; label: string }[] = [
  { value: "indigo", label: "靛蓝" },
  { value: "ocean", label: "深海" },
  { value: "forest", label: "森林" },
  { value: "grape", label: "葡萄" },
  { value: "sunset", label: "落日" },
  { value: "rose", label: "玫瑰" },
  { value: "paper", label: "宣纸（亮）" },
  { value: "mint", label: "薄荷（亮）" },
];

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
}

/** 默认作息：按用户学校实际晚自习时间表 */
export function defaultPeriods(): Period[] {
  return [
    { name: "晚读", start: "18:30", end: "19:00" },
    { name: "第一节", start: "19:00", end: "19:40" },
    { name: "第二节", start: "19:50", end: "20:30" },
    { name: "第三节", start: "20:40", end: "21:30" },
  ];
}

/** 默认配置：一套"晚自习"方案（用户学校的实际时间表），其余由用户在设置里自己加 */
export function defaultConfig(): Config {
  return {
    theme: "dark",
    theme_dark: "dark",
    theme_light: "light",
    mode: "fullscreen",
    half: "full",
    screen: 0,
    contrast: "A2",
    tint: "cyan",
    clock_format: "hm",
    title: "",
    time_offset: 0,
    crop_left: 0,
    crop_right: 0,
    float_w: 0,
    float_h: 0,
    float_x: -1,
    float_y: -1,
    bar: { enabled: true, show_names: false, gap_minutes: true },
    plans: [{ name: "晚自习", periods: defaultPeriods() }],
    active_plan: "晚自习",
    periods: [],
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
    plans: c.plans.map((plan) => ({ name: plan.name, periods: plan.periods.map((p) => ({ ...p })) })),
    periods: [],
  };
}
