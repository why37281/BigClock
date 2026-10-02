/* ============================================================================
   启动 / 定时器 / 事件绑定 / 设置面板
   ========================================================================== */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
    sem: $("f-sem") as HTMLSelectElement,
    mode: $("f-mode") as HTMLSelectElement,
    half: $("f-half") as HTMLSelectElement,
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
let monitors: ConfigEnvelope["monitors"] = [];
/** "语义色"开关：配置里没有这个字段（配色令牌已定稿），属于纯展示层偏好 */
let semOn = true;

let segments: Segment[] = [];
let nowIndex = -1;
let lastAppliedKey = "";

const renderer = new Renderer();
const fitter = new ClockFitter(renderer.viewEl, renderer.clockEl, renderer.headerEl);

const BASE_TITLE = "BigClock";
document.title = BASE_TITLE;

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
  void invoke("set_cursor_hidden", { enabled: false });
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
  void invoke("set_cursor_hidden", { enabled: true });
}

function fillForm(c: Config): void {
  dom.f.theme.value = c.theme;
  dom.f.contrast.value = c.theme === "light" ? "A2" : c.contrast;
  dom.f.contrast.disabled = c.theme === "light";
  dom.f.tint.value = c.tint;
  dom.f.sem.value = semOn ? "on" : "off";
  dom.f.mode.value = c.mode;
  dom.f.half.value = c.half;
  dom.f.clockFormat.value = c.clock_format;
  dom.f.title.value = c.title;
  dom.f.barEnabled.value = String(c.bar.enabled);
  dom.f.barNames.value = String(c.bar.show_names);
  dom.f.barGap.value = String(c.bar.gap_minutes);
  fillScreens(c.screen);
  dom.cfgPath.textContent = cfgPath || "（未确定）";
}

function fillScreens(current: number): void {
  dom.f.screen.textContent = "";
  if (!monitors.length) {
    const o = document.createElement("option");
    o.value = String(current);
    o.textContent = `显示器 ${current + 1}`;
    dom.f.screen.appendChild(o);
    return;
  }
  for (const m of monitors) {
    const o = document.createElement("option");
    o.value = String(m.index);
    o.textContent = `${m.index + 1}. ${m.name} · ${m.width}×${m.height}${m.primary ? "（主屏）" : ""}`;
    dom.f.screen.appendChild(o);
  }
  dom.f.screen.value = String(current);
}

/** 表单 → editing（每次控件变动都调用） */
function readForm(): void {
  if (!editing) return;
  editing.theme = dom.f.theme.value as Config["theme"];
  editing.contrast = dom.f.contrast.value as Config["contrast"];
  editing.tint = dom.f.tint.value as Config["tint"];
  editing.mode = dom.f.mode.value as Config["mode"];
  editing.half = dom.f.half.value as Config["half"];
  editing.screen = Number(dom.f.screen.value) || 0;
  editing.clock_format = dom.f.clockFormat.value as Config["clock_format"];
  editing.title = dom.f.title.value;
  editing.bar.enabled = dom.f.barEnabled.value === "true";
  editing.bar.show_names = dom.f.barNames.value === "true";
  editing.bar.gap_minutes = dom.f.barGap.value === "true";
  editing.periods = periodsDraft.map((p) => ({ ...p }));
  semOn = dom.f.sem.value === "on";
}

function isDirty(): boolean {
  if (!editing) return false;
  readForm();
  return JSON.stringify(editing) !== JSON.stringify(cfg) || semOn !== (document.documentElement.dataset.sem === "on");
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
    void invoke("set_cursor_hidden", { enabled: true });
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

function applyEnvelope(env: ConfigEnvelope, syncForm: boolean): void {
  cfg = env.config;
  cfgPath = env.path;
  monitors = env.monitors ?? [];

  const warns = env.warnings ?? [];
  setCornerNote(warns.length ? warns.join("\n") : null);

  dom.cfgPath.textContent = cfgPath || "（未确定）";
  if (syncForm && isOpen()) fillForm(cfg);
  if (isOpen()) fillScreens(cfg.screen);

  repaint(true);
  void refitAfterLayout();
}

async function bootstrap(): Promise<void> {
  try {
    const env = await invoke<ConfigEnvelope>("get_config");
    applyEnvelope(env, false);
  } catch (e) {
    // 后端没起来（比如直接用浏览器打开前端）也要能跑
    console.warn("拿不到配置，改用默认值：", e);
    setCornerNote(`拿不到配置：${e}`);
    applyEnvelope(
      { config: defaultConfig(), path: "", explicit_path: false, monitors: [], warnings: [], issues: [] },
      false,
    );
  }
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
      await invoke("set_fullscreen", { on: false });
    }
    return;
  }
  if (typing || isOpen()) return;

  switch (e.key) {
    case "F11": {
      e.preventDefault();
      await invoke("set_fullscreen", { on: cfg.mode !== "fullscreen" });
      break;
    }
    case "ArrowLeft":
      e.preventDefault();
      await invoke("apply_display", { mode: "fullscreen", half: "left", screen: cfg.screen });
      break;
    case "ArrowRight":
      e.preventDefault();
      await invoke("apply_display", { mode: "fullscreen", half: "right", screen: cfg.screen });
      break;
    case "ArrowDown":
      e.preventDefault();
      await invoke("apply_display", { mode: "fullscreen", half: "full", screen: cfg.screen });
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

/* ================================================================== 光标 */

let lastMove = Date.now();
function armCursorWatcher(): void {
  const bump = () => {
    lastMove = Date.now();
    document.body.classList.remove("hide-cursor");
  };
  addEventListener("mousemove", bump, { passive: true });
  addEventListener("mousedown", bump, { passive: true });
  addEventListener("wheel", bump, { passive: true });
  window.setInterval(() => {
    // 设置界面开着、或者鼠标刚动过，都不隐藏
    const shouldHide = !isOpen() && Date.now() - lastMove > 3000;
    document.body.classList.toggle("hide-cursor", shouldHide);
  }, 250);
}

/* ================================================================== 启动 */

function wireSettingsUI(): void {
  dom.btnSettings.addEventListener("click", openSettings);
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
    "theme", "contrast", "tint", "sem", "mode", "half", "screen",
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
  wireSettingsUI();
  armCursorWatcher();

  await bootstrap();
  await refitAfterLayout();

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

  // 休眠唤醒 / 切回前台：立刻重算并重新对齐分钟边界
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      clock.resync();
      scheduleFit();
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

  // 外部改了配置文件 → 后端热重载后推过来
  await listen<ConfigEnvelope>("config-changed", (ev) => {
    const env = ev.payload;
    // 设置界面开着时不覆盖正在编辑的内容，只在角落里提个醒
    if (isOpen()) {
      toast("配置文件已被外部修改，关闭设置后可看到最新内容");
      cfgPath = env.path;
      return;
    }
    applyEnvelope(env, false);
  });

  await listen<{ message: string; fatal?: boolean }>("config-error", (ev) => {
    setCornerNote(`配置文件有误，仍在使用上一次的有效配置：\n${ev.payload.message}`);
  });
}

void main();
