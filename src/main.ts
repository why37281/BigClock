/* ============================================================================
   启动 / 定时器 / 事件绑定 / 设置面板
   ========================================================================== */

import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, PhysicalPosition, availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";

import {
  activePeriods,
  cloneConfig,
  defaultConfig,
  durationOf,
  humanDuration,
  normalizeTime,
  validatePeriods,
  type Config,
  type ConfigEnvelope,
  type Period,
  type Plan,
  type Theme,
} from "./config";
import { CropController } from "./crop";
import { FLOAT_DEF_H, FLOAT_DEF_W, FLOAT_MIN_H, FLOAT_MIN_W, FloatWidget } from "./float";
import { ClockFitter } from "./fit";
import { Renderer } from "./render";
import { applyNow, buildSegments, growWeights, nowMinutes, type Segment } from "./segments";
import { MinuteClock, hhmm, ss } from "./time";

/* ------------------------------------------------------------------ DOM 句柄 */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const dom = {
  settings: $("settings"),
  status: $("settings-status"),
  periods: $("periods"),
  periodsSummary: $("periods-summary"),
  saveNote: $("save-note"),
  timeOffsetNote: $("timeoffset-live"),
  cfgPath: $("cfg-path"),
  toast: $("toast"),
  cornerNote: $("corner-note"),
  btnAddPeriod: $("btn-add-period"),
  btnClose: $("btn-close"),
  btnRestore: $("btn-restore-defaults"),
  btnOpenFile: $("btn-open-file"),
  btnReload: $("btn-reload"),
  btnSettings: $("btn-settings"),
  btnEnterFs: $("btn-enter-fs"),
  btnExitFs: $("btn-exit-fs"),
  btnFloat: $("btn-float"),
  btnQuit: $("btn-quit"),
  f: {
    theme: $("f-theme") as HTMLSelectElement,
    contrast: $("f-contrast") as HTMLSelectElement,
    tint: $("f-tint") as HTMLSelectElement,
    mode: $("f-mode") as HTMLSelectElement,
    screen: $("f-screen") as HTMLSelectElement,
    clockFormat: $("f-clockfmt") as HTMLSelectElement,
    title: $("f-title") as HTMLInputElement,
    timeOffset: $("f-timeoffset") as HTMLInputElement,
    plan: $("f-plan") as HTMLSelectElement,
    planName: $("f-plan-name") as HTMLInputElement,
    barEnabled: $("f-bar-enabled") as HTMLSelectElement,
    barNames: $("f-bar-names") as HTMLSelectElement,
    barGap: $("f-bar-gap") as HTMLSelectElement,
  },
  btnPlanAdd: $("btn-plan-add") as HTMLButtonElement,
  btnPlanDel: $("btn-plan-del") as HTMLButtonElement,
};
/* ------------------------------------------------------------------ 状态 */

let cfg: Config = defaultConfig();
let cfgPath = "";
/** 语义色（当前段用青还是纯灰）：只由配置文件的 sem 字段控制，界面上不再给开关 */
const semOn = true;

/** 是否有 Tauri 后端。
 *  npm run dev 直接用浏览器打开时没有（window.__TAURI_INTERNALS__ 不存在），
 *  这时所有走 invoke 的操作必然抛 "Cannot read properties of undefined (reading 'invoke')"
 *  —— 属预期，界面上要给友好提示而不是把 TypeError 甩给用户看。
 *  打包后的程序跑在 WebView2 里，这里恒为 true。 */
const HAS_BACKEND = "__TAURI_INTERNALS__" in window;

/** invoke 类操作的报错文案：有后端时透传真实错误，纯浏览器预览时说人话 */
function backendErr(e: unknown): string {
  return HAS_BACKEND
    ? String(e)
    : "浏览器预览模式没有后端 —— 配置读写要在打包后的程序里才能用，预览中的改动不会保存";
}

/** 暗基调主题集合：控制 data-lum（时钟暗晕）与设置面板里对比度档位是否可用 */
const DARK_THEMES = new Set(["dark", "indigo", "ocean", "forest", "grape", "sunset", "rose"]);
/** tint 只对基础双主题有意义 */
const TINT_THEMES = new Set(["dark", "light"]);

let segments: Segment[] = [];
let nowIndex = -1;
let lastAppliedKey = "";

const renderer = new Renderer();
const fitter = new ClockFitter(renderer.viewEl, renderer.clockEl, renderer.headerEl);
const floaty = new FloatWidget(document);
/** 整分对齐时钟：改偏移量之后要让它重新对齐到"展示时间"的下一个整分 */
let clockRef: MinuteClock | null = null;
/** 上一次生效的偏移量（秒），用来判断要不要重新对齐 */
let lastOffset = 0;
const crop = new CropController(document, {
  getLeft: () => cfg.crop_left,
  getRight: () => cfg.crop_right,
  onLive: (l, r) => {
    // 拖线期间禁用 .view 的宽度过渡（html.crop-dragging），保证跟手
    document.documentElement.classList.add("crop-dragging");
    cfg = { ...cfg, crop_left: l, crop_right: r };
    applyCropVars(cfg);
    scheduleFit();
  },
  onCommit: () => {
    document.documentElement.classList.remove("crop-dragging");
    void persist();
  },
});

const BASE_TITLE = "BigClock";
document.title = BASE_TITLE;

/** 展示用时间 = 系统时间 + 配置偏移（秒，可正可负）。
 *  学校的挂钟/打铃不一定准，按实测偏移校准显示；日期跟着偏移后的时间走
 *  （负偏移跨过零点时日期也自动对）。所有取"现在"的地方一律走这里。 */
function nowDate(): Date {
  return new Date(Date.now() + cfg.time_offset * 1000);
}

/* ------------------------------------------------------------------ 自检
   把"前端确实跑起来了"这件事写到 document.title 上。
   做端到端验收时不用开 devtools、也不用抓控制台 —— Rust 侧读窗口标题就知道
   module 到底加载成功没有。这是排查"整块前端没跑起来"最省事的一招。 */
function markSelfcheck(stage: string, detail = ""): void {
  const tag = `${BASE_TITLE} | ${stage}${detail ? " | " + detail : ""}`;
  document.title = tag;
}

/* ------------------------------------------------------------------ 应用配置 */

/** 自定义边界写到 <html> 的内联变量上（.view 与两条竖线都用它定位） */
function applyCropVars(c: Config): void {
  const root = document.documentElement;
  root.style.setProperty("--crop-l", `${c.crop_left.toFixed(3)}%`);
  root.style.setProperty("--crop-r", `${c.crop_right.toFixed(3)}%`);
}

