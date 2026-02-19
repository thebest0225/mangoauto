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

        // Step 2: 이미지 첨부 (드래그 → 자동으로 결과 페이지로 이동)
        showToast('Step 2: 이미지 첨부 중...', 'info');
        const attached = await attachImage(sourceImageDataUrl);
        if (!attached) throw new Error('이미지 첨부 실패');
        showToast('이미지 첨부 완료!', 'success');

        // Step 3: 결과 페이지로 자동 이동 대기
        showToast('Step 3: 결과 페이지 대기...', 'info');
        await waitForResultPage(timeoutMs);
        await delay(3000);

        // Step 4: 검열 확인
        if (isModerated()) throw new ModerationError();

        // Step 5: 비디오 설정 적용 (재생시간, 해상도, 프리셋)
        showToast('Step 5: 비디오 설정 적용...', 'info');
        await applyVideoSettings(settings);
        await delay(500);

        // Step 6: 결과 페이지 텍스트필드에 비디오 프롬프트 입력
        if (prompt?.trim()) {
          showToast('Step 6: 비디오 프롬프트 입력...', 'info');
          const resultTextarea = findResultPageTextarea();
          if (resultTextarea) {
            await typeOnResultTextarea(resultTextarea, prompt);
            await delay(500);
          } else {
            showToast('결과 페이지 텍스트필드 없음!', 'warn');
          }
        }

        // Step 7: "동영상 만들기" 클릭
        showToast('Step 7: 동영상 만들기 클릭...', 'info');
        const videoCreated = await clickCreateVideo();
        if (!videoCreated) throw new Error('"동영상 만들기" 버튼 클릭 실패');

        // Step 8: 비디오 생성 대기
        const videoResult = await waitForVideoReady(timeoutMs);
        if (videoResult === 'moderated') throw new ModerationError();

        // Step 9: 비디오 URL 추출 + 전송
        showToast('Step 9: 비디오 URL 추출...', 'info');
        const videoUrl = await extractVideoUrl();
        if (!videoUrl) throw new Error('비디오 URL을 찾을 수 없습니다');

        showToast(`비디오 URL: ${videoUrl.substring(0, 60)}`, 'success');
        // 참고자료 방식: URL을 background에 전달 → chrome.downloads.download() 사용
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
        showToast('프롬프트 입력 중...', 'info');
        await typePrompt(prompt || '');
        await delay(800 + Math.random() * 500);

        const submitted = await tryClickSubmit();
        if (!submitted) throw new Error('제출 실패');

        await waitForResultPage(timeoutMs);
        await delay(3000);

        if (isModerated()) throw new ModerationError();

        await applyVideoSettings(settings);
        await delay(500);

        // 결과 페이지에서 비디오 프롬프트 (필요시)
        const resultTextarea = findResultPageTextarea();
        if (resultTextarea && prompt?.trim()) {
          await typeOnResultTextarea(resultTextarea, prompt);
          await delay(500);
        }

        const videoCreated = await clickCreateVideo();
        if (!videoCreated) throw new Error('"동영상 만들기" 버튼 클릭 실패');

        const videoResult = await waitForVideoReady(timeoutMs);
        if (videoResult === 'moderated') throw new ModerationError();

        const videoUrl = await extractVideoUrl();
        if (!videoUrl) throw new Error('비디오 URL을 찾을 수 없습니다');

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
      await delay(2000);
      await goBack();
      await waitForMainPage(15000);

      return { ok: true };
    } catch (err) {
      console.error(LOG_PREFIX, 'Error:', err);
      chrome.runtime.sendMessage({
        type: 'GENERATION_ERROR',
        error: err.message
      });

      // 메인 페이지로 복구 시도
      try {
        if (!isOnMainPage()) {
          await goBack();
          await waitForMainPage(10000);
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Recovery failed:', e.message);
      }

      return { error: err.message };
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

  // Create video button
  function findCreateVideoButton() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.includes('동영상 만들기') || text.includes('Create video') ||
          text.includes('비디오 만들기') || text.includes('Generate video') ||
          text.includes('영상 만들기') || text.includes('Make video')) {
        return btn;
      }
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
    // Just check URL like reference implementation - don't wait for editor
    if (isOnMainPage()) {
      console.log(LOG_PREFIX, 'On /imagine page - ready');
      await delay(500);
      return;
    }
    throw new Error('/imagine 페이지가 아닙니다. https://grok.com/imagine 으로 이동해주세요.');
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
    window.history.back();
    await delay(1000);
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
  // ─── Video Settings (Grok dropdown reopen pattern) ───
  // ═══════════════════════════════════════════════════

  /**
   * Apply video settings via Grok's video options panel.
   * Grok shows a single settings panel with all options (duration, resolution, preset).
   * We open it once, click each desired option, then close.
   */
  async function applyVideoSettings(settings) {
    const grok = settings?.grok || {};
    const { videoDuration, videoResolution, aspectRatio } = grok;

    if (!videoDuration && !videoResolution && !aspectRatio) {
      console.log(LOG_PREFIX, 'No video settings to apply');
      return;
    }

    console.log(LOG_PREFIX, 'Applying video settings:', {
      duration: videoDuration, resolution: videoResolution, aspectRatio
    });

    // 설정 패널 열기
    const opened = await openVideoOptionsDropdown();
    if (!opened) {
      showToast('비디오 설정 패널 열기 실패', 'warn');
      return;
    }
    await delay(500);

    // 패널 내에서 개별 옵션 버튼 클릭
    // Grok의 설정 패널은 라디오 버튼 스타일의 개별 버튼들로 구성
    if (videoDuration) {
      const durationLabels = [`${videoDuration}s`, `${videoDuration}초`, String(videoDuration)];
      await clickOptionInPanel(durationLabels, 'duration');
      await delay(300);
    }

    if (videoResolution) {
      const resLabels = [videoResolution, videoResolution.replace('p', '')];
      await clickOptionInPanel(resLabels, 'resolution');
      await delay(300);
    }

    if (aspectRatio) {
      const arLabels = [aspectRatio, '가로', 'Landscape', 'Wide', '세로', 'Portrait', '정사각', 'Square']
        .filter(l => {
          if (aspectRatio === '16:9') return ['16:9', '가로', 'Landscape', 'Wide'].includes(l);
          if (aspectRatio === '9:16') return ['9:16', '세로', 'Portrait'].includes(l);
          if (aspectRatio === '1:1') return ['1:1', '정사각', 'Square'].includes(l);
          return l === aspectRatio;
        });
      await clickOptionInPanel(arLabels, 'aspect ratio');
      await delay(300);
    }

    // 패널 닫기
    document.body.click();
    await delay(500);
  }

  /**
   * 현재 열린 설정 패널 안에서 옵션 버튼을 찾아 클릭.
   * 다양한 텍스트 형식에 대응 (예: "720p", "720", "16:9", "가로" 등)
   */
  async function clickOptionInPanel(labels, settingName) {
    // 모든 가능한 클릭 요소
    const allClickable = document.querySelectorAll(
      'button, [role="radio"], [role="option"], [role="menuitemradio"], [data-state], ' +
      '[role="tab"], label, [class*="option"], [class*="chip"], [class*="toggle"], ' +
      'div[tabindex], span[tabindex]'
    );

    // 디버그: 패널 내 모든 클릭 가능 요소 텍스트 로그
    const debugTexts = [];
    for (const el of allClickable) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 30 && t.length > 0) {
        debugTexts.push(t);
      }
    }
    console.log(LOG_PREFIX, `[${settingName}] 클릭 가능 요소: [${debugTexts.join(', ')}]`);

    for (const label of labels) {
      const labelLower = label.toLowerCase();
      for (const el of allClickable) {
        const fullText = (el.textContent || '').trim();
        if (!fullText || fullText.length > 30) continue;

        const fullLower = fullText.toLowerCase();
        const directText = getDirectText(el).trim();
        const directLower = directText.toLowerCase();

        // 1. 정확한 매칭
        if (fullLower === labelLower || directLower === labelLower) {
          MangoDom.simulateClick(el);
          console.log(LOG_PREFIX, `Set ${settingName}: "${label}" (exact: "${fullText}")`);
          return true;
        }

        // 2. 짧은 텍스트에서 포함 매칭 (부모 컨테이너 제외, 최대 20자)
        if (fullText.length <= 20) {
          if (fullLower.includes(labelLower) || labelLower.includes(fullLower)) {
            MangoDom.simulateClick(el);
            console.log(LOG_PREFIX, `Set ${settingName}: "${label}" (partial: "${fullText}")`);
            return true;
          }
        }
      }
    }

    // 3. aria-label 기반 매칭
    for (const label of labels) {
      const labelLower = label.toLowerCase();
      for (const el of allClickable) {
        const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
        if (ariaLabel && (ariaLabel.includes(labelLower) || labelLower.includes(ariaLabel))) {
          MangoDom.simulateClick(el);
          console.log(LOG_PREFIX, `Set ${settingName}: "${label}" (aria: "${ariaLabel}")`);
          return true;
        }
      }
    }

    showToast(`${settingName} 옵션 못찾음: ${labels.join(', ')}`, 'warn');
    console.warn(LOG_PREFIX, `${settingName} option not found: ${labels.join(', ')}`);
    return false;
  }

  /**
   * 요소의 직접 텍스트 노드만 반환 (자식 요소 텍스트 제외)
   */
  function getDirectText(el) {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent;
      }
    }
    return text;
  }

  /**
   * Find and click the video options dropdown trigger button.
   * Grok result page has icon buttons above the image (duration, resolution, etc.)
   */
  async function openVideoOptionsDropdown() {
    // Strategy 1: aria-label based
    const ariaSelectors = [
      'button[aria-label*="비디오" i]',
      'button[aria-label*="video" i]',
      'button[aria-label*="옵션" i]',
      'button[aria-label*="option" i]',
      'button[aria-label*="설정" i]',
      'button[aria-label*="customize" i]',
      'button[aria-label*="tune" i]',
    ];
    for (const sel of ariaSelectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.offsetParent !== null) {
        console.log(LOG_PREFIX, 'Video options via aria:', sel);
        MangoDom.simulateClick(btn);
        await delay(600);
        return true;
      }
    }

    // Strategy 2: "..." or more button (near result area, not top nav)
    const allButtons = document.querySelectorAll('button');
    for (const btn of allButtons) {
      const text = (btn.textContent || '').trim();
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (text === '...' || text === '···' || text === '\u22EE' || text === '\u22EF' ||
          text === 'more_vert' || text === 'more_horiz' ||
          label.includes('more') || label.includes('더보기')) {
        const rect = btn.getBoundingClientRect();
        if (rect.top > 100) {
          console.log(LOG_PREFIX, 'Video options via more button');
          MangoDom.simulateClick(btn);
          await delay(600);
          return true;
        }
      }
    }

    // Strategy 3: Button showing current resolution/duration (e.g., "720", "720p", "10초")
    for (const btn of allButtons) {
      const text = (btn.textContent || '').trim();
      if (/^\d{3,4}p?$/.test(text) || /^\d+초$/.test(text) || /^\d+s$/.test(text)) {
        console.log(LOG_PREFIX, 'Video options via display button:', text);
        MangoDom.simulateClick(btn);
        await delay(600);
        return true;
      }
    }

    // Strategy 4: Icon buttons near a generated image
    const resultImgs = document.querySelectorAll('img');
    let resultImg = null;
    for (const img of resultImgs) {
      if (img.naturalWidth >= 300 && img.alt !== 'pfp') {
        resultImg = img;
        break;
      }
    }
    if (resultImg) {
      const imgRect = resultImg.getBoundingClientRect();
      for (const btn of allButtons) {
        if (!btn.querySelector('svg')) continue;
        const btnRect = btn.getBoundingClientRect();
        // Button should be above or overlapping the image top area
        if (btnRect.bottom >= imgRect.top - 60 && btnRect.top <= imgRect.top + 60) {
          const submitBtn = findSubmitButton();
          const createBtn = findCreateVideoButton();
          if (btn !== submitBtn && btn !== createBtn) {
            console.log(LOG_PREFIX, 'Video options via nearby icon button');
            MangoDom.simulateClick(btn);
            await delay(600);
            return true;
          }
        }
      }
    }

    console.warn(LOG_PREFIX, 'Could not find video options trigger');
    return false;
  }

  /**
   * Select an option from the currently open dropdown/popover/menu.
   * Searches through all visible popup elements for matching text.
   */
  async function selectDropdownOption(labels, settingName) {
    // Collect all clickable elements from visible popovers and overlays
    const popoverSelectors = [
      '[role="menu"]', '[role="listbox"]', '[role="dialog"]:not([class*="settings"])',
      '[class*="popover"]', '[class*="dropdown"]', '[class*="menu"]',
      '[class*="overlay"]', '[class*="popup"]', '[class*="panel"]'
    ];

    const candidates = new Set();

    // Items from popovers
    for (const sel of popoverSelectors) {
      for (const container of document.querySelectorAll(sel)) {
        if (container.offsetParent === null && !container.style.display) continue;
        container.querySelectorAll('button, div, span, li, a, [role="menuitem"], [role="option"], [role="menuitemradio"]')
          .forEach(el => candidates.add(el));
      }
    }

    // Also try generic role-based items anywhere
    document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], [role="radio"]')
      .forEach(el => candidates.add(el));

    for (const label of labels) {
      for (const el of candidates) {
        const elText = (el.textContent || '').trim();
        if (!elText || elText.length > 50) continue;

        const isMatch = elText === label ||
          elText.includes(label) ||
          (label.length >= 2 && elText.toLowerCase().includes(label.toLowerCase()));

        if (isMatch) {
          if (isElementSelected(el)) {
            console.log(LOG_PREFIX, `${settingName} already set: ${label}`);
            // 드롭다운 닫기
            document.body.click();
            await delay(300);
            return true;
          }
          MangoDom.simulateClick(el);
          console.log(LOG_PREFIX, `Set ${settingName}: "${label}" (element: "${elText}")`);
          await delay(500);
          // 드롭다운이 자동으로 안 닫힐 수 있으니 명시적으로 닫기
          document.body.click();
          await delay(300);
          return true;
        }
      }
    }

    console.warn(LOG_PREFIX, `${settingName} option not found: ${labels.join(', ')}`);
    // Close dropdown by clicking body
    document.body.click();
    await delay(300);
    return false;
  }

  function isElementSelected(el) {
    if (el.classList.contains('active') || el.classList.contains('selected') || el.classList.contains('checked')) return true;
    if (el.getAttribute('aria-checked') === 'true') return true;
    if (el.getAttribute('aria-selected') === 'true') return true;
    if (el.getAttribute('aria-pressed') === 'true') return true;
    if (el.getAttribute('data-state') === 'active') return true;
    for (const cls of el.classList) {
      const lc = cls.toLowerCase();
      if (lc.includes('active') || lc.includes('selected') || lc.includes('current') || lc.includes('checked')) return true;
    }
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

  // ─── 480p Upscale ───
  async function tryUpscaleVideo(timeout = 300000) {
    // Look for Upscale / 업스케일 / HD button after video is ready
    const upscaleTexts = ['업스케일', 'Upscale', 'HD', 'Enhance', '고화질'];
    let upscaleBtn = null;

    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      for (const t of upscaleTexts) {
        if (text.includes(t)) {
          upscaleBtn = btn;
          break;
        }
      }
      if (upscaleBtn) break;
    }

    if (!upscaleBtn) {
      // Also check aria-labels
      for (const t of upscaleTexts) {
        const btn = document.querySelector(`button[aria-label*="${t}" i]`);
        if (btn && !btn.disabled) {
          upscaleBtn = btn;
          break;
        }
      }
    }

    if (!upscaleBtn || upscaleBtn.disabled) {
      console.log(LOG_PREFIX, 'Upscale button not found or disabled');
      return false;
    }

    console.log(LOG_PREFIX, 'Clicking upscale button...');
    MangoDom.simulateClick(upscaleBtn);
    await delay(3000);

    // Wait for upscaled video to appear (look for _hd.mp4 or new video src)
    const start = Date.now();
    const checkInterval = 3000;
    const beforeUrls = new Set();
    document.querySelectorAll('video[src]').forEach(v => beforeUrls.add(v.src));

    while (Date.now() - start < timeout) {
      // Check for HD video URL
      const hdUrl = getVideoUrl();
      if (hdUrl && hdUrl.includes('_hd')) {
        console.log(LOG_PREFIX, 'Upscaled video ready:', hdUrl.substring(0, 60));
        return true;
      }

      // Check for any new video URL that wasn't there before
      const videos = document.querySelectorAll('video[src]');
      for (const v of videos) {
        if (v.src && !beforeUrls.has(v.src)) {
          console.log(LOG_PREFIX, 'New video detected after upscale');
          return true;
        }
      }

      // Check if upscale button changed (e.g., became disabled or text changed)
      if (upscaleBtn.disabled || !(upscaleBtn.textContent || '').trim()) {
        await delay(5000);
        return true;
      }

      await delay(checkInterval);
    }

    console.warn(LOG_PREFIX, 'Upscale timeout');
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
  setInterval(() => {
    ['Dismiss', 'Close', 'Skip', 'No thanks', 'Maybe later'].forEach(text => {
      const btn = MangoDom.findButtonByText(text);
      if (btn) { btn.click(); console.log(LOG_PREFIX, 'Dismissed:', text); }
    });
  }, 8000);

  console.log(LOG_PREFIX, 'Content script loaded (with video settings & improved image attach)');
  showToast('Content script 로드 완료!', 'success');
})();
