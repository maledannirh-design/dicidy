# DICIDY Flow Automation — POC

This is a **local** proof-of-concept. It is not deployed to GitHub Pages.

## Purpose

DICIDY Content Factory creates a JSON job queue:

DICIDY → job.json → Playwright → ChatGPT → Google Flow → Veo

The browser uses a dedicated local Chrome profile. The user signs into ChatGPT and Google Flow manually once. DICIDY does not receive or store either password.

## Setup

1. Install Node.js 20+.
2. In this folder run:

```
npm install
npx playwright install
```

3. Copy a Content Factory job JSON into this folder as `job.json`.
4. Run:

```
npm start
```

5. The first run opens a visible Chrome window. Sign in manually if needed.
6. The worker processes the queue one job at a time.

## Current POC behavior

- Uses a persistent local browser profile at `./profiles/dicidy-flow`.
- Opens ChatGPT and Google Flow in separate tabs.
- Sends a prompt to ChatGPT to compile a Flow-ready video prompt.
- Reads the latest assistant response.
- Opens Google Flow and attempts to place the compiled prompt into a text input.
- Stops before automatic submission if the Flow UI cannot be identified reliably.

This deliberate stop is important: Google Flow's UI changes over time, so selectors must be verified against the live account before enabling automatic generation.

## Security

- Never put ChatGPT or Google passwords into job.json.
- Never put API keys or client secrets into this folder.
- The browser session stays on the user's machine.
- Do not commit `job.json` or `profiles/` to Git.

## Next POC step

After one successful manual Flow submission is observed, add a versioned Flow adapter for the exact live UI selectors, then enable automatic Generate + completion detection + download.
