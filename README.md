# BigClock · 教室晚自习大屏时钟

给 **3840×2160 教室大屏**用的晚自习时间展示工具。目标只有一个：让学生从教室任何位置一眼看清
**现在几点、现在是什么时段、还剩多久**。

- 顶部分段胶囊进度条按你的作息表驱动，每段宽度 ∝ 真实时长，**当前段横向拉长 + 青色高亮**
- 逐位定宽时钟：换分钟时整块**零位移、零抖动**；字号按容器宽自适应（整屏 / 半屏都不会溢出）
- 暗色（晚自习）+ 亮色（白天开灯）双主题，4 档对比度可选
- **支持整屏 / 左半屏 / 右半屏** —— 大屏常有一半边被黑板挡住
- 配置就是 exe 旁边一个**纯文本文件**，可以直接拿记事本改，存盘 1 秒内生效，不用重启
- 也可以在程序里按 `F1` 打开设置界面改作息表，改完写回同一个文本文件

<br>

**整屏（3840×2160）**

![整屏](docs/screenshot-full.png)

**左半屏（1920×2160 竖屏视口）** —— 另一半被黑板挡住时用

![左半屏](docs/screenshot-half.png)

---

## ⚠️ 构建时最容易踩的坑（务必先读）

**必须用 `cargo tauri build`，不能用 `cargo build`。**

这两个命令产出的 exe 看起来一样，行为却完全不同：

| 命令 | webview 加载的东西 | 结果 |
|---|---|---|
| `cargo build --release` | **`devUrl`（http://localhost:5183）** | 页面一片空白、什么都不动，而且**完全静默不报错** |
| `cargo tauri build` | `frontendDist`（打进 exe 的 `dist/`） | 正常 |

原因：`cargo build` 走的是 dev 模式，`tauri-build` 会把 `tauri.conf.json` 里的
`devUrl` 编进去而不是 `frontendDist`。开发服务器没开时，WebView2 加载的是
浏览器的"无法连接"错误页 —— 窗口在、标题在、`eval` 也能跑，但你的前端一行都不执行。
排查时极容易误判成"CSP 挡了""资源没打包""字体路径错了"。

（这个坑实际花了很久才定位，详见 `BUG-交接文档.md` 末尾。）

---

## 快速开始

### 只看界面（不需要 Rust，立刻能跑）

```powershell
npm install
npm run dev          # 浏览器打开 http://localhost:5183
```

没有 Tauri 后端时，前端会自动回退到默认配置（单段 `18:40–19:00`），
界面、字号自适应、进度条都可以正常看和调。设置面板也能开，只是保存会提示拿不到配置。

### 构建桌面应用（需要 Rust 工具链）

前置条件：

| 依赖 | 说明 |
|---|---|
| Node ≥ 18 | 构建前端 |
| Rust ≥ 1.77 + MSVC 工具链 | `rustup` 装 `stable-x86_64-pc-windows-msvc`，另需 VS2022 生成工具（提供 `link.exe`） |
| WebView2 Runtime | Windows 11 自带；Windows 10 可能需装一次（微软官网免费） |
| Tauri CLI | `cargo install tauri-cli --locked --version "^2"` |

```powershell
npm install
cd src-tauri
cargo tauri build             # ← 注意是 tauri build，它会自己先跑 npm run build
```

产物：

- `src-tauri\target\release\bigclock.exe` —— 便携版可执行文件
- `src-tauri\target\release\bundle\nsis\BigClock_0.1.0_x64-setup.exe` —— 安装包

exe 可以直接拷到别的机器上用（那台机器需要 WebView2 运行时）。
首次运行会在 exe 同目录生成 `bigclock.toml`。

---

## 配置

首次启动时，程序会在 **exe 同目录**生成 `bigclock.toml`。它就是个普通文本文件，
用记事本改完存盘，界面 1 秒内自动更新。

参考 [`bigclock.example.toml`](bigclock.example.toml)。

```toml
theme        = "dark"        # dark（晚自习）/ light（白天开灯）
mode         = "fullscreen"  # fullscreen（全屏展示）/ window（窗口配置）
half         = "full"        # full（整屏）/ left（左半屏）/ right（右半屏）
screen       = 0             # 第几块显示器，0 = 主屏
contrast     = "A2"          # A | A2 | B | C —— 只对暗色有效，越往后越柔
tint         = "cyan"        # neutral | cyan | warm（背景色偏）
clock_format = "hm"          # hm（19:29）/ hms（19:29:53）
title        = ""            # 顶部标题，留空则不显示

[bar]
enabled     = true           # 是否显示进度条
show_names  = false          # 是否在当前段里显示段名
gap_minutes = true           # 时段之间的空档是否自动补成「课间」

[[periods]]
name  = "晚自习"
start = "18:40"
end   = "19:00"
```

### 时间写法很宽松

`18:40` / `1840` / 全角 `18：40` 都认；`end` 允许写 `24:00`；
**跨零点也支持**：`start = "23:30", end = "00:10"`。

### 进度条规则

每段宽度 ∝ 该段真实时长 → **当前段拉长到原长的 250%**，但**上限为总宽的 70%**，
其余段按比例让位，整条精确占满 100%。

### 健壮性

配置文件写坏（乱码 / 删字段 / 值写错）时，程序**保留上一次有效配置**继续显示，
只在左下角提示错误 —— 绝不让大屏白屏。

---

## 快捷键

