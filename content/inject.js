/**
 * MangoAuto - Flow Fetch Interceptor + Prompt Injector (v4)
 * Injected into MAIN world to intercept native window.fetch
 *
 * v4: Slate.js 에디터 API 직접 접근
 * - React fiber 트리에서 Slate editor 인스턴스를 찾아 직접 텍스트 설정
 * - clipboard/포커스 불필요 → MangoHub 모드에서도 안정 동작
 * - fetch 인터셉션은 안전망으로 유지
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Inject]';
  const originalFetch = window.fetch;
  let batchSeq = 0;
  const pendingVideoOps = new Map();

  // ─── Prompt Injection State ───
  let pendingPrompt = null;

  // ─── Listen for SET_FLOW_PROMPT from content script ───
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'SET_FLOW_PROMPT') {
      pendingPrompt = event.data.text;
      console.log(LOG_PREFIX, '📝 Prompt received:', pendingPrompt?.substring(0, 60));

      // Slate 에디터에 직접 텍스트 설정 시도
      const slateOk = trySetSlateText(pendingPrompt);
      console.log(LOG_PREFIX, slateOk ? '✅ Slate API 성공' : '⚠️ Slate API 실패, fetch 인터셉션으로 대체');

      window.postMessage({ type: 'SET_FLOW_PROMPT_RESULT', ok: true, slateOk }, '*');
    }
  });

  // ─── Find Slate editor element ───
  function findSlateElement() {
    // data-slate-node="value" 는 Slate의 Editable 컴포넌트
    const el = document.querySelector('[data-slate-node="value"]');
    if (el) return el;

    // Fallback: contenteditable near generate button
    for (const ce of document.querySelectorAll('[contenteditable="true"]')) {
      if (ce.offsetHeight > 10 && ce.offsetWidth > 100) return ce;
    }
    return null;
  }

  // ─── Find Slate editor instance from React fiber tree ───
  function findSlateEditor(el) {
    if (!el) return null;

    // Find React fiber key
    let fiberKey = null;
    try {
      for (const key of Object.getOwnPropertyNames(el)) {
        if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
          fiberKey = key;
          break;
        }
      }
    } catch (e) {}

    if (!fiberKey) {
      console.log(LOG_PREFIX, '🔍 No React fiber on Slate element');
      return null;
    }

    const fiber = el[fiberKey];
    let current = fiber;

    // Walk up fiber tree
    for (let level = 0; level < 30 && current; level++) {
      if (current.memoizedState) {
        let hook = current.memoizedState;
        let hookIdx = 0;

        while (hook) {
          const state = hook.memoizedState;

          if (state && typeof state === 'object' && state !== null) {
            // Check: is this a Slate editor? (has insertText, apply, children)
            if (typeof state.insertText === 'function' &&
                typeof state.apply === 'function' &&
                Array.isArray(state.children)) {
              console.log(LOG_PREFIX, `🎯 Slate editor found at fiber level ${level}, hook ${hookIdx}`);
              return state;
            }

            // Check ref: { current: editor }
            if (state.current &&
                typeof state.current.insertText === 'function' &&
                typeof state.current.apply === 'function' &&
                Array.isArray(state.current.children)) {
              console.log(LOG_PREFIX, `🎯 Slate editor ref found at fiber level ${level}, hook ${hookIdx}`);
              return state.current;
            }
          }

          hook = hook.next;
          hookIdx++;
        }
      }

      // Also check memoizedProps for editor
      if (current.memoizedProps) {
        const props = current.memoizedProps;
        if (props.editor &&
            typeof props.editor.insertText === 'function' &&
            Array.isArray(props.editor.children)) {
          console.log(LOG_PREFIX, `🎯 Slate editor in props at fiber level ${level}`);
          return props.editor;
        }
      }

      current = current.return;
    }

    console.log(LOG_PREFIX, '🔍 Slate editor not found in fiber tree');
    return null;
  }

  // ─── Set text in Slate editor directly ───
  function trySetSlateText(text) {
    const el = findSlateElement();
    if (!el) {
      console.log(LOG_PREFIX, '🔍 Slate element not found');
      return false;
    }

    const editor = findSlateEditor(el);
    if (!editor) return false;

    try {
      console.log(LOG_PREFIX, `📊 Slate state: ${editor.children.length} children, selection=${!!editor.selection}`);

      // Step 1: Remove all existing content via Slate operations
      while (editor.children.length > 0) {
        editor.apply({
          type: 'remove_node',
          path: [editor.children.length - 1],
          node: editor.children[editor.children.length - 1]
        });
      }

      // Step 2: Insert new paragraph with our text
      editor.apply({
        type: 'insert_node',
        path: [0],
        node: {
          type: 'paragraph',
          children: [{ text: text }]
        }
      });

      // Step 3: Set selection at end of text
      editor.apply({
        type: 'set_selection',
        properties: editor.selection,
        newProperties: {
          anchor: { path: [0, 0], offset: text.length },
          focus: { path: [0, 0], offset: text.length }
        }
      });

      // Step 4: Trigger Slate onChange
      if (typeof editor.onChange === 'function') {
        editor.onChange();
      }

      console.log(LOG_PREFIX, `✅ Slate text set: "${text.substring(0, 40)}..." (${editor.children.length} children)`);
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, `Slate API method 1 failed: ${e.message}`);

      // Fallback: try simpler approach
      try {
        // Direct children replacement
        editor.children.length = 0;
        editor.children.push({
          type: 'paragraph',
          children: [{ text: text }]
        });
        editor.selection = {
          anchor: { path: [0, 0], offset: text.length },
          focus: { path: [0, 0], offset: text.length }
        };
        if (typeof editor.onChange === 'function') {
          editor.onChange();
        }
        console.log(LOG_PREFIX, '✅ Slate text set (fallback method)');
        return true;
      } catch (e2) {
        console.warn(LOG_PREFIX, `Slate fallback also failed: ${e2.message}`);

        // Last resort: try insertText with select-all
        try {
          if (editor.children.length > 0) {
            const lastChild = editor.children[editor.children.length - 1];
            const lastTextNode = lastChild.children?.[lastChild.children.length - 1];
            const lastOffset = lastTextNode?.text?.length || 0;

            editor.selection = {
              anchor: { path: [0, 0], offset: 0 },
              focus: { path: [editor.children.length - 1, lastChild.children.length - 1], offset: lastOffset }
            };
          }
          editor.insertText(text);
          console.log(LOG_PREFIX, '✅ Slate text set (insertText method)');
          return true;
        } catch (e3) {
          console.warn(LOG_PREFIX, `All Slate methods failed: ${e3.message}`);
          return false;
        }
      }
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

    // ─── Prompt Injection: replace empty prompt ───
    if ((isImageApi || isVideoStart) && pendingPrompt) {
      try {
        const body = args[1]?.body;
        if (typeof body === 'string') {
          const parsed = JSON.parse(body);

          console.log(LOG_PREFIX, `⚡ Injecting prompt: "${pendingPrompt.substring(0, 40)}"`);

          // Deep inject
          const injectPrompt = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
              if (key.toLowerCase().includes('prompt') && typeof obj[key] === 'string' &&
                  (obj[key] === '' || obj[key].length < 3)) {
                obj[key] = pendingPrompt;
              }
              if (typeof obj[key] === 'object') injectPrompt(obj[key]);
            }
          };
          injectPrompt(parsed);

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
                type: 'VEO3_API_RESULT', seq: pending.seq, prompt: pending.prompt,
                status: 200, ok: true, hasMedia: !!videoUrl,
                mediaUrls: videoUrl ? [videoUrl] : [], isVideo: true
              }, '*');
            } else if (op.status === 'MEDIA_GENERATION_STATUS_FAILED') {
              pendingVideoOps.delete(opName);
              const failReason = op.operation?.error?.message || op.failureReason || '';
              console.log(LOG_PREFIX, 'Video failed:', opName, failReason);
              window.postMessage({
                type: 'VEO3_API_RESULT', seq: pending.seq, prompt: pending.prompt,
                status: 400, ok: false, error: failReason || 'Video generation failed',
                errorCode: op.operation?.error?.code || op.status, isVideo: true
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
                pendingVideoOps.set(op.operation.name, { seq: currentSeq, prompt: requestPrompt });
                console.log(LOG_PREFIX, 'Video started:', op.operation.name);
              }
            }
          } else if (!response.ok) {
            window.postMessage({
              type: 'VEO3_API_RESULT', seq: currentSeq, prompt: requestPrompt,
              status: response.status, ok: false,
              error: data.error?.message || 'Video start failed',
              errorCode: data.error?.code, isVideo: true
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
            type: 'VEO3_API_RESULT', seq: currentSeq, prompt: requestPrompt,
            status: response.status, ok: response.ok,
            hasMedia: false, mediaUrls: [], isVideo: false
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

  console.log(LOG_PREFIX, 'Fetch interceptor installed (v4 Slate API)');
})();
