/**
 * MangoAuto - Flow Fetch Interceptor + Prompt Injector
 * Injected into MAIN world to intercept native window.fetch
 *
 * This script:
 * 1. Intercepts batchGenerate/batchAsyncGenerateVideo/batchCheckAsyncVideo
 * 2. Handles SET_FLOW_PROMPT: sets prompt in framework's internal state
 *    (bypasses Lit framework contenteditable desync)
 * 3. Overrides prompt element getters as additional safety net
 * 4. Injects prompt into outgoing API request body as final backup
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Inject]';
  const originalFetch = window.fetch;
  let batchSeq = 0;
  const pendingVideoOps = new Map();

  // ─── Prompt Injection State ───
  let pendingPrompt = null;
  let promptOverrideActive = false;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ─── Listen for SET_FLOW_PROMPT from content script ───
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'SET_FLOW_PROMPT') {
      pendingPrompt = event.data.text;
      console.log(LOG_PREFIX, '📝 Prompt received:', pendingPrompt?.substring(0, 60));
      setPromptInFramework(event.data.text);
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

  // ─── Main prompt setting function ───
  async function setPromptInFramework(text) {
    const el = findPromptElement();
    if (!el) {
      console.warn(LOG_PREFIX, '❌ Prompt element not found');
      return;
    }
    console.log(LOG_PREFIX, `🔍 Prompt element: <${el.tagName}> id="${el.id || ''}" ce=${el.contentEditable}`);

    // Strategy 1: Walk up DOM, find framework components, set properties
    const litResult = walkDOMAndSetProperties(el, text);

    // Strategy 2: execCommand selectAll + insertText in MAIN world
    try {
      el.focus();
      await sleep(50);
      // Select all content
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
      }
      // Delete selected, then insert
      document.execCommand('delete', false, null);
      await sleep(30);
      document.execCommand('insertText', false, text);
      console.log(LOG_PREFIX, `📝 execCommand insertText done, content="${(el.textContent || '').substring(0, 40)}"`);
    } catch (e) {
      console.warn(LOG_PREFIX, 'execCommand failed:', e.message);
    }

    // Strategy 3: Override textContent/innerText/value getters
    overrideElementGetters(el, text);

    // Strategy 4: Dispatch comprehensive events
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      await sleep(100);
      el.focus();
    } catch (e) {}
  }

  // ─── Walk DOM tree and set framework properties ───
  function walkDOMAndSetProperties(el, text) {
    let node = el;
    let found = false;

    for (let depth = 0; depth < 40 && node; depth++) {
      const tag = node.tagName || '';

      // Check for framework internals on EVERY element (not just custom)
      const hasLit = (typeof node.requestUpdate === 'function');
      const hasReactiveValues = (node.__reactiveValues instanceof Map);
      const isCustom = tag.includes('-');

      // Check for React fiber
      let reactFiberKey = null;
      for (const key of Object.getOwnPropertyNames(node)) {
        if (key.startsWith('__reactFiber') || key.startsWith('__reactInternalInstance')) {
          reactFiberKey = key;
          break;
        }
      }

      if (isCustom || hasLit || hasReactiveValues || reactFiberKey) {
        console.log(LOG_PREFIX, `🏗️ Depth ${depth}: <${tag}> custom=${isCustom} lit=${hasLit} reactive=${hasReactiveValues} react=${!!reactFiberKey}`);

        // Enumerate ALL string properties (own + prototype chain)
        const stringProps = enumerateStringProps(node);
        if (stringProps.length > 0) {
          console.log(LOG_PREFIX, `  String props (${stringProps.length}):`);
          for (const p of stringProps) {
            const gs = (p.getter ? 'G' : '') + (p.setter ? 'S' : '');
            console.log(LOG_PREFIX, `    ${p.key} = "${p.val}" ${gs ? '[' + gs + ']' : ''}`);
          }
        }

        // SET properties: empty reactive props + known prompt names
        for (const p of stringProps) {
          const lower = p.key.toLowerCase();
          const isPromptLike = lower.includes('prompt') || lower.includes('query') ||
                              lower.includes('userinput') || lower.includes('textinput') ||
                              (lower === 'value' && isCustom) || lower === 'text';
          const isEmptyReactive = (p.val === '' && (p.getter || p.setter));

          if (isPromptLike || isEmptyReactive) {
            console.log(LOG_PREFIX, `  ✏️ Setting <${tag}>.${p.key}`);
            try {
              node[p.key] = text;
              found = true;
            } catch (e) {
              console.warn(LOG_PREFIX, `  ✏️ Failed: ${e.message}`);
            }
          }
        }

        // Lit __reactiveValues (Map)
        if (hasReactiveValues) {
          console.log(LOG_PREFIX, `  📦 __reactiveValues:`);
          for (const [k, v] of node.__reactiveValues) {
            const vStr = String(v).substring(0, 40);
            console.log(LOG_PREFIX, `    ${k} = ${JSON.stringify(v)?.substring(0, 50)}`);
            if (typeof v === 'string' && (v === '' || v.length < 3)) {
              console.log(LOG_PREFIX, `    → Setting ${k}`);
              node.__reactiveValues.set(k, text);
              found = true;
            }
          }
        }

        // Trigger Lit re-render
        if (hasLit) {
          try { node.requestUpdate(); } catch (e) {}
        }

        // React fiber: try to find and set state
        if (reactFiberKey) {
          trySetReactState(node, reactFiberKey, text);
        }
      }

      // Move to parent (exit shadow root if needed)
      node = node.parentElement;
      if (!node) {
        const root = el.getRootNode();
        if (root && root !== document && root.host) {
          node = root.host;
          console.log(LOG_PREFIX, `  ↑ Exiting shadow root to <${node.tagName}>`);
        }
      }
    }

    if (!found) {
      console.warn(LOG_PREFIX, '⚠️ No framework properties found in DOM ancestry');
    }
    return found;
  }

  // ─── Enumerate string properties including prototype chain ───
  function enumerateStringProps(node) {
    const results = [];
    const visited = new Set();

    let proto = node;
    for (let p = 0; p < 5 && proto && proto !== HTMLElement.prototype && proto !== Element.prototype && proto !== Object.prototype; p++) {
      try {
        for (const key of Object.getOwnPropertyNames(proto)) {
          if (visited.has(key)) continue;
          if (key.startsWith('_') && key.startsWith('__')) continue; // skip double underscore internals
          visited.add(key);

          try {
            const desc = Object.getOwnPropertyDescriptor(proto, key);
            const val = node[key];
            if (typeof val === 'string' && val.length < 500) {
              results.push({
                key,
                val: val.substring(0, 60),
                getter: !!desc?.get,
                setter: !!desc?.set
              });
            }
          } catch (e) {}
        }
      } catch (e) {}
      proto = Object.getPrototypeOf(proto);
    }
    return results;
  }

  // ─── Try to set React component state ───
  function trySetReactState(node, fiberKey, text) {
    try {
      const fiber = node[fiberKey];
      if (!fiber) return;
      // Walk up fiber tree to find state
      let current = fiber;
      for (let i = 0; i < 10 && current; i++) {
        if (current.memoizedState) {
          console.log(LOG_PREFIX, `  ⚛️ React memoizedState found at level ${i}`);
          // Try to find and update prompt in state
          let state = current.memoizedState;
          while (state) {
            if (state.queue && typeof state.memoizedState === 'string' && state.memoizedState === '') {
              console.log(LOG_PREFIX, `  ⚛️ Setting React state`);
              state.memoizedState = text;
              state.baseState = text;
            }
            state = state.next;
          }
        }
        if (current.memoizedProps) {
          const props = current.memoizedProps;
          for (const key of Object.keys(props)) {
            if (typeof props[key] === 'string' && props[key] === '' &&
                key.toLowerCase().includes('prompt')) {
              console.log(LOG_PREFIX, `  ⚛️ React prop: ${key} (empty) → setting`);
              props[key] = text;
            }
          }
        }
        current = current.return;
      }
    } catch (e) {
      console.warn(LOG_PREFIX, '  ⚛️ React state access failed:', e.message);
    }
  }

  // ─── Override element getters so framework reads our prompt ───
  function overrideElementGetters(el, text) {
    if (promptOverrideActive) return;
    promptOverrideActive = true;

    try {
      const origTC = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')?.get;
      const origIT = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')?.get;

      if (origTC) {
        Object.defineProperty(el, 'textContent', {
          get() {
            const actual = origTC.call(this);
            if (pendingPrompt && (!actual || actual.trim() === '')) {
              console.log(LOG_PREFIX, '🔄 textContent getter override returning prompt');
              return pendingPrompt;
            }
            return actual;
          },
          configurable: true
        });
      }

      if (origIT) {
        Object.defineProperty(el, 'innerText', {
          get() {
            const actual = origIT.call(this);
            if (pendingPrompt && (!actual || actual.trim() === '')) {
              console.log(LOG_PREFIX, '🔄 innerText getter override returning prompt');
              return pendingPrompt;
            }
            return actual;
          },
          configurable: true
        });
      }

      // Also override .value for textarea-like elements
      Object.defineProperty(el, 'value', {
        get() {
          return pendingPrompt || el.textContent || '';
        },
        set(v) {
          el.textContent = v;
        },
        configurable: true
      });

      console.log(LOG_PREFIX, '✅ Getter overrides installed');
    } catch (e) {
      console.warn(LOG_PREFIX, 'Getter override failed:', e.message);
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

    // Extract prompt from request body
    try {
      const body = args[1]?.body;
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        requestPrompt = parsed.requests?.[0]?.prompt ||
                       parsed.requests?.[0]?.textInput?.prompt ||
                       parsed.request?.prompt || '';
      }
    } catch (e) {}

    // ─── Prompt Injection: replace empty/wrong prompt ───
    if ((isImageApi || isVideoStart) && pendingPrompt) {
      try {
        const body = args[1]?.body;
        if (typeof body === 'string') {
          const parsed = JSON.parse(body);

          console.log(LOG_PREFIX, `⚡ Request intercepted. Current prompt: "${(requestPrompt || '').substring(0, 40)}"`);
          console.log(LOG_PREFIX, `⚡ Pending prompt: "${pendingPrompt.substring(0, 40)}"`);

          // Inject prompt into all known locations
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
      promptOverrideActive = false;
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

  console.log(LOG_PREFIX, 'Fetch interceptor + prompt injector installed (v2)');
})();
