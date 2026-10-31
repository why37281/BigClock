# ============================================================
# BigClock 构建脚本
#
# 【推荐入口是 scripts\build.cmd，不是这个文件】
#   build.cmd 会挑解释器：有 PowerShell 7（pwsh）就用 7，没有才退回 5.1。
#   原因：5.1 读 .ps1 时按 ANSI/GBK 解码，除非文件开头有 UTF-8 BOM ——
#   谁用编辑器改一次（把 BOM 抹了），构建就整个语法报错。
#   PS 7 默认按 UTF-8 读，BOM 可有可无，这个坑就不存在了。
#   所以本文件仍然保留 BOM：那是给 5.1 兜底用的，别删。
#
#   .\scripts\build.cmd              构建 release exe（前端 + Rust）
#   .\scripts\build.cmd -Portable    额外产出便携 zip（推荐的分发方式）
#   .\scripts\build.cmd -SkipBuild   不重新编译，只用现有 exe 重新打包
#
# 直接调本文件也行（两个参数含义相同），但那样就绕过了上面的解释器选择。
#
# 产物：
#   src-tauri\target\release\bigclock.exe
#   release\BigClock\BigClock.exe + bigclock.toml + README.txt      （-Portable）
#   release\BigClock_<版本>_x64_portable.zip                         （-Portable）
#   release\SHA256SUMS.txt                                          （-Portable）
#
# 为什么用 `tauri build --no-bundle` 而不是 `cargo build --release`：
#   前者会带上 Tauri 需要的环境变量并先跑前端构建，后者不会。
#   用后者编出来的包出现过"前端不执行"的假象，别再用它验证打包结果。
# ============================================================
[CmdletBinding()]
param(
    [switch]$Portable,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ..  $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "  !!  $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 版本号
# 必须显式按 UTF-8 读：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI 解码，
# 会把 tauri.conf.json 里的中文读成乱码，接着 ConvertFrom-Json 直接报错。
$confPath = Join-Path $root 'src-tauri\tauri.conf.json'
$confJson = [System.IO.File]::ReadAllText($confPath, [System.Text.Encoding]::UTF8)
$conf = $confJson | ConvertFrom-Json
$version = $conf.version
if (-not $version) { Die 'tauri.conf.json 里没有 version' }

# ---------------------------------------------------------------- 编译
$exe = Join-Path $root 'src-tauri\target\release\bigclock.exe'

if ($SkipBuild) {
    Warn "-SkipBuild：跳过编译，直接用现有 exe"
    if (-not (Test-Path $exe)) { Die "没有现成的 $exe，去掉 -SkipBuild 重新编译" }
} else {
    Step '检查工具链'
    foreach ($tool in @('node', 'cargo')) {
        $cmd = Get-Command $tool -ErrorAction SilentlyContinue
        if (-not $cmd) { Die "找不到 $tool，请先安装" }
        Ok "$tool $(& $tool --version 2>&1 | Select-Object -First 1)"
    }

    Step '构建（tauri build --no-bundle：前端 + Rust release）'
    # 不走 npm 包那层 .cmd 包装：直接调本地 CLI，避免某些环境下管道/子进程的怪问题
    & npx --no-install tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { Die '构建失败（报错见上方）' }

    if (-not (Test-Path $exe)) { Die "没有产出 $exe" }
    $sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 2)
    Ok "bigclock.exe  $sizeMb MB"
}