| 键 | 作用 |
|---|---|
| `F1` | 打开 / 关闭设置 |
| `F11` | 全屏 ⇄ 窗口 |
| `←` / `→` | 左半屏 / 右半屏 |
| `↓` | 整屏 |
| `Esc` | 退出全屏（设置开着时是关闭设置） |
| `T` | 暗色 ⇄ 亮色 |

左下角的控制条平时是隐形的，鼠标移上去才浮现，里面是 **主题 / 显示模式 / 设置** 三个按钮。
显示模式是一个图标三态循环：整屏 → 左半屏 → 右半屏，图案跟着变。

---

## 设计要点

**半屏不切窗口。** 窗口始终铺满整块显示器（`setFullscreen`），
"左半屏/右半屏"纯粹是 CSS —— `.view` 的 `width:50%` + `translateX`，
把内容挪到那一半，另一半留黑。这和 `design-preview.html` 里的做法完全一致。

这么做的好处：不必跟系统的最大化状态、窗口边框、DPI 缩放打架
（切成半个窗口时，`set_size` 设的是内容区、带边框会差一圈；
最大化状态下改尺寸会被系统改回去）。视觉上单显示器和双显示器都等价。

**字号自适应**量的是真实渲染宽度，再按比例一次乘法解出目标字号 ——
时钟宽度对 `font-size` 严格线性，所以这是精确解，不需要迭代。
`src/fit.ts` 里记着三条硬规则和一个值得知道的坑。

---

## 目录结构

```
BigClock/
├─ index.html              前端入口（含一段内联自检脚本，见下）
├─ src/
│  ├─ main.ts              启动、控制条、定时器、设置面板、热重载轮询
│  ├─ time.ts              整分对齐时钟
│  ├─ segments.ts          分段计算：宽度分配、三态、拉长规则
│  ├─ render.ts            逐位定宽数字渲染 + 局部 DOM 更新
│  ├─ fit.ts               时钟字号自适应
│  ├─ config.ts            配置类型 + 宽松时间解析 + 兜底校验
│  ├─ styles.css           全部样式（含配色令牌与控制条）
│  └─ fonts/               内嵌字体
├─ src-tauri/
│  ├─ src/main.rs          启动、状态管理
│  ├─ src/config.rs        配置读写 + 宽松解析 + 校验
│  ├─ src/commands.rs      前端可调指令（配置读写 / 打开目录 / 退出）
│  ├─ src/single_instance.rs  命名互斥体
│  ├─ src/debug_server.rs  仅测试时开启的只读自省端口（见下）
│  └─ tauri.conf.json
├─ scripts/build.ps1       构建脚本（内部走 cargo tauri build）
├─ design-preview.html     最早的设计稿（静态 HTML，保留作参考，不参与打包）
├─ BUG-交接文档.md          字号不重算那个 bug 与构建模式坑的完整记录
├─ 实施计划.md              整体方案与验收标准
└─ .preview/               开发期自动化验收脚本（不进仓库）
```

### Rust 侧为什么这么小

只做**前端做不到的事**：读 exe 同目录的配置文件、宽松解析时间、校验、
单实例。窗口形态走 Tauri 官方 JS API，热重载是前端每秒轮询文件原文，
半屏是 CSS。所以三个依赖都省掉了（`windows-sys` / `notify` / `dirs`），
代码量比初版少了一半。

### 排查前端时的自检通道

- `index.html` 顶部有一段内联脚本，把资源加载失败和 JS 异常记进 `window.__selfcheck`
- 设了环境变量 `BIGCLOCK_DEBUG_PORT` 时，程序会开一个**只监听 127.0.0.1 的只读** HTTP 端口：
  - `/state` 当前生效的配置、是否全屏
  - `/why` 让 webview 自述：当前 URL、`window.__selfcheck`、DOM 里有没有渲染出时钟
  - `/raw` 配置文件原文

  不设这个环境变量时这套代码一行都不跑，端口也不存在。

  `/why` 是靠 `eval_with_callback` 实现的 —— 注意 Windows 上 `eval()` 是**不回传返回值**的，
  排查时用 `eval` 拿结果会一直拿到空，这是个很容易踩的坑。

---

## 开发笔记：一个值得记下来的坑

时钟字号在「全屏 ⇄ 半屏」切换后不重算，永远停在 CSS 兜底值 —— 零报错、零控制台输出。
真凶是**一个 NaN**：

```js
parseFloat(getComputedStyle(root).getPropertyValue('--pad-x')) * 2
```

`getComputedStyle` 读**自定义属性**返回的是 **token 流原文**（实测拿到字符串
`"min(5.5vmin, 4.6vw)"`，连 `"2.4vmin"` 都是原样返回），**不是解析后的像素**。
于是 `parseFloat(...)` = `NaN` → `avail = NaN` → `if (!(avail > 0)) return;` **静默返回**。

由此确立三条硬规则（`src/fit.ts` 里也写了）：

1. **绝不用 `getComputedStyle` 读自定义属性再 `parseFloat`** —— 要读就读具体属性
   （`paddingLeft`、`fontSize` 这些返回真实像素）
2. **不要用 em 常量硬算宽度** —— 靠"数格子"推字距个数一定会错
3. **量自然宽度前必须解除约束** —— `max-width:100%` 会把读数夹到容器宽，
   `transform` 会让读数落在位移后的坐标系里

完整记录见 [`BUG-交接文档.md`](BUG-交接文档.md)。

---

## 许可

MIT
