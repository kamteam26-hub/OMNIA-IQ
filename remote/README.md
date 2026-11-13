# OMNIA IQ online (Vercel + your PC)

The website on Vercel is only the interface. The AI (Ollama models, FFmpeg, memory, files)
keeps running on your PC. This folder connects the two, safely and for free.

    Browser -> Vercel (password lock) -> Tailscale Funnel -> Caddy (secret key check) -> OMNIA IQ :8000

## One-time setup
1. Copy this `remote` folder into your OMNIA IQ folder on the PC (next to START_OMNIA.bat).
2. Run `SETUP_REMOTE.bat`. It installs Caddy + Tailscale, creates your secret key,
   signs you in to Tailscale and turns on Funnel. It prints OMNIA_BACKEND_URL and OMNIA_BACKEND_KEY.
3. In Vercel -> omnia-iq -> Settings -> Environment Variables add (Production):
   OMNIA_USER, OMNIA_PASSWORD, OMNIA_BACKEND_URL, OMNIA_BACKEND_KEY. Then redeploy.

## Every day
1. Start OMNIA IQ (START_OMNIA.bat).
2. Run `START_REMOTE.bat`.
3. Open https://omnia-iq.vercel.app and log in.
Run `STOP_REMOTE.bat` to take it off the internet.

## Limits
- Works only while the PC is on, awake and online.
- Vercel waits up to 2 minutes for a reply. Longer jobs (big video builds, Full harmony on
  large files) keep running on the PC; the page tells you to check again, and the Projects
  list refreshes itself every 20 seconds while a build is running.
- Never share omnia-remote.env. If it leaks, delete it, run SETUP_REMOTE.bat, and update
  OMNIA_BACKEND_KEY in Vercel.
