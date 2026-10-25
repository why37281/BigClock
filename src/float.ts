/* ============================================================================
   浮窗模式 —— mode = "float" 时的全部交互。

   窗口本身被 main.ts 设成无边框、置顶、透明背景的小窗，
   这里只管页面里那张圆角卡片：

     · 时钟逐位定宽格（与主时钟同一套 markup / 度量，换字零抖动）
     · 点一下卡片 → 弹出按钮排（对应全屏控制条四个按钮）；再点收起
     · 按住拖动 → 移动窗口（优先走系统原生拖动，触屏同样可用；
       环境不支持时退化为手动 setPosition）
     · 右下角手柄 → 改窗口大小，带最小尺寸，别拖一下拖没了
     · 字号自适应复用 ClockFitter（写 --float-fill，与主时钟互不干扰）

   拖动 vs 点按的区分：位移超过 6px 视为拖动；否则 pointerup 视为点按。
   ========================================================================== */

import { LogicalSize, PhysicalPosition, getCurrentWindow } from "@tauri-apps/api/window";

import { ClockFitter } from "./fit";

/** 浮窗最小尺寸（逻辑像素）。与 Rust config.rs 的 FLOAT_MIN_W/H 保持一致。 */
export const FLOAT_MIN_W = 210;
export const FLOAT_MIN_H = 90;
/** 默认浮窗大小（逻辑像素），配置里没存几何时用它 */
export const FLOAT_DEF_W = 640;
export const FLOAT_DEF_H = 260;
/** 拖动判定阈值（CSS 像素）：小于这个位移算点按 */
const TAP_SLOP = 6;

/** 卡片正下方按钮排的按钮。不放"显示模式"：浮窗里半屏状态不可见，点了没有反馈 */
export type FloatButton = "theme" | "fullscreen" | "settings" | "quit";

export class FloatWidget {
  readonly fitter: ClockFitter;

  private root: HTMLElement;
  private clockEl: HTMLElement;
  private actionsEl: HTMLElement;
  private handleEl: HTMLElement;
  private cells: HTMLElement[] = [];
  private secEl!: HTMLElement;   // buildCells() 里赋值
  private showSeconds = true;
  private cacheKey = "";

  /** 拖动状态机：idle → pending(按下未动) → starting → native(系统拖动) / manual(手动 setPosition) */
  private drag: "idle" | "pending" | "starting" | "native" | "manual" = "idle";
  /** 触屏/触笔走手动拖动：系统原生 startDragging 在触摸流已经开始后才下发
   *  WM_NCLBUTTONDOWN，Windows 不认 —— 实测触屏下原生拖动完全不生效。
   *  鼠标保留原生（更跟手），触摸改用逐帧 setPosition 跟随。 */
  private preferManual = false;
  private manualReady = false;
  private startPtr = { x: 0, y: 0 };
  private startWin = { x: 0, y: 0 };

  /** 缩放状态：起点指针 + 起点窗口逻辑尺寸；rAF 合并连续 setSize */
  private resizing = false;
  private resizeStart = { px: 0, py: 0, w: 0, h: 0 };
  private pendingSize: { w: number; h: number } | null = null;
  private resizeRaf = 0;

  constructor(doc: Document) {
    this.root = doc.getElementById("float") as HTMLElement;
    this.clockEl = doc.getElementById("fclock") as HTMLElement;
    const wrap = doc.getElementById("fclock-wrap") as HTMLElement;
    this.actionsEl = doc.getElementById("float-actions") as HTMLElement;
    this.handleEl = doc.getElementById("float-handle") as HTMLElement;

    this.buildCells();
    // stage 和 padding 都量 wrap：时钟的真实约束是 wrap 的内容盒（去掉左右 padding）。
    // stage 用 #float 的话会把 padding 也算进可用宽，字会微微溢出。
    this.fitter = new ClockFitter(wrap, this.clockEl, wrap, {
      varName: "--float-fill",
      capPct: 66,
    });
  }