function applyTheme(c: Config): void {
  const root = document.documentElement;
  // 亮暗切换的"槽位"记忆：当前主题属于哪个基调，就更新哪个槽。
  // 所有主题变化（设置面板、热重载、亮暗切换本身）都经过这里，
  // 槽位永远跟着最近一次的选择走；已是同值时是空操作。
  if (DARK_THEMES.has(c.theme)) c.theme_dark = c.theme;
  else c.theme_light = c.theme;
  root.dataset.theme = c.theme;
  // 基调：彩色暗主题也有时钟暗晕；彩色亮主题没有（和 light 一致）
  root.dataset.lum = DARK_THEMES.has(c.theme) ? "dark" : "light";
  // 对比度档位只对暗色基础主题有意义
  root.dataset.pal = c.theme === "dark" ? c.contrast : "A2";
  root.dataset.tint = c.tint;
  root.dataset.sem = semOn ? "on" : "off";
  root.dataset.half = c.half;
  root.dataset.mode = c.mode;
  applyCropVars(c);
  // 窗口背景跟主题走，避免半屏切换时闪一下白；浮窗模式必须透明（圆角外要透出桌面）
  if (c.mode === "float") {
    document.body.style.backgroundColor = "transparent";
  } else {
    const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
    if (bg) document.body.style.backgroundColor = bg;
  }
}

/**
 * 重画一次。这是唯一改动界面的入口，所有变化都从这里过，
 * 保证"数据 → 界面"永远单向、不会出现两处各改一半。
 */
function repaint(force = false): void {
  const now = nowDate();
  const key = `${now.getHours()}:${now.getMinutes()}`;

  applyTheme(cfg);
  paintModeIcon(cfg.half);
  renderer.setTitle(cfg.title);
  // 秒区的显隐会改变时钟总宽 → 必须重量一次字号，否则大小对不上
  const secChanged = renderer.setShowSeconds(cfg.clock_format === "hms");
  const secChangedF = floaty.setShowSeconds(cfg.clock_format === "hms");
  renderer.setBarVisible(cfg.bar.enabled);
  renderer.setShowNames(cfg.bar.show_names);
  renderer.setDate(now);
  paintClock(now);

  // 控制条按钮与边界线的显隐跟着模式走
  syncModeButtons(cfg);
  crop.setActive(cfg.half === "custom" && cfg.mode !== "float");

  if (force || key !== lastAppliedKey) {
    lastAppliedKey = key;
    segments = buildSegments(activePeriods(cfg), cfg.bar.gap_minutes);
  }
  const res = applyNow(segments, nowMinutes(now));
  nowIndex = res.nowIndex;
  const weights = growWeights(segments, nowIndex);
  renderer.renderSegments(segments, weights);

  if (secChanged || secChangedF) scheduleFit();
}

/** 高频路径：只动时钟与进度填充，别的都不碰 */
function paintClock(now: Date): void {
  const sec = cfg.clock_format === "hms" ? ss(now) : "";
  renderer.setTime(hhmm(now), sec);
  floaty.setTime(hhmm(now), sec);
}

function tickFast(): void {
  const now = nowDate();
  paintClock(now);
  if (isOpen()) updateTimeOffsetNote();
  if (segments.length) {
    const res = applyNow(segments, nowMinutes(now));
    const weights = growWeights(segments, nowIndex);
    renderer.renderSegments(res.segments, weights);
  }
}

/* ------------------------------------------------------------------ 字号自适应 */

let fitRaf = 0;
let fitFallback = 0;
function scheduleFit(): void {
  cancelAnimationFrame(fitRaf);
  clearTimeout(fitFallback);
  const run = (): void => {
    fitRaf = 0;
    fitter.fit();
    // 浮窗时钟各写各的变量；非浮窗模式下 #float 是 display:none，
    // clientWidth 为 0，fit 会自己提前返回，这里不用判模式
    floaty.fitter.fit();
  };
  fitRaf = requestAnimationFrame(run);
  // 兜底：页面被完全遮挡时 Chromium 会暂停 rAF（visibilityState 仍是 visible），
  // 没有这层超时，字号会一直停在旧值。
  fitFallback = window.setTimeout(() => {
    if (fitRaf) {
      cancelAnimationFrame(fitRaf);
      run();
    }
  }, 200);
}

/** 改完会影响可用宽的界面之后调用：等布局稳定再量 */
async function refitAfterLayout(): Promise<void> {
  await Renderer.settled();
  fitter.invalidate();
  fitter.fit();
  floaty.fitter.invalidate();
  floaty.fitter.fit();
}

/**
 * 半屏/自定义边界切换的宽度过渡期间持续拟合字号。
 *
 * 只在切换后第 ~32ms 量一次是不够的：那时 .view 的 width 还在过渡中间，
 * 量到的可用宽偏大，算出的字号跟着偏大；宽度过渡结束后字号不再重算，
 * 时钟就会伸出显示区（直到下一分钟的整分重算才自己恢复）。
 * 这里让 fit 跟着过渡逐帧跑 —— 量宽对字号严格线性，任何中间时刻算出的
 * 目标值都精确对应当前宽度，字号与宽度同帧收敛，结束时正好到位。
 */
function trackFit(): void {
  const DUR = 420;   // --dur(320ms) + 余量
  const t0 = performance.now();
  const step = (): void => {
    fitter.fit();
    floaty.fitter.fit();
    if (performance.now() - t0 < DUR) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  // 页面被遮挡时 rAF 会停（CSS 过渡本身也停，两边冻结在一起，不冲突）；
  // 这条超时兜底保证任何情况下终态至少被量一次，恢复可见后还有
  // visibilitychange 里的 scheduleFit 再补一道。
  window.setTimeout(() => {
    fitter.fit();
    floaty.fitter.fit();
  }, 460);
}

/* ------------------------------------------------------------------ 轻提示 */

let toastTimer = 0;
function toast(msg: string, isErr = false): void {
  dom.toast.textContent = msg;
  dom.toast.classList.toggle("err", isErr);
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    dom.toast.hidden = true;
  }, isErr ? 5200 : 2600);
}

/** 角落常驻提示：配置出错之类"必须让用户看到但不能挡住界面"的信息 */
function setCornerNote(msg: string | null): void {
  dom.cornerNote.textContent = msg ?? "";
  dom.cornerNote.hidden = !msg;
}

/* ================================================================== 设置面板
   ★ 设置是【即时保存】的：改一个控件就立刻预览，350ms 后写盘。
     没有"保存 / 放弃修改"按钮，也没有"设置还没保存，确定关闭吗"的弹窗。
     以前那套草稿机制还有一个隐蔽的副作用：关面板时草稿留在 cfg 里、文件里
     还是旧值，看起来就是"时间偏移改了却没生效"。
   ★ 唯一保留确认框的是底部的「恢复默认配置」—— 它会丢掉用户自己写的作息表。 */

/** 当前编辑中的时段草稿（只服务行 DOM；权威数据始终是 cfg） */
let periodsDraft: Period[] = [];
let issuesByIndex = new Map<number, string>();
/** 即时保存的防抖定时器 */
let saveTimer = 0;
/** 是否有还没写盘的改动 */
let unsaved = false;
/** 最近一次成功写盘的配置：校验失败/写盘失败后关面板时用它把显示回滚回去 */
let lastSaved: Config | null = null;
/** 最近一次写盘失败的原因（成功后清空）。关面板时据此决定要不要回滚显示 */
let lastSaveError = "";
/** 最近一次写盘时间：轮询要避开自己刚写的那一拍 */
let lastWriteAt = 0;
/** 打开设置时的窗口形态：面板关掉后才真正应用（否则选浮窗会把面板一起缩小） */
let modeAtOpen: Config["mode"] = "fullscreen";
/** 正在关闭（关闭流程里有 await，防止连点/连按重复执行） */
let closing = false;

