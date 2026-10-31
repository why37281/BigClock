/* ============================================================================
   浮窗模式 —— mode = "float" 时的全部交互。

   窗口本身被 main.ts 设成无边框、置顶、透明背景的小窗，
   这里只管页面里那张圆角卡片：

     · 时钟逐位定宽格（与主时钟同一套 markup / 度量，换字零抖动）
     · 点一下卡片 → 弹出按钮排（对应全屏控制条四个按钮）；再点收起
     · 按住拖动 → 移动窗口（手动逐帧 setPosition，触屏/鼠标同一套）
     · 右下角手柄 → 改窗口大小，带最小尺寸，别拖一下拖没了
     · 字号自适应复用 ClockFitter（写 --float-fill，与主时钟互不干扰）

   拖动 vs 点按的区分：位移超过 6px 视为拖动；否则 pointerup 视为点按。

   ★★ 拖动为什么是自己搬窗口，而不是 startDragging / clientX ★★
   1) Windows 上 startDragging（WM_NCLBUTTONDOWN + HTCAPTION）只对鼠标有效：
      触摸流已经开始之后再发这条消息，系统不认，手指按着完全不动。
      所以触摸必须自己算位移、自己 setPosition。
   2) 位移必须用【屏幕坐标 screenX/Y】。clientX/Y 是相对窗口的，窗口一动
      坐标系跟着动，下一帧位移就算错，形成反馈回路 —— 实测表现是抖、抽搐、
      或者干脆"拖几下才挪一点"。
   3) screenX/Y 的单位是 CSS 像素，而窗口位置 outerPosition() / setPosition()
      是物理像素。Windows 显示缩放 125% / 150% / 200% 时两者差一个
      devicePixelRatio —— 不乘这个系数，手指移 3 格窗口只移 2 格甚至更少，
      正是"学校一体机上几乎拖不动"的原因。
   4) 窗口位置是异步 IPC 取的。必须在 pointerdown 时就发起（而不是等越过
      6px 阈值才问），否则 IPC 还没回来手指已经在动，这段位移全丢。
   5) pointermove 可能一秒上百个，每个都发一次 setPosition 会把 IPC 队列堵住，
      窗口一跳一跳追手指。用 rAF 合并成每帧一次。
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

  /** 拖动状态机：idle → pending(按下未动) → moving(逐帧搬窗口) */
  private drag: "idle" | "pending" | "moving" = "idle";
  /** 当前参与拖动的指针：多指（手掌误触）不重置状态、不参与拖动 */
  private pointerId = -1;
  /** 阈值判定用 client 坐标（CSS px；pending 阶段窗口还没动，坐标系没被污染） */
  private startClient = { x: 0, y: 0 };
  /** 手动拖动的锚点。screenXY = 屏幕 CSS 像素，参考系固定；
   *  startWin = 窗口位置的物理像素。 */
  private startScreen = { x: 0, y: 0 };
  private startWin = { x: 0, y: 0 };
  /** devicePixelRatio：把 screenX/Y 的 CSS 像素位移换算成物理像素 */
  private dpr = 1;
  /** 窗口位置是否已经拿到（拿不到就不搬，避免从 (0,0) 起跳） */
  private winReady = false;
  /** 最近一次 pointermove 的屏幕坐标，rAF 里用它算目标位置 */
  private latestScreen = { x: 0, y: 0 };
  private dragRaf = 0;
  /** 最近一次真正发出去的窗口位置：目标值没变就不再发 IPC */
  private sentPos = { x: NaN, y: NaN };

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

  /** pointerdown 时就问窗口在哪：等越过阈值再问的话，IPC 还没回、手指已在动，
   *  这段时间的位移会整段丢掉（"拖好几下才动一点"的另一个来源）。 */
  private primeWindowOrigin(): void {
    this.winReady = false;
    getCurrentWindow()
      .outerPosition()
      .then((p) => {
        if (this.drag === "idle") return; // 已经松手了，别用过期数据
        this.startWin = { x: p.x, y: p.y };
        this.sentPos = { x: p.x, y: p.y }; // 窗口本来就在这，别先发一条"摆回起点"
        this.winReady = true;
        // 位置回来得比阈值晚：补一帧，别让手指已经走了一段而窗口还在原地
        if (this.drag === "moving") this.scheduleMoveFrame();
      })
      .catch(() => {
        this.winReady = false; // 纯浏览器预览没有窗口 API
      });
  }

  /** 每帧最多一次 setPosition：pointermove 一秒上百个，逐个发会堵住 IPC 队列，
   *  窗口就会一跳一跳地追手指。发出去不 await —— 等回来时下一帧又到了。 */
  private scheduleMoveFrame(): void {
    if (this.dragRaf) return;
    this.dragRaf = requestAnimationFrame(() => {
      this.dragRaf = 0;
      if (this.drag !== "moving" || !this.winReady) return;
      const scale = this.dpr > 0 && Number.isFinite(this.dpr) ? this.dpr : 1;
      const dx = Math.round((this.latestScreen.x - this.startScreen.x) * scale);
      const dy = Math.round((this.latestScreen.y - this.startScreen.y) * scale);
      const x = this.startWin.x + dx;
      const y = this.startWin.y + dy;
      // 目标没变就别再发 IPC：一次拖动开头那帧位移是 0，没必要先把窗口
      // "摆回起点"；手指按住不动时也不该每秒发几十条同样的命令。
      if (x === this.sentPos.x && y === this.sentPos.y) return;
      this.sentPos = { x, y };
      getCurrentWindow()
        .setPosition(new PhysicalPosition(x, y))
        .catch(() => {
          /* 浏览器预览里没有窗口 API，忽略 */
        });
    });
  }

  private finishDrag(): void {
    if (this.dragRaf) {
      cancelAnimationFrame(this.dragRaf);
      this.dragRaf = 0;
    }
    this.drag = "idle";
    this.pointerId = -1;
    this.winReady = false;
    this.sentPos = { x: NaN, y: NaN };
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

  private endResize(pointerId: number): void {
    this.resizing = false;
    this.pendingSize = null;
    if (this.resizeRaf) {
      cancelAnimationFrame(this.resizeRaf);
      this.resizeRaf = 0;
    }
    try {
      this.handleEl.releasePointerCapture(pointerId);
    } catch {
      /* 已释放 */
    }
  }

  /* ------------------------------------------------------------ 事件绑定 */

  wire(): void {
    // 卡片：点按切按钮排 / 拖动移窗口
    this.root.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || this.inInteractive(ev)) return;
      if (this.drag !== "idle" || this.resizing) return; // 已有指针在拖/缩放：手掌误触不重置状态
      this.drag = "pending";
      this.pointerId = ev.pointerId;
      this.startClient = { x: ev.clientX, y: ev.clientY };
      this.startScreen = { x: ev.screenX, y: ev.screenY };
      this.latestScreen = { x: ev.screenX, y: ev.screenY };
      this.dpr = window.devicePixelRatio || 1;
      this.primeWindowOrigin();
      try {
        this.root.setPointerCapture(ev.pointerId);
      } catch {
        /* capture 失败不影响：只是少了 pointer 出卡片后的跟手性 */
      }
    });

    this.root.addEventListener("pointermove", (ev) => {
      if (ev.pointerId !== this.pointerId) return; // 别的手指不算数
      if (this.drag === "pending") {
        const d = Math.hypot(ev.clientX - this.startClient.x, ev.clientY - this.startClient.y);
        if (d <= TAP_SLOP) return;
        // ★ 屏幕锚点取"越过阈值这一刻"的坐标：手指在阈值之前走的那点位移
        //   不该算进去，否则窗口会先跳一下
        this.startScreen = { x: ev.screenX, y: ev.screenY };
        this.latestScreen = { x: ev.screenX, y: ev.screenY };
        this.drag = "moving";
        this.scheduleMoveFrame();
        return;
      }
      if (this.drag === "moving") {
        this.latestScreen = { x: ev.screenX, y: ev.screenY };
        this.scheduleMoveFrame();
      }
    });

    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== this.pointerId) return;
      if (this.drag === "pending") this.toggleActions();
      this.finishDrag();
    };
    this.root.addEventListener("pointerup", end);
    this.root.addEventListener("pointercancel", end);

    // 兜底：指针在窗口外松开、或者系统把 capture 收走时，root 可能收不到
    // pointerup。不补这条，状态机会永远停在 moving，卡片再也点不动。
    window.addEventListener("pointerup", (ev) => {
      if (this.drag !== "idle" && ev.pointerId === this.pointerId) this.finishDrag();
    });
    window.addEventListener("pointercancel", (ev) => {
      if (this.drag !== "idle" && ev.pointerId === this.pointerId) this.finishDrag();
    });
    window.addEventListener("blur", () => this.finishDrag());

    // 右下角手柄：缩放。独立监听（不走拖动状态机）—— 手柄自己 capture，
    // 收缩放的指针和拖动/点按的指针互不干扰。
    this.handleEl.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      const pid = ev.pointerId;
      void this.beginResize(ev);

      const move = (e: PointerEvent): void => {
        if (e.pointerId === pid && this.resizing) this.resizeTo(e);
      };
      const up = (e: PointerEvent): void => {
        if (e.pointerId !== pid) return;
        this.handleEl.removeEventListener("pointermove", move);
        this.handleEl.removeEventListener("pointerup", up);
        this.handleEl.removeEventListener("pointercancel", up);
        this.endResize(pid);
      };
      this.handleEl.addEventListener("pointermove", move);
      this.handleEl.addEventListener("pointerup", up);
      this.handleEl.addEventListener("pointercancel", up);
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
