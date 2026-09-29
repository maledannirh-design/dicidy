const button = document.getElementById("test");
const output = document.getElementById("result");

button.addEventListener("click", async () => {
  button.disabled = true;
  output.textContent = "Running debugger bridge test…";

  try {
    const result = await chrome.runtime.sendMessage({
      type: "DICIDY_RUN_DIAGNOSTIC"
    });

    output.textContent = JSON.stringify(result, null, 2);
  } catch (error) {
    output.textContent = `ERROR: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});