function isOpen(): boolean {
  return !dom.settings.hidden;
}

/** cfg 当前生效的方案（按 active_plan 匹配，失配退回第一个） */
function activePlanOf(c: Config): Plan {
  return c.plans.find((p) => p.name === c.active_plan) ?? c.plans[0];
}

/** 起一个不与现有方案重名的名字（下拉按名字索引，必须唯一） */
function uniquePlanName(c: Config, base: string): string {
  let name = base;
  let n = 2;
  while (c.plans.some((p) => p.name === name)) {
    name = `${base} ${n}`;
    n += 1;
  }
  return name;
}

/** 方案下拉的选项 + 删除按钮的可用态（只剩一套时不许删） */
function fillPlanSelect(c: Config): void {
  dom.f.plan.textContent = "";
  for (const p of c.plans) {
    const o = document.createElement("option");
    o.value = p.name;
    o.textContent = p.name;
    dom.f.plan.appendChild(o);
  }
  dom.f.plan.value = activePlanOf(c).name;
  dom.btnPlanDel.disabled = c.plans.length <= 1;
}

function openSettings(): void {
  if (isOpen()) return;
  modeAtOpen = cfg.mode;
  periodsDraft = activePlanOf(cfg).periods.map((p) => ({ ...p }));
  issuesByIndex.clear();
  dom.settings.hidden = false;
  document.body.classList.add("settings-open");
  fillForm(cfg);
  renderPeriodRows();
  setSaveNote(
    HAS_BACKEND ? "改动会即时保存" : "浏览器预览模式：改动不会写进文件",
    !HAS_BACKEND,
  );
  dom.status.textContent = !HAS_BACKEND
    ? "浏览器预览模式：配置读写不可用，改动只在本次预览里生效"
    : cfgPath
      ? ""
      : "未能确定配置文件路径";
}

/**
 * 关闭设置。
 * ★ 这里【不再】问"设置还没保存，确定关闭吗"：设置是即时保存的，
 *   关掉时最多只有一个 350ms 的防抖窗口，先把这次写完再关就行。
 * ★ 如果草稿里有校验不过的内容（根本写不进文件），关掉时把显示回滚到
 *   文件里的有效配置 —— 否则界面会一直显示一份"文件里并不存在"的配置。
 */
async function closeSettings(): Promise<void> {
  if (!isOpen() || closing) return;
  closing = true;
  try {
    await closeSettingsNow();
  } finally {
    closing = false;
  }
}

async function closeSettingsNow(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (unsaved && !hasDraftIssues()) await commitSettings();

  // 校验不过或写盘失败（文件里没有这份配置）：把显示回滚到文件里的有效配置，
  // 否则界面会一直显示一份"文件里并不存在"的配置 —— 正是"时间偏移改了却没生效"的成因。
  if ((hasDraftIssues() || lastSaveError !== "") && lastSaved) {
    const issues = validatePeriods(periodsDraft).length;
    cfg = cloneConfig(lastSaved);
    lastOffset = cfg.time_offset;
    repaint(true);
    void refitAfterLayout();
    clockRef?.resync();
    if (issues) toast(`有 ${issues} 处问题没改好，已恢复成文件里的配置`, true);
    else if (lastSaveError) toast("刚才的改动没能写进文件，已恢复成文件里的配置", true);
  }

  dom.settings.hidden = true;
  document.body.classList.remove("settings-open");
  issuesByIndex.clear();
  unsaved = false;
  lastSaveError = "";

  // 「显示模式」在面板里改了：等面板关掉之后再动窗口，
  // 不然选「浮窗」会把设置面板一起缩成 640×260。
  if (cfg.mode !== modeAtOpen) {
    await applyWindowMode(cfg);
    await refitAfterLayout();
  }
}

/** 草稿是否写不进文件（有校验问题或一段都没有） */
function hasDraftIssues(): boolean {
  return periodsDraft.length === 0 || validatePeriods(periodsDraft).length > 0;
}

function fillForm(c: Config): void {
  dom.f.theme.value = c.theme;
  dom.f.contrast.value = c.theme === "dark" ? c.contrast : "A2";
  dom.f.contrast.disabled = c.theme !== "dark";
  dom.f.tint.disabled = !TINT_THEMES.has(c.theme);
  dom.f.tint.value = c.tint;
  dom.f.mode.value = c.mode;
  dom.f.clockFormat.value = c.clock_format;
  dom.f.title.value = c.title;
  dom.f.timeOffset.value = c.time_offset ? String(c.time_offset) : "";
  fillPlanSelect(c);
  dom.f.planName.value = activePlanOf(c).name;
  dom.f.barEnabled.value = String(c.bar.enabled);
  dom.f.barNames.value = String(c.bar.show_names);
  dom.f.barGap.value = String(c.bar.gap_minutes);
  void fillScreens(c.screen);
  dom.cfgPath.textContent = cfgPath || "（未确定）";
  updateTimeOffsetNote();
}

/**
 * 显示器下拉。用 Tauri 官方的 availableMonitors()，不再自己写 Win32 枚举。
 * 拿不到（浏览器里直接开前端）就退化成"显示器 1/2"。
 */
async function fillScreens(current: number): Promise<void> {
  dom.f.screen.textContent = "";
  let list: { name: string | null; size: { width: number; height: number } }[] = [];
  try {
    list = await availableMonitors();
  } catch {
    list = [];
  }

  if (!list.length) {
    const o = document.createElement("option");
    o.value = String(current);
    o.textContent = `显示器 ${current + 1}`;
    dom.f.screen.appendChild(o);
    dom.f.screen.value = String(current);
    return;
  }

  list.forEach((m, i) => {
    const o = document.createElement("option");
    o.value = String(i);
    const label = m.name && m.name.trim() ? m.name.trim() : `显示器 ${i + 1}`;
    o.textContent = `${i + 1}. ${label} · ${m.size.width}×${m.size.height}`;
    dom.f.screen.appendChild(o);
  });
  dom.f.screen.value = String(Math.min(current, list.length - 1));
}

/** 表单 → cfg（每次控件变动都调用）。cfg 是唯一权威状态，不再有第二份草稿。 */
function readForm(): void {
  cfg.theme = dom.f.theme.value as Config["theme"];
  cfg.contrast = dom.f.contrast.value as Config["contrast"];
  cfg.tint = dom.f.tint.value as Config["tint"];
  cfg.mode = dom.f.mode.value as Config["mode"];
  cfg.screen = Number(dom.f.screen.value) || 0;
  cfg.clock_format = dom.f.clockFormat.value as Config["clock_format"];
  cfg.title = dom.f.title.value;
  // 时间偏移：空串当 0；非数字 Number() 得 NaN → || 0 兜底；允许负数和超过 60 的值
  cfg.time_offset = Math.round(Number(dom.f.timeOffset.value) || 0);
  cfg.active_plan = dom.f.plan.value || activePlanOf(cfg).name;
  cfg.bar.enabled = dom.f.barEnabled.value === "true";
  cfg.bar.show_names = dom.f.barNames.value === "true";
  cfg.bar.gap_minutes = dom.f.barGap.value === "true";
  // 当前方案的时段草稿写回所属方案（其它方案不动）
  activePlanOf(cfg).periods = periodsDraft.map((p) => ({ ...p }));
}