  /** 与主时钟完全一致的 6 格结构（秒区是右下角小尾巴，不带冒号），不随显隐重建 */
  private buildCells(): void {
    const cell = (c: string) => `<span class="d">${c}</span>`;
    this.clockEl.innerHTML =
      cell("0") + cell("0") + '<span class="c">:</span>' +
      cell("0") + cell("0") +
      `<span class="sec">${cell("0")}${cell("0")}</span>`;
    this.cells = Array.from(this.clockEl.querySelectorAll<HTMLElement>(".d"));
    this.secEl = (this.clockEl.querySelector(".sec") as HTMLElement) ?? this.clockEl;
    this.secEl.hidden = !this.showSeconds;
  }

  /** @param hhmm "19:29" @param sec "53" 或 "" */
  setTime(hhmm: string, sec: string): void {
    const key = hhmm + sec;
    if (key === this.cacheKey) return;
    this.cacheKey = key;

    const chars = [hhmm[0], hhmm[1], hhmm[3], hhmm[4]];
    for (let i = 0; i < 4; i++) {
      const el = this.cells[i];
      if (el && el.textContent !== chars[i]) el.textContent = chars[i];
    }
    if (this.showSeconds) {
      const s0 = sec[0] ?? "0";
      const s1 = sec[1] ?? "0";
      const e4 = this.cells[4];
      const e5 = this.cells[5];
      if (e4 && e4.textContent !== s0) e4.textContent = s0;
      if (e5 && e5.textContent !== s1) e5.textContent = s1;
    }
  }

  /** 秒区显隐；返回是否变化（变了要重新 fit，宽度参与拟合） */
  setShowSeconds(on: boolean): boolean {
    if (this.showSeconds === on) return false;
    this.showSeconds = on;
    this.secEl.hidden = !on;
    this.cacheKey = "";
    return true;
  }

  /** 按钮排显隐。显隐会改变时钟可用高度 → 高度上限跟着变，必须重 fit。 */
  setActionsVisible(on: boolean): void {
    if (this.actionsEl.hidden === !on) return;
    this.actionsEl.hidden = !on;
    this.fitter.capPct = on ? 46 : 66;
    this.fitter.fit();
  }

  toggleActions(): void {
    this.setActionsVisible(this.actionsEl.hidden);
  }

  /* ------------------------------------------------------------ 拖动（移动窗口） */

  private inInteractive(ev: PointerEvent): boolean {
    const t = ev.target as HTMLElement | null;
    return !!t && !!t.closest(".float-actions, .float-handle");
  }

  private beginNativeDrag(): void {
    // 先占住状态再 await：否则 startDragging 返回前的每个 pointermove
    // 都会再触发一次 beginDrag，等于疯狂重复调用系统拖动
    this.drag = "starting";
    getCurrentWindow()
      .startDragging()
      .then(() => {
        if (this.drag === "starting") this.drag = "native";
      })
      .catch(() => {
        // 非 Tauri 环境或原生拖动不可用：手动 setPosition 跟随
        this.beginManualDrag();
      });
  }

  /** 手动拖动：逐帧 setPosition 跟随指针。触屏固定走这条路（见 preferManual 注释）。
   *  窗口当前位置是异步拿的，拿到之前忽略 move 事件 —— 否则起点是 (0,0)，
   *  窗口会先跳到左上角再开始跟。 */
  private beginManualDrag(): void {
    this.drag = "manual";
    this.manualReady = false;
    getCurrentWindow()
      .outerPosition()
      .then((p) => {
        this.startWin = { x: p.x, y: p.y };
        this.manualReady = true;
      })
      .catch(() => {
        this.drag = "idle"; // 连窗口位置都拿不到（浏览器预览），放弃拖动
      });
  }

  private async manualDragTo(ev: PointerEvent): Promise<void> {
    if (!this.manualReady) return;
    const x = this.startWin.x + Math.round(ev.clientX - this.startPtr.x);
    const y = this.startWin.y + Math.round(ev.clientY - this.startPtr.y);
    // startWin 是物理像素，clientXY 是逻辑像素 —— 大多数单屏场景缩放一致，
    // 跨不同 DPI 的显示器拖动会有细微偏差，可接受（拖完松手 onMoved 会存真实位置）。
    try {
      await getCurrentWindow().setPosition(new PhysicalPosition(x, y));
    } catch {
      /* 浏览器预览里没有窗口 API，忽略 */
    }
  }

  /* ------------------------------------------------------------ 缩放（右下角手柄） */

