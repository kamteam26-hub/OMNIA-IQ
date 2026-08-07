param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$LogPath
)
$ErrorActionPreference='Stop'

function Write-Log([string]$Message) {
    $line="[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Write-Host $line
    for($i=0;$i -lt 10;$i++){
        try{[System.IO.File]::AppendAllText($LogPath,$line+[Environment]::NewLine);return}catch{Start-Sleep -Milliseconds 250}
    }
}
function Refresh-Path {
    $env:Path = ([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))
}
function Find-OllamaPath {
    Refresh-Path
    $cmd=Get-Command ollama.exe -ErrorAction SilentlyContinue
    if($cmd){return $cmd.Source}
    $saved=Join-Path $Root '.ollama_path'
    if(Test-Path $saved){$p=(Get-Content $saved -Raw).Trim();if(Test-Path $p){return $p}}
    foreach($p in @("$env:LOCALAPPDATA\Programs\Ollama\ollama.exe","$env:ProgramFiles\Ollama\ollama.exe")){if(Test-Path $p){return $p}}
    return $null
}
function Wait-Ollama([string]$Exe){
    for($i=0;$i -lt 30;$i++){
        try{
            $r=Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2
            return $true
        }catch{Start-Sleep -Seconds 1}
    }
    return $false
}

Set-Location $Root
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath -Parent) | Out-Null
$ollama = Find-OllamaPath
if(-not $ollama){throw 'Ollama is not installed or was not detected. Run INSTALL_OMNIA.bat first, then restart Windows if necessary.'}
Write-Log "Using Ollama at $ollama"

$ramBytes=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
$ramGB=[math]::Round($ramBytes/1GB)
Write-Log "Detected approximately $ramGB GB of RAM."

Write-Host ''
Write-Host 'Choose an OMNIA IQ local model profile:'
Write-Host '1. Light      Best for 8 GB systems and faster startup'
Write-Host '2. Balanced   Recommended for most 16 GB systems'
Write-Host '3. Full       More specialists for 32 GB or higher'
$default=if($ramGB -lt 12){'1'}elseif($ramGB -lt 28){'2'}else{'3'}
$choice=Read-Host "Profile [default $default]"
if([string]::IsNullOrWhiteSpace($choice)){$choice=$default}

switch($choice){
 '1' {$models=@('llama3.2:3b');$roles=@('generalist');$parallel=1}
 '3' {$models=@('gemma3:4b','qwen2.5:7b','llama3.2:3b','mistral:7b','deepseek-r1:7b');$roles=@('reasoner','engineer','creator','researcher','critic');$parallel=3}
 default {$models=@('gemma3:4b','qwen2.5:7b','llama3.2:3b');$roles=@('reasoner','engineer','creator');$parallel=2}
}

if(-not (Wait-Ollama $ollama)){
    Write-Log 'Starting Ollama service.'
    Start-Process -WindowStyle Hidden -FilePath $ollama -ArgumentList 'serve'
    if(-not (Wait-Ollama $ollama)){throw 'Ollama service did not start on http://127.0.0.1:11434.'}
}

foreach($model in $models){
    Write-Log "Pulling model $model. This can take time."
    & $ollama pull $model
    if($LASTEXITCODE -ne 0){Write-Log "WARNING: Could not pull $model. Retry later with: ollama pull $model"}
}

$envPath=Join-Path $Root '.env'
$content=@"
# OMNIA IQ v75 Local Orchestrator
OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODELS=$($models -join ',')
OLLAMA_MODEL_ROLES=$($roles -join ',')
OMNIA_ORCHESTRATION_MODE=adaptive
OMNIA_MAX_PARALLEL_MODELS=$parallel
OLLAMA_CONTEXT_SIZE=8192
OMNIA_MODEL_TIMEOUT_SECONDS=600
OMNIA_ENABLE_WEB_SEARCH=false
"@
Set-Content -Path $envPath -Value $content -Encoding UTF8
Write-Log "Saved the selected profile to .env."
Write-Log "Installed models: $($models -join ', ')"
exit 0
