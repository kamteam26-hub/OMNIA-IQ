# OMNIA IQ - one-time setup so the Vercel website can reach OMNIA IQ on this PC.
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$EnvFile = Join-Path $Here 'omnia-remote.env'
Write-Host "`n=== OMNIA IQ remote setup ===`n" -ForegroundColor Cyan

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

if (-not (Have 'winget')) { throw 'Windows Package Manager (winget) is missing. Install "App Installer" from the Microsoft Store, then run this again.' }

if (-not (Have 'caddy')) {
    Write-Host 'Installing Caddy (gatekeeper)...'
    winget install --id CaddyServer.Caddy -e --accept-source-agreements --accept-package-agreements
}
if (-not (Have 'tailscale')) {
    Write-Host 'Installing Tailscale (free secure public address)...'
    winget install --id Tailscale.Tailscale -e --accept-source-agreements --accept-package-agreements
}
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
if (-not (Have 'caddy') -or -not (Have 'tailscale')) { throw 'Caddy or Tailscale was installed but is not visible yet. Close this window and run SETUP_REMOTE.bat again.' }

if (-not (Test-Path $EnvFile)) {
    $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $key = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    "OMNIA_BACKEND_KEY=$key" | Set-Content -Path $EnvFile -Encoding ASCII
    Write-Host 'Created a new secret key in omnia-remote.env' -ForegroundColor Green
}
$key = ((Get-Content $EnvFile | Where-Object { $_ -like 'OMNIA_BACKEND_KEY=*' }) -replace '^OMNIA_BACKEND_KEY=','').Trim()

Write-Host "`nSigning this PC in to Tailscale (a browser window may open - log in with Google/Microsoft/GitHub)..."
tailscale up
Write-Host "`nTurning on Tailscale Funnel. If it prints a link, open it, click Enable, then press Enter here."
tailscale funnel --bg 8787
Read-Host 'Press Enter to continue'
tailscale funnel --bg 8787 | Out-Null

$dns = ((tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
Write-Host "`n=== Copy these into Vercel -> omnia-iq -> Settings -> Environment Variables ===`n" -ForegroundColor Yellow
Write-Host "OMNIA_BACKEND_URL = https://$dns"
Write-Host "OMNIA_BACKEND_KEY = $key"
Write-Host "`nAlso add OMNIA_USER and OMNIA_PASSWORD (your website login), then redeploy."
Write-Host "From now on, start everything with START_REMOTE.bat`n" -ForegroundColor Green
