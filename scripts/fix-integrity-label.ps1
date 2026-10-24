# ============================================================
# 修复 NTFS 完整性级别（Low Mandatory Level → Medium）
#
# 【为什么需要它】
#   dsh（DeepSeek 编程助手 harness）的 workspace-write 沙箱，会在 Windows 上
#   给工作区目录打上 "Mandatory Label\Low Mandatory Level"（含子项继承）。
#   在这棵树里编译出来的 exe 会继承该标签，双击时 WebView2 拉不起浏览器子进程：
#     · 第 1 次失败 HRESULT 0x800700AA（请求的资源在使用中）
#     · 之后失败 HRESULT 0x8000FFFF（灾难性故障，10~23 秒后）
#     · 事件日志里 msedgewebview2.exe 崩在 msedge_elf.dll，异常码 0x80000003
#   典型特征：**把 exe 拷到别的目录就能跑，原目录不行**。
#
# 【怎么用（拷到哪都能用）】
#   把 fix-integrity-label.cmd 和 fix-integrity-label.ps1 一起放到目标目录
#   （或它的 scripts 子目录）里，双击 .cmd 即可：
#     · 默认清理"脚本自己所在的目录"；若脚本在 scripts\ 里，则自动取上一级
#     · 想清别的目录：fix-integrity-label.cmd -Path D:\别的项目
#     · 只看不改：    fix-integrity-label.cmd -CheckOnly
#     · 连 target\ 里所有文件一起改（慢）：fix-integrity-label.cmd -All
#
# 【默认不全量递归的原因】
#   target\ 里有一万多个文件，改它们没意义。默认只改：
#     1) 目标根目录（(OI)(CI) 继承，保证以后新编译的文件是 Medium）
#     2) 目标目录下已有的 *.exe（跳过 node_modules / deps / build 等）
# ============================================================
[CmdletBinding()]
param(
    [string[]]$Path,
    [switch]$CheckOnly,
    [switch]$All,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK   $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  !!   $m" -ForegroundColor Red }
function Info($m) { Write-Host "  ..   $m" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 目标目录
if (-not $Path -or $Path.Count -eq 0) {
    # 脚本自己所在的目录；如果在 scripts\ 里，就往上取一级
    $root = $PSScriptRoot
    if ((Split-Path $root -Leaf) -ieq 'scripts') { $root = Split-Path $root -Parent }
    $Path = @($root)
}
$Path = @($Path | ForEach-Object { (Resolve-Path -LiteralPath $_).Path })

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

# ---------------------------------------------------------------- 自动提权
if (-not $isAdmin -and -not $CheckOnly -and -not $Elevated) {
    Info '修改完整性标签需要管理员权限，正在请求提权…'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath,
                 '-Elevated', '-Path', ($Path -join ','))
    if ($All) { $argList += '-All' }
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait
    } catch {
        Bad "提权被取消：$($_.Exception.Message)"
        exit 1
    }
    exit 0
}

# ---------------------------------------------------------------- 读标签
# 返回 'Low' / 'Medium' / 'High' / 'UNKNOWN' —— 读不到时如实说 UNKNOWN，不冒充 OK
function Get-Label([string]$p) {
    if (-not (Test-Path -LiteralPath $p)) { return $null }
    $lines = @(& icacls.exe $p 2>&1)
    if ($lines.Count -eq 0) { return 'UNKNOWN' }
    $hit = @($lines | Where-Object { $_ -match 'Mandatory Label' })
    if ($hit.Count -eq 0) {
        if (($lines -join ' ') -match 'Successfully processed') { return 'Medium(无标签)' }
        return 'UNKNOWN'
    }
    $f = $hit[0]
    if ($f -match 'Low Mandatory')    { return 'Low' }
    if ($f -match 'High Mandatory')   { return 'High' }
    if ($f -match 'Medium Mandatory') { return 'Medium' }
    return 'UNKNOWN'
}

# 目标目录下会被运行的 exe（有界扫描，跳过噪音目录）
function Find-Exes([string]$root) {
    Get-ChildItem -LiteralPath $root -Filter '*.exe' -File -Recurse -Depth 6 -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\(node_modules|deps|build|incremental|\.git)\\' }
}

function Show-State {
    $problems = 0
    foreach ($p in $Path) {
        $lab = Get-Label $p
        $mark = if ($lab -eq 'Low') { 'X ' } elseif ($lab -eq 'UNKNOWN') { '? ' } else { 'OK' }
        Write-Host ("  {0} {1,-52} {2}" -f $mark, $p, $lab)
        if ($lab -eq 'Low' -or $lab -eq 'UNKNOWN') { $problems++ }

        foreach ($f in (Find-Exes $p)) {
            $flab = Get-Label $f.FullName
            $fmark = if ($flab -eq 'Low') { 'X ' } elseif ($flab -eq 'UNKNOWN') { '? ' } else { 'OK' }
            $short = $f.FullName.Substring($p.Length).TrimStart('\')
            Write-Host ("     {0} {1,-49} {2}" -f $fmark, $short, $flab)
            if ($flab -eq 'Low' -or $flab -eq 'UNKNOWN') { $problems++ }
        }
    }
    return $problems
}

# ---------------------------------------------------------------- 检查
Step "目标目录：$($Path -join ' , ')"
Step '当前状态'
$problems = Show-State

if ($CheckOnly) {
    if ($problems -eq 0) { Ok '全部是 Medium' }
    else { Bad "有 $problems 项是 Low 或读不到（去掉 -CheckOnly 即可修复）" }
    exit 0
}

if ($problems -eq 0) { Ok '全部是 Medium，什么都没做'; exit 0 }

# ---------------------------------------------------------------- 修复
Step '修复'
if (-not $isAdmin) {
    Bad '没有管理员权限，无法把标签从 Low 提到 Medium'
    Info '双击 fix-integrity-label.cmd（会自动提权），或用管理员 PowerShell 再跑一次'
    exit 1
}

function Apply([string]$target, [string]$mode, [switch]$Recurse) {
    $icArgs = @($target, '/setintegritylevel', $mode)
    if ($Recurse) { $icArgs += @('/T', '/C') }
    $icArgs += '/Q'
    $out = @(& icacls.exe @icArgs 2>&1)
    $denied = @($out | Where-Object { $_ -match 'Access is denied|拒绝访问' }).Count
    $done   = @($out | Where-Object { $_ -match 'Successfully processed' })
    if ($denied -gt 0) { Bad "$target ：$denied 项被拒（可能被占用）" }
    elseif ($done.Count -gt 0) { Ok "$target → $($done[0].Trim())" }
    else { Info "$target ：无输出（可能被拦截）" }
}

foreach ($p in $Path) {
    Apply $p '(OI)(CI)Medium' -Recurse:$All
    foreach ($f in (Find-Exes $p)) { Apply $f.FullName 'Medium' }
}

# ---------------------------------------------------------------- 复检
Step '复检'
$left = Show-State

Step '结论'
if ($left -eq 0) {
    Ok '修好了，现在双击 exe 应该能正常启动'
    Info 'dsh 每次会话可能重新打标签 —— 每轮构建之后跑一次本脚本即可'
    exit 0
} else {
    Bad "还有 $left 项没修好"
    Info '常见原因：exe 正在运行 / 被安全软件占用。关掉进程后重跑，或重新编译一次再跑'
    exit 1
}
