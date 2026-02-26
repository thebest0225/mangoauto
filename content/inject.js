/**
 * MangoAuto - Flow Fetch Interceptor + Prompt Injector
 * Injected into MAIN world to intercept native window.fetch
 * Captures API responses for video/image generation and posts results back
 *
 * This script intercepts:
 * - batchGenerate (image generation - sync)
 * - batchAsyncGenerateVideo (video generation - start)
 * - batchCheckAsyncVideo (video generation - status polling)
 *
 * Also handles:
 * - SET_FLOW_PROMPT: Stores prompt and injects it into outgoing API requests
 *   (bypasses Lit framework internal state issue)
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Inject]';
  const originalFetch = window.fetch;
  let batchSeq = 0;
  const pendingVideoOps = new Map();

  // ─── Prompt Injection State ───
  let pendingPrompt = null;

  // Listen for SET_FLOW_PROMPT from content script (flow.js)
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'SET_FLOW_PROMPT') {
      pendingPrompt = event.data.text;
      console.log(LOG_PREFIX, 'Prompt stored for injection:', pendingPrompt?.substring(0, 60));

      // Also try to set prompt on Lit component directly (for UI state sync)
      trySetLitPrompt(event.data.text);

      window.postMessage({ type: 'SET_FLOW_PROMPT_RESULT', ok: true }, '*');
    }
  });

  /**
   * Try to find the Lit/Web Component hosting the prompt input
   * and set its property directly for UI state consistency
   */
  function trySetLitPrompt(text) {
    const el = document.getElementById('PINHOLE_TEXT_AREA_ELEMENT_ID') ||
               document.querySelector('textarea:not([id*="recaptcha"])') ||
               document.querySelector('[contenteditable="true"]');

    if (!el) {
      console.log(LOG_PREFIX, 'Prompt element not found for Lit property set');
      return;
    }

    // Walk up DOM to find custom elements (Lit components have hyphenated tag names)
    let node = el;
    for (let i = 0; i < 30 && node; i++) {
      if (node.tagName?.includes('-')) {
        // Log all properties that look prompt-related
        const allProps = Object.getOwnPropertyNames(node);
        const protoProps = Object.getOwnPropertyNames(Object.getPrototypeOf(node) || {});
        const combined = [...new Set([...allProps, ...protoProps])];

        for (const prop of combined) {
          const lower = prop.toLowerCase();
          if (lower.includes('prompt') || lower.includes('userinput') ||
              lower.includes('textinput') || lower === 'value' || lower === 'text') {
            try {
              const val = node[prop];
              if (typeof val === 'string' || val === null || val === undefined) {
                console.log(LOG_PREFIX, `Lit ${node.tagName}.${prop} = "${String(val)?.substring(0, 30)}"`);
                node[prop] = text;
                console.log(LOG_PREFIX, `  → Set to: "${text.substring(0, 30)}"`);
              }
            } catch (e) {
              // Skip non-writable props
            }
          }
        }

        // Trigger Lit re-render if available
        if (typeof node.requestUpdate === 'function') {
          try { node.requestUpdate(); } catch (e) {}
        }
      }
      node = node.parentElement || node.getRootNode()?.host;
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
    } catch (e) {
      // Ignore parse errors
    }

    // ─── Prompt Injection: replace empty prompt with pending prompt ───
    if ((isImageApi || isVideoStart) && pendingPrompt) {
      try {
        const body = args[1]?.body;
        if (typeof body === 'string') {
          const parsed = JSON.parse(body);
          const currentPrompt = parsed.requests?.[0]?.prompt ||
                               parsed.requests?.[0]?.textInput?.prompt ||
                               parsed.request?.prompt || '';

          // Inject if current prompt is empty or differs from what we want
          if (!currentPrompt || currentPrompt.trim() === '') {
            console.log(LOG_PREFIX, '⚡ Injecting prompt (was empty):', pendingPrompt.substring(0, 60));
          } else {
            console.log(LOG_PREFIX, '⚡ Overriding prompt:', currentPrompt.substring(0, 30), '→', pendingPrompt.substring(0, 30));
          }

          // Set prompt in all known locations
          if (parsed.requests?.[0]) {
            parsed.requests[0].prompt = pendingPrompt;
            if (parsed.requests[0].textInput) {
              parsed.requests[0].textInput.prompt = pendingPrompt;
            }
          }
          if (parsed.request) {
            parsed.request.prompt = pendingPrompt;
          }

          // Rebuild args with modified body
          args = [args[0], { ...args[1], body: JSON.stringify(parsed) }];
          requestPrompt = pendingPrompt;
          console.log(LOG_PREFIX, '✓ Prompt injected into request body');
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Prompt injection failed:', e.message);
      }
      pendingPrompt = null; // Clear after use
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
            // Other statuses (PENDING, IN_PROGRESS) are ignored - still waiting
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

  console.log(LOG_PREFIX, 'Fetch interceptor + prompt injector installed');
})();
