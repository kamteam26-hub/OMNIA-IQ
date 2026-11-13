# OMNIA IQ - start the gatekeeper + public address. Run AFTER OMNIA IQ itself is running.
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$EnvFile = Join-Path $Here 'omnia-remote.env'
if (-not (Test-Path $EnvFile)) { throw 'Run SETUP_REMOTE.bat first.' }
$key = ((Get-Content $EnvFile | Where-Object { $_ -like 'OMNIA_BACKEND_KEY=*' }) -replace '^OMNIA_BACKEND_KEY=','').Trim()
if ($key.Length -lt 32) { throw 'The key in omnia-remote.env is missing or too short. Delete the file and run SETUP_REMOTE.bat again.' }
$env:OMNIA_BACKEND_KEY = $key

try { Invoke-RestMethod 'http://127.0.0.1:8000/api/system/health' -TimeoutSec 5 | Out-Null; Write-Host 'OMNIA IQ backend: running' -ForegroundColor Green }
catch { Write-Host 'OMNIA IQ backend is NOT running on port 8000. Start OMNIA IQ (START_OMNIA.bat) first, then run this again.' -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }

Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force
$log = Join-Path $Here 'caddy.log'
Start-Process -FilePath 'caddy' -ArgumentList @('run','--config',(Join-Path $Here 'Caddyfile'),'--adapter','caddyfile') -WindowStyle Hidden -RedirectStandardError $log
Start-Sleep -Seconds 2
if (-not (Get-Process caddy -ErrorAction SilentlyContinue)) { Write-Host "Caddy failed to start. See $log" -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }
Write-Host 'Gatekeeper (Caddy): running on 127.0.0.1:8787' -ForegroundColor Green

tailscale funnel --bg 8787 | Out-Null
$dns = ((tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd('.')
Write-Host "Public address: https://$dns  (only your Vercel site can use it)" -ForegroundColor Green
Write-Host "`nOMNIA IQ is now reachable from your Vercel website. Keep this PC on and awake."
Read-Host 'Press Enter to close this window (OMNIA stays online)'
