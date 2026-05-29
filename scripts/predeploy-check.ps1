<#
.SYNOPSIS
  Sola Scholar pre-deploy gate. Read-only. Blocks unsafe production deploys.

.DESCRIPTION
  Runs the full deployment-safety checklist and prints a deploy report.
  It NEVER deploys, commits, pushes, or reads secret values. It only reports
  whether a deploy SHOULD be allowed by a human approver.

  Checks:
    1. Repo safety (delegates to repo-safety.ps1)
    2. Tests pass (npm test)
    3. Prod vulnerabilities = 0
    4. railway.json present + healthcheck configured
    5. Basic Auth code present (requireAuth + INTERNAL_PASSWORD gate)
    6. Provider config sanity (server boots, /api/health responds locally)
    7. Approved-file check (only expected paths changed)

  Exit code: 0 = all gates pass (human may approve deploy), 1 = blocked.

.PARAMETER SkipLocalBoot
  Skip the local server boot + /api/health probe (step 6).

.EXAMPLE
  pwsh ./scripts/predeploy-check.ps1
#>
[CmdletBinding()]
param([switch]$SkipLocalBoot)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$blockers = New-Object System.Collections.Generic.List[string]
function Section($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok($t)      { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Block($t)   { Write-Host "  [STOP] $t" -ForegroundColor Red; $blockers.Add($t) }

Write-Host "Sola Scholar - Pre-Deploy Gate" -ForegroundColor White
Write-Host "Branch: $(git branch --show-current)"
Write-Host "Target: production (Railway) — DEPLOY REQUIRES HUMAN APPROVAL"

# 1. Repo safety -------------------------------------------------------------
Section "1. Repo safety"
& "$PSScriptRoot\repo-safety.ps1" | Out-Null
if ($LASTEXITCODE -ne 0) { Block "Repo not safe to commit (run scripts/repo-safety.ps1 for detail)" }
else { Ok "Repo safety passed" }

# 2. Tests -------------------------------------------------------------------
Section "2. Tests"
npm test *> $null
if ($LASTEXITCODE -eq 0) { Ok "npm test passed" } else { Block "npm test FAILED" }

# 3. Vulnerabilities (prod) --------------------------------------------------
Section "3. Vulnerabilities (prod)"
$audit = npm audit --omit=dev --json 2>$null | ConvertFrom-Json
$v = $audit.metadata.vulnerabilities
if ($v.critical -gt 0 -or $v.high -gt 0) { Block "Critical/high prod vulnerabilities present" }
else { Ok "0 critical/high prod vulnerabilities (moderate=$($v.moderate) low=$($v.low))" }

# 4. railway.json ------------------------------------------------------------
Section "4. Railway config"
if (Test-Path railway.json) {
    $rj = Get-Content railway.json -Raw | ConvertFrom-Json
    if ($rj.deploy.healthcheckPath -eq '/api/health') { Ok "healthcheckPath = /api/health" }
    else { Block "railway.json healthcheckPath is not /api/health" }
    if ($rj.deploy.startCommand) { Ok "startCommand: $($rj.deploy.startCommand)" }
    else { Block "railway.json missing startCommand" }
} else { Block "railway.json missing" }

# 5. Basic Auth code present -------------------------------------------------
Section "5. Basic Auth protection"
$srv = Get-Content backend/server.js -Raw
if ($srv -match 'function requireAuth' -and $srv -match "app\.use\('/api', requireAuth\)") { Ok "requireAuth middleware wired to /api" }
else { Block "Basic Auth middleware not found / not wired" }
if ($srv -match 'INTERNAL_PASSWORD' -and $srv -match 'Refusing to expose API without auth') { Ok "Server refuses to serve API when INTERNAL_PASSWORD blank" }
else { Block "INTERNAL_PASSWORD safety gate not found" }
if ($srv -match 'timingSafeEqual') { Ok "Credential comparison is timing-safe" }
else { Block "Credential comparison not timing-safe" }

# 6. Local boot + health -----------------------------------------------------
Section "6. Local boot + /api/health"
if ($SkipLocalBoot) {
    Write-Host "  (skipped via -SkipLocalBoot)"
} else {
    $env:INTERNAL_USER = 'sola'
    $env:INTERNAL_PASSWORD = 'predeploy_local_probe'   # ephemeral, never committed
    $env:PORT = '8231'
    $env:DATA_PATH = './data'
    $proc = Start-Process node -ArgumentList 'backend/server.js' -PassThru -NoNewWindow `
        -RedirectStandardOutput '.predeploy.out' -RedirectStandardError '.predeploy.err'
    try {
        Start-Sleep -Seconds 2
        $r = Invoke-WebRequest 'http://127.0.0.1:8231/api/health' -UseBasicParsing -TimeoutSec 5
        $j = $r.Content | ConvertFrom-Json
        if ($j.status -eq 'ok' -and $j.auth -eq 'enabled') { Ok "Server boots; /api/health ok; auth enabled" }
        else { Block "Health responded but status/auth unexpected" }
        # health must never leak values
        if ($r.Content -match '(sk-|key=|token=|password)') { Block "Health response may contain a secret-like token" }
        else { Ok "Health response contains no secret-like values" }
    } catch {
        Block "Server failed to boot or /api/health unreachable: $($_.Exception.Message)"
    } finally {
        if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
        Remove-Item .predeploy.out, .predeploy.err -ErrorAction SilentlyContinue
    }
}

# 7. Approved-file check -----------------------------------------------------
Section "7. Approved-file check"
# Anything changed/untracked outside these paths needs explicit review before deploy.
$approved = @('backend/', 'test/', 'config/', 'scripts/', 'docs/',
              'package.json', 'package-lock.json', 'railway.json',
              '.gitignore', '.env.example', 'README.md')
$changedAll = @()
$changedAll += git diff --name-only
$changedAll += git diff --name-only --cached
$changedAll += git ls-files --others --exclude-standard
$changedAll = $changedAll | Sort-Object -Unique
$unexpected = $changedAll | Where-Object { $p = $_; -not ($approved | Where-Object { $p -like "$_*" }) }
if ($unexpected) { $unexpected | ForEach-Object { Block "Unexpected changed path (review before deploy): $_" } }
else { Ok "All changed/untracked files are within approved paths" }

# Verdict --------------------------------------------------------------------
Section "DEPLOY VERDICT"
if ($blockers.Count -eq 0) {
    Write-Host "  All automated gates PASSED." -ForegroundColor Green
    Write-Host "  This does NOT auto-deploy. A human must:" -ForegroundColor Yellow
    Write-Host "   - confirm Railway production env vars are set (INTERNAL_PASSWORD + provider keys)"
    Write-Host "   - confirm the target service: happy-motivation / production / hospitable-trust"
    Write-Host "   - approve and trigger the deploy manually"
    Write-Host ""
    Write-Host "RESULT: SAFE TO REQUEST DEPLOY APPROVAL" -ForegroundColor Green
    exit 0
} else {
    Write-Host "Blockers:" -ForegroundColor Red
    $blockers | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "RESULT: DEPLOY BLOCKED" -ForegroundColor Red
    exit 1
}
