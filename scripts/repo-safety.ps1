<#
.SYNOPSIS
  Sola Scholar repo-safety check. Read-only. Never prints secret values.

.DESCRIPTION
  Reports whether the working tree is safe to commit / deploy:
    - clean or dirty
    - changed / untracked / staged / ignored files
    - whether .env / backend/.env exist
    - whether .env / backend/.env are tracked (must NOT be)
    - whether risky files are staged
    - whether package.json / package-lock.json / railway.json changed
    - whether tests pass (optional, -RunTests)
    - whether a secrets risk exists
    - SAFE TO COMMIT / SAFE TO DEPLOY verdicts

  Exit code: 0 = safe to commit, 1 = not safe (blockers found).

.PARAMETER RunTests
  Also run `npm test` and factor the result into the verdict.

.EXAMPLE
  pwsh ./scripts/repo-safety.ps1
  pwsh ./scripts/repo-safety.ps1 -RunTests
#>
[CmdletBinding()]
param(
    [switch]$RunTests
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$blockers = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Section($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok($t)      { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn($t)    { Write-Host "  [WARN] $t" -ForegroundColor Yellow; $warnings.Add($t) }
function Block($t)   { Write-Host "  [STOP] $t" -ForegroundColor Red;    $blockers.Add($t) }

Write-Host "Sola Scholar - Repo Safety Check" -ForegroundColor White
Write-Host "Repo: $repoRoot"
Write-Host "Branch: $(git branch --show-current)"

# ---------------------------------------------------------------------------
# 1. Working tree state
# ---------------------------------------------------------------------------
Section "Working tree"
$porcelain = git status --porcelain
if (-not $porcelain) {
    Ok "Working tree clean"
} else {
    $count = ($porcelain | Measure-Object).Count
    Warn "Working tree DIRTY ($count entries)"
}

# Categorize
$staged    = git diff --name-only --cached
$changed   = git diff --name-only
$untracked = git ls-files --others --exclude-standard

Section "Staged files"
if ($staged)  { $staged  | ForEach-Object { Write-Host "  + $_" } } else { Write-Host "  (none)" }

Section "Changed (unstaged) files"
if ($changed) { $changed | ForEach-Object { Write-Host "  ~ $_" } } else { Write-Host "  (none)" }

Section "Untracked files"
if ($untracked) { $untracked | ForEach-Object { Write-Host "  ? $_" } } else { Write-Host "  (none)" }

# ---------------------------------------------------------------------------
# 2. Secret-file safety (never prints contents)
# ---------------------------------------------------------------------------
Section "Secret files"
$secretPaths = @('.env', 'backend/.env', '.env.local', 'backend/.env.local')
foreach ($p in $secretPaths) {
    $exists  = Test-Path $p
    git ls-files --error-unmatch $p *> $null
    $tracked = ($LASTEXITCODE -eq 0)
    if ($exists) { Write-Host "  $p exists: yes" } else { Write-Host "  $p exists: no" }
    if ($tracked) { Block "$p is TRACKED by git (must be ignored)" } else { Ok "$p not tracked" }
}

# Anything staged that looks like a secret?
$riskyPatterns = '(^|/)\.env($|\.)|secret|credential|\.key$|\.pem$|\.p12$|\.pfx$|service-account|adminsdk'
$riskyStaged = $staged | Where-Object { $_ -match $riskyPatterns }
if ($riskyStaged) {
    foreach ($r in $riskyStaged) { Block "Risky file STAGED: $r" }
} else {
    Ok "No risky/secret-looking files staged"
}

# Grep staged diff for obvious inline secrets (key names only; values not printed)
if ($staged) {
    $diffText = git diff --cached
    $leakHits = $diffText | Select-String -Pattern '(API_KEY|SECRET|PASSWORD|TOKEN|PAT)\s*=\s*\S' |
                Where-Object { $_ -notmatch '=\s*$' -and $_ -notmatch '=\s*<' -and $_ -notmatch '\.example' }
    if ($leakHits) {
        Block "Staged diff contains assigned secret-like values ($((($leakHits)|Measure-Object).Count) line(s)). Review before commit."
    } else {
        Ok "No assigned secret-like values in staged diff"
    }
}

# ---------------------------------------------------------------------------
# 3. Key file change detection
# ---------------------------------------------------------------------------
Section "Key files"
function FileState($f) {
    git ls-files --error-unmatch $f *> $null
    $tracked = ($LASTEXITCODE -eq 0)
    $dirty = ($porcelain | Where-Object { $_ -match [regex]::Escape($f) })
    if (-not (Test-Path $f)) { return "missing" }
    if (-not $tracked)       { return "UNTRACKED" }
    if ($dirty)              { return "changed" }
    return "tracked/clean"
}
foreach ($f in 'package.json','package-lock.json','railway.json','backend/server.js') {
    $s = FileState $f
    Write-Host ("  {0,-22} {1}" -f $f, $s)
    if ($s -eq 'UNTRACKED') { Warn "$f is untracked - include in commit plan" }
    if ($f -eq 'package-lock.json' -and $s -eq 'missing') { Warn "package-lock.json missing - run npm install" }
}

# ---------------------------------------------------------------------------
# 4. .gitignore sanity
# ---------------------------------------------------------------------------
Section ".gitignore sanity"
git check-ignore .env       *> $null; if ($LASTEXITCODE -eq 0) { Ok ".env is ignored" } else { Block ".env is NOT ignored" }
git check-ignore backend/.env *> $null; if ($LASTEXITCODE -eq 0) { Ok "backend/.env is ignored" } else { Block "backend/.env is NOT ignored" }
git check-ignore package-lock.json *> $null; if ($LASTEXITCODE -eq 0) { Warn "package-lock.json is ignored (Node app should track it)" } else { Ok "package-lock.json not ignored" }
git check-ignore node_modules *> $null; if ($LASTEXITCODE -eq 0) { Ok "node_modules is ignored" } else { Warn "node_modules is NOT ignored" }

# .env.example must exist and contain no assigned values
if (Test-Path '.env.example') {
    $assigned = Get-Content '.env.example' | Where-Object { $_ -match '^[A-Z0-9_]+=.+\S' -and $_ -notmatch '^[A-Z0-9_]+=(\./|3000|Matches|sola)\s*$' }
    if ($assigned) { Warn ".env.example has non-placeholder values on $((($assigned)|Measure-Object).Count) line(s) - verify they are safe defaults" }
    else { Ok ".env.example present, placeholders only" }
} else { Warn ".env.example missing" }

# ---------------------------------------------------------------------------
# 5. Tests (optional)
# ---------------------------------------------------------------------------
$testsPassed = $null
if ($RunTests) {
    Section "Tests"
    npm test *> $null
    if ($LASTEXITCODE -eq 0) { $testsPassed = $true; Ok "npm test passed" }
    else { $testsPassed = $false; Block "npm test FAILED (exit $LASTEXITCODE)" }
} else {
    Section "Tests"
    Write-Host "  (skipped - pass -RunTests to include)"
}

# ---------------------------------------------------------------------------
# 6. Vulnerabilities (prod)
# ---------------------------------------------------------------------------
Section "Vulnerabilities (prod deps)"
$auditJson = npm audit --omit=dev --json 2>$null | ConvertFrom-Json
if ($auditJson -and $auditJson.metadata) {
    $v = $auditJson.metadata.vulnerabilities
    $total = $v.critical + $v.high + $v.moderate + $v.low
    Write-Host "  critical=$($v.critical) high=$($v.high) moderate=$($v.moderate) low=$($v.low)"
    if ($v.critical -gt 0 -or $v.high -gt 0) { Block "Critical/high prod vulnerabilities present" }
    elseif ($total -gt 0) { Warn "$total non-critical prod vulnerabilities present" }
    else { Ok "0 prod vulnerabilities" }
} else { Warn "Could not parse npm audit output" }

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
Section "VERDICT"
$secretsRisk = ($blockers | Where-Object { $_ -match 'TRACKED|STAGED|secret-like' }).Count -gt 0
$safeCommit  = ($blockers.Count -eq 0)
$safeDeploy  = $safeCommit -and ($testsPassed -ne $false) -and (-not $porcelain -or $RunTests)

Write-Host ("  Secrets risk:   {0}" -f $(if ($secretsRisk) {'YES'} else {'no'}))
Write-Host ("  Safe to commit: {0}" -f $(if ($safeCommit)  {'YES'} else {'NO'}))
Write-Host ("  Safe to deploy: {0}" -f $(if ($safeDeploy)  {'YES'} else {'NO (review blockers/tests/dirty tree)'}))

if ($warnings.Count) { Write-Host ""; Write-Host "Warnings:" -ForegroundColor Yellow; $warnings | ForEach-Object { Write-Host "  - $_" } }
if ($blockers.Count) { Write-Host ""; Write-Host "Blockers:" -ForegroundColor Red;    $blockers | ForEach-Object { Write-Host "  - $_" } }

Write-Host ""
if ($safeCommit) { Write-Host "RESULT: safe to commit" -ForegroundColor Green; exit 0 }
else             { Write-Host "RESULT: NOT safe to commit" -ForegroundColor Red; exit 1 }