/** 主题/对比度/底色这几个控件的可用性跟着主题走 */
function syncFieldAvailability(): void {
  dom.f.contrast.disabled = cfg.theme !== "dark";
  dom.f.tint.disabled = !TINT_THEMES.has(cfg.theme);
}

/** 保存状态提示（底部那行小字） */
function setSaveNote(msg: string, isErr = false): void {
  dom.saveNote.textContent = msg;
  dom.saveNote.classList.toggle("err", isErr);
}

/** "19:29:53"（自检/校准用） */
function hhmmss(d: Date): string {
  return `${hhmm(d)}:${ss(d)}`;
}

/**
 * 时间偏移那一栏下方的实时读数：
 * 左边是界面正在显示的时间（已加偏移），右边是电脑自己的时间。
 * 学校挂钟不准时，拿这两个数一对就知道该填多少 —— 也能直接看出
 * "填了 +8 到底生效没有"。设置面板开着时每秒刷新。
 */
function updateTimeOffsetNote(): void {
  if (!dom.timeOffsetNote) return;
  if (!isOpen()) return;
  const shown = nowDate();
  const sys = new Date();
  const off = cfg.time_offset;
  const sign = off > 0 ? "+" : "";
  dom.timeOffsetNote.textContent =
    `当前显示 ${hhmmss(shown)} · 电脑时间 ${hhmmss(sys)}（偏移 ${sign}${off} 秒）`;
}

/* ---------------------------------------------------------- 作息表编辑行 */

function renderPeriodRows(): void {
  dom.periods.textContent = "";
  if (!periodsDraft.length) {
    const p = document.createElement("div");
    p.className = "periods-empty";
    p.textContent = "还没有时段，点下面的「添加时段」加一条。";
    dom.periods.appendChild(p);
  }

  periodsDraft.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "period-row";

    const name = document.createElement("input");
    name.type = "text";
    name.value = p.name;
    name.placeholder = "段名，例如 第一节";
    name.maxLength = 20;
    name.addEventListener("input", () => {
      periodsDraft[i].name = name.value;
      onFormChanged();
    });

    const start = document.createElement("input");
    start.type = "time";
    start.value = toTimeInput(p.start);
    start.addEventListener("input", () => {
      periodsDraft[i].start = start.value || p.start;
      onFormChanged();
    });

    const dash = document.createElement("span");
    dash.className = "dash";
    dash.textContent = "—";

    const end = document.createElement("input");
    end.type = "time";
    end.value = toTimeInput(p.end);
    end.addEventListener("input", () => {
      periodsDraft[i].end = end.value || p.end;
      onFormChanged();
    });

    const dur = document.createElement("span");
    dur.className = "dur";
    const d = durationOf(p.start, p.end);
    dur.textContent = d === null ? "—" : humanDuration(d);

    const del = document.createElement("button");
    del.className = "del";
    del.title = "删除这一段";
    del.setAttribute("aria-label", "删除这一段");
    del.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>';
    del.addEventListener("click", () => {
      periodsDraft.splice(i, 1);
      onFormChanged();
      renderPeriodRows();
    });

    row.append(name, start, dash, end, dur, del);

    const issue = issuesByIndex.get(i);
    if (issue) {
      row.classList.add("bad");
      const msg = document.createElement("div");
      msg.className = "rowmsg";
      msg.textContent = issue;
      row.appendChild(msg);
    }
    dom.periods.appendChild(row);
  });

  const total = periodsDraft.reduce((s, p) => {
    const d = durationOf(p.start, p.end);
    return s + (d ?? 0);
  }, 0);
  dom.periodsSummary.textContent = periodsDraft.length
    ? `共 ${periodsDraft.length} 段 · 合计 ${humanDuration(total)}`
    : "";
}

/** <input type="time"> 不认 "24:00"，转换一下 */
function toTimeInput(v: string): string {
  const n = normalizeTime(v);
  if (!n) return "";
  return n === "24:00" ? "23:59" : n;
}

/** 草稿变了：重算校验 + 立刻预览到界面上 + 防抖写盘（即时保存） */
function onFormChanged(): void {
  readForm();
  syncFieldAvailability();
  const issues = validatePeriods(periodsDraft);
  issuesByIndex = new Map(issues.map((x) => [x.index, x.message]));

  // 立刻预览：所见即所得（cfg 是唯一状态，readForm 已经把它改成最新）
  repaint(true);
  void refitAfterLayout();

  unsaved = true;
  scheduleSave();
  void refreshRowErrors();
  updateTimeOffsetNote();

  // 偏移量改了：整分对齐时钟是按【展示时间】对齐的，必须让它重新算下一次
  // 整分边界；否则新偏移要等到下一个系统整分才会被"整分"事件认到。
  if (cfg.time_offset !== lastOffset) {
    lastOffset = cfg.time_offset;
    clockRef?.resync();
  }
}

/** 350ms 防抖：连续敲键盘时只在停下来之后写一次文件 */
function scheduleSave(): void {
  if (!HAS_BACKEND) return;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    void commitSettings();
  }, 350);
}

/**
 * 把当前 cfg 写回配置文件（即时保存的执行体）。
 * 校验不过就【不写】—— 文件里保留上一份有效配置，界面上照常显示草稿，
 * 底部提示改成"有 N 处问题，暂未保存"。改好之后下一次自动保存会写进去。
 *
 * 连续改多个控件时可能同时有几次保存排着队，这里用一条 Promise 链串起来：
 * 后一次执行时会读到最新的 cfg，不会出现两份内容交叉写同一个文件。
 */
let saveQueued = false;
let saveChain: Promise<void> = Promise.resolve();

function commitSettings(): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (saveQueued) return saveChain; // 已排队；它执行时读到的就是最新 cfg
  saveQueued = true;
  saveChain = saveChain
    .then(async () => {
      saveQueued = false;
      await writeSettingsNow();
    })
    .catch(() => {
      saveQueued = false;
    });
  return saveChain;
}

async function writeSettingsNow(): Promise<void> {
  if (!HAS_BACKEND) {
    unsaved = false;
    setSaveNote("浏览器预览模式：改动不会写进文件", true);
    return;
  }

  const issues = validatePeriods(periodsDraft);
  if (issues.length) {
    setSaveNote(`有 ${issues.length} 处问题，暂未保存（改好就自动保存）`, true);
    return;
  }
  if (!periodsDraft.length) {
    setSaveNote("至少留一个时段，暂未保存", true);
    return;
  }

  // 归一化当前方案的时段（其它方案原样提交，后端会各自校验）
  const payload: Config = cloneConfig(cfg);
  activePlanOf(payload).periods = periodsDraft.map((p) => ({
    name: p.name.trim(),
    start: normalizeTime(p.start) ?? p.start,
    end: normalizeTime(p.end) ?? p.end,
  }));

  setSaveNote("正在保存…");
  // 写盘开始就记账：轮询要避开"正在写 / 刚写完"的这一拍，
  // 否则可能读到半截文件，被误判成"配置文件格式有误"。
  lastWriteAt = Date.now();
  try {
    const res = await invoke<ConfigEnvelope>("save_config", { config: payload });
    lastRaw = res.raw ?? lastRaw;
    lastWriteAt = Date.now();
    unsaved = false;
    lastSaveError = "";
    // 后端归一化后的配置才是权威值（主题槽位、方案重名、时间写法…）
    cfg = res.config;
    lastSaved = cloneConfig(res.config);
    const warns = res.warnings ?? [];
    setCornerNote(warns.length ? warns.join("\n") : null);
    setSaveNote(`已保存 · ${hhmmss(nowDate())}`);
    repaint(true);
    void refitAfterLayout();
  } catch (e) {
    lastSaveError = backendErr(e);
    setSaveNote(`保存失败：${lastSaveError}`, true);
    toast(lastSaveError, true);
  }
}

