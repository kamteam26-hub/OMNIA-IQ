# OMNIA IQ v75 Local Orchestrator

OMNIA IQ is a free-only local AI assistant that coordinates multiple Ollama models as specialist workers, a critic, and a final conductor.

## New in v75

- Guided Windows installer with logs
- Python 3.10+ and Ollama detection
- Optional automatic installation through Windows Package Manager
- First-run model profile wizard based on available RAM
- Automatic local model download
- Dependency verification and system-check report
- Desktop and Start Menu shortcuts
- One-click dependency and model updater
- Runtime, installer, setup, update, and diagnostic logs
- Adaptive orchestration enabled by default

## Install

1. Extract the ZIP to a permanent folder.
2. Run `INSTALL_OMNIA.bat`.
3. Allow the first-run wizard to select and download a model profile.
4. Run `START_OMNIA.bat`.

If Python or Ollama is installed automatically, close the installer and run it again so Windows can refresh PATH.

## Utility files

- `FIRST_RUN_SETUP.bat` changes the local model profile.
- `CHECK_OMNIA.bat` verifies Python, Ollama, dependencies, models, and `.env`.
- `UPDATE_OMNIA.bat` updates Python packages and refreshes configured Ollama models.
- `CREATE_SHORTCUTS.bat` creates Desktop and Start Menu launch shortcuts.

## Profiles

- Light: one local generalist model
- Balanced: reasoner, engineer, and creator
- Full: reasoner, engineer, creator, researcher, and critic

The Full profile can require substantial RAM, storage, and processing time. The orchestrator automatically falls back to available models when one fails.


## v77 installer fix

Removed the stale temporary lock-file check that could incorrectly report that another installer was running after a previous interrupted installation. The installer can now be rerun normally.

## v78 installer correction

- Uses one installer only: `INSTALL_OMNIA.bat`.
- Removed duplicate ONMIA installer entry points.
- Restored the product name, logo, and frontend text to **OMNIA IQ**.
- Pip self-upgrade is no longer a fatal installation step.


## Performance modes
- Fast local (default): uses one task-matched local model for the quickest response.
- Full harmony: toggle it in the header to use up to three local models plus synthesis. This is slower but useful for complex work.


## Attached project processing

Files attached beside the chat box are now sent with the prompt. OMNIA IQ can directly inspect text/code files and safely inspect ZIP project archives using a bounded manifest plus selected source contents. Attachment-only submission is supported. Large generated folders such as node_modules, .git, build, dist, virtual environments, and caches are skipped to keep local-model context responsive.

## v81.1 reliability fix
- Prevents local RAM spikes by running Harmony specialists sequentially.
- Automatically uses one task-matched model for large or binary-only attachments.
- Streams uploads instead of loading the complete file into backend memory.
- Adds clearer connection and timeout errors instead of the generic `Failed to fetch` message.
- Video files are safely routed with honest capability reporting. Frame/audio analysis still requires a media-processing integration.

## OMNIA IQ v82 Autonomous Production + Long-Term Memory

- Projects that request a video, reel, MP4, explainer, or training video can now render a real MP4 locally.
- The renderer uses Pillow, FFmpeg, and optional eSpeak narration. FFmpeg and eSpeak must be available on PATH.
- Completed video files appear as downloadable task artifacts.
- Long-term memory stores durable conversation knowledge, manual teachings, and completed project outcomes in SQLite.
- Relevant memories are retrieved for new requests using local keyword relevance. Users can inspect and delete memories in the Memory tab.
- Memory is a retrieval system, not human consciousness or unrestricted self-modification. It does not silently alter application code or bypass approval controls.

## v82.1 systematic architecture repair

- API routes are separated into System, Chat, Files, Projects, and Memory modules.
- Video production is loaded only when a project actually requests video, so a missing optional media dependency no longer prevents OMNIA IQ from starting.
- The frontend uses versioned static assets to prevent an old cached interface from hiding new navigation and pages.
- Each frontend panel loads independently. A Files or Memory error no longer blocks Chat, Projects, or provider status.
- The Windows launcher starts the backend first, waits for the health endpoint, and only then opens the browser.
- All long-running requests use centralized timeouts and clearer connection errors.

Primary health endpoint: `GET /api/system/health`


## v82.2 Windows launcher fix

- Fixed the PowerShell `Start-Process` crash caused by assigning the same file to both `RedirectStandardOutput` and `RedirectStandardError`.
- Backend standard output and errors now use separate log files.
- Startup failures are merged into `logs/runtime.log` for easier diagnosis.
- The launcher reuses an already healthy backend instead of creating a duplicate instance.
- The backend health-check wait was increased to 60 seconds for slower computers.

## Integrated video runtime

OMNIA IQ v83.1 resolves FFmpeg in this order:

1. `OMNIA_FFMPEG_PATH` and `OMNIA_FFPROBE_PATH`
2. `tools/ffmpeg/bin`
3. Windows or system `PATH`
4. Common WinGet installation locations

Open **Settings → Video Production Runtime** to verify or install FFmpeg. The project engine now passes the resolved executable path directly to the renderer, so a global PATH entry is not required when the binaries are bundled in `tools/ffmpeg/bin`.

`ffmpeg-snapshot.tar.bz2` contains source code and is not a runnable Windows binary. Use the Settings installer, `INSTALL_MEDIA_RUNTIME.bat`, or copy prebuilt `ffmpeg.exe` and `ffprobe.exe` into the bundled runtime folder.

## Local speech engine
OMNIA IQ now supports Piper neural text-to-speech for narrated video production. Open Settings and choose **Install Piper speech engine**. A starter ONNX voice model is bundled in `tools/piper/voices`. You can replace it with another compatible Piper `.onnx` model and matching `.onnx.json` file, or set `OMNIA_PIPER_MODEL` in `.env`.
