const CHAT_TITLE = "DICIDY VIDEO PROMPT ENGINE";
const FLOW_HOSTS = ["flow.google.com", "labs.google"];
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
    /*
     * FLOW DOM VERIFIED FROM THE USER'S LIVE DOM DUMP.
     *
     * The real prompt editor is:
     * flow-rich-text-editor.prompt-input
     *   > .prosemirror-editor
     *     > .ProseMirror[contenteditable="true"]
     *
     * Do NOT guess by generic contenteditable, textarea, placeholder,
     * icon position, or Shadow DOM. The user has already confirmed that
     * direct CDP Input.insertText works on this exact editor.
     *
     * IMPORTANT:
     * The user manually opens "Scenes" first. This function intentionally
     * does NOT search for or click the Scenes navigation control.
     */

    const target = await evaluate(flowTab.id, `(() => {
      const el = document.querySelector(
        'flow-rich-text-editor.prompt-input .prosemirror-editor .ProseMirror[contenteditable="true"]'
      );

      if (!el) {
        return {
          ok: false,
          reason: "Verified Flow ProseMirror prompt editor was not found.",
          exactSelector:
            'flow-rich-text-editor.prompt-input .prosemirror-editor .ProseMirror[contenteditable="true"]'
        };
      }

      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);

      if (
        r.width <= 0 ||
        r.height <= 0 ||
        s.display === "none" ||
        s.visibility === "hidden"
      ) {
        return {
          ok: false,
          reason: "Verified Flow ProseMirror prompt editor exists but is not visible.",
          rect: {
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height
          }
        };
      }

      return {
        ok: true,
        tag: el.tagName,
        className: el.className,
        contenteditable: el.getAttribute("contenteditable") || "",
        currentText: (el.innerText || el.textContent || "").trim(),
        rect: {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height
        },
        x: r.left + Math.min(Math.max(r.width / 2, 20), Math.max(r.width - 20, 20)),
        y: r.top + Math.min(Math.max(r.height / 2, 10), Math.max(r.height - 10, 10))
      };
    })()`);

    if (!target?.ok) {
      return {
        ready: false,
        reason: target?.reason || "Verified Flow prompt editor not found.",
        target
      };
    }

    // Trusted mouse click into the exact ProseMirror editor.
    await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: target.x,
      y: target.y
    });
    await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1
    });
    await new Promise(resolve => setTimeout(resolve, 150));

    // Focus the exact editor and place the caret at the end.
    const focused = await evaluate(flowTab.id, `(() => {
      const el = document.querySelector(
        'flow-rich-text-editor.prompt-input .prosemirror-editor .ProseMirror[contenteditable="true"]'
      );

      if (!el) return { ok: false, reason: "Exact ProseMirror editor disappeared after click." };

      el.focus();

      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

      const active = document.activeElement;

      return {
        ok: true,
        activeIsExactEditor:
          active === el &&
          active.getAttribute("contenteditable") === "true",
        activeTag: active?.tagName || "",
        activeClass: active?.className || "",
        selectionRangeCount: selection?.rangeCount || 0
      };
    })()`);

    if (!focused?.ok || !focused.activeIsExactEditor) {
      return {
        ready: false,
        reason: "Exact Flow ProseMirror editor could not be focused.",
        target,
        focused
      };
    }

    // Clear only the exact editor. No DOM text mutation is used.
    await sendCommand(flowTab.id, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17
    });
    await sendCommand(flowTab.id, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    });
    await sendCommand(flowTab.id, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65
    });
    await sendCommand(flowTab.id, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17
    });
    await sendCommand(flowTab.id, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    });
    await sendCommand(flowTab.id, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    });
    await new Promise(resolve => setTimeout(resolve, 150));

    // Proven direct-input method.
    await sendCommand(flowTab.id, "Input.insertText", {
      text: compiledPrompt
    });
    await new Promise(resolve => setTimeout(resolve, 700));

    // Verify the exact ProseMirror editor, not a generic contenteditable.
    const verification = await evaluate(flowTab.id, `(() => {
      const el = document.querySelector(
        'flow-rich-text-editor.prompt-input .prosemirror-editor .ProseMirror[contenteditable="true"]'
      );

      if (!el) {
        return {
          found: false,
          reason: "Exact ProseMirror editor disappeared during verification."
        };
      }

      const text = (el.innerText || el.textContent || "").trim();
      const needle = ${JSON.stringify(String(compiledPrompt).slice(0, 80))};

      return {
        found: Boolean(needle && text.includes(needle)),
        textLength: text.length,
        preview: text.slice(0, 300),
        expectedPreview: needle,
        activeIsExactEditor: document.activeElement === el
      };
    })()`);

    if (!verification?.found) {
      return {
        ready: false,
        reason:
          "Input.insertText completed, but the exact Flow ProseMirror editor did not contain the compiled prompt.",
        target,
        focused,
        verification
      };
    }

    return {
      ready: true,
      target,
      focused,
      verification,
      videoModeDeferred: true,
      scenesNavigation: "MANUAL_USER_SELECTION"
    };
  } finally {
    await chrome.debugger.detach({ tabId: flowTab.id }).catch(() => {});
  }
}