/**
 * 恢复默认配置（底部按钮）。
 * ★ 会丢掉用户自己写的作息方案，所以这里保留确认框；
 *   显示形态（模式 / 半屏 / 边界 / 浮窗几何）保持不动 —— 那不是"配置内容"，
 *   而且把窗口一起改掉会让人莫名其妙。
 */
function restoreDefaults(): void {
  const ok = confirm(
    "确定恢复默认配置吗？\n\n" +
      "作息方案、主题、标题、时间偏移等都会回到出厂默认值，\n" +
      "你自己添加的方案和时段会被删掉，此操作不可撤销。\n\n" +
      "（显示模式、半屏状态和浮窗位置保持不变）",
  );
  if (!ok) return;

  const keep = {
    mode: cfg.mode,
    half: cfg.half,
    screen: cfg.screen,
    crop_left: cfg.crop_left,
    crop_right: cfg.crop_right,
    float_w: cfg.float_w,
    float_h: cfg.float_h,
    float_x: cfg.float_x,
    float_y: cfg.float_y,
  };
  cfg = { ...defaultConfig(), ...keep };
  periodsDraft = activePlanOf(cfg).periods.map((p) => ({ ...p }));
  issuesByIndex.clear();
  fillForm(cfg);
  renderPeriodRows();
  repaint(true);
  void refitAfterLayout();
  unsaved = true;
  void commitSettings();
  toast("已恢复默认配置");
}

async function refreshRowErrors(): Promise<void> {
  // 重画行的报错文案（不整块重画，避免输入框失焦）
  const rows = dom.periods.querySelectorAll<HTMLElement>(".period-row");
  rows.forEach((row, i) => {
    const old = row.querySelector(".rowmsg");
    const issue = issuesByIndex.get(i);
    row.classList.toggle("bad", !!issue);
    if (issue) {
      if (old) old.textContent = issue;
      else {
        const msg = document.createElement("div");
        msg.className = "rowmsg";
        msg.textContent = issue;
        row.appendChild(msg);
      }
    } else if (old) {
      old.remove();
    }
  });
  // 时长文本也跟着更新
  const durs = dom.periods.querySelectorAll<HTMLElement>(".period-row .dur");
  durs.forEach((el, i) => {
    const p = periodsDraft[i];
    if (!p) return;
    const d = durationOf(p.start, p.end);
    el.textContent = d === null ? "—" : humanDuration(d);
  });
}

/* ================================================================== 配置来源 */

/** 记住最近一次见到的文件原文，用来判断"文件是不是被别人改了" */
let lastRaw = "";

function applyEnvelope(env: ConfigEnvelope, syncForm: boolean): void {
  cfg = env.config;
  cfgPath = env.path;
  lastRaw = env.raw ?? "";
  lastSaved = cloneConfig(env.config);
  lastOffset = env.config.time_offset;
  unsaved = false;
  lastSaveError = "";

  const warns = env.warnings ?? [];
  setCornerNote(warns.length ? warns.join("\n") : null);

  dom.cfgPath.textContent = cfgPath || "（未确定）";
  if (syncForm && isOpen()) {
    periodsDraft = activePlanOf(cfg).periods.map((p) => ({ ...p }));
    fillForm(cfg);
    renderPeriodRows();
  }

  repaint(true);
  void refitAfterLayout();
}

/* ---------------------------------------------------- 热重载：前端轮询
   为什么不放 Rust：Rust 侧要引 notify、做 500ms 防抖、还要把回调切回主线程，
   三样东西合起来几十行，还多一个依赖。前端本来每秒都在跑（心跳 250ms），
   顺手比对一次文件文本就够了，逻辑全在一处，出问题也好查。

   判定方式：拿 /raw 端点的文件原文跟自己记住的比。
   自己刚保存过的那份文本已经记进 lastRaw，所以不会自激重渲染。 */
const POLL_MS = 1000;
let polling = false;

async function pollConfigOnce(): Promise<void> {
  // 纯浏览器预览（npm run dev 直接打开）没有 Tauri 后端，
  // 轮询必然每秒失败一次 —— 别把 TypeError 常驻在角落里，静默跳过。
  if (!HAS_BACKEND) return;
  if (document.hidden || polling) return;
  // 刚写完盘的那一拍别读：read 可能发生在 write 与"记下自己写的原文"之间，
  // 否则会把自己写的内容误判成"外部修改"，白弹一次提示。
  if (Date.now() - lastWriteAt < 1500) return;
  polling = true;
  try {
    const res = await invoke<{ raw: string }>("raw_config");
    if (res.raw === lastRaw) return;              // 没变
    // 文件变了：交给后端解析（校验/归一化都在那边）
    const env = await invoke<ConfigEnvelope>("reload_config");
    // 设置界面开着时不覆盖正在编辑的内容，只在角落里提个醒
    if (isOpen()) {
      toast("配置文件已被外部修改，关闭设置后可看到最新内容");
      lastRaw = env.raw ?? lastRaw;
      return;
    }
    const prevMode = cfg.mode;
    applyEnvelope(env, false);
    // 形态字段被手改了（比如把 mode 改成 float）：窗口本身也要跟着变，
    // 否则会出现"页面是浮窗、窗口还是全屏"的错位
    if (env.config.mode !== prevMode) void applyWindowMode(env.config);
  } catch (e) {
    // 文件被改成看不懂的内容：后端会返回错误并保留上一次有效配置
    setCornerNote(String(e));
  } finally {
    polling = false;
  }
}

/**
 * 控制条上「全屏 / 退出全屏 / 浮窗」按钮的显隐。
 * 全屏与退出全屏同一时间只显示一个 —— 用户不用去记"这个图标现在按下去是进还是退"。
 * 浮窗按钮在已经是浮窗时藏起来（浮窗里有自己的按钮排）。
 */
function syncModeButtons(c: Config): void {
  const fs = c.mode === "fullscreen";
  dom.btnEnterFs.hidden = fs;
  dom.btnExitFs.hidden = !fs;
  dom.btnFloat.hidden = c.mode === "float";
}

