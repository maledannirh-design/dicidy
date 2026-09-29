const CHAT_TITLE = "DICIDY VIDEO PROMPT ENGINE";
const FLOW_HOST = "flow.google";
const BRIDGE_URL = "http://127.0.0.1:8787";

async function evaluate(tabId, expression) {
  const result = await chrome.debugger.sendCommand(
    { tabId },
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true
    }
  );

  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed.");
  }

  return result?.result?.value;
}

async function inspectTab(tab, role) {
  if (!tab?.id) throw new Error(`No tab id for ${role}.`);

  await chrome.debugger.attach({ tabId: tab.id }, "1.3");

  try {
    return await evaluate(
      tab.id,
      `(() => ({
        role: ${JSON.stringify(role)},
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        bodyTextSample: (document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 300)
      }))()`
    );
  } finally {
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
  }
}

async function findTargets() {
  const tabs = await chrome.tabs.query({});
  const chat = tabs.find(tab =>
    typeof tab.title === "string" &&
    tab.title.toUpperCase().includes(CHAT_TITLE)
  );
  const flow = tabs.find(tab =>
    typeof tab.url === "string" &&
    /^https?:\/\/flow\.google\//i.test(tab.url)
  );

  return { tabs, chat, flow };
}

async function runDiagnostic() {
  const { tabs, chat, flow } = await findTargets();

  const result = {
    ok: false,
    timestamp: new Date().toISOString(),
    browserTabCount: tabs.length,
    chat: null,
    flow: null,
    errors: []
  };

  if (!chat) {
    result.errors.push(`ChatGPT tab with title containing "${CHAT_TITLE}" was not found.`);
  } else {
    try {
      result.chat = await inspectTab(chat, "chatgpt");
    } catch (error) {
      result.errors.push(`ChatGPT debugger attach failed: ${error.message}`);
    }
  }

  if (!flow) {
    result.errors.push("Google Flow tab was not found.");
  } else {
    try {
      result.flow = await inspectTab(flow, "flow");
    } catch (error) {
      result.errors.push(`Google Flow debugger attach failed: ${error.message}`);
    }
  }

  result.ok = Boolean(result.chat && result.flow && result.errors.length === 0);

  // Optional local bridge log. The diagnostic still works if the Node bridge is not running.
  try {
    await fetch(`${BRIDGE_URL}/api/diagnostic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    });
  } catch (_) {
    // Local logging server is optional during this first bridge test.
  }

  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "DICIDY_RUN_DIAGNOSTIC") return;

  runDiagnostic()
    .then(result => sendResponse(result))
    .catch(error => sendResponse({
      ok: false,
      timestamp: new Date().toISOString(),
      browserTabCount: 0,
      chat: null,
      flow: null,
      errors: [error.message]
    }));

  return true;
});
