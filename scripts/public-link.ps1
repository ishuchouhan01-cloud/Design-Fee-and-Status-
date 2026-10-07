# ===========================================================================
#  PROJECT DRAWING STATUS - share a public test link from this laptop
#
#  Started by START-PUBLIC-LINK.bat. Free, no account, no router or firewall
#  change: a Cloudflare Quick Tunnel (cloudflared) gives an https link like
#  https://random-words.trycloudflare.com that reaches the app on this laptop.
#
#    1. makes sure the app is running (starts it in its own window if not)
#    2. makes sure a Viewer password is set (the link is public)
#    3. gets cloudflared (tools\cloudflared.exe) the first time
#    4. opens the tunnel, shows the link and copies it to the clipboard
#    5. keeps the laptop awake while this window is open
#
#  Close this window (or press Ctrl+C) to stop sharing. The app keeps running.
#  The link changes every time. For testing only: no uptime guarantee.
#  Windows PowerShell 5.1 compatible. ASCII only.
# ===========================================================================

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Tools = Join-Path $Root 'tools'
if (-not (Test-Path $Tools)) { New-Item -ItemType Directory -Path $Tools | Out-Null }

function Say([string]$text = '') { Write-Host "  $text" }
function Step([string]$text) { Write-Host ''; Write-Host "  >> $text" -ForegroundColor Cyan }
function Fail([string]$text) {
  Write-Host ''
  Write-Host "  $text" -ForegroundColor Red
  Write-Host ''
  Read-Host '  Press Enter to close'
  exit 1
}
function AskYes([string]$question) {
  $a = Read-Host "  $question (Y/N)"
  return ($a -match '^(y|yes)$')
}

Write-Host ''
Write-Host '  ============================================'
Write-Host '   PROJECT DRAWING STATUS - public test link'
Write-Host '  ============================================'

# --- the port the app uses (.env PORT, else 3100) --------------------------
$Port = 3100
if (Test-Path (Join-Path $Root '.env')) {
  $line = Get-Content (Join-Path $Root '.env') | Where-Object { $_ -match '^\s*PORT\s*=\s*"?(\d+)"?\s*$' } | Select-Object -First 1
  if ($line -and ($line -match '(\d+)')) { $Port = [int]$Matches[1] }
}
$Local = "http://127.0.0.1:$Port"

function AppUp {
  try {
    $r = Invoke-WebRequest -Uri "$Local/api/health" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# --- 1. the app ------------------------------------------------------------
Step "Checking the app on $Local"
if (-not (AppUp)) {
  Say 'The app is not running. Starting it in its own window...'
  Start-Process -FilePath (Join-Path $Root 'START-PROJECT-DRAWING-STATUS.bat') -WorkingDirectory $Root
  $deadline = (Get-Date).AddMinutes(15)
  while (-not (AppUp)) {
    if ((Get-Date) -gt $deadline) { Fail 'The app did not start within 15 minutes. Look at the Project Drawing Status window for the reason.' }
    Start-Sleep -Seconds 5
    Write-Host '.' -NoNewline
  }
  Write-Host ''
}
Say 'The app is running.'

# --- 2. passwords ----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js was not found on this computer.' }
$Tsx = Join-Path $Root 'node_modules\tsx\dist\cli.mjs'
$Logins = Join-Path $Root 'scripts\logins-set.ts'

function LoginStatus {
  $out = & node $Tsx $Logins --status 2>$null
  $json = $out | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
  if (-not $json) { return $null }
  return ($json | ConvertFrom-Json)
}

Step 'Checking sign-in passwords'
$status = LoginStatus
if ($null -eq $status) { Fail 'Could not read the sign-in set-up from the database.' }
if (-not $status.VIEWER) {
  Say 'Anyone who has the link can open the sign-in page, and today the Viewer'
  Say 'signs in with one click. A public link needs a Viewer password.'
  Say 'Give it only to your testers. (To remove it later:'
  Say '  npm run logins:set -- --role VIEWER --remove )'
  if (-not (AskYes 'Set a Viewer password now?')) { Fail 'No link was opened: a Viewer password is needed first.' }
  & node $Tsx $Logins --role VIEWER
  $status = LoginStatus
  if (-not $status.VIEWER) { Fail 'The Viewer password was not set. No link was opened.' }
}
Say 'Viewer password: set.'

# The running app must enforce it (an app started before this update would not).
$enforced = $false
try {
  Invoke-WebRequest -Uri "$Local/api/auth/login" -Method Post -ContentType 'application/json' -Body '{"role":"VIEWER"}' -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop | Out-Null
} catch {
  if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $enforced = $true }
}
if (-not $enforced) {
  Fail ('The running app still lets the Viewer in without a password: it was started before this update. ' +
        'Close the Project Drawing Status window, then run START-PUBLIC-LINK.bat again (it starts the app itself).')
}
Say 'Checked: the app asks the Viewer for the password.'
if (-not $status.ADMIN -or -not $status.SUPER_ADMIN) { Fail 'The Admin or Super Admin password is not set (npm run logins:set).' }
Say 'Admin and Super Admin are protected by their passwords and a lock after'
Say 'repeated wrong attempts. Use long passwords before sharing a public link.'
if (AskYes 'Change the Admin password now?') { & node $Tsx $Logins --role ADMIN }
if (AskYes 'Change the Super Admin password now?') { & node $Tsx $Logins --role SUPER_ADMIN }

# --- 3. cloudflared --------------------------------------------------------
Step 'Getting cloudflared'
$Cf = Join-Path $Tools 'cloudflared.exe'
if (-not (Test-Path $Cf)) {
  $found = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($found) { $Cf = $found.Source }
}
if (-not (Test-Path $Cf)) {
  Say 'Downloading cloudflared from Cloudflare (github.com/cloudflare/cloudflared)...'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    $arch = 'amd64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'x86') { $arch = '386' }
    Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" -OutFile $Cf -ErrorAction Stop
  } catch {
    if (Test-Path $Cf) { Remove-Item $Cf -Force }
    Say 'The download did not work. Trying winget...'
    try { & winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements | Out-Host } catch { }
    $found = Get-Command cloudflared -ErrorAction SilentlyContinue
    if ($found) { $Cf = $found.Source }
  }
}
if (-not (Test-Path $Cf)) {
  Fail ('cloudflared could not be downloaded (the network may block it). Download ' +
        'cloudflared-windows-amd64.exe from https://github.com/cloudflare/cloudflared/releases, ' +
        'rename it to cloudflared.exe, put it in the tools folder, and run this again.')
}
Say "cloudflared: $Cf"