async function prepareFlowImage(flowTab, product) {
  const imageData = String(product?.imageData || "");
  const imageUrl = String(product?.image || "");

  if (!imageData && !/^https?:\/\//i.test(imageUrl)) {
    return { ready:false, reason:"No transferable product image found. Re-export the Content Factory job after selecting the local image." };
  }

  const staged = await bridgeRequest("/api/image-file", {
    method:"POST",
    body:JSON.stringify({
      dataUrl:imageData,
      sourceUrl:imageUrl,
      fileName:product?.imageFileName || "product-image"
    })
  });

  if (!staged || !staged.ok || !staged.path) {
    return {ready:false,reason:"Local image staging failed: "+JSON.stringify(staged || {})};
  }

  await chrome.debugger.attach({tabId:flowTab.id},"1.3");
  try {
    const before = await evaluate(flowTab.id, `(() => ({
      fileInputs:Array.from(document.querySelectorAll('input[type="file"]')).length,
      buttons:Array.from(document.querySelectorAll('button,[role="button"]')).filter(b => {
        const r=b.getBoundingClientRect();
        if(!(r.width>0&&r.height>0)) return false;
        const t=[
          b.innerText||"",
          b.getAttribute("aria-label")||"",
          b.getAttribute("title")||"",
          ...Array.from(b.querySelectorAll("i")).map(i=>i.textContent||"")
        ].join(" ").trim();
        return /upload|add image|add media|reference|ingredient|photo|image|^\+$|add_photo/i.test(t);
      }).slice(-20).map(b => {
        const r=b.getBoundingClientRect();
        return {text:(b.innerText||"").trim(),aria:b.getAttribute("aria-label")||"",title:b.getAttribute("title")||"",x:r.left+r.width/2,y:r.top+r.height/2};
      })
    }))()`);

    if (!before.fileInputs) {
      const candidate = before.buttons.find(b => /add image|add media|reference|ingredient|photo|image|^\+$/i.test([b.text,b.aria,b.title].join(" "))) || before.buttons[before.buttons.length-1];
      if (candidate) {
        await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseMoved",x:candidate.x,y:candidate.y});
        await new Promise(r=>setTimeout(r,75));
        await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mousePressed",x:candidate.x,y:candidate.y,button:"left",clickCount:1});
        await new Promise(r=>setTimeout(r,50));
        await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseReleased",x:candidate.x,y:candidate.y,button:"left",clickCount:1});
        await new Promise(r=>setTimeout(r,500));
      }
    }

    await sendCommand(flowTab.id,"DOM.enable",{});
    const doc=await sendCommand(flowTab.id,"DOM.getDocument",{depth:-1});
    const q=await sendCommand(flowTab.id,"DOM.querySelector",{nodeId:doc.root.nodeId,selector:'input[type="file"]'});

    if (!q || !q.nodeId) {
      return {ready:false,reason:"Flow file input was not found after opening the media control.",diagnostic:before};
    }

    await sendCommand(flowTab.id,"DOM.setFileInputFiles",{nodeId:q.nodeId,files:[staged.path]});
    await new Promise(r=>setTimeout(r,1200));

    const verify=await evaluate(flowTab.id,`(() => {
      const inputs=Array.from(document.querySelectorAll('input[type="file"]'));
      return inputs.map(i => ({files:i.files ? Array.from(i.files).map(f => ({name:f.name,size:f.size,type:f.type})) : []}));
    })()`);

    const hasFile=Array.isArray(verify) && verify.some(x => Array.isArray(x.files) && x.files.length);
    if (!hasFile) return {ready:false,reason:"Flow file input accepted the command but no file is visible in the input.",verify};

    return {ready:true,path:staged.path,verify};
  } finally {
    await chrome.debugger.detach({tabId:flowTab.id}).catch(()=>{});
  }
}