/**
 * 应用窗口形态：全屏 / 窗口 / 浮窗。
 * 全屏与半屏（含自定义边界）由 CSS 负责，窗口始终铺满整块显示器。
 *
 * ★ 全屏必须把窗口【提到前台】。
 * 实测：只调 setFullscreen(true)，窗口会正确地铺满屏幕，但**不会获得前台焦点** ——
 * 用户在别的地方（比如浏览器、聊天窗口）时，双击 exe 后屏幕上看不到任何变化，
 * 以为程序没启动。只 setFocus() 也不够：Windows 不允许后台进程随意抢前台，
 * 这个调用会被静默忽略。
 * 可靠做法是 setAlwaysOnTop(true) 再关掉 —— 这个 API 能穿透前台的限制，
 * 是 Windows 上公认的"把窗口弄到最前"的办法。
 * 顺便：全屏展示期间保持置顶也是对的，免得被别的窗口盖住大屏时钟。
 *
 * ★ 窗口模式显式设大小：不设的话恢复的是 tauri.conf.json 里建窗时的 1280×800
 * 逻辑像素，在 4K + 高 DPI 缩放下物理尺寸非常大（这就是"窗口怎么这么大"的来源）。
 * ★ 浮窗模式：无边框 + 置顶 + 透明背景（圆角外透出桌面），大小有下限，
 * 右下角手柄缩放（JS 接管，窗口本身不再走系统边框缩放）。
 */
async function applyWindowMode(c: Config): Promise<void> {
  syncModeButtons(c);
  try {
    const win = getCurrentWindow();
    if (c.mode === "fullscreen") {
      await win.setFullscreen(true);
      await win.setBackgroundColor(bgColorOf()).catch(() => {});
      // 穿过后台限制，确保用户看得见
      await win.setAlwaysOnTop(true);
      await win.setFocus().catch(() => {});
    } else if (c.mode === "float") {
      await win.setAlwaysOnTop(true);
      await win.setDecorations(false);
      await win.setResizable(false);   // 缩放走右下角手柄（JS 接管）
      await win.setFullscreen(false);
      // 先把最小尺寸压下去，再设目标大小，避免被旧的窗口最小值夹住
      await win.setMinSize(new LogicalSize(FLOAT_MIN_W, FLOAT_MIN_H));
      const w = c.float_w > 0 ? Math.max(FLOAT_MIN_W, c.float_w) : FLOAT_DEF_W;
      const h = c.float_h > 0 ? Math.max(FLOAT_MIN_H, c.float_h) : FLOAT_DEF_H;
      await win.setSize(new LogicalSize(w, h));
      // 透明背景：圆角矩形外的部分要透出桌面（离开浮窗时再设回主题色）
      await win.setBackgroundColor("#00000000").catch(() => {});
      if (c.float_x >= 0 && c.float_y >= 0) {
        await win.setPosition(new PhysicalPosition(c.float_x, c.float_y));
      }
      await win.setFocus().catch(() => {});
    } else {
      // 窗口配置模式：允许被别的窗口盖住，方便一边改设置一边看效果
      await win.setAlwaysOnTop(false);
      await win.setFullscreen(false);
      await win.setBackgroundColor(bgColorOf()).catch(() => {});
      await win.setDecorations(true);
      await win.setResizable(true);
      await win.setMinSize(new LogicalSize(680, 440));
      await win.setSize(new LogicalSize(960, 640));
      await win.center();
      await win.setFocus().catch(() => {});
    }
  } catch (e) {
    // 用浏览器直接打开前端时会失败，不该影响显示
    console.warn("设置窗口形态失败（非 Tauri 环境属正常）：", e);
  }
}

/** 当前主题的窗口底色（浮窗以外的模式给 webview 设回不透明的主题色） */
function bgColorOf(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0D1315";
}

/** 读回浮窗几何（逻辑大小 + 物理位置），存进配置。离开浮窗/拖动缩放后调用。 */
async function saveFloatGeometry(): Promise<void> {
  try {
    const win = getCurrentWindow();
    const [size, pos, sf] = await Promise.all([win.outerSize(), win.outerPosition(), win.scaleFactor()]);
    cfg = {
      ...cfg,
      float_w: Math.max(FLOAT_MIN_W, size.width / sf),
      float_h: Math.max(FLOAT_MIN_H, size.height / sf),
      float_x: pos.x,
      float_y: pos.y,
    };
  } catch {
    // 浏览器预览里没有窗口 API
  }
}

async function bootstrap(): Promise<void> {
  try {
    const env = await invoke<ConfigEnvelope>("get_config");
    applyEnvelope(env, false);
  } catch (e) {
    // 后端没起来（比如直接用浏览器打开前端）也要能跑
    console.warn("拿不到配置，改用默认值：", e);
    applyEnvelope(
      {
        config: defaultConfig(),
        path: "",
        raw: "",
        warnings: [],
        issues: [],
      },
      false,
    );
  }
  // ★ 启动时的形态规则：
  //   · 记成"窗口配置"（F11 退出去看桌面那种临时动作）→ 一律强制回全屏，不写盘；
  //   · 记成"浮窗" → 保留。浮窗是正式的展示形态（课间放视频时还要看时间），
  //     重启后回到浮窗才是用户要的。
  //
  // 原因：F11 退出全屏是"调试时想看眼桌面"的临时动作，不该被记住。之前的表现是
  // 按 F11 退出、关掉程序，下次再开就停在一个 1280×800 的小窗口里，还得手动按一次
  // F11 —— 而课间十分钟，老师根本不知道该按哪个键。
  //
  // 所以「配置文件里的 mode」只当作"上一次运行时的状态"；这里只改内存里的 cfg，
  // 【不写盘】：文件里的旧值启动时没人看，免得每次开机都重写一遍配置文件
  // （重写会把用户手写的注释冲掉）。
  if (cfg.mode === "window") cfg = { ...cfg, mode: "fullscreen" };

  // 配置拿到手、界面按配置画好之后，再摆窗口形态，避免"先小窗后全屏"的跳动
  await applyWindowMode(cfg);
}

/* ================================================================== 控制条
   照搬 design-preview.html 的 #devbar：主题 / 显示模式 / 设置。
   显示模式是三态循环图标（整屏 → 左半屏 → 右半屏），纹理跟着变。
   注意：JS 直接改 <g id="modefill"> 的 innerHTML，和设计稿里的做法完全一致；
   所以这里按 SVGGraphicsElement 处理，不能用 HTMLElement。 */

const MODES: Config["half"][] = ["full", "left", "right", "custom"];

/** 图标里的填充块：整屏填满 / 左半填左 / 右半填右 / 自定义填中间一条 */
function paintModeIcon(half: Config["half"]): void {
  const rect =
    half === "full"
      ? '<rect class="st" x="4.2" y="6.2" width="15.6" height="11.6" rx="1.4"/>'
      : half === "left"
        ? '<rect class="st" x="4.2" y="6.2" width="7.2" height="11.6" rx="1.4"/>'
        : half === "right"
          ? '<rect class="st" x="12.6" y="6.2" width="7.2" height="11.6" rx="1.4"/>'
          : '<rect class="st" x="7.6" y="6.2" width="8.8" height="11.6" rx="1.4"/>';
  // 控制条和浮窗按钮排里各有一个图标，一起画
  document.querySelectorAll<SVGElement>(".modefill").forEach((g) => {
    g.innerHTML = rect;
  });
}

function nextMode(cur: Config["half"]): Config["half"] {
  const i = MODES.indexOf(cur);
  return MODES[(i + 1) % MODES.length];
}

/* ================================================================== 快捷键 */