# --- 4. the tunnel ---------------------------------------------------------
Step 'Opening the public link'
$LogErr = Join-Path $Tools 'cloudflared.log'
$LogOut = Join-Path $Tools 'cloudflared.out.log'
foreach ($f in @($LogErr, $LogOut)) { if (Test-Path $f) { Remove-Item $f -Force } }
$proc = Start-Process -FilePath $Cf -ArgumentList @('tunnel', '--no-autoupdate', '--url', $Local) `
  -RedirectStandardError $LogErr -RedirectStandardOutput $LogOut -NoNewWindow -PassThru

$Url = $null
$deadline = (Get-Date).AddSeconds(90)
while (-not $Url) {
  if ($proc.HasExited) { break }
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Seconds 2
  foreach ($f in @($LogErr, $LogOut)) {
    if (Test-Path $f) {
      $m = Select-String -Path $f -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -First 1
      if ($m) { $Url = $m.Matches[0].Value }
    }
  }
}
if (-not $Url) {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  $tail = ''
  if (Test-Path $LogErr) { $tail = (Get-Content $LogErr -Tail 8) -join "`n    " }
  Fail ("The tunnel did not open. If a file config.yml or config.yaml exists in " +
        "$env:USERPROFILE\.cloudflared, rename it and try again. Office networks can also block it. " +
        "Last lines of tools\cloudflared.log:`n    $tail")
}

Set-Content -Path (Join-Path $Tools 'public-link.txt') -Value $Url
try { Set-Clipboard -Value $Url } catch { }

# --- 5. keep the laptop awake while sharing ---------------------------------
try {
  Add-Type -ErrorAction Stop -Namespace Pds -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
  [Pds.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED
} catch { }

Write-Host ''
Write-Host '  ============================================================' -ForegroundColor Green
Write-Host "   PUBLIC LINK:  $Url" -ForegroundColor Green
Write-Host '  ============================================================' -ForegroundColor Green
Say '(copied to the clipboard; also saved in tools\public-link.txt)'
Say ''
Say 'Send testers the link and the Viewer password (separately).'
Say 'Admin / Super Admin passwords: only to the people who need them.'
Say 'Keep this window open, the laptop on and online, and the lid open.'
Say 'The link changes each time this is started.'
Say 'To stop sharing: close this window or press Ctrl+C.'
Write-Host ''

try {
  while (-not $proc.HasExited) { Start-Sleep -Seconds 5 }
  Write-Host ''
  Say 'The tunnel stopped. Run START-PUBLIC-LINK.bat again for a new link.'
} finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  try { [Pds.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null } catch { }
  if (Test-Path (Join-Path $Tools 'public-link.txt')) { Remove-Item (Join-Path $Tools 'public-link.txt') -Force }
}
Read-Host '  Press Enter to close'
