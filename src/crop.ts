/* ============================================================================
   自定义边界 —— half = "custom" 时的左右两条可拖竖线。

   语义：crop_left / crop_right 是视口宽度两侧各缩进的百分比，
   显示区宽度 = 100% - crop_left - crop_right，下限 30%（别拖得只剩一条缝）。

   交互（按用户实测反馈定的）：
     · 进入自定义模式时边界线亮起；
     · 3 秒内没有任何点击/拖动 → 线淡出（.dim），边界本身仍然生效；
     · 之后任意点击再亮回来，重新计时。
   边界线的"命中区"比视觉线宽（36px vs 3px），触屏上才好按。
   ========================================================================== */

/** 显示区最小宽度（视口宽的百分比） */
export const CROP_MIN_WIDTH_PCT = 30;
/** 无交互多久后藏线 */
const IDLE_HIDE_MS = 3000;

export interface CropOptions {
  getLeft(): number;
  getRight(): number;
  /** 拖动过程中每帧回调（改 CSS 变量 + 重算字号） */
  onLive(left: number, right: number): void;
  /** 拖动结束回调（存配置） */
  onCommit(left: number, right: number): void;
}

export class CropController {
  private bar: HTMLElement;
  private lineL: HTMLElement;
  private lineR: HTMLElement;
  private opts: CropOptions;
  private hideTimer = 0;

  constructor(doc: Document, opts: CropOptions) {
    this.bar = doc.getElementById("cropbar") as HTMLElement;
    this.lineL = doc.getElementById("crop-l") as HTMLElement;
    this.lineR = doc.getElementById("crop-r") as HTMLElement;
    this.opts = opts;
    this.wire();
  }

  /** 当前是否应该显示（half=custom 且不在浮窗模式）。由 repaint 统一调用。
   *  注意：repaint 每分钟都会跑一次，只有"从关到开"才唤起并计时，
   *  否则已藏起来的线会每分钟自己冒出来。 */
  setActive(on: boolean): void {
    const wasOn = !this.bar.hidden;
    this.bar.hidden = !on;
    if (on && !wasOn) this.poke();
    if (!on) clearTimeout(this.hideTimer);
  }

  /** 亮起边界线并重新计时；3 秒无交互自动淡出 */
  poke(): void {
    if (this.bar.hidden) return;
    this.bar.classList.remove("dim");
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.bar.classList.add("dim");
    }, IDLE_HIDE_MS);
  }

  /* ------------------------------------------------------------ 拖线 */

  private wire(): void {
    const attach = (el: HTMLElement, isLeft: boolean) => {
      el.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          /* 某些合成指针没有 capture 资格；不跟手但拖动仍然成立 */
        }
        this.poke();
        const startX = ev.clientX;
        const startL = this.opts.getLeft();
        const startR = this.opts.getRight();

        const move = (e: PointerEvent): void => {
          const pct = ((e.clientX - startX) / innerWidth) * 100;
          let l = startL;
          let r = startR;
          if (isLeft) {
            // 左线：0 ≤ l ≤ 100 - r - 30（保住最小宽度）
            l = Math.max(0, Math.min(100 - startR - CROP_MIN_WIDTH_PCT, startL + pct));
          } else {
            r = Math.max(0, Math.min(100 - startL - CROP_MIN_WIDTH_PCT, startR - pct));
          }
          this.poke();
          this.opts.onLive(l, r);
        };
        const up = (e: PointerEvent): void => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          el.removeEventListener("pointercancel", up);
          try {
            el.releasePointerCapture(e.pointerId);
          } catch {
            /* 已释放 */
          }
          this.opts.onCommit(this.opts.getLeft(), this.opts.getRight());
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
        el.addEventListener("pointercancel", up);
      });
    };
    attach(this.lineL, true);
    attach(this.lineR, false);
  }
}
