(() => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const isVisible = el => {
    const r = el.getBoundingClientRect();
    return r.width > 60 && r.height > 5 &&
      getComputedStyle(el).visibility !== "hidden" &&
      getComputedStyle(el).display !== "none";
  };

  const iconNames = b => $$("i", b).map(i => (i.textContent || "").trim());
  const SUBMIT_ICONS = ["arrow_forward", "arrow_upward", "send", "north_east"];
  const CHIP_RE = /Nano Banana|Veo|Omni|Imagen/i;

  function findPromptBox() {
    let eds = $$('[data-slate-editor="true"]').filter(isVisible);
    if (!eds.length) eds = $$('[contenteditable="true"]').filter(isVisible);
    if (!eds.length) eds = $$('textarea, input[type="text"]').filter(el =>
      /create|change|describe/i.test(el.getAttribute("placeholder") || "") && isVisible(el)
    );
    if (!eds.length) return null;
    const scored = eds.map(el => {
      let score = el.getBoundingClientRect().width;
      let up = el.parentElement, hops = 0;
      while (up && up !== document.body && hops < 8) {
        const buttons = $$("button", up);
        if (buttons.some(b => CHIP_RE.test(b.textContent || "") ||
          iconNames(b).some(n => SUBMIT_ICONS.includes(n)))) {
          score += 100000; break;
        }
        up = up.parentElement; hops++;
      }
      return {el, score};
    }).sort((a,b) => b.score - a.score);
    return scored[0].el;
  }

  function editorStateText(box) {
    const l = box && box.querySelector('[data-slate-string="true"]');
    return l ? l.textContent : "";
  }

  async function enterPrompt(text) {
    const box = findPromptBox();
    if (!box) return {
      ok:false, error:"Flow prompt box not found",
      slate:$$('[data-slate-editor="true"]').length,
      contenteditable:$$('[contenteditable="true"]').length
    };

    box.scrollIntoView({block:"center", inline:"center"});
    await sleep(150);
    const r = box.getBoundingClientRect();

    const clicked = await chrome.runtime.sendMessage({
      type:"DICIDY_TRUSTED_CLICK",
      x:Math.round(r.x + Math.min(r.width / 2, 300)),
      y:Math.round(r.y + Math.min(r.height / 2, 30))
    });
    if (!clicked || !clicked.ok) return {ok:false,error:"Trusted click failed",clicked};

    await sleep(250);

    const typed = await chrome.runtime.sendMessage({
      type:"DICIDY_TRUSTED_TYPE", text
    });
    if (!typed || !typed.ok) return {ok:false,error:"Trusted text input failed",typed};

    await sleep(500);
    const fb = findPromptBox();
    const verified = !!(fb && editorStateText(fb).includes(text.slice(0,20)));

    return {
      ok:verified, verified,
      error:verified ? null : "Text was sent but Slate editor verification failed",
      editorText:fb ? editorStateText(fb).slice(0,200) : ""
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== "DICIDY_ENTER_FLOW_PROMPT") return;
    enterPrompt(String(msg.text || ""))
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ok:false,error:error.message}));
    return true;
  });
})();

  window.addEventListener("message", event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "DICIDY_CONTENT_FACTORY") return;

    let message = null;
    if (data.type === "DICIDY_RUN_VIDEO") {
      message = {type:"DICIDY_RUN_WEB_JOB", requestId:data.requestId||"", job:data.job};
    } else if (data.type === "DICIDY_PASTE_ONE_IMAGE") {
      message = {type:"DICIDY_PASTE_ONE_IMAGE", requestId:data.requestId||"", expectedBeforeCount:Number(data.expectedBeforeCount||0)};
    } else if (data.type === "DICIDY_GENERATE_FLOW") {
      message = {type:"DICIDY_GENERATE_FLOW", requestId:data.requestId||""};
    } else {
      return;
    }

    chrome.runtime.sendMessage(message).then(result => {
      window.postMessage({
        source:"DICIDY_FLOW_BRIDGE",
        type:"DICIDY_BRIDGE_RESULT",
        requestId:data.requestId||"",
        result
      },"*");
    }).catch(error => {
      window.postMessage({
        source:"DICIDY_FLOW_BRIDGE",
        type:"DICIDY_BRIDGE_RESULT",
        requestId:data.requestId||"",
        result:{ok:false,error:error.message}
      },"*");
    });
  });
