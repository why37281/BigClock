/* ============================================================================
   渲染层 —— 只负责"把数据画到 DOM 上"，不做任何时间计算。
   所有 DOM 节点在构造时抓一次，之后只改文本/类名/变量，不重建结构
   （重建会打断 CSS 过渡，而且每秒重建一次纯属浪费）。
   ========================================================================== */

import type { Segment } from "./segments";

const WD = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export interface SegEls {
  root: HTMLElement;
  fill: HTMLElement;
  name: HTMLElement | null;
  lastGrow: number;
  lastState: string;
  lastProgress: number;
}

export class Renderer {
  readonly clockEl: HTMLElement;
  readonly dateEl: HTMLElement;
  readonly segsEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly viewEl: HTMLElement;
  readonly headerEl: HTMLElement;
  /** 秒区容器；不显示秒时它不存在，退化成时钟本体（所以不能是 readonly） */
  secEl: HTMLElement;

  private cells: HTMLElement[] = [];
  private cacheKey = "";
  private dateKey = "";
  private segEls: SegEls[] = [];
  private showNames = false;
  private showSeconds = true;

  constructor(doc: Document = document) {
    this.viewEl = doc.getElementById("view") as HTMLElement;
    this.headerEl = doc.getElementById("header") as HTMLElement;
    this.titleEl = doc.getElementById("title") as HTMLElement;
    this.segsEl = doc.getElementById("segs") as HTMLElement;
    this.clockEl = doc.getElementById("clock") as HTMLElement;
    this.dateEl = doc.getElementById("date") as HTMLElement;
    this.secEl = this.clockEl;
    this.refreshClockCells();
  }

  /**
   * 建立逐位定宽格。只做一次。
   *
   * 刻意【不】随"是否显示秒"重建结构：重建会打断正在跑的 CSS 过渡，
   * 而且切 hms/hm 时整块时钟会闪一下重排。这里永远建满 6 格，
   * 不显示秒时只是把秒区容器 hidden —— DOM 结构稳定，切换零成本。
   * 附带好处：字号拟合量到的自然宽度恒定，切格式不会引起字号跳动。
   */
  private refreshClockCells(): void {
    if (this.cells.length === 6 && this.clockEl.childElementCount > 0) return;
    // 秒区前面必须有自己那个冒号格 —— 没有它，hm 下量到的自然宽会短一格，
    // 切到 hms 时整块时钟会突然变宽、字号跟着跳一下。
    const cell = (c: string) => `<span class="d">${c}</span>`;
    this.clockEl.innerHTML =
      cell("0") + cell("0") + '<span class="c">:</span>' +
      cell("0") + cell("0") +
      `<span class="sec"><span class="c">:</span>${cell("0")}${cell("0")}</span>`;
    this.cells = Array.from(this.clockEl.querySelectorAll<HTMLElement>(".d"));
    this.secEl = (this.clockEl.querySelector(".sec") as HTMLElement) ?? this.clockEl;
    this.secEl.hidden = !this.showSeconds;
    this.cacheKey = "";
  }

  /**
   * 显示/隐藏秒区。
   * 注意：秒区宽度参与字号拟合，所以显示状态一变，调用方【必须】重新 fit 一次，
   * 否则整块时钟的宽度会变而字号不变（看起来就是"右边多出一截"或"缩了一截"）。
   * 返回是否真的发生了变化，方便调用方决定要不要重算。
   */
  setShowSeconds(on: boolean): boolean {
    if (this.showSeconds === on) return false;
    this.showSeconds = on;
    if (this.secEl !== this.clockEl) this.secEl.hidden = !on;
    this.cacheKey = ""; // 强制下一次重画
    return true;
  }

