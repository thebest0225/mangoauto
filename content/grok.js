/**
 * MangoAuto - Grok Imagine Automation
 * Content script for grok.com
 *
 * Workflow (video mode):
 *   1. Ensure main page
 *   2. Attach source image (if provided)
 *   3. Fill prompt in TipTap editor
 *   4. Submit
 *   5. Wait for result page (image generation)
 *   6. Check moderation
 *   7. Apply video settings (duration, resolution, aspect ratio)
 *   8. Enter video prompt in result textarea
 *   9. Click "동영상 만들기"
 *   10. Wait for video, extract URL
 *   11. Go back for next item
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Grok]';
  let isProcessing = false;
  let shouldStop = false;
  let videoSettingsApplied = false; // 비디오 설정 메인 페이지 적용 여부

  // ─── Navigation Debug: URL 변경 감지 ───
  let _lastUrl = window.location.href;
  const _urlChecker = setInterval(() => {
    const now = window.location.href;
    if (now !== _lastUrl) {
      console.warn(LOG_PREFIX, `🚨 URL CHANGED: ${_lastUrl} → ${now}`);
      showToast(`🚨 URL변경: ${now.substring(0, 50)}`, 'error');
      _lastUrl = now;
    }
  }, 500);

  // ─── Navigation Debug: 클릭 이벤트 추적 ───
  document.addEventListener('click', (e) => {
    if (!isProcessing) return;
    const el = e.target;
    const tag = el.tagName;
    const text = (el.textContent || '').trim().substring(0, 40);
    const href = el.href || el.closest('a')?.href || '';
    const classes = (el.className || '').substring?.(0, 50) || '';
    const ariaLabel = el.getAttribute?.('aria-label') || '';
    console.warn(LOG_PREFIX, `🖱️ CLICK during processing:`, {
      tag, text, href, classes, ariaLabel,
      isLink: !!el.closest('a'),
      path: e.composedPath().slice(0, 3).map(n => `${n.tagName || 'text'}.${(n.className || '').substring?.(0, 20) || ''}`).join(' > ')
    });
    if (href && !href.includes('grok.com/imagine')) {
      console.error(LOG_PREFIX, `🚨🚨🚨 NAVIGATION CLICK DETECTED: ${href}`);
      showToast(`🚨 잘못된 클릭: ${href.substring(0, 50)}`, 'error');
    }
  }, true); // capture phase

  // ─── Navigation Debug: history 조작 감지 ───
  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;
  history.pushState = function(...args) {
    console.warn(LOG_PREFIX, `🚨 history.pushState:`, args[2]);
    if (isProcessing) showToast(`🚨 pushState: ${args[2]}`, 'error');
    return _origPushState.apply(this, args);
  };
  history.replaceState = function(...args) {
    console.warn(LOG_PREFIX, `🚨 history.replaceState:`, args[2]);
    if (isProcessing) showToast(`🚨 replaceState: ${args[2]}`, 'error');
    return _origReplaceState.apply(this, args);
  };
  window.addEventListener('popstate', () => {
    console.warn(LOG_PREFIX, `🚨 popstate event → ${window.location.href}`);
    if (isProcessing) showToast(`🚨 popstate: ${window.location.href.substring(0, 50)}`, 'error');
  });

  // ─── Visual Debug Toast (화면에 직접 보이는 디버그) ───
  function showToast(message, type = 'info') {
    console.log(LOG_PREFIX, `[${type}]`, message);
    try {
      let container = document.getElementById('mangoauto-debug');
      if (!container) {
        container = document.createElement('div');
        container.id = 'mangoauto-debug';
        container.style.cssText = 'position:fixed;top:10px;right:10px;z-index:999999;max-width:400px;font-family:monospace;font-size:12px;pointer-events:none;';
        document.body.appendChild(container);
      }
      const toast = document.createElement('div');
      const colors = { info: '#2196F3', success: '#4CAF50', error: '#f44336', warn: '#FF9800' };
      toast.style.cssText = `background:${colors[type] || colors.info};color:white;padding:8px 12px;margin-bottom:4px;border-radius:6px;opacity:0.95;word-break:break-all;box-shadow:0 2px 8px rgba(0,0,0,0.3);`;
      toast.textContent = `[MangoAuto] ${message}`;
      container.appendChild(toast);
      // 10초 후 사라짐
      setTimeout(() => { toast.remove(); }, 10000);
      // 최대 8개
      while (container.children.length > 8) container.removeChild(container.firstChild);
    } catch (e) { /* DOM not ready */ }
  }

  // ─── Message Handler ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXECUTE_PROMPT') {
      showToast(`EXECUTE_PROMPT 수신! mode=${msg.settings?._mode}, hasImage=${!!msg.sourceImageDataUrl}`, 'info');

      // 올바른 페이지인지 먼저 확인 (project 등 엉뚱한 페이지면 즉시 에러 반환)
      const url = window.location.href;
      if (!url.includes('grok.com/imagine')) {
        console.log(LOG_PREFIX, `Wrong page detected: ${url}, navigating to /imagine`);
        showToast(`잘못된 페이지: ${url.substring(0, 40)}... → /imagine 이동`, 'warn');
        sendResponse({ ok: false, error: 'WRONG_PAGE: /imagine이 아닙니다. 페이지 이동 후 재시도 필요.' });
        window.location.href = 'https://grok.com/imagine';
        return false;
      }

      // Send immediate acknowledgment to prevent channel closure
      sendResponse({ ok: true, started: true });

      // Then process async (results sent via chrome.runtime.sendMessage)
      handleExecutePrompt(msg).catch(err => {
        showToast(`실행 에러: ${err.message}`, 'error');
        console.error(LOG_PREFIX, 'Execution error:', err);
        chrome.runtime.sendMessage({
          type: 'GENERATION_ERROR',
          error: err.message
        });
      });

      return false; // Already sent response synchronously
    }
    if (msg.type === 'STOP_GENERATION') {
      shouldStop = true;
      isProcessing = false;
      videoSettingsApplied = false;
      showToast('중지 명령 수신', 'warn');
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'RESET_SETTINGS') {
      videoSettingsApplied = false;
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, site: 'grok' });
      return false;
    }
  });

  async function handleExecutePrompt(msg) {
    if (isProcessing) {
      showToast('이전 작업 진행 중, 5초 대기...', 'warn');
      // 이전 작업이 끝나기를 최대 10초 대기
      for (let i = 0; i < 20; i++) {
        await delay(500);
        if (!isProcessing) break;
      }
      if (isProcessing) {
        // 강제 리셋 (이전 작업이 stuck 된 경우)
        showToast('이전 작업 강제 리셋', 'warn');
        isProcessing = false;
      }
    }
    isProcessing = true;
    shouldStop = false; // 새 작업 시작 시 중지 플래그 리셋
    showToast('handleExecutePrompt 시작', 'info');

    try {
      const { prompt, mediaType, sourceImageDataUrl, settings } = msg;
      const mode = settings?._mode || 'text-image';
      const timeoutMs = (settings?.grok?.timeout || 5) * 60000;

      showToast(`Mode: ${mode} | HasImage: ${!!sourceImageDataUrl} | Prompt: ${(prompt || '').substring(0, 30)}`, 'info');

      // ══════════════════════════════════════════════════
      // 프레임→영상 (image-to-video) 워크플로우
      // 1. 메인 페이지에서 이미지 첨부 → 자동으로 결과 페이지 이동
      // 2. 결과 페이지에서 비디오 설정 + 프롬프트 입력
      // 3. "동영상 만들기" 클릭
      // ══════════════════════════════════════════════════
      if (mode === 'image-video' && sourceImageDataUrl) {
        showToast('=== 프레임→영상 모드 시작 ===', 'info');

        // Step 1: 메인 페이지 확인
        showToast('Step 1: 메인 페이지 확인...', 'info');
        await ensureMainPage();
        checkStopped();

        // Step 2: 비디오 설정 적용 (메인 페이지에서 - 참고자료 방식)
        if (!videoSettingsApplied) {
          showToast('Step 2: 비디오 설정 적용 (메인 페이지)...', 'info');
          await applySettingsOnMainPage(settings);
          videoSettingsApplied = true;
          await delay(500);
          checkStopped();
        }

        // Step 3: 이미지 첨부 (드래그 → 자동으로 결과 페이지로 이동)
        showToast('Step 3: 이미지 첨부 중...', 'info');
        const attached = await attachImage(sourceImageDataUrl);
        if (!attached) throw new Error('이미지 첨부 실패');
        showToast('이미지 첨부 완료!', 'success');
        checkStopped();

        // Step 4: 결과 페이지로 자동 이동 대기
        showToast('Step 4: 결과 페이지 대기...', 'info');
        await waitForResultPage(timeoutMs);
        await delay(3000);
        checkStopped();

        // Step 5: 검열 확인
        if (isModerated()) throw new ModerationError();

        // Step 6: 결과 페이지 텍스트필드에 비디오 프롬프트 입력
        // 새 UI는 TipTap 에디터를 사용하므로 typePrompt() 사용
        if (prompt?.trim()) {
          showToast('Step 6: 비디오 프롬프트 입력...', 'info');
          await typePrompt(prompt);
          await delay(500);
        }
        checkStopped();

        // Step 7: "동영상 만들기" 클릭
        showToast('Step 7: 동영상 만들기 클릭...', 'info');
        const videoCreated = await clickCreateVideo();
        if (!videoCreated) throw new Error('"동영상 만들기" 버튼 클릭 실패');
        checkStopped();

        // Step 8: 비디오 생성 대기
        const videoResult = await waitForVideoReady(timeoutMs);
        if (videoResult === 'moderated') throw new ModerationError();

        // Step 9: 비디오 URL 추출
        showToast('Step 9: 비디오 URL 추출...', 'info');
        let videoUrl = await extractVideoUrl();
        if (!videoUrl) throw new Error('비디오 URL을 찾을 수 없습니다');

        // Step 10: 480p면 자동 업스케일 시도
        if (settings?.grok?.autoUpscale !== false && videoUrl && !videoUrl.includes('_hd')) {
          showToast('Step 10: 480p 감지 - 업스케일 시도...', 'info');
          const upscaled = await tryUpscaleVideo(timeoutMs);
          if (upscaled) {
            const hdUrl = await extractVideoUrl();
            if (hdUrl) videoUrl = hdUrl;
          }
        }
        checkStopped();

        showToast(`비디오 URL: ${videoUrl.substring(0, 60)}`, 'success');
        chrome.runtime.sendMessage({
          type: 'GENERATION_COMPLETE',
          mediaUrl: videoUrl,
          mediaType: 'video'
        });
        showToast('비디오 URL 전송 완료!', 'success');

      // ══════════════════════════════════════════════════
      // 텍스트→영상 (text-to-video) 워크플로우
      // 1. 메인 페이지에서 프롬프트 입력 + 제출
      // 2. 결과 페이지에서 비디오 설정 + 동영상 만들기
      // ══════════════════════════════════════════════════
      } else if (mediaType === 'video') {
        showToast('=== 텍스트→영상 모드 시작 ===', 'info');

        await ensureMainPage();
        checkStopped();

        // 비디오 설정 적용 (메인 페이지에서 - 참고자료 방식)
        if (!videoSettingsApplied) {
          showToast('비디오 설정 적용 (메인 페이지)...', 'info');
          await applySettingsOnMainPage(settings);
          videoSettingsApplied = true;
          await delay(500);
          checkStopped();
        }

        showToast('프롬프트 입력 중...', 'info');
        await typePrompt(prompt || '');
        await delay(800 + Math.random() * 500);

        const submitted = await tryClickSubmit();
        if (!submitted) throw new Error('제출 실패');

        await waitForResultPage(timeoutMs);
        await delay(3000);
        checkStopped();

        if (isModerated()) throw new ModerationError();

        // 결과 페이지에서 비디오 프롬프트 (필요시)
        // 새 UI는 TipTap 에디터를 사용하므로 typePrompt() 사용
        if (prompt?.trim()) {
          await typePrompt(prompt);
          await delay(500);
        }

        const videoCreated = await clickCreateVideo();
        if (!videoCreated) throw new Error('"동영상 만들기" 버튼 클릭 실패');
        checkStopped();

        const videoResult = await waitForVideoReady(timeoutMs);
        if (videoResult === 'moderated') throw new ModerationError();

        let videoUrl = await extractVideoUrl();
        if (!videoUrl) throw new Error('비디오 URL을 찾을 수 없습니다');

        // 480p면 자동 업스케일 시도
        if (settings?.grok?.autoUpscale !== false && videoUrl && !videoUrl.includes('_hd')) {
          showToast('480p 감지 - 업스케일 시도...', 'info');
          const upscaled = await tryUpscaleVideo(timeoutMs);
          if (upscaled) {
            const hdUrl = await extractVideoUrl();
            if (hdUrl) videoUrl = hdUrl;
          }
        }
        checkStopped();

        chrome.runtime.sendMessage({
          type: 'GENERATION_COMPLETE',
          mediaUrl: videoUrl,
          mediaType: 'video'
        });

      // ══════════════════════════════════════════════════
      // 텍스트→이미지 / 이미지→이미지 워크플로우
      // 1. 메인 페이지에서 (이미지 첨부 +) 프롬프트 입력 + 제출
      // 2. 결과 페이지에서 이미지 추출
      // ══════════════════════════════════════════════════
      } else {
        showToast(`=== ${mode} 모드 시작 ===`, 'info');

        await ensureMainPage();

        // 이미지→이미지: 이미지 첨부
        if (sourceImageDataUrl) {
          const attached = await attachImage(sourceImageDataUrl);
          if (!attached) throw new Error('이미지 첨부 실패');
          await delay(2000);
        }

        await typePrompt(prompt || '');
        await delay(800 + Math.random() * 500);

        const submitted = await tryClickSubmit();
        if (!submitted) throw new Error('제출 실패');

        await waitForResultPage(timeoutMs);
        await delay(3000);

        if (isModerated()) throw new ModerationError();

        const imageUrl = await getGeneratedImageUrl();
        if (!imageUrl) throw new Error('생성된 이미지를 찾을 수 없습니다');

        const mediaDataUrl = await MangoDom.fetchAsDataUrl(imageUrl);
        chrome.runtime.sendMessage({
          type: 'GENERATION_COMPLETE',
          mediaDataUrl,
          mediaType: 'image'
        });
      }

      // 다음 아이템을 위해 메인 페이지로 복귀
      // goBack()이 /imagine으로 직접 이동 → 페이지 리로드 → content script 재시작
      try {
        await delay(2000);
        if (!shouldStop) {
          await goBack();
          // goBack()이 location.href 변경하므로 여기까지 올 수도 있고 안 올 수도 있음
        }
      } catch (navErr) {
        console.warn(LOG_PREFIX, 'Post-complete navigation failed (ignored):', navErr.message);
      }

      return { ok: true };
    } catch (err) {
      console.error(LOG_PREFIX, 'Error:', err);
      // 사용자 중지 시에는 에러 메시지를 보내지 않음 (무한 루프 방지)
      if (shouldStop) {
        showToast('사용자 중지로 인해 작업 종료', 'warn');
      } else {
        chrome.runtime.sendMessage({
          type: 'GENERATION_ERROR',
          error: err.message,
          errorCode: err instanceof ModerationError ? 'MODERATED' : ''
        });
      }

      // 메인 페이지로 복구 시도
      // goBack()은 browser history에 따라 프로젝트 페이지 등 엉뚱한 곳으로 갈 수 있음
      // /imagine으로 직접 이동
      try {
        if (!isOnMainPage()) {
          console.log(LOG_PREFIX, '메인 페이지로 직접 이동...');
          window.location.href = 'https://grok.com/imagine';
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Recovery failed:', e.message);
      }

      return { error: err.message, errorCode: err instanceof ModerationError ? 'MODERATED' : '' };
    } finally {
      isProcessing = false;
    }
  }

  // ─── Moderation Error ───
  class ModerationError extends Error {
    constructor() { super('Content moderated'); }
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function checkStopped() {
    if (shouldStop) throw new Error('사용자에 의해 중지됨');
  }

  // ─── DOM Selectors ───

  // Grok uses TipTap ProseMirror editor (try multiple selectors)
  const EDITOR_SELECTORS = [
    '.tiptap.ProseMirror',
    '.ProseMirror',
    '[contenteditable="true"].tiptap',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ];

  function findEditor() {
    for (const sel of EDITOR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Submit button: aria-label="제출" or text "제출"/"Submit"
  function findSubmitButton() {
    let btn = document.querySelector('button[aria-label="제출"]');
    if (btn) return btn;

    const buttons = document.querySelectorAll('button');
    for (const b of buttons) {
      const text = (b.textContent || '').trim();
      if (text === '제출' || text === 'Submit') return b;
    }
    return null;
  }

  // File input for image attachment (may be hidden)
  function findFileInput() {
    return document.querySelector('input[type="file"]');
  }

  // Upload/attach button for images on the main page
  function findUploadButton() {
    // Strategy 1: aria-label based
    const ariaSelectors = [
      'button[aria-label*="이미지" i]',
      'button[aria-label*="첨부" i]',
      'button[aria-label*="업로드" i]',
      'button[aria-label*="Upload" i]',
      'button[aria-label*="Attach" i]',
      'button[aria-label*="Image" i]',
      'button[aria-label*="Photo" i]',
      'button[aria-label*="사진" i]',
      'button[aria-label*="파일" i]',
      'button[aria-label*="File" i]',
      'button[aria-label*="media" i]',
      'button[aria-label*="미디어" i]'
    ];
    for (const sel of ariaSelectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) {
        console.log(LOG_PREFIX, 'Found upload button via aria-label:', sel);
        return btn;
      }
    }

    // Strategy 2: Find buttons near the editor that are NOT submit
    const editor = findEditor();
    if (editor) {
      // Walk up to find the form/container
      let container = editor.parentElement;
      for (let i = 0; i < 5 && container; i++) {
        container = container.parentElement;
      }

      if (container) {
        const submitBtn = findSubmitButton();
        const buttons = container.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn === submitBtn) continue;
          if (btn.disabled) continue;

          // Look for icon buttons (small buttons with SVG or icon)
          const hasSvg = btn.querySelector('svg');
          const hasIcon = btn.querySelector('i, [class*="icon"]');
          if (hasSvg || hasIcon) {
            const label = (btn.getAttribute('aria-label') || '').toLowerCase();
            const text = (btn.textContent || '').trim().toLowerCase();
            // Skip known non-upload buttons
            if (label.includes('제출') || label.includes('submit')) continue;
            if (label.includes('pfp') || label.includes('설정')) continue;
            if (text.includes('제출') || text.includes('submit')) continue;

            // If it has an SVG with a path that looks like a clip/image icon
            if (hasSvg) {
              console.log(LOG_PREFIX, 'Found potential upload button (SVG):', label || text || 'unnamed');
              return btn;
            }
          }
        }
      }
    }

    // Strategy 3: Look for specific icon text patterns
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = (btn.textContent || '').trim();
      // Material icon text patterns for upload/attach
      if (['attach_file', 'add_photo_alternate', 'image', 'photo_camera',
           'upload_file', 'add_a_photo', 'insert_photo'].includes(text)) {
        console.log(LOG_PREFIX, 'Found upload button via icon text:', text);
        return btn;
      }
    }

    return null;
  }

  // Result page textarea (for video prompt)
  function findResultPageTextarea() {
    return document.querySelector('textarea');
  }

  // Create video button (참고자료 방식: aria-label 우선, text 매칭 fallback)
  function findCreateVideoButton() {
    // 1. aria-label 기반 (참고자료 방식)
    let btn = document.querySelector('button[aria-label="동영상 만들기"]');
    if (btn) return btn;

    // 2. 정확한 텍스트 매칭
    const buttons = document.querySelectorAll('button');
    for (const b of buttons) {
      const text = (b.textContent || '').trim();
      if (text === '동영상 만들기' || text === 'Create video') return b;
    }

    // 3. 부분 매칭 (설정 적용 후 버튼 텍스트가 변경되는 경우 대비)
    for (const b of buttons) {
      const text = (b.textContent || '').trim();
      if (text.includes('동영상 만들기') || text.includes('Create video') ||
          text.includes('비디오 만들기') || text.includes('Generate video') ||
          text.includes('영상 만들기') || text.includes('Make video')) {
        return b;
      }
    }

    // 4. "동영상"/"video" 키워드와 액션 키워드 조합 매칭
    for (const b of buttons) {
      const text = (b.textContent || '').trim().toLowerCase();
      const hasVideo = text.includes('동영상') || text.includes('비디오') || text.includes('영상') || text.includes('video');
      const hasAction = text.includes('만들기') || text.includes('생성') || text.includes('create') || text.includes('generate') || text.includes('make');
      if (hasVideo && hasAction) return b;
    }

    return null;
  }

  // ─── Page Navigation ───

  function isOnMainPage() {
    // Main page: grok.com/imagine (not /post/)
    const url = window.location.href;
    return url.includes('grok.com/imagine') && !url.includes('/post/');
  }

  function isOnResultPage() {
    // Result page: grok.com/imagine/post/{UUID}
    return window.location.href.includes('grok.com/imagine/post/');
  }

  async function ensureMainPage() {
    if (isOnMainPage()) {
      console.log(LOG_PREFIX, 'On /imagine page - ready');
      await delay(500);
      return;
    }

    // /imagine이 아닌 경우 직접 이동
    console.log(LOG_PREFIX, 'Not on /imagine page, navigating directly...');
    window.location.href = 'https://grok.com/imagine';
    // 페이지 리로드 → 현재 스크립트 중단됨. 배경에서 재시도 필요.
    await delay(10000); // 리로드 전까지 대기
    throw new Error('/imagine으로 이동 중...');
  }

  // Wait for an element to appear
  async function waitForElement(selector, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await delay(300);
    }
    return null;
  }

  async function goBack() {
    // history.back()은 채팅(/c/...) 또는 프로젝트 페이지로 갈 수 있으므로
    // /imagine으로 직접 이동
    console.log(LOG_PREFIX, 'goBack: /imagine으로 직접 이동');
    window.location.href = 'https://grok.com/imagine';
    await delay(2000);
  }

  async function waitForMainPage(timeout = 15000) {
    console.log(LOG_PREFIX, 'Waiting for main page...');
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (isOnMainPage() && findEditor()) {
        console.log(LOG_PREFIX, 'Main page ready');
        await delay(500);
        return true;
      }
      await delay(500);
    }
    // Even if editor not found, if we're on main page, return true
    if (isOnMainPage()) {
      console.warn(LOG_PREFIX, 'Main page but editor not found yet, continuing anyway');
      return true;
    }
    console.warn(LOG_PREFIX, 'Main page wait timeout');
    return false;
  }

  async function waitForResultPage(timeout = 120000) {
    console.log(LOG_PREFIX, 'Waiting for result page...');
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!isOnMainPage()) return true;
      await delay(1000);
    }
    throw new Error('Result page navigation timeout');
  }

  // ─── Auto Video Generation Toggle ───
  async function setAutoVideoGeneration(enabled) {
    try {
      // Step 1: Click profile picture button
      const pfpBtn = document.querySelector('img[alt="pfp"]')?.closest('button') ||
                     document.querySelector('button[aria-label="pfp"]');
      if (!pfpBtn) {
        console.log(LOG_PREFIX, 'Profile button not found, skipping auto-video toggle');
        return;
      }

      MangoDom.simulateClick(pfpBtn);
      await delay(500);

      // Step 2: Find and click Settings menu item
      const settingsItem = findMenuItemByText('설정') || findMenuItemByText('Settings');
      if (!settingsItem) {
        // Close the menu
        document.body.click();
        console.log(LOG_PREFIX, 'Settings menu item not found');
        return;
      }
      MangoDom.simulateClick(settingsItem);
      await delay(500);

      // Step 3: Find dialog and Behavior tab
      const dialog = document.querySelector('dialog, [role="dialog"]');
      if (!dialog) {
        console.log(LOG_PREFIX, 'Settings dialog not found');
        return;
      }

      const behaviorTab = findButtonInContainer(dialog, '동작') ||
                          findButtonInContainer(dialog, 'Behavior');
      if (behaviorTab) {
        MangoDom.simulateClick(behaviorTab);
        await delay(300);
      }

      // Step 4: Find auto-video switch
      const switches = dialog.querySelectorAll('[role="switch"]');
      let autoVideoSwitch = null;
      for (const sw of switches) {
        const label = sw.getAttribute('aria-label') || '';
        if (label.includes('자동 비디오 생성') || label.includes('auto video')) {
          autoVideoSwitch = sw;
          break;
        }
      }

      if (!autoVideoSwitch) {
        // Try finding by nearby label text
        const labels = dialog.querySelectorAll('label, span, div');
        for (const lbl of labels) {
          const text = lbl.textContent.trim();
          if (text.includes('자동 비디오 생성') || text.includes('auto video generation')) {
            const sw = lbl.closest('[role="switch"]') ||
                       lbl.parentElement?.querySelector('[role="switch"]') ||
                       lbl.nextElementSibling?.querySelector('[role="switch"]');
            if (sw) { autoVideoSwitch = sw; break; }
          }
        }
      }

      if (autoVideoSwitch) {
        const isChecked = autoVideoSwitch.getAttribute('aria-checked') === 'true';
        if (isChecked !== enabled) {
          MangoDom.simulateClick(autoVideoSwitch);
          console.log(LOG_PREFIX, `Auto video generation: ${enabled ? 'ON' : 'OFF'}`);
          await delay(300);
        }
      }

      // Close dialog
      const closeBtn = dialog.querySelector('button[aria-label="Close"]') ||
                       dialog.querySelector('button[aria-label="닫기"]');
      if (closeBtn) closeBtn.click();
      else document.body.click();
      await delay(300);

    } catch (e) {
      console.warn(LOG_PREFIX, 'Auto video toggle failed:', e.message);
      document.body.click(); // close any open menus
    }
  }

  function findMenuItemByText(text) {
    const items = document.querySelectorAll('[role="menuitem"], [role="option"], li, a');
    for (const item of items) {
      if ((item.textContent || '').trim().includes(text)) return item;
    }
    return null;
  }

  function findButtonInContainer(container, text) {
    const buttons = container.querySelectorAll('button, [role="tab"]');
    for (const btn of buttons) {
      if ((btn.textContent || '').trim().includes(text)) return btn;
    }
    return null;
  }

  // ─── Prompt Input ───
  async function typePrompt(text) {
    if (!text || !text.trim()) {
      console.log(LOG_PREFIX, 'Empty prompt, skipping typePrompt');
      return;
    }

    // Try 1: TipTap/ProseMirror editor
    const editor = findEditor();
    if (editor) {
      console.log(LOG_PREFIX, 'Editor found:', editor.className);
      editor.focus();
      await delay(100);
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      await delay(100);
      document.execCommand('insertText', false, text);
      await delay(200);
      if (editor.textContent?.includes(text.substring(0, 20))) {
        console.log(LOG_PREFIX, 'Prompt typed via editor');
        return;
      }
      // DOM fallback for editor
      const p = editor.querySelector('p');
      if (p) p.textContent = text;
      else editor.innerHTML = `<p>${text}</p>`;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      console.log(LOG_PREFIX, 'Prompt typed via editor DOM fallback');
      return;
    }

    // Try 2: textarea
    const textarea = document.querySelector('textarea');
    if (textarea) {
      console.log(LOG_PREFIX, 'Using textarea');
      MangoDom.setTextareaValue(textarea, text);
      console.log(LOG_PREFIX, 'Prompt typed via textarea');
      return;
    }

    // Try 3: Any contenteditable or input
    const contentEditable = document.querySelector('[contenteditable="true"]');
    if (contentEditable) {
      console.log(LOG_PREFIX, 'Using contenteditable');
      MangoDom.setContentEditable(contentEditable, text);
      console.log(LOG_PREFIX, 'Prompt typed via contenteditable');
      return;
    }

    console.warn(LOG_PREFIX, 'No input element found - prompt not typed');
  }

  // ─── Submit ───
  async function tryClickSubmit() {
    // Don't submit if auto-generating already
    if (isAutoGenerating()) {
      console.log(LOG_PREFIX, 'Auto-generating in progress, skipping submit');
      return false;
    }

    // Wait for submit button to be enabled
    const btn = await waitForSubmitEnabled(5000);
    if (!btn) return false;

    btn.click();
    console.log(LOG_PREFIX, 'Submit clicked');
    await delay(1000);
    return true;
  }

  function isAutoGenerating() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text === '동영상 취소' || text === 'Cancel video') {
        return true;
      }
    }
    return false;
  }

  async function waitForSubmitEnabled(timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const btn = findSubmitButton();
      if (btn && !btn.disabled) return btn;
      await delay(300);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════
  // ─── Image Attachment ───
  // ═══════════════════════════════════════════════════
  async function attachImage(imageDataUrl) {
    try {
      console.log(LOG_PREFIX, '=== 이미지 첨부 시작 ===');

      // Remove any existing attachment first
      await removeExistingAttachment();
      await delay(500);

      const file = MangoDom.dataUrlToFile(imageDataUrl, `image-${Date.now()}.png`);
      console.log(LOG_PREFIX, `파일 생성: ${file.name}, 크기: ${file.size}`);

      // ── Strategy 1: Direct DataTransfer on file input (참고자료 방식) ──
      console.log(LOG_PREFIX, 'Strategy 1: DataTransfer (file input 직접 설정)');
      try {
        const fileInput = findFileInput();
        if (fileInput) {
          fileInput.value = '';
          const dt = new DataTransfer();
          dt.items.add(file);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          fileInput.dispatchEvent(new Event('input', { bubbles: true }));
          await delay(3000);
          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ DataTransfer로 첨부 성공');
            return true;
          }
          console.log(LOG_PREFIX, 'DataTransfer 설정했으나 미확인, 다음 방식 시도');
        } else {
          console.log(LOG_PREFIX, 'file input 없음, 다음 방식 시도');
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'DataTransfer 실패:', e.message);
      }

      // 이미 첨부됐으면 중단
      if (checkImageAttached() || !isOnMainPage()) {
        console.log(LOG_PREFIX, '✅ Strategy 1 이후 첨부 확인됨');
        return true;
      }

      // ── Strategy 2: MAIN world injection (React 이벤트 호환) ──
      // file input 초기화 후 진행 (중복 방지)
      console.log(LOG_PREFIX, 'Strategy 2: MAIN world 파일 주입');
      try {
        // 이전 strategy에서 설정된 files 클리어
        const fi2 = findFileInput();
        if (fi2) { fi2.value = ''; }

        const resp = await chrome.runtime.sendMessage({
          type: 'INJECT_GROK_FILE',
          imageDataUrl
        });
        if (resp?.success) {
          const uploadBtn = findUploadButton();
          if (uploadBtn) {
            MangoDom.simulateClick(uploadBtn);
            await delay(3000);
          } else {
            const fi = findFileInput();
            if (fi) {
              const arr = imageDataUrl.split(',');
              const mime = arr[0].match(/:(.*?);/)[1];
              const bstr = atob(arr[1]);
              const u8arr = new Uint8Array(bstr.length);
              for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
              const f = new File([u8arr], `image-${Date.now()}.png`, { type: mime });
              const dt = new DataTransfer();
              dt.items.add(f);
              fi.files = dt.files;
              fi.dispatchEvent(new Event('change', { bubbles: true }));
              await delay(3000);
            }
          }
          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ MAIN world 주입으로 첨부 성공');
            return true;
          }
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'MAIN world 주입 실패:', e.message);
      }

      // 이미 첨부됐으면 중단
      if (checkImageAttached() || !isOnMainPage()) {
        console.log(LOG_PREFIX, '✅ Strategy 2 이후 첨부 확인됨');
        return true;
      }

      // ── Strategy 3: Drag-and-drop on editor / page area ──
      console.log(LOG_PREFIX, 'Strategy 3: Drag-and-drop');
      try {
        const dropTargets = [
          findEditor(),
          document.querySelector('main'),
          document.querySelector('[role="main"]'),
          document.querySelector('.tiptap'),
          document.querySelector('[contenteditable]'),
          document.body
        ].filter(Boolean);

        for (const target of dropTargets) {
          // 매 타겟 시도 전 재확인
          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ Drag-and-drop 중 첨부 확인됨');
            return true;
          }
          console.log(LOG_PREFIX, `드래그 대상: ${target.tagName}.${target.className?.substring?.(0, 30) || ''}`);
          await MangoDom.dropFileOnElement(target, file);
          await delay(3000);
          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ Drag-and-drop 첨부 성공');
            return true;
          }
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Drag-and-drop 실패:', e.message);
      }

      // 이미 첨부됐으면 중단
      if (checkImageAttached() || !isOnMainPage()) {
        console.log(LOG_PREFIX, '✅ Strategy 3 이후 첨부 확인됨');
        return true;
      }

      // ── Strategy 4: Upload button click → file input ──
      console.log(LOG_PREFIX, 'Strategy 4: Upload 버튼 클릭');
      try {
        const uploadBtn = findUploadButton();
        if (uploadBtn) {
          console.log(LOG_PREFIX, '업로드 버튼 클릭');
          MangoDom.simulateClick(uploadBtn);
          await delay(800);
          const fi = findFileInput();
          if (fi) {
            fi.value = '';
            const dt = new DataTransfer();
            dt.items.add(file);
            fi.files = dt.files;
            fi.dispatchEvent(new Event('change', { bubbles: true }));
            fi.dispatchEvent(new Event('input', { bubbles: true }));
            await delay(3000);
            if (checkImageAttached() || !isOnMainPage()) {
              console.log(LOG_PREFIX, '✅ Upload 버튼 방식 첨부 성공');
              return true;
            }
          }
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Upload 버튼 방식 실패:', e.message);
      }

      console.error(LOG_PREFIX, '❌ 모든 이미지 첨부 방식 실패');
      return false;
    } catch (e) {
      console.error(LOG_PREFIX, '❌ 이미지 첨부 에러:', e);
      return false;
    }
  }

  async function removeExistingAttachment() {
    // Click delete button if exists
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text === '삭제') {
        btn.click();
        console.log(LOG_PREFIX, '이전 첨부 이미지 삭제');
        await delay(1000);
        break;
      }
    }

    // Clear file input
    const fileInput = findFileInput();
    if (fileInput) {
      fileInput.value = '';
      const emptyDt = new DataTransfer();
      fileInput.files = emptyDt.files;
    }
  }

  function checkImageAttached() {
    // Check 1: file input already has files
    const fileInput = findFileInput();
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      console.log(LOG_PREFIX, 'checkImageAttached: file input has', fileInput.files.length, 'files');
      return true;
    }

    // Check 2: delete/remove button (appears when image is attached)
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text === '삭제') return true;
    }

    // Check 3: blob/data images (uploaded images show as blob URLs)
    const images = document.querySelectorAll('img[src^="blob:"], img[src^="data:"]');
    if (images.length > 0) return true;

    // Check 4: thumbnail/preview images near the editor
    const previewImgs = document.querySelectorAll('[class*="preview"] img, [class*="thumb"] img, [class*="attach"] img');
    if (previewImgs.length > 0) return true;

    return false;
  }

  // ═══════════════════════════════════════════════════
  // ─── Video Settings (메인 페이지 "모델 선택" 방식 - 참고자료) ───
  // ═══════════════════════════════════════════════════

  /**
   * 메인 페이지에서 "모델 선택" 버튼을 통해 비디오 설정 적용 (참고자료 방식).
   * Grok UI는 [role="menu"]를 사용하지 않을 수 있으므로
   * 플로팅 팝오버/드롭다운을 다양한 셀렉터로 탐색.
   */
  async function applySettingsOnMainPage(settings) {
    const grok = settings?.grok || {};
    const { videoDuration, videoResolution, aspectRatio } = grok;

    console.log(LOG_PREFIX, 'Applying video settings on main page:', {
      duration: videoDuration, resolution: videoResolution, aspectRatio
    });

    // Step 1: "모델 선택" 버튼 찾기 (하단바의 모델 드롭다운 트리거)
    const modelBtn = document.querySelector('button[aria-label="모델 선택"]') ||
                     findButtonByTextInArea('비디오') ||
                     findButtonByTextInArea('이미지');
    if (!modelBtn) {
      showToast('모델 선택 버튼 없음, 설정 건너뜀', 'warn');
      return;
    }
    showToast(`모델 버튼 찾음: "${(modelBtn.textContent || '').trim().substring(0, 20)}"`, 'info');

    // Step 2: 패널 열기
    MangoDom.simulateClick(modelBtn);
    await delay(600);

    // Step 3: "비디오" 모드 선택
    const videoItem = findDropdownItem('비디오');
    if (videoItem) {
      const itemText = (videoItem.textContent || '').trim();
      MangoDom.simulateClick(videoItem);
      showToast(`"${itemText}" 선택`, 'info');
      await delay(500);
    }

    // Step 4: 패널이 닫혔는지 확인 → 닫혔으면 다시 열기
    let dropdownBtns = findDropdownButtons();
    if (dropdownBtns.length === 0) {
      showToast('패널 닫힘 감지 → 다시 열기', 'info');
      MangoDom.simulateClick(modelBtn);
      await delay(600);
      dropdownBtns = findDropdownButtons();
    }

    const btnTexts = dropdownBtns.map(b => (b.textContent || '').trim()).filter(t => t.length < 20);
    showToast(`패널 버튼 ${dropdownBtns.length}개: [${btnTexts.join(', ')}]`, 'info');

    // Step 5: 재생시간 설정
    if (videoDuration) {
      const durationLabels = [`${videoDuration}s`, `${videoDuration}초`, String(videoDuration)];
      if (!clickButtonInList(dropdownBtns, durationLabels, 'duration')) {
        showToast(`duration 미적용: ${videoDuration}`, 'warn');
      }
      await delay(200);
    }

    // Step 6: 해상도 설정
    if (videoResolution) {
      const resLabels = [videoResolution, videoResolution.replace('p', '')];
      if (!clickButtonInList(dropdownBtns, resLabels, 'resolution')) {
        showToast(`resolution 미적용: ${videoResolution}`, 'warn');
      }
      await delay(200);
    }

    // Step 7: 종횡비 설정
    if (aspectRatio) {
      const arLabels = [aspectRatio];
      if (!clickButtonInList(dropdownBtns, arLabels, 'aspectRatio')) {
        showToast(`aspect ratio 미적용: ${aspectRatio}`, 'warn');
      }
      await delay(200);
    }

    // Step 8: 패널 닫기 (여러 방법 시도)
    await closeSettingsPanel(modelBtn);

    showToast('비디오 설정 적용 완료!', 'success');
    console.log(LOG_PREFIX, `설정 적용 완료: ${videoDuration}, ${videoResolution}, ${aspectRatio}`);
  }

  /**
   * 설정 패널(팝오버/드롭다운) 닫기
   */
  async function closeSettingsPanel(triggerBtn) {
    // 방법1: Escape 키 (메뉴 요소에 직접 dispatch)
    const panel = findFloatingContainer();
    if (panel) {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await delay(300);
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(300);
    }

    // 방법2: 트리거 버튼 재클릭 (토글)
    if (findFloatingContainer() && triggerBtn) {
      console.log(LOG_PREFIX, '패널 아직 열림 → 트리거 버튼 재클릭');
      MangoDom.simulateClick(triggerBtn);
      await delay(400);
    }

    // 방법3: 에디터 영역 클릭 (팝오버 외부 클릭 효과)
    if (findFloatingContainer()) {
      const editor = findEditor();
      if (editor) {
        console.log(LOG_PREFIX, '패널 아직 열림 → 에디터 영역 클릭');
        editor.click();
        await delay(300);
      }
    }

    // 방법4: 패널을 DOM에서 숨기기 (최후 수단)
    const stillOpen = findFloatingContainer();
    if (stillOpen) {
      console.log(LOG_PREFIX, '패널 아직 열림 → display:none으로 강제 숨김');
      stillOpen.style.display = 'none';
      await delay(100);
    }
  }

  /**
   * 하단바 입력 영역 근처에서 텍스트로 버튼 찾기
   */
  function findButtonByTextInArea(text) {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const btnText = (btn.textContent || '').trim();
      if (btnText.includes(text) && btnText.length < 30) {
        // 하단바 버튼: 화면 하단 200px 이내
        const rect = btn.getBoundingClientRect();
        if (rect.top > window.innerHeight - 200) {
          return btn;
        }
      }
    }
    return null;
  }

  /**
   * 현재 열린 드롭다운/팝오버에서 항목 찾기.
   * [role="menu"], [role="menuitem"] 뿐만 아니라
   * 다양한 팝오버 컨테이너 검색.
   */
  function findDropdownItem(text) {
    // 1. [role="menuitem"] (참고자료 방식)
    const menuItems = document.querySelectorAll('[role="menuitem"]');
    for (const item of menuItems) {
      if ((item.textContent || '').trim().includes(text)) return item;
    }

    // 2. 팝오버/드롭다운 내부의 클릭 가능 요소
    const container = findFloatingContainer();
    if (container) {
      const elements = container.querySelectorAll('button, div[role], span[role], a, li, [tabindex]');
      for (const el of elements) {
        const elText = (el.textContent || '').trim();
        if (elText.includes(text) && elText.length < 30) return el;
      }
    }

    // 3. 전체 페이지에서 짧은 텍스트의 클릭 요소
    const allClickable = document.querySelectorAll('button, [role="option"], [role="radio"]');
    for (const el of allClickable) {
      const elText = (el.textContent || '').trim();
      if (elText === text || (elText.includes(text) && elText.length < 20)) return el;
    }

    return null;
  }

  /**
   * 현재 열린 플로팅 컨테이너(팝오버/드롭다운/메뉴) 찾기
   */
  function findFloatingContainer() {
    const selectors = [
      '[role="menu"]',
      '[role="dialog"]:not([class*="settings"])',
      '[role="listbox"]',
      '[data-radix-popper-content-wrapper]',
      '[data-floating-ui-portal]',
      '[class*="popover" i]',
      '[class*="dropdown" i]',
      '[class*="floating" i]',
      '[class*="overlay" i]',
      '[class*="popup" i]'
    ];

    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        // 보이는 요소만
        if (el.offsetParent !== null || el.style.display !== 'none') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 50) {
            console.log(LOG_PREFIX, `Floating container found: ${sel}`);
            return el;
          }
        }
      }
    }

    return null;
  }

  /**
   * 드롭다운 내부의 모든 버튼 수집
   */
  function findDropdownButtons() {
    const buttons = new Set();

    // 1. 특정 컨테이너 내부 버튼
    const container = findFloatingContainer();
    if (container) {
      container.querySelectorAll('button').forEach(b => buttons.add(b));
    }

    // 2. [role="menu"] 내부 버튼
    const menu = document.querySelector('[role="menu"]');
    if (menu) {
      menu.querySelectorAll('button').forEach(b => buttons.add(b));
    }

    // 3. 컨테이너를 못 찾으면 페이지 전체에서 짧은 텍스트 버튼 수집
    if (buttons.size === 0) {
      console.log(LOG_PREFIX, '드롭다운 컨테이너 못 찾음, 페이지 전체 검색');
      document.querySelectorAll('button').forEach(b => {
        const text = (b.textContent || '').trim();
        // 짧은 텍스트 (설정 버튼: "6s", "10s", "480p", "720p", "16:9" 등)
        if (text.length > 0 && text.length <= 10 && b.offsetParent !== null) {
          buttons.add(b);
        }
      });
    }

    return [...buttons];
  }

  /**
   * 버튼 리스트에서 레이블 매칭하여 클릭
   */
  function clickButtonInList(buttons, labels, settingName) {
    // 1차: 정확 매칭 (텍스트)
    for (const label of labels) {
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text && text === label) {
          MangoDom.simulateClick(btn);
          console.log(LOG_PREFIX, `Setting [${settingName}] clicked (exact): "${text}"`);
          return true;
        }
      }
    }

    // 2차: aria-label 매칭 (종횡비 등 아이콘 버튼)
    for (const label of labels) {
      const labelLower = label.toLowerCase();
      for (const btn of buttons) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        if (ariaLabel && (ariaLabel.includes(labelLower) || labelLower.includes(ariaLabel))) {
          MangoDom.simulateClick(btn);
          console.log(LOG_PREFIX, `Setting [${settingName}] clicked (aria-label): "${ariaLabel}" for "${label}"`);
          return true;
        }
      }
    }

    // 3차: 부분 매칭 (짧은 텍스트만, 빈 문자열 무시)
    for (const label of labels) {
      const labelLower = label.toLowerCase();
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (!text || text.length > 15) continue;
        const textLower = text.toLowerCase();
        if (textLower.includes(labelLower) || labelLower.includes(textLower)) {
          MangoDom.simulateClick(btn);
          console.log(LOG_PREFIX, `Setting [${settingName}] clicked (partial): "${text}" for "${label}"`);
          return true;
        }
      }
    }

    console.warn(LOG_PREFIX, `Setting [${settingName}] not found for: ${labels.join(', ')}`);
    return false;
  }

  // ─── Result Page: Prompt + Create Video ───
  async function typeOnResultTextarea(textarea, text) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(textarea, text);
    } else {
      textarea.value = text;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(LOG_PREFIX, 'Result page prompt set');
  }

  async function clickCreateVideo() {
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const btn = findCreateVideoButton();
      if (btn && !btn.disabled) {
        btn.click();
        console.log(LOG_PREFIX, 'Create video clicked');
        await delay(1000);
        return true;
      }
      await delay(300);
    }
    return false;
  }

  // ─── Wait for Video Ready ───
  // 참고자료 방식: video[src]에 UUID가 포함된 URL이 나타날 때까지 대기
  // 3초 간격 폴링, 5분 타임아웃
  async function waitForVideoReady(timeout = 300000) {
    showToast('영상 생성 대기 중...', 'info');
    await delay(5000); // Initial 5 second wait

    const start = Date.now();
    const checkInterval = 3000; // 참고자료: 3초 간격

    while (Date.now() - start < timeout) {
      if (isModerated()) return 'moderated';

      // 참고자료 방식: video[src]에서 실제 URL 감지
      const videoUrl = getVideoUrl();
      if (videoUrl) {
        // 비디오 URL이 있으면 추가로 2초 대기 (로딩 완료 보장)
        showToast(`영상 감지! 로딩 대기 2초...`, 'success');
        await delay(2000);
        return 'ready';
      }

      // 진행 상태 로그 (15초마다)
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 15 === 0 && elapsed > 0) {
        showToast(`영상 생성 대기 중... (${elapsed}초 경과)`, 'info');
      }

      await delay(checkInterval);
    }

    // 타임아웃: 마지막으로 video 요소 확인
    const lastChance = getVideoUrl();
    if (lastChance) {
      showToast('타임아웃 직전 영상 발견!', 'warn');
      return 'ready';
    }

    return 'timeout';
  }

  // ─── 480p → 720p Upscale (... 메뉴 → 동영상 업스케일) ───
  async function tryUpscaleVideo(timeout = 300000) {
    const upscaleKeywords = ['업스케일', 'upscale'];

    // Step 1: ... (점 세 개) 메뉴 버튼 찾기
    // 이미지 위 오버레이 영역에서 마지막 아이콘 버튼 (보통 ...)
    let moreBtn = null;

    // aria-label로 찾기
    const ariaLabels = ['더보기', 'More', 'More options', '옵션'];
    for (const label of ariaLabels) {
      const btn = document.querySelector(`button[aria-label="${label}"]`);
      if (btn) { moreBtn = btn; break; }
    }

    // 못 찾으면 "..." 텍스트 또는 SVG 3-dot 아이콘 버튼 찾기
    if (!moreBtn) {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        // "..." 또는 "⋯" 또는 SVG만 있는 작은 버튼
        if (text === '...' || text === '⋯' || text === '⋮') {
          moreBtn = btn;
          break;
        }
        // SVG 3-dot 패턴: circle 이 3개인 SVG
        const svg = btn.querySelector('svg');
        if (svg && svg.querySelectorAll('circle').length >= 3 && !btn.textContent?.trim()) {
          moreBtn = btn;
          break;
        }
      }
    }

    if (!moreBtn) {
      console.log(LOG_PREFIX, 'More (...) button not found');
      return false;
    }

    // Step 2: 메뉴 열기
    console.log(LOG_PREFIX, 'Opening more menu...');
    MangoDom.simulateClick(moreBtn);
    await delay(800);

    // Step 3: "동영상 업스케일" 메뉴 항목 찾기
    let upscaleItem = null;
    const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], button, div[class*="menu"] span, div[class*="menu"] div');
    for (const el of menuItems) {
      const text = (el.textContent || '').trim().toLowerCase();
      for (const kw of upscaleKeywords) {
        if (text.includes(kw)) {
          // 가장 클릭 가능한 요소 찾기 (자신이 버튼이거나 부모가 버튼)
          upscaleItem = el.closest('button') || el.closest('[role="menuitem"]') || el;
          break;
        }
      }
      if (upscaleItem) break;
    }

    if (!upscaleItem) {
      console.log(LOG_PREFIX, 'Upscale menu item not found, closing menu');
      // 메뉴 닫기
      document.body.click();
      await delay(300);
      return false;
    }

    // Step 4: 업스케일 클릭
    console.log(LOG_PREFIX, 'Clicking upscale menu item...');
    showToast('업스케일 시작...', 'info');
    MangoDom.simulateClick(upscaleItem);
    await delay(3000);

    // Step 5: HD 비디오 대기 (_hd.mp4 또는 새 비디오 URL)
    const start = Date.now();
    const checkInterval = 3000;
    const beforeUrls = new Set();
    document.querySelectorAll('video[src]').forEach(v => {
      if (v.src && v.src.startsWith('http')) beforeUrls.add(v.src);
    });
    // currentSrc도 기록
    document.querySelectorAll('video').forEach(v => {
      if (v.currentSrc && v.currentSrc.startsWith('http')) beforeUrls.add(v.currentSrc);
    });

    while (Date.now() - start < timeout) {
      checkStopped();

      // HD URL 감지
      const hdUrl = getVideoUrl();
      if (hdUrl && hdUrl.includes('_hd')) {
        console.log(LOG_PREFIX, 'Upscaled (HD) video ready:', hdUrl.substring(0, 60));
        showToast('업스케일 완료!', 'success');
        return true;
      }

      // 새 비디오 URL 감지 (HD 태그 없어도 URL이 바뀌면 업스케일된 것)
      const allVideos = document.querySelectorAll('video');
      for (const v of allVideos) {
        const src = v.src || v.currentSrc || '';
        if (src.startsWith('http') && !src.startsWith('blob:') && !beforeUrls.has(src)) {
          console.log(LOG_PREFIX, 'New video detected after upscale:', src.substring(0, 60));
          showToast('업스케일 완료! (새 URL 감지)', 'success');
          return true;
        }
      }

      // 진행 로그 (15초마다)
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (elapsed % 15 === 0 && elapsed > 0) {
        showToast(`업스케일 대기 중... (${elapsed}초)`, 'info');
      }

      await delay(checkInterval);
    }

    console.warn(LOG_PREFIX, 'Upscale timeout after', timeout / 1000, 'seconds');
    showToast('업스케일 타임아웃 - 480p로 진행', 'warn');
    return false;
  }

  // ─── Video URL Extraction ───

  /**
   * 비디오 URL 추출: 여러 방법 시도 + 재시도
   */
  async function extractVideoUrl() {
    // 즉시 시도
    let url = getVideoUrl();
    if (url) return url;

    // 3초 대기 후 재시도
    await delay(3000);
    url = getVideoUrl();
    if (url) return url;

    // 5초 더 대기 후 재시도
    await delay(5000);
    url = getVideoUrl();
    if (url) return url;

    // 최종: UUID 기반 fallback URL 생성 (참고자료 방식)
    const uuid = getCurrentPostUUID();
    if (uuid) {
      const fallbackUrl = `https://imagine-public.x.ai/imagine-public/share-videos/${uuid}.mp4`;
      console.log(LOG_PREFIX, 'Fallback video URL:', fallbackUrl);
      showToast(`Fallback URL 사용: ${uuid}`, 'warn');
      return fallbackUrl;
    }

    return null;
  }

  function getCurrentPostUUID() {
    // URL format: grok.com/imagine/post/{UUID} 또는 grok.com/imagine/{UUID}
    const match = window.location.pathname.match(/\/imagine\/(?:post\/)?([a-f0-9-]+)/);
    return match ? match[1] : null;
  }

  /**
   * 참고자료 방식: video[src]에서 UUID가 포함된 URL 추출
   * HD 버전(_hd.mp4) 우선, 없으면 일반 버전
   */
  function getVideoUrl() {
    const uuid = getCurrentPostUUID();
    let hdUrl = null, normalUrl = null;

    const videos = document.querySelectorAll('video[src]');
    for (const video of videos) {
      const src = video.src;
      if (!src || src.startsWith('blob:') || src.startsWith('data:')) continue;

      // UUID가 URL에 포함되어 있는지 확인 (참고자료 방식)
      if (uuid && !src.includes(uuid)) continue;

      if (src.includes('_hd.mp4')) {
        hdUrl = src;
      } else if (src.includes('.mp4') || src.startsWith('http')) {
        normalUrl = src;
      }
    }

    // video[src]에서 못 찾으면 source 요소도 확인
    if (!hdUrl && !normalUrl) {
      const allVideos = document.querySelectorAll('video');
      for (const video of allVideos) {
        // currentSrc 확인
        if (video.currentSrc && video.currentSrc.startsWith('http') && !video.currentSrc.startsWith('blob:')) {
          if (!uuid || video.currentSrc.includes(uuid)) {
            if (video.currentSrc.includes('_hd.mp4')) hdUrl = video.currentSrc;
            else normalUrl = video.currentSrc;
          }
        }
        // source 자식 요소 확인
        const sources = video.querySelectorAll('source[src]');
        for (const source of sources) {
          if (source.src && source.src.startsWith('http')) {
            if (!uuid || source.src.includes(uuid)) {
              if (source.src.includes('_hd.mp4')) hdUrl = source.src;
              else if (!normalUrl) normalUrl = source.src;
            }
          }
        }
      }
    }

    // UUID 없이도 비디오 요소에서 http URL 추출 시도
    if (!hdUrl && !normalUrl) {
      const allVideos = document.querySelectorAll('video');
      for (const video of allVideos) {
        if (video.src && video.src.startsWith('http') && !video.src.startsWith('blob:')) {
          normalUrl = video.src;
          break;
        }
        if (video.currentSrc && video.currentSrc.startsWith('http') && !video.currentSrc.startsWith('blob:')) {
          normalUrl = video.currentSrc;
          break;
        }
      }
    }

    if (hdUrl || normalUrl) {
      console.log(LOG_PREFIX, 'Video URL found:', (hdUrl || normalUrl).substring(0, 80));
    }

    return hdUrl || normalUrl;
  }

  // ─── Image URL Extraction ───
  async function getGeneratedImageUrl() {
    // Wait for images to load
    await delay(2000);

    // Look for generated images (non-small, non-avatar)
    const images = document.querySelectorAll('img');
    for (const img of images) {
      if (img.alt === 'Moderated') continue;
      if (img.alt === 'pfp') continue;
      if (img.naturalWidth < 200 && img.width < 200) continue;

      const src = img.src;
      if (src && (src.includes('blob:') || src.includes('generated') ||
                  src.includes('imagine') || src.includes('x.ai'))) {
        return src;
      }
    }

    // Fallback: any large image
    for (const img of images) {
      if (img.naturalWidth >= 400 || img.width >= 400) {
        return img.src;
      }
    }

    return null;
  }

  // ─── Moderation Detection ───
  function isModerated() {
    const images = document.querySelectorAll('img[alt="Moderated"]');
    return images.length > 0;
  }

  // ─── Popup Dismissal ───
  // 작업 중에는 비활성화 (결과 페이지의 "Close" 등을 잘못 클릭하여 페이지 이동 방지)
  setInterval(() => {
    if (isProcessing) return;
    ['Dismiss', 'Close', 'Skip', 'No thanks', 'Maybe later'].forEach(text => {
      const btn = MangoDom.findButtonByText(text);
      if (btn) { btn.click(); console.log(LOG_PREFIX, 'Dismissed:', text); }
    });
  }, 8000);

  console.log(LOG_PREFIX, 'Content script loaded (with video settings & improved image attach)');
  showToast('Content script 로드 완료!', 'success');
})();