  private async beginResize(ev: PointerEvent): Promise<void> {
    this.resizeStart = { px: ev.clientX, py: ev.clientY, w: 0, h: 0 };
    try {
      this.handleEl.setPointerCapture(ev.pointerId);
    } catch {
      /* 合成指针没有 capture 资格 */
    }
    try {
      const win = getCurrentWindow();
      const [size, sf] = await Promise.all([win.outerSize(), win.scaleFactor()]);
      this.resizeStart.w = size.width / sf;   // 逻辑尺寸：手柄位移是逻辑像素
      this.resizeStart.h = size.height / sf;
      // 数据就绪才开始跟随：await 期间 resizing 还是 false，
      // 否则用 w=0 的起点算出来的尺寸会被钳到最小值，窗口闪缩一下
      this.resizing = true;
    } catch {
      this.resizing = false; // 浏览器预览里没有窗口 API
    }
  }

  private resizeTo(ev: PointerEvent): void {
    const w = Math.min(3840, Math.max(FLOAT_MIN_W, this.resizeStart.w + (ev.clientX - this.resizeStart.px)));
    const h = Math.min(2160, Math.max(FLOAT_MIN_H, this.resizeStart.h + (ev.clientY - this.resizeStart.py)));
    this.pendingSize = { w: Math.round(w), h: Math.round(h) };
    if (!this.resizeRaf) {
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = 0;
        const s = this.pendingSize;
        this.pendingSize = null;
        if (!s) return;
        try {
          void getCurrentWindow().setSize(new LogicalSize(s.w, s.h)).catch(() => {});
        } catch {
          /* 浏览器预览没有窗口 API */
        }
      });
    }
  }

  /* ------------------------------------------------------------ 事件绑定 */

  wire(): void {
    // 卡片：点按切按钮排 / 拖动移窗口
    this.root.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || this.inInteractive(ev)) return;
      this.drag = "pending";
      // 触屏/触笔不能用系统原生拖动（见 preferManual 注释），直接记下来
      this.preferManual = ev.pointerType !== "mouse";
      this.startPtr = { x: ev.clientX, y: ev.clientY };
      try {
        this.root.setPointerCapture(ev.pointerId);
      } catch {
        /* capture 失败不影响：只是少了 pointer 出卡片后的跟手性 */
      }
    });

    this.root.addEventListener("pointermove", (ev) => {
      if (this.drag === "pending") {
        const d = Math.hypot(ev.clientX - this.startPtr.x, ev.clientY - this.startPtr.y);
        if (d > TAP_SLOP) {
          // 手动拖动的起点取"越过阈值那一刻"的指针位置，避免把阈值前的
          // 那点位移也算进去导致窗口起步跳动
          this.startPtr = { x: ev.clientX, y: ev.clientY };
          if (this.preferManual) this.beginManualDrag();
          else this.beginNativeDrag();
        }
      } else if (this.drag === "manual") {
        void this.manualDragTo(ev);
      }
      if (this.resizing) this.resizeTo(ev);
    });

    const end = (ev: PointerEvent) => {
      if (this.drag === "pending") this.toggleActions();
      this.drag = "idle";
      if (this.resizing) {
        this.resizing = false;
        this.pendingSize = null;
        try {
          this.handleEl.releasePointerCapture(ev.pointerId);
        } catch {
          /* 已释放 */
        }
      }
    };
    this.root.addEventListener("pointerup", end);
    this.root.addEventListener("pointercancel", end);

    // 右下角手柄：缩放
    this.handleEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      void this.beginResize(ev);
    });

    // 按钮排（行为由 main.ts 通过 setButtonHandler 注入）
    const bind = (id: string, b: FloatButton) => {
      document.getElementById(id)?.addEventListener("click", () => {
        // 点按钮后顺手把按钮排收起来，别挡着
        this.setActionsVisible(false);
        this.onButton?.(b);
      });
    };
    bind("fa-theme", "theme");
    bind("fa-fs", "fullscreen");
    bind("fa-settings", "settings");
    bind("fa-quit", "quit");
  }

  private onButton: ((b: FloatButton) => void) | null = null;

  /** main.ts 在拿到配置后注入按钮行为（要访问 cfg / 切模式） */
  setButtonHandler(h: (b: FloatButton) => void): void {
    this.onButton = h;
  }
}