async function testFlowDirectInput() {
  const targets = await findTargets();
  if (!targets.flow) throw new Error("Google Flow tab not found.");

  const flowTab = targets.flow;
  const text = "DICIDY DIRECT FLOW TEST";

  await chrome.debugger.attach({ tabId: flowTab.id }, "1.3");

  try {
    const snapshot = async () => evaluate(flowTab.id, `(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 &&
          s.display !== "none" && s.visibility !== "hidden";
      };
      const attrs = el => ({
        tag: el.tagName,
        role: el.getAttribute("role") || "",
        contenteditable: el.getAttribute("contenteditable") || "",
        placeholder: el.getAttribute("data-placeholder") || el.getAttribute("placeholder") || "",
        aria: el.getAttribute("aria-label") || "",
        text: (el.innerText || el.textContent || "").trim().slice(0, 160),
        rect: (() => {
          const r = el.getBoundingClientRect();
          return {left:Math.round(r.left),top:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)};
        })()
      });
      const all = Array.from(document.querySelectorAll(
        '[role="textbox"],[contenteditable="true"],[data-slate-editor="true"]'
      )).filter(visible).map(attrs);
      const active = document.activeElement;
      const sel = window.getSelection();
      return {
        url: location.href,
        title: document.title,
        scenes: Array.from(document.querySelectorAll('button,[role="button"],a'))
          .filter(visible)
          .filter(el => /^Scenes$/i.test([
            el.innerText || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("title") || ""
          ].join(" ").trim()))
          .map(attrs),
        candidates: all,
        active: active ? attrs(active) : null,
        selection: sel ? {
          rangeCount: sel.rangeCount,
          anchorNode: sel.anchorNode ? sel.anchorNode.nodeName : null,
          anchorText: sel.anchorNode ? (sel.anchorNode.textContent || "").slice(0,120) : "",
          anchorOffset: sel.anchorOffset,
          focusNode: sel.focusNode ? sel.focusNode.nodeName : null,
          focusOffset: sel.focusOffset
        } : null
      };
    })()`);

    const before = await snapshot();

    const scene = await evaluate(flowTab.id, `(() => {
      const visible = el => {
        const r=el.getBoundingClientRect(), s=getComputedStyle(el);
        return r.width>0 && r.height>0 && s.display!=="none" &&
          s.visibility!=="hidden" && !el.disabled;
      };
      const nodes = Array.from(document.querySelectorAll('button,[role="button"],a')).filter(visible);
      const el = nodes.find(n => /^Scenes$/i.test([
        n.innerText || "",
        n.getAttribute("aria-label") || "",
        n.getAttribute("title") || ""
      ].join(" ").trim()));
      if (!el) return {found:false};
      const r=el.getBoundingClientRect();
      return {found:true,x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);

    if (scene?.found) {
      await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseMoved",x:scene.x,y:scene.y});
      await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mousePressed",x:scene.x,y:scene.y,button:"left",clickCount:1});
      await new Promise(r=>setTimeout(r,50));
      await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseReleased",x:scene.x,y:scene.y,button:"left",clickCount:1});
      await new Promise(r=>setTimeout(r,1000));
    }

    const afterScene = await snapshot();

    const target = await evaluate(flowTab.id, `(() => {
      const visible = el => {
        const r=el.getBoundingClientRect(), s=getComputedStyle(el);
        return r.width>0 && r.height>0 && s.display!=="none" && s.visibility!=="hidden";
      };
      const candidates = Array.from(document.querySelectorAll(
        '[role="textbox"][contenteditable="true"],' +
        '[role="textbox"] [contenteditable="true"],' +
        '[data-slate-editor="true"][contenteditable="true"],' +
        '[contenteditable="true"]'
      )).filter(visible);

      const score = el => {
        const host = el.closest('[role="textbox"]');
        const p = [
          el.getAttribute("data-placeholder") || "",
          el.getAttribute("placeholder") || "",
          host?.getAttribute("data-placeholder") || "",
          host?.getAttribute("placeholder") || "",
          el.innerText || "",
          el.textContent || ""
        ].join(" ");
        let s = el.getAttribute("contenteditable")==="true" ? 20 : 0;
        if (/What do you want to create\?/i.test(p)) s += 1000;
        if (el.matches('[data-slate-editor="true"]')) s += 100;
        const r=el.getBoundingClientRect();
        s += Math.max(0, r.top);
        return s;
      };

      const ranked = candidates
        .map((el,index)=>({el,index,score:score(el)}))
        .sort((a,b)=>b.score-a.score);

      const el = ranked[0]?.el;
      if (!el) return {
        ok:false,
        candidates:candidates.map(e => ({
          tag:e.tagName,
          role:e.getAttribute("role")||"",
          contenteditable:e.getAttribute("contenteditable")||"",
          placeholder:e.getAttribute("data-placeholder")||e.getAttribute("placeholder")||"",
          text:(e.innerText||e.textContent||"").trim().slice(0,160)
        }))
      };

      const r=el.getBoundingClientRect();
      const host=el.closest('[role="textbox"]');
      const hr=host?.getBoundingClientRect();
      return {
        ok:true,
        tag:el.tagName,
        role:el.getAttribute("role")||"",
        contenteditable:el.getAttribute("contenteditable")||"",
        placeholder:el.getAttribute("data-placeholder")||el.getAttribute("placeholder")||
          host?.getAttribute("data-placeholder")||host?.getAttribute("placeholder")||"",
        text:(el.innerText||el.textContent||"").trim().slice(0,160),
        x:(hr||r).left+Math.min((hr||r).width/2,300),
        y:(hr||r).top+Math.min((hr||r).height/2,30)
      };
    })()`);

    if (!target?.ok) {
      return {ok:false,stage:"target-selection",scene,before,afterScene,target};
    }

    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseMoved",x:target.x,y:target.y});
    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mousePressed",x:target.x,y:target.y,button:"left",clickCount:1});
    await new Promise(r=>setTimeout(r,50));
    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseReleased",x:target.x,y:target.y,button:"left",clickCount:1});
    await new Promise(r=>setTimeout(r,200));

    const focused = await evaluate(flowTab.id, `(() => {
      const candidates = Array.from(document.querySelectorAll(
        '[role="textbox"][contenteditable="true"],' +
        '[role="textbox"] [contenteditable="true"],' +
        '[data-slate-editor="true"][contenteditable="true"],' +
        '[contenteditable="true"]'
      )).filter(el => {
        const r=el.getBoundingClientRect(), s=getComputedStyle(el);
        return r.width>0 && r.height>0 && s.display!=="none" && s.visibility!=="hidden";
      });
      const el = candidates.find(e => {
        const host=e.closest('[role="textbox"]');
        return /What do you want to create\?/i.test([
          e.getAttribute("data-placeholder")||"",
          e.getAttribute("placeholder")||"",
          host?.getAttribute("data-placeholder")||"",
          host?.getAttribute("placeholder")||""
        ].join(" "));
      }) || candidates.sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom)[0];
      if (!el) return {ok:false};
      el.focus();
      const range=document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection=window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const active=document.activeElement;
      return {
        ok:true,
        activeTag:active?.tagName||null,
        activeRole:active?.getAttribute("role")||"",
        activeContenteditable:active?.getAttribute("contenteditable")||"",
        activePlaceholder:active?.getAttribute("data-placeholder")||active?.getAttribute("placeholder")||"",
        selection:selection ? {
          rangeCount:selection.rangeCount,
          anchorNode:selection.anchorNode?.nodeName||null,
          anchorOffset:selection.anchorOffset,
          focusNode:selection.focusNode?.nodeName||null,
          focusOffset:selection.focusOffset
        } : null
      };
    })()`);

    const afterFocus = await snapshot();

    // Test the most reliable CDP text insertion path first.
    await sendCommand(flowTab.id,"Input.insertText",{text});
    await new Promise(r=>setTimeout(r,500));
    const afterInsertText = await snapshot();

    const insertWorked = JSON.stringify(afterInsertText).includes(text);

    if (!insertWorked) {
      // Test a single real character event. This tells us whether Flow accepts
      // browser-style keyboard input even when Input.insertText is ignored.
      await sendCommand(flowTab.id,"Input.dispatchKeyEvent",{
        type:"keyDown",key:"D",code:"KeyD",windowsVirtualKeyCode:68,nativeVirtualKeyCode:68
      });
      await sendCommand(flowTab.id,"Input.dispatchKeyEvent",{
        type:"char",key:"D",text:"D",unmodifiedText:"D"
      });
      await sendCommand(flowTab.id,"Input.dispatchKeyEvent",{
        type:"keyUp",key:"D",code:"KeyD",windowsVirtualKeyCode:68,nativeVirtualKeyCode:68
      });
      await new Promise(r=>setTimeout(r,500));
    }

    const afterKey = await snapshot();

    return {
      ok: JSON.stringify(afterInsertText).includes(text) || JSON.stringify(afterKey).includes(text.slice(0,1)),
      stage: "input-test-complete",
      scene,
      target,
      before,
      afterScene,
      focused,
      afterFocus,
      afterInsertText,
      afterKey,
      interpretation: {
        insertTextChangedComposer: JSON.stringify(afterInsertText).includes(text),
        singleKeyChangedComposer: JSON.stringify(afterKey).includes("D")
      }
    };
  } finally {
    await chrome.debugger.detach({tabId:flowTab.id}).catch(()=>{});
  }
}

async function generateAndDownloadOne(flowTab) {
  const downloadStartedAt = Date.now();

  await chrome.debugger.attach({ tabId: flowTab.id }, "1.3");

  try {
    const generationStart = await evaluate(flowTab.id, `(() => {
      const videos = Array.from(document.querySelectorAll("video")).filter(video => {
        const r = video.getBoundingClientRect();
        return r.width > 120 && r.height > 80;
      });
      return {
        videoCount: videos.length,
        sources: videos.map(video => video.currentSrc || video.src || "")
      };
    })()`);

    const submitted = await evaluate(flowTab.id, `(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 &&
          s.visibility !== "hidden" &&
          s.display !== "none" &&
          !el.disabled &&
          el.getAttribute("aria-disabled") !== "true";
      };

      const editors = Array.from(document.querySelectorAll(
        '[data-slate-editor="true"]'
      )).filter(visible);

      const contenteditables = Array.from(document.querySelectorAll(
        '[contenteditable="true"]'
      )).filter(visible);

      const inputs = editors.length ? editors : contenteditables;
      const input = inputs[inputs.length - 1];

      if (!input) {
        return {
          ok: false,
          reason: "Flow Slate/contenteditable editor not found",
          editorCount: editors.length,
          contenteditableCount: contenteditables.length
        };
      }

      const inputRect = input.getBoundingClientRect();
      const submitIcons = new Set([
        "arrow_forward",
        "arrow_upward",
        "send",
        "north_east"
      ]);

      const ancestry = [];
      let root = input;
      for (let i = 0; root && root !== document.body && i < 12; i++, root = root.parentElement) {
        ancestry.push(root);
      }

      const inspectButtons = container => Array.from(
        container.querySelectorAll('button,[role="button"]')
      ).filter(visible).map(button => {
        const r = button.getBoundingClientRect();
        const icons = Array.from(button.querySelectorAll("i"))
          .map(i => (i.textContent || "").trim())
          .filter(Boolean);

        const label = [
          button.innerText || "",
          button.getAttribute("aria-label") || "",
          button.getAttribute("title") || "",
          button.getAttribute("data-testid") || "",
          ...icons
        ].join(" ").trim();

        const recognizedIcon = icons.find(icon => submitIcons.has(icon)) || "";

        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const distance = Math.hypot(cx - inputRect.right, cy - inputRect.bottom);

        return {
          button,
          label,
          recognizedIcon,
          distance,
          rect: {top:r.top,left:r.left,width:r.width,height:r.height},
          center: {x:cx,y:cy}
        };
      });

      let allCandidates = [];

      for (let level = 0; level < ancestry.length; level++) {
        const root = ancestry[level];
        const candidates = inspectButtons(root)
          .filter(x => x.recognizedIcon)
          .map(x => ({...x, level}));

        if (candidates.length) {
          allCandidates = candidates;
          break;
        }
      }

      if (!allCandidates.length) {
        return {
          ok: false,
          reason: "No recognized Flow submit icon found inside Slate editor ancestry",
          inputRect: {
            top: inputRect.top,
            left: inputRect.left,
            width: inputRect.width,
            height: inputRect.height
          },
          editors: editors.length,
          contenteditables: contenteditables.length,
          visibleButtonsNearEditor: inspectButtons(document.body)
            .filter(x => x.distance < 500)
            .slice(0, 20)
            .map(x => ({
              label:x.label,
              recognizedIcon:x.recognizedIcon,
              distance:Math.round(x.distance),
              rect:x.rect
            }))
        };
      }

      allCandidates.sort((a,b) => a.distance - b.distance);
      const target = allCandidates[0];

      return {
        ok: true,
        label: target.label,
        icon: target.recognizedIcon,
        distance: Math.round(target.distance),
        ancestryLevel: target.level,
        clickX: target.center.x,
        clickY: target.center.y,
        rect: target.rect
      };
    })()`);

    if (!submitted || !submitted.ok) {
      throw new Error(
        "Google Flow submit arrow was not found. Details: " +
        JSON.stringify(submitted || {})
      );
    }

    await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: submitted.clickX,
      y: submitted.clickY
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: submitted.clickX,
      y: submitted.clickY,
      button: "left",
      clickCount: 1
    });
    await new Promise(resolve => setTimeout(resolve, 75));
    await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: submitted.clickX,
      y: submitted.clickY,
      button: "left",
      clickCount: 1
    });

    // Flow may ask for generation confirmation/credit approval.
    // Only auto-approve when the visible dialog explicitly says it is
    // starting this video generation. Then select "Always approve" and
    // confirm with "Approve".
    const approval = await evaluate(flowTab.id, `(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 &&
          s.display !== "none" && s.visibility !== "hidden";
      };
      const body = (document.body?.innerText || "").toLowerCase();
      const isGenerationDialog =
        body.includes("would you like me to kick off") &&
        body.includes("video generation") &&
        body.includes("approve");

      if (!isGenerationDialog) return {needed:false};

      const nodes = Array.from(document.querySelectorAll('button,[role="button"],[role="option"],label')).filter(visible);
      const findByText = text => nodes.find(el => {
        const value = [
          el.innerText || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("title") || ""
        ].join(" ").trim();
        return new RegExp("^" + text + "$","i").test(value);
      });

      const always = findByText("Always approve");
      const approve = findByText("Approve");

      const pick = always || approve;
      if (!pick) {
        return {
          needed:true,
          ok:false,
          reason:"Generation approval dialog detected, but approval controls were not found."
        };
      }

      const r = pick.getBoundingClientRect();
      return {
        needed:true,
        ok:true,
        action:always ? "always-approve" : "approve",
        x:r.left+r.width/2,
        y:r.top+r.height/2
      };
    })()`);

    if (approval && approval.needed) {
      if (!approval.ok) {
        throw new Error(approval.reason);
      }

      await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
        type:"mouseMoved", x:approval.x, y:approval.y
      });
      await new Promise(resolve => setTimeout(resolve, 75));
      await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
        type:"mousePressed", x:approval.x, y:approval.y,
        button:"left", clickCount:1
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
        type:"mouseReleased", x:approval.x, y:approval.y,
        button:"left", clickCount:1
      });

      if (approval.action === "always-approve") {
        await new Promise(resolve => setTimeout(resolve, 250));
        const confirm = await evaluate(flowTab.id, `(() => {
          const visible = el => {
            const r=el.getBoundingClientRect();
            const s=getComputedStyle(el);
            return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";
          };
          const nodes=Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
          const el=nodes.find(n => /^Approve$/i.test((n.innerText||"").trim()));
          if(!el) return null;
          const r=el.getBoundingClientRect();
          return {x:r.left+r.width/2,y:r.top+r.height/2};
        })()`);

        if (!confirm) {
          throw new Error("Always approve was selected, but the final Approve button was not found.");
        }

        await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
          type:"mouseMoved", x:confirm.x, y:confirm.y
        });
        await new Promise(resolve => setTimeout(resolve, 75));
        await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
          type:"mousePressed", x:confirm.x, y:confirm.y,
          button:"left", clickCount:1
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
          type:"mouseReleased", x:confirm.x, y:confirm.y,
          button:"left", clickCount:1
        });
      }
    }

    const generationWaitStarted = Date.now();
    let lastState = null;

    while (Date.now() - generationWaitStarted < 600000) {
      lastState = await evaluate(flowTab.id, `(() => {
        const videos = Array.from(document.querySelectorAll("video")).filter(video => {
          const r = video.getBoundingClientRect();
          return r.width > 120 && r.height > 80;
        });

        const baselineCount = generationStart.videoCount;
        const baselineSources = JSON.stringify(generationStart.sources || []);

        const candidates = videos.map(video => ({
          src: video.currentSrc || video.src || "",
          duration: Number(video.duration || 0),
          readyState: video.readyState,
          width: video.getBoundingClientRect().width,
          height: video.getBoundingClientRect().height
        }));

        const readyVideo = candidates.find(video => {
          const isNew = video.src && !baselineSources.includes(video.src);
          const playable = Number.isFinite(video.duration) &&
            video.duration > 0 && video.readyState >= 2;
          return playable && (candidates.length > baselineCount || isNew);
        });

        const bodyText = document.body?.innerText || "";
        return {
          videoCount: videos.length,
          ready: Boolean(readyVideo),
          duration: readyVideo ? readyVideo.duration : 0,
          source: readyVideo ? readyVideo.src : "",
          bodySample: bodyText.slice(-1200)
        };
      })()`);

      if (lastState && lastState.ready) {
        const downloadClicked = await evaluate(flowTab.id, `(() => {
          const isVisible = node => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.height > 0 &&
              !node.disabled &&
              node.getAttribute("aria-disabled") !== "true";
          };

          const nodes = Array.from(document.querySelectorAll('button, [role="button"], a'))
            .filter(isVisible);

          const scored = nodes.map(node => {
            const label = [
              node.innerText || "",
              node.getAttribute("aria-label") || "",
              node.getAttribute("title") || "",
              node.textContent || ""
            ].join(" ").trim().toLowerCase();

            let score = 0;
            if (label === "download") score += 100;
            if (label.includes("download")) score += 50;
            return {node,label,score};
          }).sort((a,b) => b.score-a.score);

          const target = scored.find(x => x.score >= 50);
          if (!target) {
            return {
              ok:false,
              candidates:scored.slice(0,20).map(x => x.label)
            };
          }

          target.node.click();
          return {ok:true,label:target.label};
        })()`);

        if (!downloadClicked || !downloadClicked.ok) {
          throw new Error(
            "Google Flow Download control was not found after video generation. Candidates: " +
            JSON.stringify(downloadClicked && downloadClicked.candidates || [])
          );
        }

        const file = await waitForNewDownload(downloadStartedAt);
        return {
          submitted,
          video:lastState,
          download:downloadClicked,
          file
        };
      }

      await new Promise(resolve => setTimeout(resolve, 2500));
    }

    throw new Error(
      "Timed out waiting for Google Flow to finish generating a NEW playable video. Last state: " +
      JSON.stringify(lastState)
    );
  } finally {
    await chrome.debugger.detach({ tabId: flowTab.id }).catch(() => {});
  }
}

async function waitForNewDownload(startTimeMs, timeoutMs = 120000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const items = await chrome.downloads.search({ startedAfter: startTimeMs / 1000, orderBy: ["-startTime"] });
    const item = items.find(download => {
      const name = String(download.filename || "").toLowerCase();
      return name.endsWith(".mp4") || String(download.mime || "").toLowerCase().includes("video");
    });

    if (item) {
      if (item.state === "complete") return item;
      if (item.state === "interrupted") {
        throw new Error("Video download was interrupted: " + (item.error || "unknown error"));
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  throw new Error("Timed out waiting for the downloaded video file.");
}

async function testChatToFlowHandoff() {
  const jobResponse = await bridgeRequest("/api/job");
  const job = jobResponse.job;
  if (!job) throw new Error("No local job.json available.");

  const item = Array.isArray(job.jobs) ? job.jobs[0] : null;
  if (!item || !item.prompt) throw new Error("job.json has no usable first prompt.");

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

  const started = Date.now();
  const compiledPrompt = await sendPromptToChat(targets.chat, compilerInstruction);
  const chatDoneMs = Date.now() - started;

  const flowResult = await prepareFlow(targets.flow, compiledPrompt);

  return {
    ok: Boolean(flowResult?.ready),
    status: flowResult?.ready ? "CHATGPT_TO_FLOW_HANDOFF_READY" : "CHATGPT_TO_FLOW_HANDOFF_FAILED",
    chatDoneMs,
    promptLength: compiledPrompt.length,
    promptPreview: compiledPrompt.slice(0, 500),
    flow: flowResult
  };
}

async function moveLastChatToFlow() {
  const targets = await findTargets();
  if (!targets.chat) throw new Error("Dedicated ChatGPT room was not found.");
  if (!targets.flow) throw new Error("Google Flow tab was not found.");

  // PHASE 3 ONLY.
  // IMPORTANT: user manually opens Scenes first.
  // Do not search for/click Scenes here. The proven direct Flow input
  // path works once the user has already opened the correct video scene.
  await chrome.debugger.attach({ tabId: targets.chat.id }, "1.3");
  let lastAssistantText = "";
  let chatSnapshot = null;
  try {
    chatSnapshot = await evaluate(targets.chat.id, `(() => {
  const messages = Array.from(
    document.querySelectorAll('[data-message-author-role="assistant"]')
  );
  const last = messages[messages.length - 1];
  return {
    count: messages.length,
    text: last ? (last.innerText || last.textContent || "").trim() : ""
  };
})()`);
    lastAssistantText = String(chatSnapshot?.text || "").trim();
  } finally {
    await chrome.debugger.detach({ tabId: targets.chat.id }).catch(() => {});
  }

  if (!lastAssistantText) throw new Error("No usable last assistant message was found in ChatGPT.");

  // Flow is assumed to already be on Scenes/video composer.
  // Reuse the exact same prepareFlow path proven by TEST DIRECT TEXT -> FLOW.
  const flowResult = await prepareFlow(targets.flow, lastAssistantText);

  return {
    ok: Boolean(flowResult?.ready),
    status: flowResult?.ready ? "LAST_CHATGPT_TO_FLOW_READY" : "LAST_CHATGPT_TO_FLOW_FAILED",
    source: {
      chatTabId: targets.chat.id,
      assistantMessageCount: chatSnapshot?.count || 0,
      textLength: lastAssistantText.length,
      preview: lastAssistantText.slice(0, 300)
    },
    flow: flowResult
  };
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

  let imageResult = null;
  if (flowResult.ready) {
    imageResult = await prepareFlowImage(targets.flow, job.product || {});
  }

  let generation = null;
  if (imageResult && imageResult.ready) {
    generation = await generateAndDownloadOne(targets.flow);
  }

  const result = {
    status: generation ? "VIDEO_GENERATED_AND_DOWNLOADED" : (imageResult?.ready ? "FLOW_IMAGE_READY" : (flowResult.ready ? "FLOW_PROMPT_READY" : "FLOW_PROMPT_NOT_READY")),
    compiledPrompt,
    flow: flowResult,
    generation,
    angle: item.angle || null,
    timestamp: new Date().toISOString()
  };

  await bridgeRequest("/api/result", {
    method: "POST",
    body: JSON.stringify(result)
  });

  return result;
}

async function trustedDebuggerInput(tabId, type, payload) {
  await chrome.debugger.attach({ tabId }, "1.3");
  try {
    if (type === "click") {
      await sendCommand(tabId, "Input.dispatchMouseEvent", { type:"mouseMoved", x:payload.x, y:payload.y });
      await new Promise(r => setTimeout(r, 75));
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type:"mousePressed", x:payload.x, y:payload.y, button:"left", clickCount:1
      });
      await new Promise(r => setTimeout(r, 50));
      await sendCommand(tabId, "Input.dispatchMouseEvent", {
        type:"mouseReleased", x:payload.x, y:payload.y, button:"left", clickCount:1
      });
    } else {
      await sendCommand(tabId, "Input.insertText", { text:payload.text });
    }
    return {ok:true};
  } finally {
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
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

  if (message.type === "DICIDY_TRUSTED_CLICK") {
    trustedDebuggerInput(message.tabId || _sender.tab?.id, "click", {
      x: Number(message.x),
      y: Number(message.y)
    })
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok:false, error:error.message }));
    return true;
  }

  if (message.type === "DICIDY_TRUSTED_TYPE") {
    trustedDebuggerInput(message.tabId || _sender.tab?.id, "type", {
      text: String(message.text || "")
    })
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ ok:false, error:error.message }));
    return true;
  }

  if (message.type === "DICIDY_TEST_FLOW_DIRECT") {
    testFlowDirectInput()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ok:false,error:error.message}));
    return true;
  }

  if (message.type === "DICIDY_TEST_CHAT_TO_FLOW") {
    testChatToFlowHandoff()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, status: "ERROR", error: error.message }));
    return true;
  }

  if (message.type === "DICIDY_MOVE_LAST_CHAT_TO_FLOW") {
    moveLastChatToFlow()
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, status: "ERROR", error: error.message }));
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