  /**
   * 时钟。逐位写入，且只在字符真的变了才碰 DOM ——
   * 每个格宽度固定，所以换数字不会引起任何重排。
   * @param hhmm "19:29"
   * @param ss   "53" 或 ""（不显示秒）
   */
  setTime(hhmm: string, ss: string): void {
    const key = hhmm + ss;
    if (key === this.cacheKey) return;
    this.cacheKey = key;

    const chars = [hhmm[0], hhmm[1], hhmm[3], hhmm[4]];
    for (let i = 0; i < 4; i++) {
      const el = this.cells[i];
      if (el && el.textContent !== chars[i]) el.textContent = chars[i];
    }
    if (this.showSeconds) {
      const s0 = ss[0] ?? "0";
      const s1 = ss[1] ?? "0";
      const e4 = this.cells[4];
      const e5 = this.cells[5];
      if (e4 && e4.textContent !== s0) e4.textContent = s0;
      if (e5 && e5.textContent !== s1) e5.textContent = s1;
    }
  }

  setDate(d: Date): void {
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (key === this.dateKey) return;
    this.dateKey = key;
    this.dateEl.textContent =
      `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 · ${WD[d.getDay()]}`;
  }

  setTitle(t: string): void {
    this.titleEl.textContent = t ?? "";
  }

  /** 段名显示开关 */
  setShowNames(on: boolean): void {
    if (this.showNames === on) return;
    this.showNames = on;
    for (const s of this.segEls) {
      if (s.name) s.name.hidden = !on;
    }
  }

  /**
   * 重画进度条。结构变化（段数变了）才重建节点，否则只改类名与宽度，
   * 这样 CSS 的 flex-grow / width 过渡才能真的动起来。
   */
  renderSegments(segments: Segment[], weights: number[]): void {
    if (this.segEls.length !== segments.length) this.rebuildSegments(segments);
    const totalDur = segments.reduce((s, x) => s + x.dur, 0);

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const els = this.segEls[i];
      if (!els) continue;

      // 宽度：flex-grow（flex-basis 为 0，所以 grow 值就是占比）
      const grow = weights[i] ?? 0;
      if (Math.abs(els.lastGrow - grow) > 0.0005) {
        els.root.style.flexGrow = String(grow);
        els.lastGrow = grow;
      }
      // 把"时长 / 时长占比"挂到 DOM 上：一是便于自动化验收核对拉长公式，
      // 二是将来想在界面上做提示时不用再算一遍。开销可忽略（只在变化时写）。
      if (els.root.dataset.dur !== String(seg.dur)) els.root.dataset.dur = String(seg.dur);
      const base = totalDur > 0 ? seg.dur / totalDur : 0;
      const baseStr = base.toFixed(6);
      if (els.root.dataset.base !== baseStr) els.root.dataset.base = baseStr;

      // 三态
      if (els.lastState !== seg.state) {
        els.root.classList.toggle("done", seg.state === "done");
        els.root.classList.toggle("now", seg.state === "now");
        els.lastState = seg.state;
      }
      if (els.name && els.name.textContent !== seg.name) els.name.textContent = seg.name;

      // 进度填充：只对当前段有意义
      const wantPct = seg.state === "now" ? seg.progress * 100 : seg.state === "done" ? 100 : 0;
      if (Math.abs(els.lastProgress - wantPct) > 0.02) {
        els.fill.style.width = `${wantPct.toFixed(2)}%`;
        els.lastProgress = wantPct;
      }
    }
  }

  private rebuildSegments(segments: Segment[]): void {
    this.segsEl.textContent = "";
    this.segEls = segments.map(() => {
      const root = document.createElement("div");
      root.className = "seg";
      const fill = document.createElement("i");
      fill.className = "fill";
      root.appendChild(fill);
      const name = document.createElement("span");
      name.className = "name";
      name.hidden = !this.showNames;
      root.appendChild(name);
      this.segsEl.appendChild(root);
      return { root, fill, name, lastGrow: -1, lastState: "", lastProgress: -1 };
    });
  }

  /** 进度条整体开关 */
  setBarVisible(on: boolean): void {
    this.segsEl.style.display = on ? "" : "none";
  }

  /**
   * 改变会影响到时钟可用宽的 DOM 之后，等浏览器算完样式再量。
   * 用双 rAF：单 rAF 时样式可能还没提交，量到的还是旧布局。
   */
  static settled(): Promise<void> {
    return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
  }
}