if (-not $Portable) {
    Write-Host "`n完成：$exe" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- 便携版
Step '打包便携版'

$out = Join-Path $root 'release\BigClock'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 程序名用产品名，别让用户看到小写的 bigclock.exe
Copy-Item $exe (Join-Path $out 'BigClock.exe')

# 配置文件必须与 exe 同目录。放一份带注释的示例；程序首次启动发现没有
# bigclock.toml 会自动生成一份同样的。
Copy-Item (Join-Path $root 'bigclock.example.toml') (Join-Path $out 'bigclock.toml')

# 便携版说明（注意：必须用 CRLF，老记事本对纯 LF 不友好）
$readme = @'
BigClock · 教室晚自习大屏时钟  v__VERSION__
==========================================

双击 BigClock.exe 即可运行，不需要安装、不需要联网。
整个文件夹可以随便拷到别的 Windows 电脑上用（U 盘拷贝即可）。


【第一次运行被 Windows 拦了？】
  Windows 有两种提示，原因完全不同，别混：

  (1) 蓝底「Windows 已保护你的电脑」
      这是 SmartScreen 对"没有数字签名的新程序"的常规提示，不是病毒。
      点「更多信息」→「仍要运行」即可，之后不会再问。
      用 U 盘拷贝过来的文件通常根本不会弹这个提示。

  (2) 黄色盾牌「打开这些文件可能会对你的计算机有害」
      「你的 Internet 安全设置阻止打开一个或多个文件」
      这是文件带了"来自 Internet"的标记（下载 / 从网页打开造成的），
      【和签名无关】，也不是病毒。
      处理：右键该文件 → 属性 → 最下面勾上「解除锁定」→ 确定。
      整个文件夹一起处理：在 PowerShell 里执行
          Get-ChildItem . -Recurse | Unblock-File


【配置文件】
  bigclock.toml 就在这个文件夹里，是普通文本文件，
  用记事本直接改，存盘后 1 秒内界面自动更新，不用重启。
  改坏了也不怕：程序会保留上一次的有效配置继续显示，并在角落提示错误。
  这个文件被设成了 Windows 的「隐藏」属性 —— 资源管理器里默认看不到，
  在「查看 → 显示 → 隐藏的项目」勾上就能看见（只是看不见，不是打不开）。
  程序里按 F1 → 「打开所在文件夹」也会直接定位到它。
  删掉这个文件也没关系：下次启动会自动重新生成一份带注释的默认配置。


【快捷键】
  F1          打开 / 关闭设置
  F11         全屏 / 窗口 切换
  ← / →       左半屏 / 右半屏（黑板挡哪边选哪边）
  ↓           整屏
  Esc         退出全屏
  T           暗色 / 亮色 切换


【全屏】
  每次启动都会自动进全屏，不用按任何键（上次按 F11 退出了也一样）。
  想退出全屏：按 F11 / Esc，或者点左下角控制条上的「退出全屏」；
  想回去：点「全屏」或再按一次 F11。
  控制条除了浮窗模式以外一直显示，不用找。


【设置界面】
  按 F1 打开，可以直接改作息表。设置是即时保存的：改一个控件就写回
  bigclock.toml（没有「保存」按钮）。想恢复出厂设置：点底部的
  「恢复默认配置」，会先弹确认框。


【打不开怎么办】
  1. 启动失败会弹一个系统对话框，里面写了原因和最后几行启动记录 ——
     截图发过来就能定位。程序不会在旁边生成日志文件，用完不留垃圾。
  2. 如果弹出「BigClock 启动失败」的对话框，按里面的提示操作即可；
     最常见的原因是杀毒软件正在扫描刚解压的程序，等十几秒再双击一次。
  3. 界面是一片空白：多半是这台机器缺 WebView2 运行时。去微软官网搜
     "WebView2 Runtime" 免费下载安装（Windows 11 自带；Windows 10 可能需要装一次）。


【卸载】
  没有装到系统里，直接删掉整个文件夹就干净了。
'@
$readme = $readme.Replace('__VERSION__', $version)
# 显式写成「带 BOM 的 UTF-8」：PowerShell 5.1 的 -Encoding UTF8 带 BOM，
# 7.x 的不带 —— 同一份脚本换个解释器跑，发给用户的文件就不一样了，
# 而老记事本还要靠 BOM 才认得中文。
[System.IO.File]::WriteAllText(
    (Join-Path $out 'README.txt'),
    $readme,
    (New-Object System.Text.UTF8Encoding($true))
)

# ---------------------------------------------------------------- 压缩
$zip = Join-Path $root "release\BigClock_${version}_x64_portable.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# 这里刻意不用 Compress-Archive：5.1 和 7.x 的实现不同，同一次构建换个
# 解释器出来的包能差 80 KB（实测 2.18 MB vs 2.26 MB），说不清是哪个对的。
# 直接调 .NET 的 ZipFile：两个解释器走同一套 API，只剩压缩等级要挑。
try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop } catch { }
# SmallestSize 只有 .NET 6+（PowerShell 7）才有；.NET Framework 4.8（5.1）上
# 直接写它会是 $null，然后 CreateFromDirectory 找不到重载 —— 必须探测。
$level = [System.IO.Compression.CompressionLevel]::Optimal
if ([System.Enum]::GetNames([System.IO.Compression.CompressionLevel]) -contains 'SmallestSize') {
    $level = [System.IO.Compression.CompressionLevel]::SmallestSize
}
[System.IO.Compression.ZipFile]::CreateFromDirectory($out, $zip, $level, $true)
Ok "zip  $( [math]::Round((Get-Item $zip).Length / 1MB, 2) ) MB  ($($level))"

# ---------------------------------------------------------------- 校验和
$targets = @()
$targets += Get-ChildItem (Join-Path $root 'release') -File |
    Where-Object { $_.Extension -in '.zip', '.exe' }
$targets += Get-Item (Join-Path $out 'BigClock.exe')
$sums = $targets | ForEach-Object {
    $h = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
    "$h  $($_.Name)"
}
$sumsFile = Join-Path $root 'release\SHA256SUMS.txt'
Set-Content -Path $sumsFile -Value $sums -Encoding ASCII

Step '完成'
Get-ChildItem $out | ForEach-Object {
    "  {0,-18} {1,8} KB" -f $_.Name, [math]::Round($_.Length / 1KB, 1)
}
Write-Host "`n便携目录：$out" -ForegroundColor Green
Write-Host "便携 zip ：$zip" -ForegroundColor Green
Write-Host "校验和  ：$sumsFile" -ForegroundColor Green
Write-Host '用法：把 zip 拷到目标机器解压，双击 BigClock.exe。' -ForegroundColor Green
