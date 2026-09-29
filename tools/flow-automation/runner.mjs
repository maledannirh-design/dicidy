import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const JOB_FILE = path.join(ROOT, "job.json");
const PROFILE = path.join(ROOT, "profiles", "dicidy-flow");

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
console.log("If either site asks for login, complete it manually in the opened Chrome window.");
console.log("The automation will not receive or store your password.\n");

async function waitForUserReady() {
  await chat.waitForTimeout(2500);
  await flow.waitForTimeout(2500);
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

await waitForUserReady();

for (let i = 0; i < job.jobs.length; i++) {
  const item = job.jobs[i];
  log(`JOB ${i + 1}/${job.jobs.length}: ${item.angle}`);

  try {
    log("Compiling Flow prompt in ChatGPT...");
    const compiledPrompt = await sendToChatGPT(item.prompt);

    log("Prompt received.");
    console.log("\n--- FLOW PROMPT ---\n" + compiledPrompt + "\n--- END PROMPT ---\n");

    const placed = await prepareFlowPrompt(compiledPrompt);

    if (!placed) {
      log("Flow prompt input was not identified. POC paused for selector verification.");
      console.log("Paste the displayed prompt into Flow manually, then press Enter here to continue.");
      await new Promise(resolve => process.stdin.once("data", resolve));
    } else {
      log("Prompt placed in Google Flow.");
      console.log("POC intentionally stops before clicking Generate until the live Flow UI selector is verified.");
      console.log("Press Enter after you inspect the prompt in Flow.");
      await new Promise(resolve => process.stdin.once("data", resolve));
    }

    item.status = "FLOW_PROMPT_READY";
    item.compiledPrompt = compiledPrompt;
  } catch (error) {
    item.status = "ERROR";
    item.error = error.message;
    log(`ERROR: ${error.message}`);
    console.log("Press Enter to continue to the next job.");
    await new Promise(resolve => process.stdin.once("data", resolve));
  }
}

fs.writeFileSync(
  path.join(ROOT, "job-result.json"),
  JSON.stringify(job, null, 2),
  "utf8"
);

log("Queue finished. Result saved to job-result.json.");
await context.close();