async function handleKey(e: KeyboardEvent): Promise<void> {
  // 在输入框里打字时不要抢键
  const t = e.target as HTMLElement | null;
  const typing = !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");

  if (e.key === "F1") {
    e.preventDefault();
    // 浮窗里打开设置：先回到窗口模式（设置面板需要一个正常窗口装下）
    if (!isOpen() && cfg.mode === "float") await switchMode("window");
    if (isOpen()) void closeSettings();
    else openSettings();
    return;
  }
  if (e.key === "Escape") {
    if (isOpen()) {
      e.preventDefault();
      void closeSettings();
    } else if (cfg.mode === "fullscreen") {
      e.preventDefault();
      await switchMode("window");
    } else if (cfg.mode === "float") {
      e.preventDefault();
      await switchMode("fullscreen");
    }
    return;
  }
  if (typing || isOpen()) return;

  switch (e.key) {
    case "F11": {
      e.preventDefault();
      // F11 永远在全屏 ⇄ 窗口之间切；从浮窗按 F11 视为"退出去调配置"
      await switchMode(cfg.mode === "fullscreen" ? "window" : "fullscreen");
      break;
    }
    // 方向键只切"前端显示状态"，窗口始终保持全屏 ——
    // 整屏/半屏就是 .view 的宽度 + 位移，改窗口大小是多余的一层。
    case "ArrowLeft":
      e.preventDefault();
      await switchHalf("left");
      break;
    case "ArrowRight":
      e.preventDefault();
      await switchHalf("right");
      break;
    case "ArrowDown":
      e.preventDefault();
      await switchHalf("full");
      break;
    case "t":
    case "T":
      toggleTheme();
      break;
    default:
      break;
  }
}

/**
 * 切换整屏 / 左半屏 / 右半屏 / 自定义边界。
 * 只改前端的 data-half 并顺手存进配置（下次启动还是这个状态），
 * 不动窗口形态 —— 半屏就是"内容挪到那一块、其余留黑"，窗口本身不变。
 * 自定义边界作为半屏的补充：两条竖线把显示区夹出来，位置存 crop_left/right。
 */
async function switchHalf(half: Config["half"]): Promise<void> {
  if (cfg.half === half) return;
  cfg = { ...cfg, half };
  applyTheme(cfg);                 // 这里会把 data-half / --crop-* 写到 <html> 上
  crop.setActive(half === "custom" && cfg.mode !== "float");
  paintModeIcon(half);
  // 宽度过渡期间逐帧拟合字号（一次性 fit 会量到中间宽度，见 trackFit 注释）
  trackFit();
  if (isOpen()) fillForm(cfg);
  await persist();
}

/** 切换全屏展示 / 窗口配置 / 浮窗（走 Tauri 官方 API） */
async function switchMode(mode: Config["mode"]): Promise<void> {
  if (cfg.mode === mode) return;
  // 离开浮窗前把几何存下来，下次进浮窗回到原样
  if (cfg.mode === "float") await saveFloatGeometry();
  cfg = { ...cfg, mode };
  floaty.setActionsVisible(false);
  await applyWindowMode(cfg);
  applyTheme(cfg);
  crop.setActive(cfg.half === "custom" && mode !== "float");
  await refitAfterLayout();
  if (isOpen()) fillForm(cfg);
  await persist();
}

/** 存盘（切主题 / 半屏 / 形态 / 边界 / 浮窗几何这类"一改就落盘"的动作）。
 *  失败不影响当前显示，用户下次改还会再存一次。 */
async function persist(): Promise<void> {
  lastWriteAt = Date.now(); // 写之前就记账，轮询别在写入中途读文件
  try {
    const res = await invoke<ConfigEnvelope>("save_config", { config: cfg });
    lastRaw = res.raw ?? lastRaw;   // 记下自己写的这份，轮询才不会自激
    lastWriteAt = Date.now();
    lastSaved = cloneConfig(res.config);
    // 只采信后端归一化后的主题槽位之类的附带修正，窗口几何以本地为准
    // （拖动过程中 persist 可能比 setPosition 的回传还早到，别让旧值把新位置盖回去）
  } catch (e) {
    console.warn("保存配置失败：", e);
  }
}

/* ================================================================== 启动 */

/**
 * 亮暗切换：在"最近用的暗色主题"和"最近用的亮色主题"两个槽之间翻。
 * 之前是硬切 dark⇄light，会把用户选好的彩色主题顶掉；改成槽位记忆后，
 * 葡萄紫 ↔ 薄荷 这样来回翻也不会丢主题（槽位由 applyTheme 维护并持久化）。
 * 控制条 / 浮窗按钮排 / T 键共用这一个入口。
 */
function toggleTheme(): void {
  const next: Theme = DARK_THEMES.has(cfg.theme) ? cfg.theme_light : cfg.theme_dark;
  cfg = { ...cfg, theme: next };
  applyTheme(cfg);
  if (isOpen()) fillForm(cfg);
  void refitAfterLayout();
  void persist();
}

/**
 * 退出程序。全屏/浮窗没有标题栏，控制条和浮窗按钮排是仅有的可见出口。
 * 不弹确认 —— 大屏上多弹一个框反而挡界面，误触了重新双击就是。
 */
function quitApp(): void {
  // 浏览器预览里没有后端，退不了（也无所谓）
  void invoke("quit_app").catch((e) => toast(backendErr(e), true));
}

