import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const JOB_FILE = path.join(ROOT, "job.json");
const RESULT_FILE = path.join(ROOT, "job-result.json");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const CHAT_RESPONSE_TIMEOUT_MS = 4 * 60 * 1000;
const CDP_ENDPOINT = process.env.DICIDY_CDP_ENDPOINT || "http://127.0.0.1:9222";

function log(message) {
  console.log(`[DICIDY FLOW] ${new Date().toLocaleTimeString()} ${message}`);
}

if (!fs.existsSync(JOB_FILE)) {
  console.error("job.json not found. Download a job from DICIDY Content Factory first.");
  process.exit(1);
}

const job = JSON.parse(fs.readFileSync(JOB_FILE, "utf8"));
if (!Array.isArray(job.jobs) || !job.jobs.length) {
  console.error("No jobs found in job.json.");
  process.exit(1);
}

async function connectToExistingChrome() {
  log(`Connecting to existing Chrome: ${CDP_ENDPOINT}`);

  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const contexts = browser.contexts();

    if (!contexts.length) {
      throw new Error("Chrome connected, but no browser context is available.");
    }

    const context = contexts[0];
    log(`Connected. Existing tabs: ${context.pages().length}`);
    return { browser, context };
  } catch (error) {
    console.error("\nCould not connect to the existing Chrome session.");
    console.error(`Endpoint: ${CDP_ENDPOINT}`);
    console.error("Make sure Chrome is open and remote debugging is allowed for this browser instance.");
    console.error("In Chrome open: chrome://inspect/#remote-debugging");
    console.error("Then enable: Allow remote debugging for this browser instance.");
    console.error("If Chrome exposes a different endpoint, set DICIDY_CDP_ENDPOINT before running.");
    console.error(`Original error: ${error.message}\n`);
    process.exit(1);
  }
}

function findTab(context, pattern) {
  return context.pages().find(page => pattern.test(page.url()));
}

async function getOrOpenTab(context, pattern, url, label) {
  let page = findTab(context, pattern);

  if (!page) {
    log(`No existing ${label} tab found. Opening it in the current Chrome session.`);
    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
  } else {
    log(`Reusing existing ${label} tab.`);
  }

  await page.bringToFront().catch(() => {});
  return page;
}

async function pageLooksLoggedIn(page, kind) {
  if (kind === "chat") {
    const loginButton = page.getByRole("button", { name: /^Log in$/i });
    const signupButton = page.getByRole("button", { name: /Sign up for free/i });
    const textareas = page.locator("textarea");
    const editables = page.locator('[contenteditable="true"]');

    return (await textareas.count()) > 0 ||
      (await editables.count()) > 0 ||
      ((await loginButton.count()) === 0 && (await signupButton.count()) === 0);
  }

  const url = page.url();
  if (/accounts\.google\.com/i.test(url)) return false;

  const bodyText = ((await page.locator("body").innerText().catch(() => "")) || "").trim();
  if (/couldn.?t sign you in|this browser or app may not be secure/i.test(bodyText)) {
    return false;
  }

  return true;
}

async function waitForAccess(chat, flow) {
  log("Checking existing Chrome authentication...");
  const started = Date.now();

  while (Date.now() - started < LOGIN_TIMEOUT_MS) {
    const chatReady = await pageLooksLoggedIn(chat, "chat");
    const flowReady = await pageLooksLoggedIn(flow, "flow");

    if (chatReady && flowReady) {
      log("Existing ChatGPT + Google Flow sessions detected.");
      return;
    }

    if (!chatReady) {
      log("ChatGPT session is not ready. Log in manually in this existing Chrome window if required.");
    }

    if (!flowReady) {
      log("Google Flow session is not ready. Complete any required account/access step manually.");
    }

    await chat.waitForTimeout(3000);
  }

  throw new Error("Existing ChatGPT/Google Flow access was not detected within 10 minutes.");
}

