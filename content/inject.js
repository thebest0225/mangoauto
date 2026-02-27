/**
 * MangoAuto - Flow Fetch Interceptor + Prompt Injector (v3.1)
 * Injected into MAIN world to intercept native window.fetch
 *
 * v3.1: Slate.js 호환
 * - 프레임워크 조작 완전 제거 (Slate.js DOM 상태 파괴 방지)
 * - SET_FLOW_PROMPT 수신 → 프롬프트 저장만 (DOM 건드리지 않음)
 * - fetch 인터셉션에서 빈 프롬프트를 pendingPrompt로 교체
 * - flow.js의 clipboard paste가 DOM에 텍스트 넣고,
 *   이 스크립트가 API 요청에 프롬프트를 주입하는 역할 분담
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
      console.log(LOG_PREFIX, '📝 Prompt stored for fetch injection:', pendingPrompt?.substring(0, 60));
      // Slate.js 에디터이므로 DOM/프레임워크 조작하지 않음
      // flow.js의 clipboard paste가 Slate-safe 방식으로 DOM에 텍스트를 넣고
      // 이 스크립트가 fetch 인터셉션으로 API 요청에 프롬프트를 주입함
      window.postMessage({ type: 'SET_FLOW_PROMPT_RESULT', ok: true }, '*');
    }
  });

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

  console.log(LOG_PREFIX, 'Fetch interceptor installed (v3.1 Slate-safe)');
})();