function wireSettingsUI(): void {
  dom.btnSettings.addEventListener("click", openSettings);

  // ---- 控制条：主题 ----
  $("btn-theme").addEventListener("click", toggleTheme);

  // ---- 控制条：显示模式（整屏 → 左半屏 → 右半屏 → 自定义边界 循环）----
  const btnMode = $("mode");
  btnMode.addEventListener("click", () => {
    void switchHalf(nextMode(cfg.half));
  });

  // ---- 控制条：全屏 / 退出全屏（两个按钮只显示一个，效果同 F11）----
  dom.btnEnterFs.addEventListener("click", () => void switchMode("fullscreen"));
  dom.btnExitFs.addEventListener("click", () => void switchMode("window"));

  // ---- 控制条：浮窗 ----
  dom.btnFloat.addEventListener("click", () => void switchMode("float"));

  // ---- 浮窗按钮排：主题 / 回全屏 / 设置 / 退出（不放显示模式，浮窗里不可见） ----
  floaty.setButtonHandler((b) => {
    switch (b) {
      case "theme":
        toggleTheme();
        break;
      case "fullscreen":
        void switchMode("fullscreen");
        break;
      case "settings":
        void (async () => {
          await switchMode("window");
          openSettings();
        })();
        break;
      case "quit":
        quitApp();
        break;
    }
  });
  floaty.wire();

  // ---- 控制条：退出程序 ----
  dom.btnQuit.addEventListener("click", quitApp);

  dom.btnClose.addEventListener("click", () => void closeSettings());
  dom.btnRestore.addEventListener("click", restoreDefaults);
  dom.btnAddPeriod.addEventListener("click", () => {
    readForm();
    // 新段默认接在最后一段结束时刻之后，省得用户手填
    const last = periodsDraft[periodsDraft.length - 1];
    const start = last ? (normalizeTime(last.end) ?? "19:00") : "18:40";
    const [h, m] = start.split(":").map(Number);
    const endMin = (h * 60 + m + 40) % 1440;
    const end = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
    periodsDraft.push({ name: "", start, end });
    renderPeriodRows();
    onFormChanged();
    const inputs = dom.periods.querySelectorAll<HTMLInputElement>(".period-row input[type=text]");
    inputs[inputs.length - 1]?.focus();
  });

  dom.btnOpenFile.addEventListener("click", () => {
    void invoke("reveal_config").catch((e) => toast(backendErr(e), true));
  });
  dom.btnReload.addEventListener("click", () => {
    void (async () => {
      try {
        const env = await invoke<ConfigEnvelope>("reload_config");
        applyEnvelope(env, true);
        toast("已重新读取配置文件");
      } catch (e) {
        toast(backendErr(e), true);
      }
    })();
  });

  const fields: (keyof typeof dom.f)[] = [
    "theme", "contrast", "tint", "mode", "screen",
    "clockFormat", "title", "timeOffset", "barEnabled", "barNames", "barGap",
  ];
  for (const k of fields) {
    dom.f[k].addEventListener("change", onFormChanged);
    dom.f[k].addEventListener("input", onFormChanged);
  }

  // ---- 作息方案：切换 / 改名 / 另存新方案 / 删除 ----
  // 切换方案：★ change 触发时 dom.f.plan.value 已经是新方案 —— 必须先把
  // 当前草稿存回【旧】方案再切换；直接 readForm 会把旧草稿写进新方案，
  // 表现就是"在这套方案里改的时段跑到另一套里去了"。
  dom.f.plan.addEventListener("change", () => {
    const activeName = cfg.active_plan; // 闭包里的窄化会丢，先取出来
    const prev = cfg.plans.find((p) => p.name === activeName) ?? cfg.plans[0];
    prev.periods = periodsDraft.map((p) => ({ ...p }));
    cfg.active_plan = dom.f.plan.value || activeName;
    periodsDraft = activePlanOf(cfg).periods.map((p) => ({ ...p }));
    dom.f.planName.value = activePlanOf(cfg).name;
    issuesByIndex.clear();
    renderPeriodRows();
    onFormChanged(); // 里面的 readForm 把（新方案的）草稿写回新方案，等于空写
  });

  // 改名：同步方案名与 active_plan（下拉按名字索引，必须唯一，重名自动加序号）
  dom.f.planName.addEventListener("input", () => {
    const raw = dom.f.planName.value.trim();
    if (!raw) return;
    const plan = activePlanOf(cfg);
    const oldName = plan.name;
    const others = cfg.plans.filter((p) => p !== plan);
    const name = uniquePlanName({ ...cfg, plans: others }, raw);
    plan.name = name;
    if (cfg.active_plan === oldName) cfg.active_plan = name;
    fillPlanSelect(cfg);
    onFormChanged();
  });

  // 另存新方案：以当前时段草稿为底稿复制一套（上午/晚上常常只是微调）
  dom.btnPlanAdd.addEventListener("click", () => {
    readForm();
    const name = uniquePlanName(cfg, "新方案");
    cfg.plans.push({ name, periods: periodsDraft.map((p) => ({ ...p })) });
    cfg.active_plan = name;
    fillPlanSelect(cfg);
    dom.f.planName.value = name;
    onFormChanged();
    dom.f.planName.focus();
    dom.f.planName.select();
  });

  // 删除当前方案（只剩一套时按钮是禁用的）
  dom.btnPlanDel.addEventListener("click", () => {
    if (cfg.plans.length <= 1) return;
    readForm();
    const delName = cfg.active_plan; // 闭包里的窄化会丢，先取出来
    cfg.plans = cfg.plans.filter((p) => p.name !== delName);
    cfg.active_plan = cfg.plans[0].name;
    periodsDraft = activePlanOf(cfg).periods.map((p) => ({ ...p }));
    fillPlanSelect(cfg);
    dom.f.planName.value = activePlanOf(cfg).name;
    issuesByIndex.clear();
    renderPeriodRows();
    onFormChanged();
  });

  // 点遮罩关闭
  dom.settings.addEventListener("mousedown", (e) => {
    if (e.target === dom.settings) void closeSettings();
  });
}

async function main(): Promise<void> {
  markSelfcheck("js-ok");
  wireSettingsUI();

  await bootstrap();
  // 不 await：refitAfterLayout 里等布局要跑 rAF，窗口不可见（被遮挡/后台）时
  // rAF 会被暂停，await 它会把整个启动链卡死在"半启动"状态 —— 时钟、轮询全不跑。
  // fit 本来就是尽力测量：可见之后 visibilitychange 里的 scheduleFit 会补上。
  void refitAfterLayout();
  markSelfcheck("ready", cfg.mode);

  // 整分对齐时钟；心跳只负责秒数与进度填充。
  // ★ 传入的"当前时间"是【展示时间】（系统时间 + time_offset）——
  //   这样整分事件落在展示时间的分钟边界上，偏移量不是 60 的整数倍时也不会错位。
  const clock = new MinuteClock(
    {
      onMinute: () => {
        lastAppliedKey = "";
        repaint();
        scheduleFit();
      },
      onTick: tickFast,
    },
    () => nowDate().getTime(),
  );
  clockRef = clock;
  clock.start();

  // 休眠唤醒 / 切回前台：立刻重算、重新对齐分钟边界，并补一次配置轮询
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      clock.resync();
      scheduleFit();
      void pollConfigOnce();
    }
  });

  addEventListener("resize", () => scheduleFit());
  addEventListener("keydown", (e) => void handleKey(e));
  // 大屏上不该出现右键菜单
  addEventListener("contextmenu", (e) => e.preventDefault());

  // 自定义边界模式：任意点击都把藏起来的边界线唤回来，并重新计时 3 秒
  addEventListener("pointerdown", () => {
    if (cfg.half === "custom" && cfg.mode !== "float") crop.poke();
  });

  // 浮窗几何持久化：系统拖动/缩放结束后（onMoved/onResized）防抖存一次。
  // 缩放手柄走 JS setSize，同样会触发 onResized，一条路就够。
  // 注意 getCurrentWindow() 在纯浏览器里会同步抛（没有 __TAURI_INTERNALS__），
  // 必须整体包住，否则 main() 后面的轮询/字体重算全被切断。
  try {
    let geoTimer = 0;
    const onGeo = (): void => {
      if (cfg.mode !== "float") return;
      clearTimeout(geoTimer);
      geoTimer = window.setTimeout(() => {
        void (async () => {
          await saveFloatGeometry();
          await persist();
        })();
      }, 800);
    };
    const win = getCurrentWindow();
    void win.onMoved(onGeo).catch(() => {});
    void win.onResized(onGeo).catch(() => {});
  } catch {
    // 浏览器预览没有窗口 API，几何持久化直接跳过
  }

  // 字号真正依赖字体度量，字体到了必须重量一次
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      fitter.invalidate();
      fitter.fit();
      floaty.fitter.invalidate();
      floaty.fitter.fit();
    });
  }

  // 热重载：每秒看一眼配置文件原文有没有被外部改动。
  // 比 Rust 侧引 notify + 防抖 + 跨线程回主线程简单得多，逻辑也只有这一处。
  window.setInterval(() => void pollConfigOnce(), POLL_MS);
}

void main();