async function getChatInput(page) {
  const selectors = [
    page.locator("textarea").last(),
    page.locator('[contenteditable="true"][role="textbox"]').last(),
    page.locator('[contenteditable="true"]').last()
  ];

  for (const candidate of selectors) {
    if (await candidate.count() && await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return null;
}

async function sendToChatGPT(page, prompt) {
  const instruction =
`You are the prompt compiler for a video-generation workflow.
Return ONLY one production-ready Google Flow video prompt.
Do not explain your reasoning.
Keep the product facts exactly as provided.
The video must be vertical 9:16 and suitable for a TikTok affiliate video.

JOB INPUT:
${prompt}`;

  await page.bringToFront().catch(() => {});

  const input = await getChatInput(page);
  if (!input) {
    throw new Error("ChatGPT input was not found. Make sure the existing ChatGPT tab is fully loaded.");
  }

  const beforeCount = await page.locator('[data-message-author-role="assistant"]').count();

  await input.fill(instruction);
  await input.press("Enter");

  log(`ChatGPT request sent. Waiting for a new assistant response (existing: ${beforeCount})...`);

  const started = Date.now();
  let lastText = "";
  let stableSince = 0;

  while (Date.now() - started < CHAT_RESPONSE_TIMEOUT_MS) {
    const messages = page.locator('[data-message-author-role="assistant"]');
    const count = await messages.count();

    if (count > beforeCount) {
      const current = (await messages.last().innerText().catch(() => "")).trim();

      if (current && !/^(Thinking|Generating|Searching)\\b/i.test(current)) {
        if (current === lastText) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= 1800) {
            return current;
          }
        } else {
          lastText = current;
          stableSince = Date.now();
        }
      }
    }

    await page.waitForTimeout(1200);
  }

  throw new Error("Timed out waiting for a new ChatGPT response.");
}

async function prepareFlowPrompt(page, prompt) {
  await page.bringToFront().catch(() => {});

  const candidates = [
    page.locator("textarea").last(),
    page.locator('[contenteditable="true"][role="textbox"]').last(),
    page.locator('[contenteditable="true"]').last()
  ];

  for (const candidate of candidates) {
    if (await candidate.count() && await candidate.isVisible().catch(() => false)) {
      await candidate.fill(prompt);
      return true;
    }
  }

  return false;
}

const { browser, context } = await connectToExistingChrome();

const chat = await getOrOpenTab(
  context,
  /^https:\/\/(chatgpt\.com|chat\.openai\.com)/i,
  "https://chatgpt.com/",
  "ChatGPT"
);

const flow = await getOrOpenTab(
  context,
  /^https:\/\/flow\.google\.com/i,
  "https://flow.google/",
  "Google Flow"
);

console.log("\nDICIDY Flow Automation");
console.log("MODE: EXISTING CHROME");
console.log("The runner does not create a separate Chrome profile.");
console.log("Your existing browser session/cookies remain in Chrome.");
console.log("The runner does not receive or store passwords.\n");

await waitForAccess(chat, flow);

// Keep the first live run intentionally limited to one job.
// Once the live handoff is verified, the queue can be expanded safely.
const item = job.jobs[0];
log(`POC JOB 1/1: ${item.angle}`);

try {
  log("Compiling Flow prompt in ChatGPT...");
  const compiledPrompt = await sendToChatGPT(chat, item.prompt);

  log("Prompt received.");
  console.log("\n--- FLOW PROMPT ---\n" + compiledPrompt + "\n--- END PROMPT ---\n");

  const placed = await prepareFlowPrompt(flow, compiledPrompt);

  item.compiledPrompt = compiledPrompt;
  item.status = placed ? "FLOW_PROMPT_READY" : "FLOW_PROMPT_READY_MANUAL";

  if (placed) {
    log("Prompt placed in Google Flow.");
  } else {
    log("Flow prompt input was not identified. POC stopped for live selector verification.");
  }

  console.log("\nPOC STOP: no Generate click yet. Inspect the existing Flow tab manually.");
} catch (error) {
  item.status = "ERROR";
  item.error = error.message;
  log(`ERROR: ${error.message}`);
}

fs.writeFileSync(RESULT_FILE, JSON.stringify(job, null, 2), "utf8");

log("POC finished. Result saved to job-result.json.");
console.log("The runner will leave your existing Chrome open.");

await browser.close().catch(() => {});
