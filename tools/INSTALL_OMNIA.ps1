param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$LogPath
)
$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
    $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
    Write-Host $line
    try {
        $dir = Split-Path $LogPath -Parent
        if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        [System.IO.File]::AppendAllText($LogPath, $line + [Environment]::NewLine)
    } catch {
        Write-Warning "Log write skipped: $($_.Exception.Message)"
    }
}

function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
    $user = [Environment]::GetEnvironmentVariable('Path','User')
    $env:Path = "$machine;$user"
}

function Find-Python {
    try {
        $exe = & py -3.10 -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $exe) { return @{ Command='py'; Args=@('-3.10') } }
    } catch {}
    try {
        $ok = & python -c "import sys; print(sys.version_info >= (3,10))" 2>$null
        if ($LASTEXITCODE -eq 0 -and $ok -match 'True') { return @{ Command='python'; Args=@() } }
    } catch {}
    return $null
}

function Find-OllamaPath {
    Refresh-Path
    $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
        "$env:LOCALAPPDATA\Ollama\ollama.exe",
        "$env:ProgramFiles\Ollama\ollama.exe"
    )
    foreach ($path in $candidates) { if (Test-Path $path) { return $path } }
    return $null
}

function Run-ProcessWithTimeout {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [string[]]$Arguments=@(),
        [int]$TimeoutSeconds=600
    )
    $stdout = Join-Path $env:TEMP ("omnia_out_" + [guid]::NewGuid().ToString('N') + '.log')
    $stderr = Join-Path $env:TEMP ("omnia_err_" + [guid]::NewGuid().ToString('N') + '.log')
    try {
        $proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill() } catch {}
            Write-Log "Process timed out after $TimeoutSeconds seconds: $FilePath"
            return 124
        }
        if (Test-Path $stdout) { Get-Content $stdout -ErrorAction SilentlyContinue | ForEach-Object { if($_){Write-Log $_} } }
        if (Test-Path $stderr) { Get-Content $stderr -ErrorAction SilentlyContinue | ForEach-Object { if($_){Write-Log $_} } }
        $proc.Refresh()
        return [int]$proc.ExitCode
    } finally {
        Remove-Item $stdout,$stderr -Force -ErrorAction SilentlyContinue
    }
}

function Install-WithWinget([string]$Id,[int]$TimeoutSeconds=420) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (-not $winget) { Write-Log 'winget is unavailable.'; return $false }
    Write-Log "Installing $Id with winget. This can take several minutes."
    $args = @('install','--id',$Id,'--exact','--source','winget','--accept-package-agreements','--accept-source-agreements','--silent','--disable-interactivity')
    $exitCode = Run-ProcessWithTimeout -FilePath $winget.Source -Arguments $args -TimeoutSeconds $TimeoutSeconds
    Write-Log "winget exit code: $exitCode"
    return ($exitCode -eq 0 -or $exitCode -eq -1978335189)
}

function Install-OllamaDirect {
    $installer = Join-Path $env:TEMP 'OllamaSetup.exe'
    try {
        Write-Log 'Downloading the official Ollama Windows installer.'
        Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile $installer -UseBasicParsing -TimeoutSec 180
        if (-not (Test-Path $installer)) { return $false }
        Write-Log 'Running the Ollama installer.'
        $code = Run-ProcessWithTimeout -FilePath $installer -Arguments @('/S') -TimeoutSeconds 600
        if ($code -ne 0) {
            Write-Log 'Silent install did not complete. Launching the installer interactively.'
            Start-Process -FilePath $installer -Wait
        }
        Refresh-Path
        Start-Sleep -Seconds 5
        return [bool](Find-OllamaPath)
    } catch {
        Write-Log "Direct Ollama installation failed: $($_.Exception.Message)"
        return $false
    }
}

Set-Location $Root
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath -Parent) | Out-Null
Write-Log 'Starting OMNIA IQ installation.'
Write-Log 'Checking Windows prerequisites.'

$python = Find-Python
if (-not $python) {
    Write-Log 'Python 3.10+ was not found.'
    if (-not (Install-WithWinget 'Python.Python.3.12' 600)) {
        Start-Process 'https://www.python.org/downloads/windows/'
        throw 'Python could not be installed automatically. Install Python 3.10 or newer, enable Add Python to PATH, then run the installer again.'
    }
    Refresh-Path
    Start-Sleep -Seconds 3
    $python = Find-Python
    if (-not $python) { throw 'Python was installed but is not visible yet. Restart Windows, then run INSTALL_OMNIA.bat again.' }
}
Write-Log 'Python 3.10+ detected.'

$ollamaPath = Find-OllamaPath
if (-not $ollamaPath) {
    Write-Log 'Ollama was not found.'
    $installed = Install-WithWinget 'Ollama.Ollama' 420
    Refresh-Path
    Start-Sleep -Seconds 5
    $ollamaPath = Find-OllamaPath
    if (-not $ollamaPath) {
        Write-Log 'winget did not finish the Ollama installation. Trying the official installer.'
        $installed = Install-OllamaDirect
        $ollamaPath = Find-OllamaPath
    }
    if (-not $ollamaPath) {
        Start-Process 'https://ollama.com/download/windows'
        throw 'Ollama installation was not completed. Finish the Ollama installer that opened, restart Windows if requested, then run INSTALL_OMNIA.bat again.'
    }
}
Write-Log "Ollama detected at $ollamaPath."

$venv = Join-Path $Root 'venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    Write-Log 'Creating isolated Python environment.'
    if ($python.Command -eq 'py') { & py @($python.Args + @('-m','venv',$venv)) }
    else { & python -m venv $venv }
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Python virtual environment.' }
}

Write-Log 'Preparing pip.'
$code = Run-ProcessWithTimeout -FilePath $venvPython -Arguments @('-m','ensurepip','--upgrade') -TimeoutSeconds 300
if ($code -ne 0) { Write-Log 'ensurepip returned a non-zero code; continuing with the existing pip installation.' }

# A pip self-upgrade is optional. Some Windows installations return a stale/non-zero
# process code even after pip upgrades successfully, so it must not abort OMNIA IQ setup.
Write-Log 'Checking pip availability.'
$code = Run-ProcessWithTimeout -FilePath $venvPython -Arguments @('-m','pip','--version') -TimeoutSeconds 120
if ($code -ne 0) { throw 'pip is unavailable inside the virtual environment.' }

Write-Log 'Installing OMNIA IQ dependencies.'
$code = Run-ProcessWithTimeout -FilePath $venvPython -Arguments @('-m','pip','install','-r',(Join-Path $Root 'requirements.txt')) -TimeoutSeconds 1200
if ($code -ne 0) { throw 'Dependency installation failed.' }

if (-not (Test-Path (Join-Path $Root '.env'))) {
    Copy-Item (Join-Path $Root '.env.example') (Join-Path $Root '.env')
    Write-Log 'Created .env from .env.example.'
}
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data\uploads') | Out-Null

Write-Log 'Verifying Python dependencies.'
$code = Run-ProcessWithTimeout -FilePath $venvPython -Arguments @('-c',"import fastapi,uvicorn,httpx,dotenv,multipart; print('Dependencies verified')") -TimeoutSeconds 120
if ($code -ne 0) { throw 'Dependency verification failed.' }

Set-Content -Path (Join-Path $Root '.ollama_path') -Value $ollamaPath -Encoding ASCII
Write-Log 'OMNIA IQ base installation is ready.'
exit 0
