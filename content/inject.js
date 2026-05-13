/**
 * MangoAuto - Flow Fetch Interceptor + Prompt Injector (v4.1)
 * Injected into MAIN world to intercept native window.fetch
 *
 * v4.1: Slate.js 고수준 API 사용
 * - editor.insertText() / editor.deleteFragment() 로 React 상태까지 업데이트
 * - v4의 editor.apply()는 저수준이라 onChange 파이프라인을 트리거하지 않음
 * - MAIN world execCommand 폴백 추가 (Slate의 onDOMBeforeInput 자연 트리거)
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
    // ─── MAIN world 에서 React onClick 직접 호출 (content script isolated world 우회) ───
    if (event.data?.type === 'SUBMIT_FLOW_CLICK') {
      const result = trySubmitFlowFromMainWorld();
      window.postMessage({ type: 'SUBMIT_FLOW_CLICK_RESULT', ...result }, '*');
    }
  });

  // ─── React fiber 에서 onClick props 찾기 ───
  function findReactPropsFromFiber(el) {
    if (!el) return null;
    for (const key of Object.getOwnPropertyNames(el)) {
      if (key.startsWith('__reactProps$')) return el[key];
    }
    return null;
  }

  // ─── Generate button 찾기 (inject.js 버전, MAIN world) ───
  function findGenerateButtonMainWorld() {
    const SUBMIT_ICONS = new Set(['arrow_forward', 'arrow_upward', 'send', 'play_arrow', 'auto_awesome']);
    const isEnabled = (b) => {
      if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      const r = b.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    };
    const hasSubmitIcon = (b) => {
      const icons = b.querySelectorAll('i, .material-icons, .material-symbols-outlined');
      for (const ic of icons) if (SUBMIT_ICONS.has((ic.textContent || '').trim())) return true;
      return false;
    };
    // prompt 근처 우선
    const promptEl = document.querySelector('[data-slate-node="value"], [contenteditable="true"]');
    if (promptEl) {
      let p = promptEl.parentElement;
      for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
        const btns = p.querySelectorAll('button');
        for (const b of btns) if (isEnabled(b) && hasSubmitIcon(b)) return b;
      }
    }
    // 전역 fallback
    for (const b of document.querySelectorAll('button')) {
      if (isEnabled(b) && hasSubmitIcon(b)) return b;
    }
    return null;
  }

  // ─── MAIN world 에서 generate button 의 React onClick 호출 ───
  function trySubmitFlowFromMainWorld() {
    const btn = findGenerateButtonMainWorld();
    if (!btn) {
      console.warn(LOG_PREFIX, '🚫 [submit] generate button 못찾음 (MAIN world)');
      return { ok: false, reason: 'button-not-found' };
    }
    const label = btn.getAttribute('aria-label') || btn.textContent?.trim().slice(0, 30) || '?';
    console.log(LOG_PREFIX, `🎯 [submit] button 발견 (MAIN world): "${label}"`);

    // ① button 자체 → 자식 → 부모(6단계) 순회하며 props.onClick 찾기
    //   주의: React handler 가 e.nativeEvent.isTrusted 를 읽는 경우 있으므로
    //   SyntheticEvent-like 객체로 wrap 해서 nativeEvent 채워줘야 함.
    const buildSyntheticEvent = (node) => {
      const nativeEvent = new MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, buttons: 0, detail: 1,
      });
      const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return {
        type: 'click',
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        eventPhase: 0,
        isTrusted: false,
        timeStamp: Date.now(),
        nativeEvent,
        currentTarget: node,
        target: node,
        relatedTarget: null,
        view: window,
        detail: 1,
        button: 0,
        buttons: 0,
        clientX: cx, clientY: cy,
        screenX: cx, screenY: cy,
        pageX: cx, pageY: cy,
        altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
        getModifierState: () => false,
        preventDefault() { this.defaultPrevented = true; nativeEvent.preventDefault(); },
        stopPropagation() { nativeEvent.stopPropagation(); },
        stopImmediatePropagation() { nativeEvent.stopImmediatePropagation && nativeEvent.stopImmediatePropagation(); },
        isPropagationStopped: () => false,
        isDefaultPrevented() { return this.defaultPrevented; },
        persist() {},
      };
    };

    const tryCallOnClick = (node) => {
      const props = findReactPropsFromFiber(node);
      if (props && typeof props.onClick === 'function') {
        try {
          const synth = buildSyntheticEvent(node);
          props.onClick(synth);
          return true;
        } catch (e) {
          console.warn(LOG_PREFIX, `🚫 [submit] onClick 호출 에러 (${node.tagName}): ${e.message}`);
        }
      }
      // onPointerDown / onMouseDown handler 도 시도 (일부 react component 는 click 대신 pointerdown 사용)
      if (props && typeof props.onPointerDown === 'function' && typeof props.onPointerUp === 'function') {
        try {
          const synth = buildSyntheticEvent(node);
          props.onPointerDown(synth);
          props.onPointerUp(synth);
          return true;
        } catch (e) {
          console.warn(LOG_PREFIX, `🚫 [submit] onPointerDown/Up 호출 에러: ${e.message}`);
        }
      }
      return false;
    };

    // 자식 우선 (Lit/React 가 가끔 icon span 에 listener 달음)
    if (tryCallOnClick(btn)) {
      console.log(LOG_PREFIX, '✅ [submit] React onClick 호출 성공 (button 자체)');
      return { ok: true, where: 'button' };
    }
    for (const child of btn.querySelectorAll('*')) {
      if (tryCallOnClick(child)) {
        console.log(LOG_PREFIX, `✅ [submit] React onClick 호출 성공 (자식: ${child.tagName})`);
        return { ok: true, where: 'child:' + child.tagName };
      }
    }
    let p = btn.parentElement;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
      if (tryCallOnClick(p)) {
        console.log(LOG_PREFIX, `✅ [submit] React onClick 호출 성공 (부모 ${i+1}단계: ${p.tagName})`);
        return { ok: true, where: 'parent:' + p.tagName };
      }
    }

    // ② React fiber 의 stateNode (class component) 에서 handleClick/onSubmit 메서드 찾기
    let fiber = null;
    for (const key of Object.getOwnPropertyNames(btn)) {
      if (key.startsWith('__reactFiber$')) { fiber = btn[key]; break; }
    }
    if (fiber) {
      let cur = fiber;
      for (let level = 0; level < 20 && cur; level++, cur = cur.return) {
        const inst = cur.stateNode;
        if (inst && typeof inst === 'object') {
          for (const m of ['handleClick', 'handleSubmit', 'onSubmit', 'submit', 'generate', 'handleGenerate']) {
            if (typeof inst[m] === 'function') {
              try {
                inst[m].call(inst, { preventDefault: () => {}, stopPropagation: () => {} });
                console.log(LOG_PREFIX, `✅ [submit] stateNode.${m}() 호출 성공 (fiber level ${level})`);
                return { ok: true, where: `stateNode.${m}:level${level}` };
              } catch (e) {
                console.warn(LOG_PREFIX, `🚫 [submit] stateNode.${m} 호출 에러: ${e.message}`);
              }
            }
          }
        }
      }
    }

    console.warn(LOG_PREFIX, '🚫 [submit] React onClick / stateNode 메서드 모두 못찾음');
    return { ok: false, reason: 'no-handler' };
  }

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

  // ─── Helper: get end point of Slate document ───
  function getEndPoint(editor) {
    if (!editor.children || editor.children.length === 0) return null;
    const lastIdx = editor.children.length - 1;
    const lastChild = editor.children[lastIdx];
    const lastTextChildren = lastChild?.children || [];
    const lastTextIdx = Math.max(0, lastTextChildren.length - 1);
    const lastText = lastTextChildren[lastTextIdx];
    const lastOffset = lastText?.text?.length || 0;
    return { path: [lastIdx, lastTextIdx], offset: lastOffset };
  }

  // ─── Set text in Slate editor ───
  function trySetSlateText(text) {
    const el = findSlateElement();
    if (!el) {
      console.log(LOG_PREFIX, '🔍 Slate element not found');
      return false;
    }

    const editor = findSlateEditor(el);

    // ─── Method 1: Slate 고수준 API (insertText pipeline) ───
    // editor.deleteFragment() + editor.insertText()는 Slate의 전체 파이프라인을 통과
    // → normalizations → onChange → React state update
    if (editor && typeof editor.insertText === 'function') {
      try {
        console.log(LOG_PREFIX, `📊 Slate state: ${editor.children.length} children, selection=${!!editor.selection}`);

        // Step 1: Select all content
        const endPoint = getEndPoint(editor);
        if (endPoint) {
          editor.selection = {
            anchor: { path: [0, 0], offset: 0 },
            focus: endPoint
          };
          console.log(LOG_PREFIX, `📊 Selection set: [0,0]:0 → [${endPoint.path}]:${endPoint.offset}`);
        }

        // Step 2: Delete selection via high-level API
        if (typeof editor.deleteFragment === 'function') {
          editor.deleteFragment('forward');
          console.log(LOG_PREFIX, `📊 deleteFragment done: ${editor.children.length} children`);
        } else if (typeof editor.delete === 'function') {
          editor.delete();
          console.log(LOG_PREFIX, `📊 delete done: ${editor.children.length} children`);
        }

        // Step 3: Insert text via high-level API (goes through full Slate pipeline)
        editor.insertText(text);
        console.log(LOG_PREFIX, `✅ Method 1 (insertText): "${text.substring(0, 40)}..." (${editor.children.length} children)`);

        // Verify: check if text actually got into the model
        const firstText = editor.children?.[0]?.children?.[0]?.text || '';
        if (firstText.includes(text.substring(0, 20))) {
          console.log(LOG_PREFIX, '✅ Verified: text is in Slate model');
          return true;
        }
        console.log(LOG_PREFIX, `⚠️ Model text mismatch: "${firstText.substring(0, 40)}"`);
      } catch (e) {
        console.warn(LOG_PREFIX, `Method 1 failed: ${e.message}`);
      }
    }

    // ─── Method 2: MAIN world execCommand (Slate onDOMBeforeInput 자연 트리거) ───
    // MAIN world에서 실행되므로 Slate의 이벤트 핸들러가 정상 처리
    try {
      console.log(LOG_PREFIX, '🔄 Method 2: execCommand from MAIN world');
      el.focus();
      document.execCommand('selectAll', false, null);
      const ok = document.execCommand('insertText', false, text);
      console.log(LOG_PREFIX, `📊 execCommand insertText: ${ok}`);

      if (ok) {
        // execCommand는 비동기로 Slate를 업데이트하므로 잠깐 대기 후 검증
        // (여기서는 즉시 검증하지 않고 성공으로 간주)
        console.log(LOG_PREFIX, '✅ Method 2 (execCommand insertText)');
        return true;
      }
    } catch (e) {
      console.warn(LOG_PREFIX, `Method 2 failed: ${e.message}`);
    }

    // ─── Method 3: editor.apply() 저수준 + 수동 onChange (최후 수단) ───
    if (editor) {
      try {
        console.log(LOG_PREFIX, '🔄 Method 3: editor.apply() low-level');

        while (editor.children.length > 0) {
          editor.apply({
            type: 'remove_node',
            path: [editor.children.length - 1],
            node: editor.children[editor.children.length - 1]
          });
        }
        editor.apply({
          type: 'insert_node',
          path: [0],
          node: { type: 'paragraph', children: [{ text: text }] }
        });
        editor.apply({
          type: 'set_selection',
          properties: editor.selection,
          newProperties: {
            anchor: { path: [0, 0], offset: text.length },
            focus: { path: [0, 0], offset: text.length }
          }
        });
        if (typeof editor.onChange === 'function') {
          editor.onChange();
        }
        console.log(LOG_PREFIX, `✅ Method 3 (apply+onChange): "${text.substring(0, 40)}..."`);
        return true;
      } catch (e) {
        console.warn(LOG_PREFIX, `Method 3 failed: ${e.message}`);
      }
    }

    console.warn(LOG_PREFIX, '❌ All Slate methods failed');
    return false;
  }

  // ─── Deep URL finder: 응답 객체에서 비디오 URL을 재귀적으로 탐색 ───
  function findDeepUrl(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 6) return null;
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 20 &&
          (val.includes('storage.googleapis.com') || val.includes('fifeUrl') ||
           key.toLowerCase().includes('url') || key.toLowerCase().includes('uri')) &&
          val.startsWith('http')) {
        return val;
      }
      if (typeof val === 'object' && val !== null) {
        const found = findDeepUrl(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  // ─── Fetch Interceptor ───
  window.fetch = async function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    const isImageApi = url.includes('batchGenerate') &&
                       !url.includes('Async') &&
                       !url.includes('Check');
    const isVideoStartImage = url.includes('batchAsyncGenerateVideoStartImage');
    const isVideoStart = url.includes('batchAsyncGenerateVideo') && !isVideoStartImage;
    const isVideoCheck = url.includes('batchCheckAsyncVideo');

    if (!isImageApi && !isVideoStart && !isVideoStartImage && !isVideoCheck) {
      // 비디오 다운로드 URL 캡처 (1080p 업스케일 등)
      // Flow가 fetch()로 비디오를 받아 blob→다운로드하는 경우, HTTP URL을 캡처
      if (url.includes('storage.googleapis.com') || url.includes('googleusercontent.com') || url.includes('googlevideo.com')) {
        const response = await originalFetch.apply(this, args);
        try {
          const ct = response.headers.get('content-type') || '';
          if (ct.includes('video') || url.match(/\.(mp4|webm)(\?|$)/i)) {
            console.log(LOG_PREFIX, `🎬 비디오 다운로드 URL 캡처: ${url.substring(0, 120)}`);
            window.postMessage({ type: 'VIDEO_DOWNLOAD_URL_CAPTURED', url }, '*');
          }
        } catch (e) {}
        return response;
      }
      return originalFetch.apply(this, args);
    }

    const currentSeq = batchSeq++;
    let requestPrompt = '';

    console.log(LOG_PREFIX, `🌐 Fetch intercepted: ${url.substring(0, 80)}`);

    // ─── Generation 시작 신호 — flow.js 가 clickGenerate 후 이 신호를 기다림 ───
    // batchCheckAsyncVideo 는 polling 이므로 시작 신호 제외 (실제 generation 요청 아님)
    if (!isVideoCheck) {
      window.postMessage({
        type: 'GENERATION_FETCH_STARTED',
        url: url.substring(0, 120),
        kind: isImageApi ? 'image' : (isVideoStartImage ? 'video-start-image' : 'video'),
        timestamp: Date.now(),
      }, '*');
    }

    // Extract prompt from request body
    try {
      const body = args[1]?.body;
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        requestPrompt = parsed.requests?.[0]?.prompt ||
                       parsed.requests?.[0]?.textInput?.prompt ||
                       parsed.requests?.[0]?.textInput?.text ||
                       parsed.requests?.[0]?.text ||
                       parsed.request?.prompt || '';
        console.log(LOG_PREFIX, `🌐 Request prompt: "${(requestPrompt || '(empty)').substring(0, 40)}"`);
        // StartImage API: 요청 구조 디버그
        if (isVideoStartImage && parsed.requests?.[0]) {
          const keys = Object.keys(parsed.requests[0]);
          console.log(LOG_PREFIX, `📋 StartImage 요청 필드: [${keys.join(', ')}]`);
        }
      }
    } catch (e) {}

    // ─── Prompt Injection: replace empty prompt ───
    // StartImage API (Frames)는 요청 구조가 다름 — Slate 에디터가 직접 처리하므로 주입 불필요
    if (isVideoStartImage && pendingPrompt) {
      console.log(LOG_PREFIX, `🎬 StartImage API — Slate에서 프롬프트 처리, 주입 스킵: "${pendingPrompt.substring(0, 40)}"`);
      pendingPrompt = null;
    }
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
          // ─── 방식 2: data.media 응답 (StartImage/Frames API) ───
          // operations가 없고 media가 있는 경우: 비디오 URL이 media에 포함됨
          if (!data.operations && data.media && Array.isArray(data.media) && pendingVideoOps.size > 0) {
            // media에서 비디오 URL 추출 시도
            let videoUrl = '';
            for (const m of data.media) {
              videoUrl = m?.video?.fifeUrl || m?.video?.videoUri || m?.video?.url ||
                        m?.video?.generatedVideo?.fifeUrl || m?.video?.generatedVideo?.videoUri ||
                        m?.video?.generatedVideo?.url || m?.video?.generatedVideo?.mediaUrl ||
                        m?.video?.generatedVideo?.encodedVideo?.url || m?.video?.generatedVideo?.encodedVideo?.uri ||
                        m?.video?.operation?.metadata?.video?.fifeUrl ||
                        m?.video?.operation?.metadata?.video?.videoUri ||
                        m?.video?.operation?.response?.video?.fifeUrl ||
                        m?.video?.operation?.response?.video?.videoUri ||
                        m?.video?.operation?.result?.video?.fifeUrl ||
                        m?.video?.operation?.result?.video?.videoUri ||
                        m?.fifeUrl || m?.videoUri || '';
              if (!videoUrl) videoUrl = findDeepUrl(m?.video) || '';
              if (videoUrl) break;
            }
            if (!videoUrl) videoUrl = findDeepUrl(data.media) || '';

            if (videoUrl) {
              // media에 비디오 URL 있음 → 완료!
              const [opName, pending] = [...pendingVideoOps.entries()][0];
              pendingVideoOps.delete(opName);
              console.log(LOG_PREFIX, `✅ Video ready (media response): ${videoUrl.substring(0, 80)}`);
              window.postMessage({
                type: 'VEO3_API_RESULT', seq: pending.seq, prompt: pending.prompt,
                status: 200, ok: true, hasMedia: true,
                mediaUrls: [videoUrl], isVideo: true, videoCompleted: true
              }, '*');
              return;
            }
            // media는 있지만 비디오 URL 없음 → 구조 확인 + 에러 감지
            if (data.media.length > 0) {
              const m0 = data.media[0];
              console.log(LOG_PREFIX, `📡 Check: media ${data.media.length}개, 비디오 URL 없음`);
              console.log(LOG_PREFIX, `📡 media[0] keys: [${Object.keys(m0).join(',')}]`);
              // video 객체 내부 구조 로깅 (URL 필드 탐색)
              if (m0.video) {
                const vKeys = Object.keys(m0.video);
                console.log(LOG_PREFIX, `📡 media[0].video keys: [${vKeys.join(',')}]`);
                // generatedVideo 내부 구조 상세 로깅
                if (m0.video.generatedVideo) {
                  const gvKeys = Object.keys(m0.video.generatedVideo);
                  console.log(LOG_PREFIX, `📡 generatedVideo keys: [${gvKeys.join(',')}]`);
                  console.log(LOG_PREFIX, `📡 generatedVideo: ${JSON.stringify(m0.video.generatedVideo).substring(0, 500)}`);
                }
                // operation 내부 구조 상세 로깅
                if (m0.video.operation) {
                  const opKeys = Object.keys(m0.video.operation);
                  console.log(LOG_PREFIX, `📡 operation keys: [${opKeys.join(',')}]`);
                  if (m0.video.operation.metadata) {
                    console.log(LOG_PREFIX, `📡 operation.metadata: ${JSON.stringify(m0.video.operation.metadata).substring(0, 500)}`);
                  }
                  if (m0.video.operation.response) {
                    console.log(LOG_PREFIX, `📡 operation.response: ${JSON.stringify(m0.video.operation.response).substring(0, 500)}`);
                  }
                }
                // 에러/실패 상태 감지
                const vStr = JSON.stringify(m0.video).substring(0, 200);
                if (vStr.toLowerCase().includes('fail') || vStr.toLowerCase().includes('error') ||
                    m0.video.status?.toLowerCase()?.includes('fail')) {
                  const [opName, pending] = [...pendingVideoOps.entries()][0];
                  pendingVideoOps.delete(opName);
                  const errMsg = m0.video.error?.message || m0.video.failureReason || 'Video generation failed (media response)';
                  console.log(LOG_PREFIX, `❌ Video failed (media response): ${errMsg}`);
                  window.postMessage({
                    type: 'VEO3_API_RESULT', seq: pending.seq, prompt: pending.prompt,
                    status: 400, ok: false, error: errMsg,
                    errorCode: 'VIDEO_GENERATION_FAILED', isVideo: true
                  }, '*');
                  return;
                }
              }
            } else {
              console.log(LOG_PREFIX, `📡 Check: media 비어있음 (생성 중)`);
            }
            return;
          }

          if (!data.operations) {
            console.log(LOG_PREFIX, `📡 Check 응답: operations 없음, keys=[${Object.keys(data).join(',')}]`);
            return;
          }
          for (const op of data.operations) {
            const opName = op.operation?.name;
            const pending = pendingVideoOps.get(opName);
            // 디버그: 모든 operation 상태 출력
            console.log(LOG_PREFIX, `📡 Op: name=${opName?.substring(0, 20)}, status=${op.status}, pending=${!!pending}, mapSize=${pendingVideoOps.size}`);
            if (!pending) continue;
            if (op.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
              const meta = op.operation?.metadata;
              const result = op.operation?.result;
              const resp = op.operation?.response;
              // 다양한 경로에서 비디오 URL 추출 시도
              const videoUrl = meta?.video?.fifeUrl ||
                              meta?.video?.videoUri ||
                              meta?.video?.url ||
                              meta?.generatedVideo?.fifeUrl ||
                              meta?.generatedVideo?.videoUri ||
                              meta?.generatedVideo?.url ||
                              result?.video?.fifeUrl ||
                              result?.video?.videoUri ||
                              resp?.video?.fifeUrl ||
                              resp?.video?.videoUri ||
                              '';
              // 디버그: 실제 응답 구조 출력 (URL 못 찾을 때 원인 파악용)
              if (!videoUrl) {
                console.log(LOG_PREFIX, '⚠️ Video URL not found in response. Structure:');
                console.log(LOG_PREFIX, '  metadata keys:', JSON.stringify(Object.keys(meta || {})));
                console.log(LOG_PREFIX, '  metadata.video:', JSON.stringify(meta?.video || 'none'));
                console.log(LOG_PREFIX, '  result keys:', JSON.stringify(Object.keys(result || {})));
                console.log(LOG_PREFIX, '  response keys:', JSON.stringify(Object.keys(resp || {})));
                console.log(LOG_PREFIX, '  full op keys:', JSON.stringify(Object.keys(op.operation || {})));
                // 재귀적으로 URL 찾기 시도
                const deepUrl = findDeepUrl(op.operation);
                if (deepUrl) {
                  console.log(LOG_PREFIX, '🔍 Deep search found URL:', deepUrl.substring(0, 80));
                }
              }
              const finalUrl = videoUrl || findDeepUrl(op.operation) || '';
              pendingVideoOps.delete(opName);
              console.log(LOG_PREFIX, 'Video ready:', finalUrl ? finalUrl.substring(0, 60) : '(URL 없음 — DOM 감지 필요)');
              window.postMessage({
                type: 'VEO3_API_RESULT', seq: pending.seq, prompt: pending.prompt,
                status: 200, ok: true, hasMedia: true,
                mediaUrls: finalUrl ? [finalUrl] : [], isVideo: true,
                videoCompleted: true
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

      // ─── Video Start (regular + StartImage/Frames) ───
      if (isVideoStart || isVideoStartImage) {
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

  // ─── Upscaled Image Blob Interceptor ───
  // Flow가 2K/4K 업스케일 이미지를 다운로드할 때 blob 데이터를 캡처
  // content script에서 ENABLE_BLOB_CAPTURE 메시지로 활성화/비활성화
  // window 전역 플래그 사용 (inject.js가 여러 VM 인스턴스로 로드될 수 있으므로)
  window.__mangoBlobCapture = window.__mangoBlobCapture || false;
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'ENABLE_BLOB_CAPTURE') {
      window.__mangoBlobCapture = !!event.data.enabled;
      if (window.__mangoBlobCapture) {
        console.log(LOG_PREFIX, '🖼️ Blob 캡처 활성화');
      }
    }
  });

  // createObjectURL은 한 번만 패치 (중복 패치 방지)
  if (!window.__mangoCreateObjectURLPatched) {
    window.__mangoCreateObjectURLPatched = true;
    const origCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(obj) {
      const blobUrl = origCreateObjectURL(obj);
      // 이미지 blob 캡처 (활성화 상태, 500KB 이상)
      if (window.__mangoBlobCapture && obj instanceof Blob && obj.type?.startsWith('image/') && obj.size > 500000) {
        console.log(LOG_PREFIX, `🖼️ 이미지 blob 감지: ${obj.type}, ${Math.round(obj.size / 1024)}KB`);
        const reader = new FileReader();
        reader.onload = () => {
          window.postMessage({
            type: 'UPSCALED_IMAGE_BLOB',
            dataUrl: reader.result,
            size: obj.size,
            mimeType: obj.type
          }, '*');
          console.log(LOG_PREFIX, `🖼️ 업스케일 이미지 dataUrl 전달 (${Math.round(obj.size / 1024)}KB)`);
        };
        reader.readAsDataURL(obj);
      }
      // 비디오 blob 캡처 (항상 활성화, 1MB 이상 — 720p/원본 다운로드 시 blob 즉시 읽기)
      // Flow는 createObjectURL 후 바로 revokeObjectURL하므로 여기서 즉시 읽어야 함
      if (obj instanceof Blob && (obj.type?.startsWith('video/') || obj.type === 'application/octet-stream') && obj.size > 1024 * 1024) {
        console.log(LOG_PREFIX, `🎬 비디오 blob 감지: ${obj.type}, ${Math.round(obj.size / 1024)}KB — 즉시 캡처`);
        const reader = new FileReader();
        reader.onload = () => {
          window.postMessage({
            type: 'VIDEO_BLOB_CAPTURED',
            dataUrl: reader.result,
            size: obj.size,
            mimeType: obj.type
          }, '*');
          console.log(LOG_PREFIX, `🎬 비디오 dataUrl 전달 완료 (${Math.round(obj.size / 1024)}KB)`);
        };
        reader.readAsDataURL(obj);
      }
      return blobUrl;
    };
  }

  console.log(LOG_PREFIX, 'Fetch interceptor installed (v4.1 high-level Slate API + blob interceptor)');
})();
