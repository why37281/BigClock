/* ============================================================================
   启动 / 定时器 / 事件绑定 / 设置面板
   ========================================================================== */

import { invoke } from "@tauri-apps/api/core";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";

import {
  cloneConfig,
  defaultConfig,
  durationOf,
  humanDuration,
  normalizeTime,
  validatePeriods,
  type Config,
  type ConfigEnvelope,
  type Period,
} from "./config";
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
  dirty: $("dirty-hint"),
  cfgPath: $("cfg-path"),
  toast: $("toast"),
  cornerNote: $("corner-note"),
  btnAddPeriod: $("btn-add-period"),
  btnSave: $("btn-save") as HTMLButtonElement,
  btnClose: $("btn-close"),
  btnRevert: $("btn-revert"),
  btnOpenFile: $("btn-open-file"),
  btnReload: $("btn-reload"),
  btnSettings: $("btn-settings"),
  f: {
    theme: $("f-theme") as HTMLSelectElement,
    contrast: $("f-contrast") as HTMLSelectElement,
    tint: $("f-tint") as HTMLSelectElement,
    mode: $("f-mode") as HTMLSelectElement,
    screen: $("f-screen") as HTMLSelectElement,
    clockFormat: $("f-clockfmt") as HTMLSelectElement,
    title: $("f-title") as HTMLInputElement,
    barEnabled: $("f-bar-enabled") as HTMLSelectElement,
    barNames: $("f-bar-names") as HTMLSelectElement,
    barGap: $("f-bar-gap") as HTMLSelectElement,
  },
};
/* ------------------------------------------------------------------ 状态 */

let cfg: Config = defaultConfig();
let cfgPath = "";
/** 语义色（当前段用青还是纯灰）：只由配置文件的 sem 字段控制，界面上不再给开关 */
const semOn = true;

let segments: Segment[] = [];
let nowIndex = -1;
let lastAppliedKey = "";

const renderer = new Renderer();
const fitter = new ClockFitter(renderer.viewEl, renderer.clockEl, renderer.headerEl);

const BASE_TITLE = "BigClock";
document.title = BASE_TITLE;

/* ------------------------------------------------------------------ 自检
   把"前端确实跑起来了"这件事写到 document.title 上。
   做端到端验收时不用开 devtools、也不用抓控制台 —— Rust 侧读窗口标题就知道
   module 到底加载成功没有。这是排查"整块前端没跑起来"最省事的一招。 */
function markSelfcheck(stage: string, detail = ""): void {
  const tag = `${BASE_TITLE} | ${stage}${detail ? " | " + detail : ""}`;
  document.title = tag;
}

/* ------------------------------------------------------------------ 应用配置 */

function applyTheme(c: Config): void {
  const root = document.documentElement;
  root.dataset.theme = c.theme;
  // 亮色主题没有对比度档位（那套灰阶只对暗色有意义）
  root.dataset.pal = c.theme === "light" ? "A2" : c.contrast;
  root.dataset.tint = c.tint;
  root.dataset.sem = semOn ? "on" : "off";
  root.dataset.half = c.half;
  // 窗口背景跟着主题走，避免半屏切换时闪一下白
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (bg) document.body.style.backgroundColor = bg;
}

/**
 * 重画一次。这是唯一改动界面的入口，所有变化都从这里过，
 * 保证"数据 → 界面"永远单向、不会出现两处各改一半。
 */
function repaint(force = false): void {
  const now = new Date();
  const key = `${now.getHours()}:${now.getMinutes()}`;

  applyTheme(cfg);
  paintModeIcon(cfg.half);
  renderer.setTitle(cfg.title);
  // 秒区的显隐会改变时钟总宽 → 必须重量一次字号，否则大小对不上
  const secChanged = renderer.setShowSeconds(cfg.clock_format === "hms");
  renderer.setBarVisible(cfg.bar.enabled);
  renderer.setShowNames(cfg.bar.show_names);
  renderer.setDate(now);
  paintClock(now);

  if (force || key !== lastAppliedKey) {
    lastAppliedKey = key;
    segments = buildSegments(cfg.periods, cfg.bar.gap_minutes);
  }
  const res = applyNow(segments, nowMinutes(now));
  nowIndex = res.nowIndex;
  const weights = growWeights(segments, nowIndex);
  renderer.renderSegments(segments, weights);

  if (secChanged) scheduleFit();
}

