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

   3) 量自然宽度前必须解除约束：
      · .clock 的 max-width:100% 会把 rect 夹到容器宽 —— 半屏下正好夹成容器宽，
        读数看起来"没溢出"，其实早被裁了；
      · 定位祖先 .view 的 transform 会让 rect 落在位移后的坐标系里。

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

export class ClockFitter {
  private stage: HTMLElement;
  private clock: HTMLElement;
  private header: HTMLElement;
  private lastApplied = -1;

  constructor(stage: HTMLElement, clock: HTMLElement, header: HTMLElement) {
    this.stage = stage;
    this.clock = clock;
    this.header = header;
  }

  /**
   * 跑一次拟合，并把结果写进 --digit-fill。
   * 结果与上次相同就跳过，避免无意义地触发样式重算。
   */
  fit(): FitResult {
    // ---- 可用宽：读 header 的【渲染后】padding（真实像素，不是 token 流）----
    let padX = 0;
    const hcs = getComputedStyle(this.header);
    padX = (parseFloat(hcs.paddingLeft) || 0) + (parseFloat(hcs.paddingRight) || 0);

    const avail = this.stage.clientWidth - padX;
    const cur = parseFloat(getComputedStyle(this.clock).fontSize) || 0;
    const result: FitResult = { target: null, avail, naturalW: 0, currentFont: cur, capped: false };
    if (!(avail > 0)) return result;   // 窄到没有空间就不动字号，保持可读
    if (!(cur > 0)) return result;

    // ---- 量自然宽度：先拆掉 max-width 与祖先 transform ----
    const prevMaxW = this.clock.style.maxWidth;
    const prevTf = this.stage.style.transform;
    this.clock.style.maxWidth = "none";
    this.stage.style.transform = "none";
    const naturalW = this.clock.getBoundingClientRect().width;
    this.clock.style.maxWidth = prevMaxW;
    this.stage.style.transform = prevTf;

    result.naturalW = naturalW;
    if (!(naturalW > 0)) return result;

    // ---- 一次乘法解出目标字号 ----
    const scale = (avail * FILL) / naturalW;
    const cap = (42 * Math.min(innerWidth, innerHeight)) / 100;  // 高度方向上限
    const raw = cur * scale;
    const target = Math.max(12, Math.min(cap, raw));
    result.target = target;
    result.capped = target < raw - 0.01;

    const px = `${target.toFixed(1)}px`;
    if (Math.abs(target - this.lastApplied) > 0.05) {
      document.documentElement.style.setProperty("--digit-fill", px);
      this.lastApplied = target;
    }
    return result;
  }

  /** 忘掉"上次写入值"，强制下次一定写一次（换主题/换字体后调用） */
  invalidate(): void {
    this.lastApplied = -1;
  }
}
