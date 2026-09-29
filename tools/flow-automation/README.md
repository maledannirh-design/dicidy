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


## Existing Chrome Bridge — first live test

The classic Playwright CDP endpoint is not available in the current Chrome remote-debugging flow, so the project now includes a **Chrome Extension Bridge** using the official `chrome.debugger` API. Chrome documents this API as an alternate transport for Chrome's debugging protocol and it can attach to tabs and evaluate page code. Chrome debugger API documentation: https://developer.chrome.com/docs/extensions/reference/api/debugger

This bridge is intentionally diagnostic first.

### Files

- `extension/` — unpacked Chrome MV3 extension.
- `bridge-server.mjs` — optional local HTTP logger on `127.0.0.1:8787`.
- `bridge-diagnostic.json` — local result file; do not commit it.

### Install the local extension

1. Keep the **same Chrome profile** open where you already have:
   - the ChatGPT room **DICIDY VIDEO PROMPT ENGINE**
   - Google Flow
2. Open:
   `chrome://extensions`
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select:
   `tools/flow-automation/extension/`
6. Pin **DICIDY Flow Automation Bridge** to the toolbar.

The extension requests the `debugger` permission. This is intentionally powerful: it allows the extension to attach to selected tabs and interact with the page through Chrome's debugging protocol. It does not export your passwords or copy your Chrome profile.

### Run the first diagnostic

In PowerShell, from `tools/flow-automation`:

```
npm run bridge
```

Then click the extension icon and choose:

**TEST EXISTING CHROME**

The diagnostic looks specifically for:

- ChatGPT tab title containing **DICIDY VIDEO PROMPT ENGINE**
- a Google Flow tab on `flow.google`

It attaches to each matching tab, reads only basic page state (title, URL, readyState and a short body-text sample), then immediately detaches.

**It does not type a prompt, click Generate, download anything, or change the page.**

A successful test produces `bridge-diagnostic.json` locally and prints the result in the extension popup and terminal.

### Next phase

Only after this diagnostic succeeds:

1. connect the Content Factory job queue to the bridge;
2. send one compiled prompt into the dedicated ChatGPT room;
3. hand the result to Google Flow;
4. manually verify one generation;
5. automate Generate and completion detection;
6. then expand to the selected 1–5 video queue.

TikTok/Shopee product sourcing stays as the later phase.
