const testButton = document.getElementById("test");
const runButton = document.getElementById("run");
const output = document.getElementById("result");

async function send(type) {
  return chrome.runtime.sendMessage({ type });
}

testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  runButton.disabled = true;
  output.textContent = "Running existing Chrome diagnostic…";

  try {
    const result = await send("DICIDY_RUN_DIAGNOSTIC");
    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = "ERROR: " + error.message;
  } finally {
    testButton.disabled = false;
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
  }
});
