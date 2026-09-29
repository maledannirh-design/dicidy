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
    const sceneNav = await evaluate(flowTab.id, `(() => {
      const visible = el => { const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"&&!el.disabled; };
      const nodes=Array.from(document.querySelectorAll('button,[role="button"],a')).filter(visible);
      const target=nodes.find(el=>/^Scenes$/i.test([el.innerText||"",el.getAttribute("aria-label")||"",el.getAttribute("title")||""].join(" ").trim()));
      if(!target)return {found:false}; const r=target.getBoundingClientRect(); return {found:true,x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
    if(sceneNav?.found){
      await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseMoved",x:sceneNav.x,y:sceneNav.y});
      await new Promise(r=>setTimeout(r,75));
      await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mousePressed",x:sceneNav.x,y:sceneNav.y,button:"left",clickCount:1});
      await new Promise(r=>setTimeout(r,50));
      await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseReleased",x:sceneNav.x,y:sceneNav.y,button:"left",clickCount:1});
      await new Promise(r=>setTimeout(r,700));
    }

    const input=await evaluate(flowTab.id,`(() => {
      const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"&&!el.disabled;};
      const selectors=['[data-slate-editor="true"]','[contenteditable="true"]','textarea','input[type="text"]'];
      let candidates=[];
      for(const selector of selectors){candidates=Array.from(document.querySelectorAll(selector)).filter(visible);if(candidates.length)break;}
      candidates.sort((a,b)=>b.getBoundingClientRect().bottom-a.getBoundingClientRect().bottom);
      const el=candidates[candidates.length-1];
      if(!el)return {ok:false,reason:"Flow prompt editor not found",slate:document.querySelectorAll('[data-slate-editor="true"]').length,contenteditable:document.querySelectorAll('[contenteditable="true"]').length,textarea:document.querySelectorAll('textarea').length};
      el.scrollIntoView({block:"center",inline:"center"});const r=el.getBoundingClientRect();
      return {ok:true,tag:el.tagName,slate:el.matches('[data-slate-editor="true"]'),aria:el.getAttribute("aria-label")||"",placeholder:el.getAttribute("data-placeholder")||el.getAttribute("placeholder")||"",x:r.left+Math.min(r.width/2,300),y:r.top+Math.min(r.height/2,40)};
    })()`);
    if(!input?.ok)return {ready:false,reason:JSON.stringify(input||{})};

    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseMoved",x:input.x,y:input.y});
    await new Promise(r=>setTimeout(r,100));
    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mousePressed",x:input.x,y:input.y,button:"left",clickCount:1});
    await new Promise(r=>setTimeout(r,50));
    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseReleased",x:input.x,y:input.y,button:"left",clickCount:1});
    await new Promise(r=>setTimeout(r,250));
    await sendCommand(flowTab.id,"Input.insertText",{text:compiledPrompt});
    await new Promise(r=>setTimeout(r,600));

    const verification=await evaluate(flowTab.id,`(() => {
      const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";};
      const nodes=Array.from(document.querySelectorAll('[data-slate-editor="true"],[contenteditable="true"],textarea,input[type="text"]')).filter(visible);
      const values=nodes.map(el=>({tag:el.tagName,text:(el.innerText||el.textContent||el.value||"").trim(),placeholder:el.getAttribute("data-placeholder")||el.getAttribute("placeholder")||""}));
      const needle=${JSON.stringify(compiledPrompt.slice(0,80))};
      return {found:values.some(v=>v.text.includes(needle)),values:values.slice(-8)};
    })()`);
    if(!verification?.found)return {ready:false,reason:"Flow composer was focused but ChatGPT prompt was not verified after paste.",input,verification};
    return {ready:true,input,verification,videoModeDeferred:true};
  } finally { await chrome.debugger.detach({tabId:flowTab.id}).catch(()=>{}); }
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
  if (!targets.flow) {
    throw new Error("Google Flow tab not found. Tabs: " + JSON.stringify(targets.flowCandidates.map(t => ({id:t.id,title:t.title,url:t.url}))));
  }

  const flowTab = targets.flow;
  await chrome.debugger.attach({ tabId: flowTab.id }, "1.3");
  try {
    const probe = await evaluate(flowTab.id, `(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      };
      const all = Array.from(document.querySelectorAll('[data-slate-editor="true"],[contenteditable="true"],textarea,input[type="text"]'));
      return {
        url: location.href,
        title: document.title,
        slate: all.filter(e => e.matches('[data-slate-editor="true"]')).filter(visible).length,
        contenteditable: all.filter(e => e.matches('[contenteditable="true"]')).filter(visible).length,
        textarea: all.filter(e => e.matches('textarea')).filter(visible).length,
        inputs: all.filter(e => e.matches('input[type="text"]')).filter(visible).length,
        elements: all.filter(visible).slice(-10).map(e => ({
          tag:e.tagName,
          slate:e.matches('[data-slate-editor="true"]'),
          text:(e.innerText||e.textContent||e.value||"").slice(0,120),
          placeholder:e.getAttribute("data-placeholder")||e.getAttribute("placeholder")||"",
          aria:e.getAttribute("aria-label")||""
        }))
      };
    })()`);

    // Force the generation surface to VIDEO before focusing the prompt.
    // Flow's current composer exposes this through generation settings.
    const videoMode = await evaluate(flowTab.id, `(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 &&
          s.display !== "none" && s.visibility !== "hidden" &&
          el.getAttribute("aria-disabled") !== "true" && !el.disabled;
      };
      const label = el => [
        el.innerText || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        el.getAttribute("data-testid") || ""
      ].join(" ").trim();

      const all = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"]')).filter(visible);

      // If a visible exact "Video" choice is already present, select it.
      let video = all.find(el => /^Video$/i.test((el.innerText || "").trim()));
      if (video) {
        const r = video.getBoundingClientRect();
        return {action:"click-video",x:r.left+r.width/2,y:r.top+r.height/2,label:label(video)};
      }

      // Otherwise open generation settings (the sliders/tune control near the composer).
      const settings = all.find(el => /generation settings|settings|tune|sliders/i.test(label(el)));
      if (!settings) return {action:"none",reason:"Video option/settings control not visible yet."};

      const r = settings.getBoundingClientRect();
      return {action:"open-settings",x:r.left+r.width/2,y:r.top+r.height/2,label:label(settings)};
    })()`);

    if (videoMode && videoMode.action !== "none") {
      await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
        type:"mouseMoved", x:videoMode.x, y:videoMode.y
      });
      await new Promise(resolve => setTimeout(resolve, 75));
      await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
        type:"mousePressed", x:videoMode.x, y:videoMode.y,
        button:"left", clickCount:1
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
        type:"mouseReleased", x:videoMode.x, y:videoMode.y,
        button:"left", clickCount:1
      });
      await new Promise(resolve => setTimeout(resolve, 500));

      // If settings was opened, now explicitly select Video.
      if (videoMode.action === "open-settings") {
        const videoChoice = await evaluate(flowTab.id, `(() => {
          const visible = el => {
            const r=el.getBoundingClientRect();
            const s=getComputedStyle(el);
            return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden"&&!el.disabled;
          };
          const nodes=Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"]')).filter(visible);
          const el=nodes.find(n => /^Video$/i.test((n.innerText||"").trim()));
          if(!el) return null;
          const r=el.getBoundingClientRect();
          return {x:r.left+r.width/2,y:r.top+r.height/2,label:el.innerText||""};
        })()`);
        if (videoChoice) {
          await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
            type:"mouseMoved", x:videoChoice.x, y:videoChoice.y
          });
          await new Promise(resolve => setTimeout(resolve, 75));
          await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
            type:"mousePressed", x:videoChoice.x, y:videoChoice.y,
            button:"left", clickCount:1
          });
          await new Promise(resolve => setTimeout(resolve, 50));
          await sendCommand(flowTab.id, "Input.dispatchMouseEvent", {
            type:"mouseReleased", x:videoChoice.x, y:videoChoice.y,
            button:"left", clickCount:1
          });
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    const input = await evaluate(flowTab.id, `(() => {
      const visible = el => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && !el.disabled;
      };
      const candidates = [
        ...Array.from(document.querySelectorAll('[data-slate-editor="true"]')).filter(visible),
        ...Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible),
        ...Array.from(document.querySelectorAll('textarea')).filter(visible),
        ...Array.from(document.querySelectorAll('input[type="text"]')).filter(visible)
      ];
      const el = candidates[candidates.length-1];
      if (!el) return null;
      el.scrollIntoView({block:"center",inline:"center"});
      const r=el.getBoundingClientRect();
      return {x:r.left+Math.min(r.width/2,300),y:r.top+Math.min(r.height/2,40),tag:el.tagName,slate:el.matches('[data-slate-editor="true"]')};
    })()`);

    if (!input) return {ok:false,reason:"No visible Flow editor",probe};

    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseMoved",x:input.x,y:input.y});
    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mousePressed",x:input.x,y:input.y,button:"left",clickCount:1});
    await sendCommand(flowTab.id,"Input.dispatchMouseEvent",{type:"mouseReleased",x:input.x,y:input.y,button:"left",clickCount:1});
    await new Promise(r=>setTimeout(r,300));

    const text="DICIDY FLOW DIRECT TEST — PLEASE SHOW THIS TEXT";
    await sendCommand(flowTab.id,"Input.insertText",{text});
    await new Promise(r=>setTimeout(r,500));

    const verify=await evaluate(flowTab.id,`(() => {
      const nodes=Array.from(document.querySelectorAll('[data-slate-editor="true"],[contenteditable="true"],textarea,input[type="text"]'));
      return nodes.filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}).map(e=>({tag:e.tagName,text:(e.innerText||e.textContent||e.value||"").slice(0,300)}));
    })()`);
    return {ok:true,input,probe,text,verify,found:JSON.stringify(verify).includes(text)};
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
