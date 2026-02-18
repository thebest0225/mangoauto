"use strict";
(() => {
  // src/content/inject.ts
  (() => {
    const originalFetch = window.fetch;
    let batchSeq = 0;
    const pendingVideoOps = /* @__PURE__ */ new Map();
    window.fetch = async function(...args) {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      const url = typeof args[0] === "string" ? args[0] : ((_a = args[0]) == null ? void 0 : _a.url) || "";
      const isImageApi = url.includes("batchGenerate") && !url.includes("Async") && !url.includes("Check");
      const isVideoStart = url.includes("batchAsyncGenerateVideo");
      const isVideoCheck = url.includes("batchCheckAsyncVideo");
      if (!isImageApi && !isVideoStart && !isVideoCheck) {
        return originalFetch.apply(this, args);
      }
      if (isVideoCheck) {
        try {
          const response = await originalFetch.apply(this, args);
          const clone = response.clone();
          clone.json().then((data) => {
            var _a2, _b2, _c2, _d2, _e2, _f2, _g2;
            if (!data.operations) return;
            for (const op of data.operations) {
              const opName = (_a2 = op.operation) == null ? void 0 : _a2.name;
              if (!opName) continue;
              const pending = pendingVideoOps.get(opName);
              if (!pending) continue;
              if (op.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
                const videoUrl = ((_d2 = (_c2 = (_b2 = op.operation) == null ? void 0 : _b2.metadata) == null ? void 0 : _c2.video) == null ? void 0 : _d2.fifeUrl) || ((_g2 = (_f2 = (_e2 = op.operation) == null ? void 0 : _e2.metadata) == null ? void 0 : _f2.video) == null ? void 0 : _g2.videoUri) || "";
                pendingVideoOps.delete(opName);
                console.log(`[Veo3 Inject] \uBE44\uB514\uC624 \uC644\uB8CC [seq=${pending.seq}]: ${videoUrl ? "\uC131\uACF5" : "URL \uC5C6\uC74C"}`);
                window.postMessage({
                  type: "VEO3_API_RESULT",
                  seq: pending.seq,
                  prompt: pending.prompt,
                  status: 200,
                  ok: true,
                  hasMedia: !!videoUrl,
                  error: null,
                  errorCode: null,
                  mediaUrls: videoUrl ? [videoUrl] : [],
                  isVideo: true
                }, "*");
              } else if (op.status === "MEDIA_GENERATION_STATUS_FAILED") {
                pendingVideoOps.delete(opName);
                console.log(`[Veo3 Inject] \uBE44\uB514\uC624 \uC2E4\uD328 [seq=${pending.seq}]`);
                window.postMessage({
                  type: "VEO3_API_RESULT",
                  seq: pending.seq,
                  prompt: pending.prompt,
                  status: 400,
                  ok: false,
                  hasMedia: false,
                  error: "Video generation failed",
                  errorCode: "VIDEO_GENERATION_FAILED",
                  mediaUrls: [],
                  isVideo: true
                }, "*");
              }
            }
          }).catch(() => {
          });
          return response;
        } catch (fetchError) {
          throw fetchError;
        }
      }
      const currentSeq = ++batchSeq;
      let requestPrompt = "";
      try {
        const body = (_b = args[1]) == null ? void 0 : _b.body;
        if (typeof body === "string") {
          const parsed = JSON.parse(body);
          requestPrompt = ((_d = (_c = parsed.requests) == null ? void 0 : _c[0]) == null ? void 0 : _d.prompt) || ((_g = (_f = (_e = parsed.requests) == null ? void 0 : _e[0]) == null ? void 0 : _f.textInput) == null ? void 0 : _g.prompt) || ((_h = parsed.request) == null ? void 0 : _h.prompt) || "";
        }
      } catch (_e2) {
      }
      if (isVideoStart) {
        try {
          const response = await originalFetch.apply(this, args);
          const clone = response.clone();
          clone.json().then((data) => {
            var _a2, _b2, _c2, _d2;
            if (response.ok && data.operations) {
              for (const op of data.operations) {
                if ((_a2 = op.operation) == null ? void 0 : _a2.name) {
                  pendingVideoOps.set(op.operation.name, {
                    seq: currentSeq,
                    prompt: requestPrompt
                  });
                  console.log(`[Veo3 Inject] \uBE44\uB514\uC624 \uC2DC\uC791 [seq=${currentSeq}]: op=${op.operation.name}`);
                }
              }
            } else if (!response.ok) {
              let errorMsg = ((_b2 = data.error) == null ? void 0 : _b2.message) || data.message || null;
              let errorCode = ((_c2 = data.error) == null ? void 0 : _c2.code) || data.code || null;
              if ((_d2 = data.error) == null ? void 0 : _d2.details) {
                for (const detail of data.error.details) {
                  if (detail.publicErrorCode) {
                    errorCode = detail.publicErrorCode;
                    break;
                  }
                }
              }
              window.postMessage({
                type: "VEO3_API_RESULT",
                seq: currentSeq,
                prompt: requestPrompt,
                status: response.status,
                ok: false,
                hasMedia: false,
                error: errorMsg,
                errorCode,
                mediaUrls: [],
                isVideo: true
              }, "*");
            }
          }).catch(() => {
            window.postMessage({
              type: "VEO3_API_RESULT",
              seq: currentSeq,
              prompt: requestPrompt,
              status: response.status,
              ok: response.ok,
              hasMedia: false,
              error: "Response parse failed",
              errorCode: null,
              mediaUrls: [],
              isVideo: true
            }, "*");
          });
          return response;
        } catch (fetchError) {
          window.postMessage({
            type: "VEO3_API_RESULT",
            seq: currentSeq,
            prompt: requestPrompt,
            status: 0,
            ok: false,
            hasMedia: false,
            error: String(fetchError),
            errorCode: "NETWORK_ERROR",
            mediaUrls: [],
            isVideo: true
          }, "*");
          throw fetchError;
        }
      }
      try {
        const response = await originalFetch.apply(this, args);
        const clone = response.clone();
        clone.json().then((data) => {
          var _a2, _b2, _c2;
          const result = {
            type: "VEO3_API_RESULT",
            seq: currentSeq,
            prompt: requestPrompt,
            status: response.status,
            ok: response.ok,
            hasMedia: false,
            error: null,
            errorCode: null,
            mediaUrls: [],
            isVideo: false
          };
          if (response.ok && data.media) {
            result.hasMedia = true;
            result.mediaUrls = data.media.map(
              (m) => {
                var _a3, _b3;
                return ((_b3 = (_a3 = m.image) == null ? void 0 : _a3.generatedImage) == null ? void 0 : _b3.fifeUrl) || m.fifeUrl || "";
              }
            ).filter(Boolean);
          } else if (!response.ok) {
            result.error = ((_a2 = data.error) == null ? void 0 : _a2.message) || data.message || null;
            result.errorCode = ((_b2 = data.error) == null ? void 0 : _b2.code) || data.code || null;
            if ((_c2 = data.error) == null ? void 0 : _c2.details) {
              for (const detail of data.error.details) {
                if (detail.publicErrorCode) {
                  result.errorCode = detail.publicErrorCode;
                  break;
                }
              }
            }
          }
          window.postMessage(result, "*");
        }).catch(() => {
          window.postMessage({
            type: "VEO3_API_RESULT",
            seq: currentSeq,
            prompt: requestPrompt,
            status: response.status,
            ok: response.ok,
            hasMedia: false,
            error: "Response parse failed",
            errorCode: null,
            mediaUrls: [],
            isVideo: false
          }, "*");
        });
        return response;
      } catch (fetchError) {
        window.postMessage({
          type: "VEO3_API_RESULT",
          seq: currentSeq,
          prompt: requestPrompt,
          status: 0,
          ok: false,
          hasMedia: false,
          error: String(fetchError),
          errorCode: "NETWORK_ERROR",
          mediaUrls: [],
          isVideo: false
        }, "*");
        throw fetchError;
      }
    };
    console.log("[Veo3 Inject] Fetch \uC778\uD130\uC149\uD130 \uC124\uCE58 \uC644\uB8CC (\uC774\uBBF8\uC9C0 + \uBE44\uB514\uC624)");
  })();
})();
