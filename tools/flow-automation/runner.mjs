import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const JOB_FILE = path.join(ROOT, "job.json");
const PROFILE = path.join(ROOT, "profiles", "dicidy-flow");
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

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

fs.mkdirSync(PROFILE, { recursive: true });

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: false,
  viewport: { width: 1440, height: 900 }
});

const chat = await context.newPage();
const flow = await context.newPage();

await chat.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
await flow.goto("https://flow.google/", { waitUntil: "domcontentloaded" });

console.log("\nDICIDY Flow POC");
console.log("IMPORTANT: The runner will NOT type anything until login/access is detected.");
console.log("Complete any required login manually in the opened Chrome window.");
console.log("The automation will not receive or store your password.\n");

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

  const candidates = [
    page.locator("textarea").last(),
    page.locator('[contenteditable="true"]').last()
  ];

  for (const candidate of candidates) {
    if (await candidate.count()) return true;
  }

  return true;
}

async function waitForAccess() {
  log("Checking ChatGPT login...");
  const started = Date.now();

  while (Date.now() - started < LOGIN_TIMEOUT_MS) {
    if (await pageLooksLoggedIn(chat, "chat")) {
      log("ChatGPT access detected.");
      break;
    }

    log("ChatGPT is not ready. Please log in manually in the opened Chrome window.");
    await chat.waitForTimeout(3000);
  }

  if (!(await pageLooksLoggedIn(chat, "chat"))) {
    throw new Error("ChatGPT login/access was not detected within 10 minutes.");
  }

  log("Checking Google Flow access...");
  const flowStarted = Date.now();

  while (Date.now() - flowStarted < LOGIN_TIMEOUT_MS) {
    if (await pageLooksLoggedIn(flow, "flow")) {
      log("Google Flow page is accessible.");
      return;
    }

    log("Google Flow is not ready. Complete any required account/access step manually.");
    await flow.waitForTimeout(3000);
  }

  throw new Error("Google Flow access was not detected within 10 minutes.");
}

async function sendToChatGPT(prompt) {
  const instruction =
`You are the prompt compiler for a video-generation workflow.
Return ONLY one production-ready Google Flow video prompt.
Do not explain your reasoning.
Keep the product facts exactly as provided.
The video must be vertical 9:16 and suitable for a TikTok affiliate video.

JOB INPUT:
${prompt}`;

  const box = chat.locator("textarea").last();
  if (await box.count()) {
    await box.fill(instruction);
    await box.press("Enter");
  } else {
    const editable = chat.locator('[contenteditable="true"]').last();
    if (!(await editable.count())) throw new Error("ChatGPT input was not found.");
    await editable.fill(instruction);
    await editable.press("Enter");
  }

  await chat.waitForTimeout(1500);
  const started = Date.now();

  while (Date.now() - started < 120000) {
    const messages = chat.locator('[data-message-author-role="assistant"]');
    if (await messages.count()) {
      const text = (await messages.last().innerText()).trim();
      if (text && !/^(Thinking|Generating|Searching)/i.test(text)) return text;
    }
    await chat.waitForTimeout(1500);
  }

  throw new Error("Timed out waiting for a ChatGPT response.");
}

async function prepareFlowPrompt(prompt) {
  const candidates = [
    flow.locator("textarea").last(),
    flow.locator('[contenteditable="true"]').last()
  ];

  for (const candidate of candidates) {
    if (await candidate.count()) {
      await candidate.fill(prompt);
      return true;
    }
  }

  return false;
}

await waitForAccess();

// POC safety mode: process ONE job only until the live ChatGPT + Flow handoff
// has been verified. The remaining jobs stay untouched in job.json.
const item = job.jobs[0];
log(`POC JOB 1/1: ${item.angle}`);

try {
  log("Compiling Flow prompt in ChatGPT...");
  const compiledPrompt = await sendToChatGPT(item.prompt);

  log("Prompt received.");
  console.log("\n--- FLOW PROMPT ---\n" + compiledPrompt + "\n--- END PROMPT ---\n");

  const placed = await prepareFlowPrompt(compiledPrompt);

  if (!placed) {
    item.status = "FLOW_PROMPT_READY_MANUAL";
    item.compiledPrompt = compiledPrompt;
    log("Flow prompt input was not identified. POC stopped for live selector verification.");
  } else {
    item.status = "FLOW_PROMPT_READY";
    item.compiledPrompt = compiledPrompt;
    log("Prompt placed in Google Flow.");
  }

  console.log("\nPOC STOP: no Generate click. Inspect the Flow page manually.");
} catch (error) {
  item.status = "ERROR";
  item.error = error.message;
  log(`ERROR: ${error.message}`);
}

fs.writeFileSync(
  path.join(ROOT, "job-result.json"),
  JSON.stringify(job, null, 2),
  "utf8"
);

log("POC finished. Result saved to job-result.json.");
console.log("You can close the automation browser when you are finished inspecting it.");
