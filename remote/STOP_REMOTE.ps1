# OMNIA IQ - take OMNIA offline from the internet (local use keeps working).
tailscale funnel reset
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host 'OMNIA IQ is no longer reachable from the internet.' -ForegroundColor Yellow
Read-Host 'Press Enter to close'
