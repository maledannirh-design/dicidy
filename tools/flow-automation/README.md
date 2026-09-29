# DICIDY Flow Automation — Existing Chrome POC

This is a **local** proof-of-concept. It is not deployed to GitHub Pages.

## Purpose

DICIDY Content Factory creates a JSON job queue:

DICIDY → job.json → Playwright → ChatGPT → Google Flow → Veo

The runner now attaches to the **user's existing Chrome session** instead of launching a separate Chrome profile. This allows the existing ChatGPT/Google login session to be reused.

## Setup

1. Install Node.js 20+.
2. In this folder run:

```
npm install
npx playwright install
```

3. Copy a Content Factory job JSON into this folder as `job.json`.
4. Open your normal Chrome profile where ChatGPT and Google Flow are already logged in.
5. In that same Chrome window open:

```
chrome://inspect/#remote-debugging
```

6. Enable:

**Allow remote debugging for this browser instance**

Chrome may show an automation-control permission/banner. Approve it for this local workflow.

7. Run:

```
npm start
```

The runner connects to the existing browser. It does **not** create a separate profile and does not ask for your passwords.

## CDP endpoint

The default endpoint is:

```
http://127.0.0.1:9222
```

If the local Chrome instance exposes another endpoint, set:

Windows PowerShell:

```
$env:DICIDY_CDP_ENDPOINT="http://127.0.0.1:9222"
npm start
```

Command Prompt:

```
set DICIDY_CDP_ENDPOINT=http://127.0.0.1:9222
npm start
```

## Current POC behavior

- Connects to the existing Chrome browser.
- Reuses an existing ChatGPT tab when available.
- Reuses an existing Google Flow tab when available.
- Opens a new tab in the same Chrome session only if the required tab is missing.
- Sends one Content Factory job to ChatGPT.
- Waits specifically for a **new** assistant response instead of accepting an old response.
- Places the compiled prompt into a Flow input when the live selector is available.
- Stops before automatic Generate.

The first live run intentionally processes **one job only**. This prevents a selector mistake from triggering multiple generations.

## Why existing Chrome

A dedicated Playwright profile would require a separate login session. The current design deliberately avoids that.

The browser session remains in the user's normal Chrome profile. DICIDY does not receive or store ChatGPT/Google passwords, cookies, or exported session files.

## Security

- Never put ChatGPT or Google passwords into `job.json`.
- Never put API keys or client secrets into this folder.
- Do not copy your Chrome User Data folder into the project.
- `job.json`, `job-result.json`, and local browser/session data must remain outside Git.
- The runner only connects to a local browser endpoint on the same machine.

## Next POC step

After one successful existing-Chrome handoff is observed:

1. Verify the exact live Flow prompt field.
2. Add a versioned Flow adapter for the live UI.
3. Test one manual Generate.
4. Add automatic Generate only after the manual handoff is confirmed.
5. Detect generation completion.
6. Save/download the generated video.
7. Then expand from one job to the selected 1–5 video queue.

Product sourcing from TikTok and Shopee remains a separate later phase.
