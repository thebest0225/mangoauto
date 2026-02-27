/**
 * MangoAuto - Flow Fetch Interceptor + Prompt Injector (v3)
 * Injected into MAIN world to intercept native window.fetch
 *
 * v3 changes:
 * - Don't destroy DOM state when text is already present (clipboard paste fix)
 * - Find and call __reactProps$ event handlers directly
 * - Use React queue.dispatch() instead of direct state assignment
 * - Use InputEvent (not plain Event) with proper inputType/data
 * - Remove getter overrides (interferes with React DOM diffing)
 * - Dispatch beforeinput + input event sequence for framework notification
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Inject]';
  const originalFetch = window.fetch;
  let batchSeq = 0;
  const pendingVideoOps = new Map();

  // ─── Prompt Injection State ───
  let pendingPrompt = null;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Listen for SET_FLOW_PROMPT from content script ───
  window.addEventListener('message', async (event) => {
    if (event.data?.type === 'SET_FLOW_PROMPT') {
      pendingPrompt = event.data.text;
      console.log(LOG_PREFIX, '📝 Prompt received:', pendingPrompt?.substring(0, 60));
      await setPromptInFramework(event.data.text);
      window.postMessage({ type: 'SET_FLOW_PROMPT_RESULT', ok: true }, '*');
    }
  });

  // ─── Find prompt element (mirrors flow.js logic) ───
  function findPromptElement() {
    // 1. By ID
    let el = document.getElementById('PINHOLE_TEXT_AREA_ELEMENT_ID');
    if (el) return el;

    // 2. Find generate button (arrow_forward icon)
    let genBtn = null;
    for (const btn of document.querySelectorAll('button')) {
      for (const icon of btn.querySelectorAll('i')) {
        if (icon.textContent?.trim() === 'arrow_forward') { genBtn = btn; break; }
      }
      if (genBtn) break;
    }

    // 3. Contenteditable near generate button
    if (genBtn) {
      let container = genBtn.parentElement;
      for (let i = 0; i < 6 && container; i++) {
        const ce = container.querySelector('[contenteditable="true"]');
        if (ce && ce.offsetHeight > 10) return ce;
        container = container.parentElement;
      }
    }

    // 4. Any visible contenteditable
    for (const ce of document.querySelectorAll('[contenteditable="true"]')) {
      if (ce.offsetHeight > 10 && ce.offsetWidth > 100) return ce;
    }

    // 5. Any visible textarea (not recaptcha)
    for (const ta of document.querySelectorAll('textarea')) {
      if (!(ta.id || '').includes('recaptcha') && ta.offsetHeight > 10) return ta;
    }

    return null;
  }

  // ─── Main prompt setting function (v3) ───
  async function setPromptInFramework(text) {
    const el = findPromptElement();
    if (!el) {
      console.warn(LOG_PREFIX, '❌ Prompt element not found');
      return;
    }

    const currentText = (el.textContent || '').trim();
    const textAlreadyPresent = currentText.length > 10 && currentText.includes(text.substring(0, 20));

    console.log(LOG_PREFIX, `🔍 Element: <${el.tagName}> ce=${el.contentEditable}`);
    console.log(LOG_PREFIX, `📋 Text in DOM: ${textAlreadyPresent ? 'YES' : 'NO'} ("${currentText.substring(0, 40)}")`);

    // Strategy 1: Find __reactProps$ handlers on element and parents
    const propsFound = tryReactPropsHandlers(el, text);

    // Strategy 2: If text NOT in DOM, insert via execCommand (don't use selectAll+delete)
    if (!textAlreadyPresent) {
      console.log(LOG_PREFIX, '📝 Text not in DOM, inserting...');
      el.focus();
      await sleep(50);
      // Use insertText which is less destructive than selectAll+delete
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      console.log(LOG_PREFIX, `📝 Inserted, content="${(el.textContent || '').substring(0, 40)}"`);
    } else {
      console.log(LOG_PREFIX, '📋 Text already in DOM, skipping re-insert');
    }

    // Strategy 3: Dispatch proper InputEvent sequence
    await dispatchInputEvents(el, text);

    // Strategy 4: React state dispatch via queue.dispatch()
    tryReactStateDispatch(el, text);

    // Strategy 5: Try calling Angular/Wiz change detection
    tryAngularChangeDetection(el);
  }

  // ─── Strategy 1: Find __reactProps$ and call event handlers ───
  function tryReactPropsHandlers(el, text) {
    let found = false;
    let node = el;

    for (let depth = 0; depth < 8 && node; depth++) {
      // Find __reactProps$ key
      let propsKey = null;
      try {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (key.startsWith('__reactProps$')) { propsKey = key; break; }
        }
      } catch (e) {}

      if (propsKey) {
        const props = node[propsKey];
        const handlers = [];
        try {
          for (const k of Object.keys(props)) {
            if (typeof props[k] === 'function') handlers.push(k);
          }
        } catch (e) {}

        console.log(LOG_PREFIX, `⚛️ __reactProps$ depth ${depth} <${node.tagName}>: [${handlers.join(', ')}]`);

        // Log non-function props too (for debugging)
        try {
          for (const k of Object.keys(props)) {
            if (typeof props[k] === 'string' && props[k].length < 100) {
              console.log(LOG_PREFIX, `  prop.${k} = "${props[k].substring(0, 50)}"`);
            }
          }
        } catch (e) {}

        // Create a synthetic-ish event
        const makeInputEvent = (type, inputType) => {
          try {
            return new InputEvent(type, {
              bubbles: true,
              cancelable: type === 'beforeinput',
              composed: true,
              inputType: inputType || 'insertText',
              data: text
            });
          } catch (e) {
            return new Event(type, { bubbles: true });
          }
        };

        // Call handlers directly
        if (props.onBeforeInput) {
          console.log(LOG_PREFIX, `  → Calling onBeforeInput`);
          try { props.onBeforeInput(makeInputEvent('beforeinput', 'insertText')); } catch (e) {
            console.log(LOG_PREFIX, `  → onBeforeInput error: ${e.message}`);
          }
          found = true;
        }
        if (props.onInput) {
          console.log(LOG_PREFIX, `  → Calling onInput`);
          try { props.onInput(makeInputEvent('input', 'insertText')); } catch (e) {
            console.log(LOG_PREFIX, `  → onInput error: ${e.message}`);
          }
          found = true;
        }
        if (props.onChange) {
          console.log(LOG_PREFIX, `  → Calling onChange`);
          try { props.onChange(makeInputEvent('input', 'insertText')); } catch (e) {
            console.log(LOG_PREFIX, `  → onChange error: ${e.message}`);
          }
          found = true;
        }
        if (props.onCompositionEnd) {
          console.log(LOG_PREFIX, `  → Calling onCompositionEnd`);
          try {
            props.onCompositionEnd(new CompositionEvent('compositionend', {
              data: text, bubbles: true
            }));
          } catch (e) {}
          found = true;
        }
        if (props.onPaste) {
          console.log(LOG_PREFIX, `  → Calling onPaste`);
          try { props.onPaste({ clipboardData: { getData: () => text } }); } catch (e) {
            console.log(LOG_PREFIX, `  → onPaste error: ${e.message}`);
          }
          found = true;
        }

        // For the element itself (depth 0), we care the most
        if (depth === 0 && found) break;
      }

      // Also check __reactEvents$ (React 18+)
      try {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (key.startsWith('__reactEvents$')) {
            console.log(LOG_PREFIX, `⚛️ __reactEvents$ found on <${node.tagName}> depth ${depth}`);
          }
        }
      } catch (e) {}

      node = node.parentElement;
    }

    if (!found) {
      console.log(LOG_PREFIX, '⚛️ No __reactProps$ handlers found');
    }
    return found;
  }

  // ─── Strategy 3: Dispatch proper InputEvent sequence ───
  async function dispatchInputEvents(el, text) {
    console.log(LOG_PREFIX, '📤 Dispatching InputEvent sequence');

    el.focus();
    await sleep(30);

    // beforeinput
    try {
      el.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
    } catch (e) {}

    // input with insertText
    try {
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        composed: true
      }));
    } catch (e) {}

    // input with insertFromPaste (some frameworks check this)
    try {
      el.dispatchEvent(new InputEvent('input', {
        inputType: 'insertFromPaste',
        data: text,
        bubbles: true,
        composed: true
      }));
    } catch (e) {}

    // compositionend (used by some frameworks including CJK handling)
    try {
      el.dispatchEvent(new CompositionEvent('compositionstart', {
        data: '', bubbles: true
      }));
      el.dispatchEvent(new CompositionEvent('compositionend', {
        data: text, bubbles: true
      }));
    } catch (e) {}

    // Plain events as fallback
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Blur + refocus can trigger some frameworks' validation
    el.blur();
    await sleep(50);
    el.focus();
  }

  // ─── Strategy 4: React state dispatch via queue.dispatch() ───
  function tryReactStateDispatch(el, text) {
    let node = el;
    let dispatched = false;

    for (let depth = 0; depth < 3 && node; depth++) {
      // Find React fiber key
      let fiberKey = null;
      try {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
            fiberKey = key;
            break;
          }
        }
      } catch (e) {}

      if (!fiberKey) { node = node.parentElement; continue; }

      try {
        const fiber = node[fiberKey];
        let current = fiber;

        // Walk up fiber tree (more levels than before)
        for (let level = 0; level < 20 && current; level++) {
          if (current.memoizedState) {
            let hook = current.memoizedState;
            let hookIdx = 0;

            while (hook) {
              // Check: has queue.dispatch AND is a string state
              if (hook.queue?.dispatch) {
                const stateType = typeof hook.memoizedState;
                const stateVal = stateType === 'string' ? hook.memoizedState : null;

                if (stateType === 'string') {
                  console.log(LOG_PREFIX,
                    `⚛️ Hook[${hookIdx}] fiber-level ${level}: ` +
                    `"${(stateVal || '').substring(0, 30)}" (dispatch=✓)`
                  );

                  // Dispatch if empty or very short (likely the prompt state)
                  if (stateVal === '' || stateVal.length < 3) {
                    console.log(LOG_PREFIX, `  → dispatch("${text.substring(0, 30)}")`);
                    try {
                      hook.queue.dispatch(text);
                      dispatched = true;
                    } catch (e) {
                      console.log(LOG_PREFIX, `  → dispatch error: ${e.message}`);
                      // Fallback: direct assignment
                      hook.memoizedState = text;
                      hook.baseState = text;
                    }
                  }
                }
              }

              hook = hook.next;
              hookIdx++;
            }
          }
          current = current.return;
        }
      } catch (e) {
        console.warn(LOG_PREFIX, `⚛️ Fiber walk error: ${e.message}`);
      }

      break; // Only process first element with fiber
    }

    if (!dispatched) {
      console.log(LOG_PREFIX, '⚛️ No React useState dispatch targets found');
    }
  }

  // ─── Strategy 5: Angular/Wiz change detection ───
  function tryAngularChangeDetection(el) {
    // Google's apps sometimes use Angular or Wiz framework
    // Try to trigger change detection

    // Angular: find ngZone on window
    try {
      if (window.ng) {
        const component = window.ng.getComponent(el) || window.ng.getComponent(el.parentElement);
        if (component) {
          console.log(LOG_PREFIX, '🔧 Angular component found');
        }
      }
    } catch (e) {}

    // Wiz: look for jscontroller/jsaction attributes
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      const jsc = node.getAttribute?.('jscontroller');
      const jsa = node.getAttribute?.('jsaction');
      if (jsc || jsa) {
        console.log(LOG_PREFIX, `🔧 Wiz element found: jscontroller="${jsc}" jsaction="${(jsa || '').substring(0, 60)}"`);
        // Try triggering Wiz action
        if (jsa && jsa.includes('input')) {
          console.log(LOG_PREFIX, '  → Dispatching for Wiz input action');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        break;
      }
      node = node.parentElement;
    }
  }

  // ─── Fetch Interceptor ───
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    const isImageApi = url.includes('batchGenerate') &&
                       !url.includes('Async') &&
                       !url.includes('Check');
    const isVideoStart = url.includes('batchAsyncGenerateVideo');
    const isVideoCheck = url.includes('batchCheckAsyncVideo');

    if (!isImageApi && !isVideoStart && !isVideoCheck) {
      return originalFetch.apply(this, args);
    }

    const currentSeq = batchSeq++;
    let requestPrompt = '';

    console.log(LOG_PREFIX, `🌐 Fetch intercepted: ${url.substring(0, 80)}`);

    // Extract prompt from request body
    try {
      const body = args[1]?.body;
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        requestPrompt = parsed.requests?.[0]?.prompt ||
                       parsed.requests?.[0]?.textInput?.prompt ||
                       parsed.request?.prompt || '';
        console.log(LOG_PREFIX, `🌐 Request prompt: "${(requestPrompt || '(empty)').substring(0, 40)}"`);
      }
    } catch (e) {}

    // ─── Prompt Injection: replace empty/wrong prompt ───
    if ((isImageApi || isVideoStart) && pendingPrompt) {
      try {
        const body = args[1]?.body;
        if (typeof body === 'string') {
          const parsed = JSON.parse(body);

          console.log(LOG_PREFIX, `⚡ Injecting prompt: "${pendingPrompt.substring(0, 40)}"`);

          // Deep inject: walk the entire request object and fill empty prompt fields
          const injectPrompt = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
              if (key.toLowerCase().includes('prompt') && typeof obj[key] === 'string' &&
                  (obj[key] === '' || obj[key].length < 3)) {
                console.log(LOG_PREFIX, `  → ${key}: "${obj[key]}" → injected`);
                obj[key] = pendingPrompt;
              }
              if (typeof obj[key] === 'object') injectPrompt(obj[key]);
            }
          };
          injectPrompt(parsed);

          // Also set known locations explicitly
          if (parsed.requests?.[0]) {
            parsed.requests[0].prompt = pendingPrompt;
            if (parsed.requests[0].textInput) {
              parsed.requests[0].textInput.prompt = pendingPrompt;
            }
          }
          if (parsed.request) {
            parsed.request.prompt = pendingPrompt;
          }

          args = [args[0], { ...args[1], body: JSON.stringify(parsed) }];
          requestPrompt = pendingPrompt;
          console.log(LOG_PREFIX, '✅ Prompt injected into request body');
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Prompt injection failed:', e.message);
      }
      pendingPrompt = null;
    }

    try {
      const response = await originalFetch.apply(this, args);

      // ─── Video Check (polling) ───
      if (isVideoCheck) {
        const clone = response.clone();
        clone.json().then((data) => {
          if (!data.operations) return;

          for (const op of data.operations) {
            const opName = op.operation?.name;
            const pending = pendingVideoOps.get(opName);
            if (!pending) continue;

            if (op.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
              const videoUrl = op.operation?.metadata?.video?.fifeUrl ||
                              op.operation?.metadata?.video?.videoUri;

              pendingVideoOps.delete(opName);
              console.log(LOG_PREFIX, 'Video ready:', videoUrl?.substring(0, 60));

              window.postMessage({
                type: 'VEO3_API_RESULT',
                seq: pending.seq,
                prompt: pending.prompt,
                status: 200,
                ok: true,
                hasMedia: !!videoUrl,
                mediaUrls: videoUrl ? [videoUrl] : [],
                isVideo: true
              }, '*');

            } else if (op.status === 'MEDIA_GENERATION_STATUS_FAILED') {
              pendingVideoOps.delete(opName);
              const failReason = op.operation?.error?.message || op.failureReason || '';
              console.log(LOG_PREFIX, 'Video failed:', opName, failReason);

              window.postMessage({
                type: 'VEO3_API_RESULT',
                seq: pending.seq,
                prompt: pending.prompt,
                status: 400,
                ok: false,
                error: failReason || 'Video generation failed',
                errorCode: op.operation?.error?.code || op.status,
                isVideo: true
              }, '*');
            }
          }
        }).catch(() => {});
        return response;
      }

      // ─── Video Start ───
      if (isVideoStart) {
        const clone = response.clone();
        clone.json().then((data) => {
          if (response.ok && data.operations) {
            for (const op of data.operations) {
              if (op.operation?.name) {
                pendingVideoOps.set(op.operation.name, {
                  seq: currentSeq,
                  prompt: requestPrompt
                });
                console.log(LOG_PREFIX, 'Video started:', op.operation.name);
              }
            }
          } else if (!response.ok) {
            window.postMessage({
              type: 'VEO3_API_RESULT',
              seq: currentSeq,
              prompt: requestPrompt,
              status: response.status,
              ok: false,
              error: data.error?.message || 'Video start failed',
              errorCode: data.error?.code,
              isVideo: true
            }, '*');
          }
        }).catch(() => {});
        return response;
      }

      // ─── Image Generation (sync) ───
      if (isImageApi) {
        const clone = response.clone();
        clone.json().then((data) => {
          const result = {
            type: 'VEO3_API_RESULT',
            seq: currentSeq,
            prompt: requestPrompt,
            status: response.status,
            ok: response.ok,
            hasMedia: false,
            mediaUrls: [],
            isVideo: false
          };

          if (response.ok && data.media) {
            result.mediaUrls = data.media
              .map(m => m.image?.generatedImage?.fifeUrl || m.fifeUrl || '')
              .filter(Boolean);
            result.hasMedia = result.mediaUrls.length > 0;
            if (!result.hasMedia) {
              result.error = '생성 실패: 미디어 URL 없음';
              result.errorCode = 'NO_MEDIA';
            }
          } else if (response.ok && !data.media) {
            result.error = '생성 실패: 응답에 미디어 없음';
            result.errorCode = 'NO_MEDIA';
          } else if (!response.ok) {
            result.error = data.error?.message || 'Image generation failed';
            result.errorCode = data.error?.code;
          }

          console.log(LOG_PREFIX, 'Image result:', result.ok, result.mediaUrls.length, 'urls');
          window.postMessage(result, '*');
        }).catch(() => {});
        return response;
      }

      return response;
    } catch (err) {
      console.error(LOG_PREFIX, 'Fetch error:', err);
      throw err;
    }
  };

  console.log(LOG_PREFIX, 'Fetch interceptor + prompt injector installed (v3)');
})();
