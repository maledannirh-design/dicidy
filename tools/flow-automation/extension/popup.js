const testButton = document.getElementById("test");
const runButton = document.getElementById("run");
const directButton = document.getElementById("direct");
const handoffButton = document.getElementById("handoff");
const lastChatButton = document.getElementById("lastChat");
const pasteImageButton = document.getElementById("pasteImage");
const buildFlowJobButton = document.getElementById("buildFlowJob");
const output = document.getElementById("result");


async function send(type) {
  return chrome.runtime.sendMessage({ type });
}

testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  runButton.disabled = true;
  directButton.disabled = true;
  output.textContent = "Running existing Chrome diagnostic…";

  try {
    const result = await send("DICIDY_RUN_DIAGNOSTIC");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = "ERROR: " + error.message;
  } finally {
    testButton.disabled = false;
    runButton.disabled = false;
    directButton.disabled = false;
  }
});

directButton.addEventListener("click", async () => {
  testButton.disabled = true;
  directButton.disabled = true;
  runButton.disabled = true;
  lastChatButton.disabled = true;
  output.textContent = "Testing direct CDP text input into Flow…";
  try {
    const result = await send("DICIDY_TEST_FLOW_DIRECT");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = "ERROR: " + error.message;
  } finally {
    testButton.disabled = false;
    directButton.disabled = false;
    runButton.disabled = false;
    lastChatButton.disabled = false;
  }
});


handoffButton.addEventListener("click", async () => {
  testButton.disabled = true;
  directButton.disabled = true;
  handoffButton.disabled = true;
  runButton.disabled = true;
  output.textContent = "Testing ChatGPT → Flow only… no image, generate, or download.";
  try {
    const result = await send("DICIDY_TEST_CHAT_TO_FLOW");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = "ERROR: " + error.message;
  } finally {
    testButton.disabled = false;
    directButton.disabled = false;
    handoffButton.disabled = false;
    runButton.disabled = false;
    lastChatButton.disabled = false;
  }
});

lastChatButton.addEventListener("click", async () => {
  testButton.disabled = true;
  directButton.disabled = true;
  handoffButton.disabled = true;
  lastChatButton.disabled = true;
  runButton.disabled = true;
  output.textContent =
    "Moving the LAST existing ChatGPT assistant message → Flow. No new prompt is sent to ChatGPT.";

  try {
    const result = await send("DICIDY_MOVE_LAST_CHAT_TO_FLOW");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = "ERROR: " + error.message;
  } finally {
    testButton.disabled = false;
    directButton.disabled = false;
    handoffButton.disabled = false;
    lastChatButton.disabled = false;
    runButton.disabled = false;
  }
});

pasteImageButton.addEventListener("click", async () => {
  testButton.disabled = true;
  directButton.disabled = true;
  handoffButton.disabled = true;
  lastChatButton.disabled = true;
  pasteImageButton.disabled = true;
  runButton.disabled = true;
  output.textContent =
    "Pasting the IMAGE currently in the Windows clipboard into the verified Flow editor…";

  try {
    const result = await send("DICIDY_PASTE_CLIPBOARD_IMAGE_TO_FLOW");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = "ERROR: " + error.message;
  } finally {
    testButton.disabled = false;
    directButton.disabled = false;
    handoffButton.disabled = false;
    lastChatButton.disabled = false;
    pasteImageButton.disabled = false;
    runButton.disabled = false;
  }
});

buildFlowJobButton.addEventListener("click", async () => {
  testButton.disabled = true;
  directButton.disabled = true;
  handoffButton.disabled = true;
  lastChatButton.disabled = true;
  pasteImageButton.disabled = true;
  buildFlowJobButton.disabled = true;
  runButton.disabled = true;
  output.textContent =
    "Building Flow job: LAST ChatGPT prompt + clipboard image. Generate stays manual.";

  try {
    const result = await send("DICIDY_BUILD_FLOW_JOB");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = "ERROR: " + error.message;
  } finally {
    testButton.disabled = false;
    directButton.disabled = false;
    handoffButton.disabled = false;
    lastChatButton.disabled = false;
    pasteImageButton.disabled = false;
    buildFlowJobButton.disabled = false;
    runButton.disabled = false;
  }
});

runButton.addEventListener("click", async () => {
  testButton.disabled = true;
  runButton.disabled = true;
  output.textContent =
    "Running 1-job handoff. ChatGPT will compile the prompt; Flow will receive it. Generate is NOT clicked.";

  try {
    const result = await send("DICIDY_RUN_ONE_JOB");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = "ERROR: " + error.message;
  } finally {
    testButton.disabled = false;
    runButton.disabled = false;
    lastChatButton.disabled = false;
  }
});
