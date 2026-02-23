/**
 * MangoAuto - Flow Fetch Interceptor
 * Injected into MAIN world to intercept native window.fetch
 * Captures API responses for video/image generation and posts results back
 *
 * This script intercepts:
 * - batchGenerate (image generation - sync)
 * - batchAsyncGenerateVideo (video generation - start)
 * - batchCheckAsyncVideo (video generation - status polling)
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Inject]';
  const originalFetch = window.fetch;
  let batchSeq = 0;
  const pendingVideoOps = new Map();

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

  console.log(LOG_PREFIX, 'Fetch interceptor installed');
})();
