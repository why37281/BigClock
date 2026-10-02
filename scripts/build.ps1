# ============================================================
# BigClock 构建脚本
#
#   .\scripts\build.ps1              构建前端 + 编译 release 版 exe
#   .\scripts\build.ps1 -Portable    额外产出可整个拷走的分发目录
#   .\scripts\build.ps1 -SkipFront   跳过前端构建（只重编 Rust）
#
# 产物：
#   src-tauri\target\release\bigclock.exe
#   dist\BigClock\BigClock.exe + bigclock.toml + README.txt   （-Portable 时）
# ============================================================
[CmdletBinding()]
param(
    [switch]$Portable,
    [switch]$SkipFront,
    [switch]$NoLto          # 调试构建速度时用：关掉 LTO，编译快很多
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Die($msg)  { Write-Host "  !!  $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 前置检查
Step '检查工具链'

foreach ($tool in @('node', 'cargo')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $cmd) { Die "找不到 $tool，请先安装" }
    Ok "$tool $(& $tool --version 2>&1 | Select-Object -First 1)"
}

if (-not (Get-Command cargo-tauri -ErrorAction SilentlyContinue)) {
    Write-Host '  提示：未检测到 tauri-cli，但本脚本直接用 cargo 构建，不一定需要它。' -ForegroundColor Yellow
}

if ($NoLto) {
    Write-Host '  -NoLto：临时关掉 LTO（仅影响本次进程环境变量，不改文件）' -ForegroundColor Yellow
    $env:CARGO_PROFILE_RELEASE_LTO = 'false'
}

# ---------------------------------------------------------------- 前端
if (-not $SkipFront) {
    Step '构建前端 (vite)'
    if (-not (Test-Path "$root\node_modules")) {
        Write-Host '  安装 npm 依赖...'
        npm install
        if ($LASTEXITCODE -ne 0) { Die 'npm install 失败' }
    }
    npm run build
    if ($LASTEXITCODE -ne 0) { Die '前端构建失败' }
    if (-not (Test-Path "$root\dist\index.html")) { Die 'dist\index.html 不存在，前端没产出' }
    Ok 'dist\ 已生成'
}

# ---------------------------------------------------------------- Rust
Step '编译 Rust (release)'
Push-Location "$root\src-tauri"
try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { Die 'cargo build 失败（报错见上方）' }
} finally {
    Pop-Location
}

$exe = "$root\src-tauri\target\release\bigclock.exe"
if (-not (Test-Path $exe)) { Die "没有产出 $exe" }
$sizeMb = [math]::Round((Get-Item $exe).Length / 1MB, 2)
Ok "bigclock.exe  $sizeMb MB"

if (-not $Portable) {
    Write-Host "`n完成：$exe" -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------- 便携版
Step '打包便携版'
$out = "$root\dist\BigClock"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path $out | Out-Null

Copy-Item $exe "$out\BigClock.exe"

# 配置文件必须与 exe 同目录。这里放一份带注释的示例，
# 程序首次启动时如果发现没有 bigclock.toml 会自动生成一份同样的。
Copy-Item "$root\bigclock.example.toml" "$out\bigclock.toml"

$readme = @'
BigClock · 教室晚自习大屏时钟
================================

双击 BigClock.exe 即可运行，不需要安装。

【配置文件】
  bigclock.toml 就在这个目录里，是普通文本文件，
  用记事本直接改，存盘后 1 秒内界面自动更新，不用重启。

【快捷键】
  F1          打开 / 关闭设置
  F11         全屏 / 窗口 切换
  ← / →       左半屏 / 右半屏（黑板挡哪边选哪边）
  ↓           整屏
  Esc         退出全屏
  T           暗色 / 亮色 切换

【设置界面】
  按 F1 打开，可以直接改作息表，改完点「保存」会写回 bigclock.toml。

【常见问题】
  · 界面全白 / 打不开：多半是缺 WebView2 运行时，去微软官网免费下载安装
    （Windows 11 自带，Windows 10 可能需要装一次）
  · 配置文件改坏了：程序会保留上一次的有效配置继续显示，左下角会提示错误
  · 想恢复默认：直接删掉 bigclock.toml，重新启动程序会重新生成
'@
Set-Content -Path "$out\README.txt" -Value $readme -Encoding UTF8

Step '完成'
Get-ChildItem $out | ForEach-Object {
    "  {0,-18} {1,8} KB" -f $_.Name, [math]::Round($_.Length / 1KB, 1)
}
Write-Host "`n便携版目录：$out" -ForegroundColor Green
Write-Host '整个目录拷到别的机器上就能直接用。' -ForegroundColor Green
