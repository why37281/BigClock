/* ============================================================================
   时钟字号自适应 —— 设计稿里已验证过的那套逻辑，照抄过来的。

   ★★ 三条硬规则（都是踩过坑换来的，别改）★★

   1) 绝不用 getComputedStyle 读【自定义属性】再 parseFloat。
      它返回的是 token 流原文（实测拿到字符串 "min(5.5vmin, 4.6vw)"，
      连 "2.4vmin" 都是原样返回），不是解析后的像素。
      parseFloat("min(5.5vmin, 4.6vw)") = NaN
        → avail = NaN → if (!(avail > 0)) return;  ← 静默返回，字号永远停在兜底值
      零报错、零控制台输出，症状看起来像"函数没被调用"，极易误诊。
      要读就读具体属性：paddingLeft / fontSize 这些返回真实像素。

   2) 不要用 em 常量硬算宽度。靠"数格子"推字距个数一定会错（差一格就贴边）。

   3) 量自然宽度前必须解除 max-width 约束：
      · .clock 的 max-width:100% 会把 rect 夹到容器宽 —— 半屏下正好夹成容器宽，
        读数看起来"没溢出"，其实早被裁了；
      · 祖先 .view 的 transform 是纯平移，不影响 rect 的【宽度】，不用碰 ——
        碰了反而会打断切换动画里正在过渡的 transform（见 fit() 内注释）。

   关键性质：时钟宽度对 font-size 是【严格线性】的（格宽 .546em / .212em、
   字距 .018em、秒区 .212em 全是 em 单位），所以
        目标字号 = 当前字号 × (可用宽 × FILL / 当前自然宽)
   一次乘法就是精确解 —— 不迭代、不试错、不含任何估出来的常量。
   ========================================================================== */

export const FILL = 0.97;   // 时钟（含秒区）最多占可用宽的 97%，留 3% 光边

export interface FitResult {
  /** 本次解出的目标字号（px）；提前返回时可能为 null */
  target: number | null;
  avail: number;
  naturalW: number;
  currentFont: number;
  capped: boolean;
}

export interface ClockFitterOptions {
  /** 解出的字号写进哪个 CSS 变量。主时钟用 --digit-fill，浮窗时钟用 --float-fill，
   *  两个实例各写各的，互不覆盖。 */
  varName?: string;
  /** 高度方向上限：字号 ≤ min(innerWidth, innerHeight) × capPct%。
   *  全屏时钟 42（上下还要留日期和进度条），浮窗时钟 66（只有时间）。 */
  capPct?: number;
}

export class ClockFitter {
  private stage: HTMLElement;
  private clock: HTMLElement;
  private header: HTMLElement | null;
  private lastApplied = -1;
  private varName: string;
  capPct: number;

  constructor(stage: HTMLElement, clock: HTMLElement, header: HTMLElement | null, options: ClockFitterOptions = {}) {
    this.stage = stage;
    this.clock = clock;
    this.header = header;
    this.varName = options.varName ?? "--digit-fill";
    this.capPct = options.capPct ?? 42;
  }

  /**
   * 跑一次拟合，并把结果写进自己的字号变量。
   * 结果与上次相同就跳过，避免无意义地触发样式重算。
   */
  fit(): FitResult {
    // ---- 可用宽：读 header 的【渲染后】padding（真实像素，不是 token 流）----
    let padX = 0;
    if (this.header) {
      const hcs = getComputedStyle(this.header);
      padX = (parseFloat(hcs.paddingLeft) || 0) + (parseFloat(hcs.paddingRight) || 0);
    }

    const avail = this.stage.clientWidth - padX;
    const cur = parseFloat(getComputedStyle(this.clock).fontSize) || 0;
    const result: FitResult = { target: null, avail, naturalW: 0, currentFont: cur, capped: false };
    if (!(avail > 0)) return result;   // 窄到没有空间就不动字号，保持可读
    if (!(cur > 0)) return result;

    // ---- 量自然宽度：只拆 max-width ----
    // ★ 不再拆祖先 transform：translateX 是纯平移，不改变 rect 的【宽度】，
    //   量宽根本不受影响；而在半屏切换动画进行中把 transform 内联成 none 再复原
    //   会打断/重启正在过渡的 transform（"none" 和 "translateX(0)" 是不同的值），
    //   导致 width 与 transform 两条过渡不同步，右缘出现超调跳动。
    const prevMaxW = this.clock.style.maxWidth;
    this.clock.style.maxWidth = "none";
    const naturalW = this.clock.getBoundingClientRect().width;
    this.clock.style.maxWidth = prevMaxW;

    result.naturalW = naturalW;
    if (!(naturalW > 0)) return result;

    // ---- 一次乘法解出目标字号 ----
    const scale = (avail * FILL) / naturalW;
    const cap = (this.capPct * Math.min(innerWidth, innerHeight)) / 100;  // 高度方向上限
    const raw = cur * scale;
    const target = Math.max(12, Math.min(cap, raw));
    result.target = target;
    result.capped = target < raw - 0.01;

    const px = `${target.toFixed(1)}px`;
    if (Math.abs(target - this.lastApplied) > 0.05) {
      document.documentElement.style.setProperty(this.varName, px);
      this.lastApplied = target;
    }
    return result;
  }

  /** 忘掉"上次写入值"，强制下次一定写一次（换主题/换字体后调用） */
  invalidate(): void {
    this.lastApplied = -1;
  }
}