/** 高频路径：只动时钟与进度填充，别的都不碰 */
function paintClock(now: Date): void {
  renderer.setTime(hhmm(now), cfg.clock_format === "hms" ? ss(now) : "");
}

function tickFast(): void {
  const now = new Date();
  paintClock(now);
  if (segments.length) {
    const res = applyNow(segments, nowMinutes(now));
    const weights = growWeights(segments, nowIndex);
    renderer.renderSegments(res.segments, weights);
  }
}

/* ------------------------------------------------------------------ 字号自适应 */

let fitRaf = 0;
function scheduleFit(): void {
  cancelAnimationFrame(fitRaf);
  fitRaf = requestAnimationFrame(() => fitter.fit());
}

/** 改完会影响可用宽的界面之后调用：等布局稳定再量 */
async function refitAfterLayout(): Promise<void> {
  await Renderer.settled();
  fitter.invalidate();
  fitter.fit();
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

/* ================================================================== 设置面板 */

let editing: Config | null = null;
let periodsDraft: Period[] = [];
let issuesByIndex = new Map<number, string>();

function isOpen(): boolean {
  return !dom.settings.hidden;
}

function openSettings(): void {
  if (isOpen()) return;
  editing = cloneConfig(cfg);
  periodsDraft = editing.periods.map((p) => ({ ...p }));
  fillForm(editing);
  dom.settings.hidden = false;
  document.body.classList.add("settings-open");
  renderPeriodRows();
  markDirty(false);
  dom.status.textContent = cfgPath ? "" : "未能确定配置文件路径";
}

function closeSettings(force = false): void {
  if (!isOpen()) return;
  if (!force && isDirty()) {
    if (!confirm("设置还没保存，确定关闭吗？")) return;
  }
  dom.settings.hidden = true;
  document.body.classList.remove("settings-open");
  editing = null;
  issuesByIndex.clear();
}

function fillForm(c: Config): void {
  dom.f.theme.value = c.theme;
  dom.f.contrast.value = c.theme === "light" ? "A2" : c.contrast;
  dom.f.contrast.disabled = c.theme === "light";
  dom.f.tint.value = c.tint;
  dom.f.mode.value = c.mode;
  dom.f.clockFormat.value = c.clock_format;
  dom.f.title.value = c.title;
  dom.f.barEnabled.value = String(c.bar.enabled);
  dom.f.barNames.value = String(c.bar.show_names);
  dom.f.barGap.value = String(c.bar.gap_minutes);
  void fillScreens(c.screen);
  dom.cfgPath.textContent = cfgPath || "（未确定）";
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

/** 表单 → editing（每次控件变动都调用） */
function readForm(): void {
  if (!editing) return;
  editing.theme = dom.f.theme.value as Config["theme"];
  editing.contrast = dom.f.contrast.value as Config["contrast"];
  editing.tint = dom.f.tint.value as Config["tint"];
  editing.mode = dom.f.mode.value as Config["mode"];
  editing.screen = Number(dom.f.screen.value) || 0;
  editing.clock_format = dom.f.clockFormat.value as Config["clock_format"];
  editing.title = dom.f.title.value;
  editing.bar.enabled = dom.f.barEnabled.value === "true";
  editing.bar.show_names = dom.f.barNames.value === "true";
  editing.bar.gap_minutes = dom.f.barGap.value === "true";
  editing.periods = periodsDraft.map((p) => ({ ...p }));
}

function isDirty(): boolean {
  if (!editing) return false;
  readForm();
  return JSON.stringify(editing) !== JSON.stringify(cfg);
}

function markDirty(dirty: boolean): void {
  dom.btnSave.disabled = !dirty;
  dom.dirty.textContent = dirty ? "有未保存的修改" : "已是最新";
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
      refreshDraft();
    });

    const start = document.createElement("input");
    start.type = "time";
    start.value = toTimeInput(p.start);
    start.addEventListener("input", () => {
      periodsDraft[i].start = start.value || p.start;
      refreshDraft();
    });

    const dash = document.createElement("span");
    dash.className = "dash";
    dash.textContent = "—";

    const end = document.createElement("input");
    end.type = "time";
    end.value = toTimeInput(p.end);
    end.addEventListener("input", () => {
      periodsDraft[i].end = end.value || p.end;
      refreshDraft();
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
      refreshDraft();
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

/** 草稿变了：重算校验 + 立刻预览到界面上 */
function refreshDraft(): void {
  readForm();
  const issues = validatePeriods(periodsDraft);
  issuesByIndex = new Map(issues.map((x) => [x.index, x.message]));

  // 立刻预览：把草稿套用到展示层，所见即所得
  if (editing) {
    const preview = cloneConfig(editing);
    preview.periods = periodsDraft.map((p) => ({ ...p }));
    cfg = preview;
    repaint(true);
    void refitAfterLayout();
  }

  markDirty(true);
  void refreshRowErrors();
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

/* ---------------------------------------------------------- 保存 / 放弃 */

async function saveSettings(): Promise<void> {
  if (!editing) return;
  readForm();

  const issues = validatePeriods(periodsDraft);
  if (issues.length) {
    issuesByIndex = new Map(issues.map((x) => [x.index, x.message]));
    await refreshRowErrors();
    toast(`作息表有 ${issues.length} 处问题，先改好再保存`, true);
    return;
  }
  if (!periodsDraft.length) {
    toast("至少留一个时段", true);
    return;
  }

  const payload: Config = cloneConfig(editing);
  payload.periods = periodsDraft.map((p) => ({
    name: p.name.trim(),
    start: normalizeTime(p.start) ?? p.start,
    end: normalizeTime(p.end) ?? p.end,
  }));

  dom.btnSave.disabled = true;
  try {
    const res = await invoke<ConfigEnvelope>("save_config", { config: payload });
    applyEnvelope(res, false);
    toast("已保存到配置文件");
    markDirty(false);
    dom.settings.hidden = true;
    document.body.classList.remove("settings-open");
    editing = null;
    await refitAfterLayout();
  } catch (e) {
    toast(String(e), true);
    dom.btnSave.disabled = false;
  }
}

function revertSettings(): void {
  editing = cloneConfig(cfg);
  periodsDraft = editing.periods.map((p) => ({ ...p }));
  issuesByIndex.clear();
  fillForm(editing);
  renderPeriodRows();
  repaint(true);
  markDirty(false);
  void refitAfterLayout();
}

/* ================================================================== 配置来源 */

/** 记住最近一次见到的文件原文，用来判断"文件是不是被别人改了" */
let lastRaw = "";

function applyEnvelope(env: ConfigEnvelope, syncForm: boolean): void {
  cfg = env.config;
  cfgPath = env.path;
  lastRaw = env.raw ?? "";

  const warns = env.warnings ?? [];
  setCornerNote(warns.length ? warns.join("\n") : null);

  dom.cfgPath.textContent = cfgPath || "（未确定）";
  if (syncForm && isOpen()) fillForm(cfg);

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
  if (document.hidden || polling) return;
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
    applyEnvelope(env, false);
  } catch (e) {
    // 文件被改成看不懂的内容：后端会返回错误并保留上一次有效配置
    setCornerNote(String(e));
  } finally {
    polling = false;
  }
}

/**
 * 应用窗口形态。窗口只有全屏/窗口两种，全屏/半屏由 CSS 负责。
 *
 * ★ 关键是必须把窗口【提到前台】。
 * 实测：只调 setFullscreen(true)，窗口会正确地铺满屏幕，但**不会获得前台焦点** ——
 * 用户在别的地方（比如浏览器、聊天窗口）时，双击 exe 后屏幕上看不到任何变化，
 * 以为程序没启动。只 setFocus() 也不够：Windows 不允许后台进程随意抢前台，
 * 这个调用会被静默忽略。
 * 可靠做法是 setAlwaysOnTop(true) 再关掉 —— 这个 API 能穿透前台的限制，
 * 是 Windows 上公认的"把窗口弄到最前"的办法。
 * 顺便：全屏展示期间保持置顶也是对的，免得被别的窗口盖住大屏时钟。
 */
async function applyWindowMode(c: Config): Promise<void> {
  try {
    const win = getCurrentWindow();
    if (c.mode === "fullscreen") {
      await win.setFullscreen(true);
      // 穿过后台限制，确保用户看得见
      await win.setAlwaysOnTop(true);
      await win.setFocus().catch(() => {});
    } else {
      // 窗口配置模式：允许被别的窗口盖住，方便一边改设置一边看效果
      await win.setAlwaysOnTop(false);
      await win.setFullscreen(false);
      await win.setDecorations(true);
      await win.setResizable(true);
      await win.center();
      await win.setFocus().catch(() => {});
    }
  } catch (e) {
    // 用浏览器直接打开前端时会失败，不该影响显示
    console.warn("设置窗口形态失败（非 Tauri 环境属正常）：", e);
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
  // 配置拿到手、界面按配置画好之后，再摆窗口形态，避免"先小窗后全屏"的跳动
  await applyWindowMode(cfg);
}

/* ================================================================== 控制条
   照搬 design-preview.html 的 #devbar：主题 / 显示模式 / 设置。
   显示模式是三态循环图标（整屏 → 左半屏 → 右半屏），纹理跟着变。
   注意：JS 直接改 <g id="modefill"> 的 innerHTML，和设计稿里的做法完全一致；
   所以这里按 SVGGraphicsElement 处理，不能用 HTMLElement。 */

const MODES: Config["half"][] = ["full", "left", "right"];

/** 图标里的填充块：整屏填满 / 左半填左 / 右半填右 */
function paintModeIcon(half: Config["half"]): void {
  const g = document.getElementById("modefill");
  if (!g) return;
  const rect =
    half === "full"
      ? '<rect class="st" x="4.2" y="6.2" width="15.6" height="11.6" rx="1.4"/>'
      : half === "left"
        ? '<rect class="st" x="4.2" y="6.2" width="7.2" height="11.6" rx="1.4"/>'
        : '<rect class="st" x="12.6" y="6.2" width="7.2" height="11.6" rx="1.4"/>';
  g.innerHTML = rect;
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
    isOpen() ? closeSettings() : openSettings();
    return;
  }
  if (e.key === "Escape") {
    if (isOpen()) {
      e.preventDefault();
      closeSettings();
    } else if (cfg.mode === "fullscreen") {
      e.preventDefault();
      await switchMode("window");
    }
    return;
  }
  if (typing || isOpen()) return;

  switch (e.key) {
    case "F11": {
      e.preventDefault();
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
    case "T": {
      const next = cfg.theme === "dark" ? "light" : "dark";
      cfg = { ...cfg, theme: next };
      applyTheme(cfg);
      void refitAfterLayout();
      void invoke("save_config", { config: { ...cfg, periods: cfg.periods } }).catch(() => {});
      break;
    }
    default:
      break;
  }
}

/**
 * 切换整屏 / 左半屏 / 右半屏。
 * 只改前端的 data-half 并顺手存进配置（下次启动还是这个状态），
 * 不动窗口本身 —— 窗口一直全屏铺满，半屏就是"内容挪到那一半、另一半留黑"。
 * 这也是 design-preview.html 里已经验证过的做法。
 */
async function switchHalf(half: Config["half"]): Promise<void> {
  if (cfg.half === half) return;
  cfg = { ...cfg, half, mode: "fullscreen" };
  applyTheme(cfg);                 // 这里会把 data-half 写到 <html> 上
  await refitAfterLayout();        // 容器宽变了，字号必须重算
  if (isOpen()) fillForm(cfg);
  await persist();
}

/** 切换全屏展示 / 窗口配置（走 Tauri 官方 API） */
async function switchMode(mode: Config["mode"]): Promise<void> {
  if (cfg.mode === mode) return;
  cfg = { ...cfg, mode };
  await applyWindowMode(cfg);
  if (isOpen()) fillForm(cfg);
  await persist();
}

/** 存盘。失败不影响当前显示，用户下次改还会再存一次。 */
async function persist(): Promise<void> {
  try {
    const res = await invoke<ConfigEnvelope>("save_config", { config: cfg });
    lastRaw = res.raw ?? lastRaw;   // 记下自己写的这份，轮询才不会自激
  } catch (e) {
    console.warn("保存配置失败：", e);
  }
}

/* ================================================================== 启动 */

function wireSettingsUI(): void {
  dom.btnSettings.addEventListener("click", openSettings);

  // ---- 控制条：主题 ----
  const btnTheme = $("btn-theme");
  btnTheme.addEventListener("click", () => {
    const next: Config["theme"] = cfg.theme === "dark" ? "light" : "dark";
    cfg = { ...cfg, theme: next };
    applyTheme(cfg);
    if (isOpen()) fillForm(cfg);
    void refitAfterLayout();
    void persist();
  });

  // ---- 控制条：显示模式（整屏 → 左半屏 → 右半屏 循环）----
  const btnMode = $("mode");
  btnMode.addEventListener("click", () => {
    void switchHalf(nextMode(cfg.half));
  });

  dom.btnClose.addEventListener("click", () => closeSettings());
  dom.btnRevert.addEventListener("click", revertSettings);
  dom.btnSave.addEventListener("click", () => void saveSettings());
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
    refreshDraft();
    const inputs = dom.periods.querySelectorAll<HTMLInputElement>(".period-row input[type=text]");
    inputs[inputs.length - 1]?.focus();
  });

  dom.btnOpenFile.addEventListener("click", () => {
    void invoke("reveal_config").catch((e) => toast(String(e), true));
  });
  dom.btnReload.addEventListener("click", () => {
    void (async () => {
      try {
        const env = await invoke<ConfigEnvelope>("reload_config");
        applyEnvelope(env, true);
        if (isOpen()) {
          editing = cloneConfig(cfg);
          periodsDraft = editing.periods.map((p) => ({ ...p }));
          renderPeriodRows();
          markDirty(false);
        }
        toast("已重新读取配置文件");
      } catch (e) {
        toast(String(e), true);
      }
    })();
  });

  const fields: (keyof typeof dom.f)[] = [
    "theme", "contrast", "tint", "mode", "screen",
    "clockFormat", "title", "barEnabled", "barNames", "barGap",
  ];
  for (const k of fields) {
    dom.f[k].addEventListener("change", () => refreshDraft());
    dom.f[k].addEventListener("input", () => refreshDraft());
  }

  // 点遮罩关闭
  dom.settings.addEventListener("mousedown", (e) => {
    if (e.target === dom.settings) closeSettings();
  });
}

async function main(): Promise<void> {
  markSelfcheck("js-ok");
  wireSettingsUI();

  await bootstrap();
  await refitAfterLayout();
  markSelfcheck("ready", cfg.mode);

  // 整分对齐时钟；心跳只负责秒数与进度填充
  const clock = new MinuteClock({
    onMinute: () => {
      lastAppliedKey = "";
      repaint();
      scheduleFit();
    },
    onTick: tickFast,
  });
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

  // 字号真正依赖字体度量，字体到了必须重量一次
  if (document.fonts?.ready) {
    document.fonts.ready.then(() => {
      fitter.invalidate();
      fitter.fit();
    });
  }

  // 热重载：每秒看一眼配置文件原文有没有被外部改动。
  // 比 Rust 侧引 notify + 防抖 + 跨线程回主线程简单得多，逻辑也只有这一处。
  window.setInterval(() => void pollConfigOnce(), POLL_MS);
}

void main();
