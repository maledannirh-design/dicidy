const CHAT_TITLE = "DICIDY VIDEO PROMPT ENGINE";
const FLOW_HOSTS = ["flow.google.com", "labs.google.com"];
const BRIDGE_URL = "http://127.0.0.1:8787";

async function sendCommand(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function evaluate(tabId, expression) {
  const result = await sendCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });

  if (result && result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed.");
  }

  return result && result.result ? result.result.value : undefined;
}

async function inspectTab(tab, role) {
  if (!tab || !tab.id) throw new Error("No tab id for " + role + ".");

  await chrome.debugger.attach({ tabId: tab.id }, "1.3");

  try {
    return await evaluate(
      tab.id,
      `(() => ({
        role: ${JSON.stringify(role)},
        title: document.title,
        url: location.href,
        readyState: document.readyState,
        bodyTextSample: (document.body?.innerText || "").split("\\n").join(" ").slice(0, 300)
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

  const flowCandidates = tabs.filter(tab => {
    const value = String(tab.url || tab.pendingUrl || "").toLowerCase();
    return FLOW_HOSTS.some(host => value.includes(host)) && value.includes("flow");
  });

  return { tabs, chat, flow: flowCandidates[0] || null, flowCandidates };
}

async function runDiagnostic() {
  const targets = await findTargets();
  const result = {
    ok: false,
    timestamp: new Date().toISOString(),
    browserTabCount: targets.tabs.length,
    chat: null,
    flow: null,
    flowCandidates: targets.flowCandidates.map(tab => ({
      id: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      pendingUrl: tab.pendingUrl || ""
    })),
    errors: []
  };

  if (!targets.chat) {
    result.errors.push("ChatGPT tab with title containing " + CHAT_TITLE + " was not found.");
  } else {
    try {
      result.chat = await inspectTab(targets.chat, "chatgpt");
    } catch (error) {
      result.errors.push("ChatGPT debugger attach failed: " + error.message);
    }
  }

  if (!targets.flow) {
    result.errors.push("Google Flow tab was not found.");
  } else {
    try {
      result.flow = await inspectTab(targets.flow, "flow");
    } catch (error) {
      result.errors.push("Google Flow debugger attach failed: " + error.message);
    }
  }

  result.ok = Boolean(result.chat && result.flow && result.errors.length === 0);

  try {
    await fetch(BRIDGE_URL + "/api/diagnostic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result)
    });
  } catch (_) {}

  return result;
}

async function bridgeRequest(pathname, options = {}) {
  const response = await fetch(BRIDGE_URL + pathname, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || ("Bridge HTTP " + response.status));
  }
  return data;
}

async function findChatInput(tabId) {
  return evaluate(tabId, `(() => {
    const candidates = Array.from(document.querySelectorAll(
      'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]'
    ));

    const visible = candidates.find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled;
    });

    return visible ? {
      tag: visible.tagName,
      role: visible.getAttribute("role"),
      aria: visible.getAttribute("aria-label") || "",
      placeholder: visible.getAttribute("placeholder") || ""
    } : null;
  })()`);
}

async function focusInput(tabId, kind) {
  const expression = kind === "chat"
    ? `(() => {
        const candidates = Array.from(document.querySelectorAll(
          'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"]'
        ));
        const el = candidates.find(node => {
          const r = node.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && !node.disabled;
        });
        if (!el) return false;
        el.focus();
        return true;
      })()`
    : `(() => {
        const selectors = [
          'textarea',
          '[contenteditable="true"][role="textbox"]',
          '[contenteditable="true"]',
          'input[type="text"]'
        ];
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          const el = nodes.find(node => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && !node.disabled;
          });
          if (el) {
            el.focus();
            return true;
          }
        }
        return false;
      })()`;

  return evaluate(tabId, expression);
}

async function typeText(tabId, textValue) {
  const focused = await evaluate(tabId, "document.activeElement ? document.activeElement.tagName : null");
  if (!focused) throw new Error("No focused input.");
  await sendCommand(tabId, "Input.insertText", { text: textValue });
}

async function pressEnter(tabId) {
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13
  });
}

async function sendPromptToChat(chatTab, prompt) {
  await chrome.debugger.attach({ tabId: chatTab.id }, "1.3");

  try {
    const before = await evaluate(
      chatTab.id,
      `(() => Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).length)()`
    );

    const input = await findChatInput(chatTab.id);
    if (!input) {
      throw new Error("ChatGPT input not found.");
    }

    await focusInput(chatTab.id, "chat");
    await typeText(chatTab.id, prompt);
    await pressEnter(chatTab.id);

    const started = Date.now();
    let lastText = "";
    let stableSince = 0;

    while (Date.now() - started < 240000) {
      const state = await evaluate(
        chatTab.id,
        `(() => {
          const messages = Array.from(
            document.querySelectorAll('[data-message-author-role="assistant"]')
          );
          const text = messages.length
            ? (messages[messages.length - 1].innerText || "").trim()
            : "";
          return { count: messages.length, text };
        })()`
      );

      if (state && state.count > before && state.text) {
        if (state.text === lastText) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince >= 1800) {
            return state.text;
          }
        } else {
          lastText = state.text;
          stableSince = Date.now();
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1200));
    }

    throw new Error("Timed out waiting for a new ChatGPT response.");
  } finally {
    await chrome.debugger.detach({ tabId: chatTab.id }).catch(() => {});
  }
}

async function prepareFlow(flowTab, compiledPrompt) {
  await chrome.debugger.attach({ tabId: flowTab.id }, "1.3");

  try {
    const input = await evaluate(
      flowTab.id,
      `(() => {
        const selectors = [
          'textarea',
          '[contenteditable="true"][role="textbox"]',
          '[contenteditable="true"]',
          'input[type="text"]'
        ];

        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector));
          const el = nodes.find(node => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && !node.disabled;
          });
          if (el) {
            return {
              tag: el.tagName,
              aria: el.getAttribute("aria-label") || "",
              placeholder: el.getAttribute("placeholder") || ""
            };
          }
        }

        return null;
      })()`
    );

    if (!input) {
      return {
        ready: false,
        reason: "Google Flow prompt input was not found. Open a Flow project with the prompt composer visible, then run the one-job handoff again."
      };
    }

    const focused = await focusInput(flowTab.id, "flow");
    if (!focused) {
      return { ready: false, reason: "Google Flow input could not be focused." };
    }

    await typeText(flowTab.id, compiledPrompt);

    return { ready: true, input };
  } finally {
    await chrome.debugger.detach({ tabId: flowTab.id }).catch(() => {});
  }
}

async function runOneJob() {
  const jobResponse = await bridgeRequest("/api/job");
  const job = jobResponse.job;

  if (!job) throw new Error("No job available. Create/export Content Factory job.json first.");

  const item = Array.isArray(job.jobs) ? job.jobs[0] : null;
  if (!item || !item.prompt) {
    throw new Error("job.json does not contain a usable first job with a prompt.");
  }

  const targets = await findTargets();
  if (!targets.chat) throw new Error("Dedicated ChatGPT room was not found.");
  if (!targets.flow) throw new Error("Google Flow tab was not found.");

  const compilerInstruction =
`You are the prompt compiler for the DICIDY video-generation workflow.
Return ONLY one production-ready Google Flow video prompt.
Do not explain your reasoning.
Preserve product facts exactly as supplied.
Make the video vertical 9:16 and suitable for a TikTok affiliate video.
Do not invent product claims, prices, discounts, specifications, or certifications.

JOB INPUT:
${item.prompt}`;

  const compiledPrompt = await sendPromptToChat(targets.chat, compilerInstruction);

  const flowResult = await prepareFlow(targets.flow, compiledPrompt);

  const result = {
    status: flowResult.ready ? "FLOW_PROMPT_READY" : "FLOW_PROMPT_NOT_READY",
    compiledPrompt,
    flow: flowResult,
    angle: item.angle || null,
    timestamp: new Date().toISOString()
  };

  await bridgeRequest("/api/result", {
    method: "POST",
    body: JSON.stringify(result)
  });

  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;

  if (message.type === "DICIDY_RUN_DIAGNOSTIC") {
    runDiagnostic()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({
        ok: false,
        timestamp: new Date().toISOString(),
        browserTabCount: 0,
        chat: null,
        flow: null,
        flowCandidates: [],
        errors: [error.message]
      }));
    return true;
  }

  if (message.type === "DICIDY_RUN_ONE_JOB") {
    runOneJob()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({
        ok: false,
        status: "ERROR",
        error: error.message
      }));
    return true;
  }
});
