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
  // 🔒 인스턴스 토큰 시스템 — 항상 "최신 로드된 인스턴스만 활성".
  // 이전 시스템 (__MANGOAUTO_GROK_LOADED__ 가드) 의 한계:
  //   - 익스텐션 reload 시 isolated world 가 일시 초기화되거나
  //   - executeScript 가 다른 컨텍스트로 주입될 때 가드가 무력화
  //   → 결과: 여러 인스턴스가 동시 활성 → EXECUTE_PROMPT 를 모두 받아
  //     attach/submit 중복 실행 → 영상 2~3개 생성, 생성중 재전송 시도.
  // 새 시스템:
  //   - 인스턴스마다 고유 토큰 생성, window 에 항상 덮어쓰기 (newest wins)
  //   - 모든 message/timer/handler 가 isActive() 체크 — 본인 아니면 즉시 return
  //   - 이전 인스턴스는 자연스럽게 silent 화됨 (변수/closure 살아있어도 작업 X)
  const INSTANCE_KEY = '__MANGOAUTO_GROK_ACTIVE_INSTANCE_ID__';
  const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  window[INSTANCE_KEY] = INSTANCE_ID;  // 항상 덮어쓰기 — 가장 최근이 활성
  function isActiveInstance() { return window[INSTANCE_KEY] === INSTANCE_ID; }

  console.log('[MangoAuto:Grok] 인스턴스 토큰:', INSTANCE_ID, '(active=', isActiveInstance(), ')');

  const LOG_PREFIX = '[MangoAuto:Grok]';
  let isProcessing = false;
  let shouldStop = false;
  let videoSettingsApplied = false; // 비디오 설정 메인 페이지 적용 여부

  // ─── Navigation Debug: 근본 원인 추적 ───
  // URL 변경 감지 (500ms 폴링) — 비활성 인스턴스는 polling skip
  let _lastUrl = window.location.href;
  setInterval(() => {
    if (!isActiveInstance()) return;  // 새 인스턴스에 자리 넘김 — silent
    const now = window.location.href;
    if (now !== _lastUrl) {
      console.error(LOG_PREFIX, `🚨 URL CHANGED: ${_lastUrl} → ${now}`);
      console.error(LOG_PREFIX, `🚨 URL변경 스택:`, new Error().stack);
      showToast(`🚨 URL변경: ${now.substring(0, 50)}`, 'error');
      _lastUrl = now;
    }
  }, 500);

  // 모든 클릭 이벤트 캡처 (작업 중) — 비활성 인스턴스는 logging skip
  document.addEventListener('click', (e) => {
    if (!isActiveInstance()) return;
    if (!isProcessing) return;
    const el = e.target;
    const tag = el.tagName;
    const text = (el.textContent || '').trim().substring(0, 40);
    const href = el.href || el.closest('a')?.href || '';
    const ariaLabel = el.getAttribute?.('aria-label') || '';
    const isTrusted = e.isTrusted; // true=사용자 클릭, false=코드 클릭

    console.warn(LOG_PREFIX, `🖱️ CLICK [${isTrusted ? 'USER' : 'CODE'}]:`, {
      tag, text, href, ariaLabel,
      isLink: !!el.closest('a'),
      path: e.composedPath().slice(0, 4).map(n =>
        `${n.tagName || 'text'}.${(n.className || '').substring?.(0, 20) || ''}`
      ).join(' > ')
    });

    // 스택 트레이스 (코드 클릭이면 어디서 호출했는지 추적)
    if (!isTrusted) {
      console.warn(LOG_PREFIX, `🖱️ CODE CLICK 스택:`, new Error().stack);
    }

    if (href && !href.includes('grok.com/imagine')) {
      console.error(LOG_PREFIX, `🚨🚨🚨 외부 네비게이션 클릭! href=${href}`);
      showToast(`🚨 외부 클릭: ${text.substring(0, 20)}`, 'error');
    }
  }, true);

  // history.pushState / replaceState 감시 (차단 아닌 로그만)
  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;
  history.pushState = function(...args) {
    console.warn(LOG_PREFIX, `🚨 pushState:`, args[2]);
    console.warn(LOG_PREFIX, `🚨 pushState 스택:`, new Error().stack);
    if (isProcessing) showToast(`🚨 pushState: ${args[2]}`, 'error');
    return _origPushState.apply(this, args);
  };
  history.replaceState = function(...args) {
    console.warn(LOG_PREFIX, `🚨 replaceState:`, args[2]);
    if (isProcessing) {
      console.warn(LOG_PREFIX, `🚨 replaceState 스택:`, new Error().stack);
      showToast(`🚨 replaceState: ${String(args[2]).substring(0, 40)}`, 'error');
    }
    return _origReplaceState.apply(this, args);
  };
  window.addEventListener('popstate', () => {
    console.warn(LOG_PREFIX, `🚨 popstate → ${window.location.href}`);
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
    // 🔒 비활성 인스턴스는 어떤 메시지도 처리하지 않음. 새 인스턴스가 모두 받음.
    //    (Chrome 은 모든 등록된 listener 에게 메시지를 broadcast — 따라서 우리가
    //     listener 단위로 활성 체크 안 하면 여러 인스턴스가 동시 실행됨.)
    if (!isActiveInstance()) {
      console.log(LOG_PREFIX, `[inactive ${INSTANCE_ID.slice(-6)}] 메시지 무시: ${msg.type}`);
      return false;
    }
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
      // 🔑 background/background.js 의 EXPECTED_VERSION 과 일치해야 함
      // 일치하지 않으면 background 가 content_script 를 강제 재주입하여
      // 같은 탭에 두 인스턴스가 동시에 EXECUTE_PROMPT 를 처리해서
      // "409 Conflict" + "전송 실패" 연쇄 버그가 재발함.
      sendResponse({ ok: true, site: 'grok', version: 'dbg-2026-05-28c' });
      return false;
    }
  });

  async function handleExecutePrompt(msg) {
    if (isProcessing) {
      // 🔑 새 작업이 오면 이전 작업(zombie)을 먼저 **중단 신호** 로 끊는다.
      //    예전엔 isProcessing 만 강제 리셋해서 이전 run 의 대기 루프가 계속 돌며
      //    같은 페이지에서 재전송/충돌을 일으켰음 (2번째 항목부터 영상 여러개 생성 버그).
      showToast('이전 작업 중단 신호 → 정리 대기...', 'warn');
      shouldStop = true;  // 이전 run 의 waitForVideoReady/대기 루프가 이걸 보고 빠져나감
      // 이전 작업이 실제로 끝나기를 최대 10초 대기
      for (let i = 0; i < 20; i++) {
        await delay(500);
        if (!isProcessing) break;
      }
      if (isProcessing) {
        // 그래도 안 끝나면 강제 리셋 (stuck)
        showToast('이전 작업 강제 리셋', 'warn');
        isProcessing = false;
      }
      await delay(300);
    }
    isProcessing = true;
    shouldStop = false; // 새 작업 시작 시 중지 플래그 리셋 (위 중단 신호 해제)
    showToast('handleExecutePrompt 시작', 'info');

    try {
      const { prompt, mediaType, sourceImageDataUrl, settings } = msg;
      const mode = settings?._mode || 'text-image';
      const timeoutMs = (settings?.grok?.timeout || 5) * 60000;
      window.__mangoauto_currentSettings = settings;  // 다른 함수에서 해상도 등 참조용

      showToast(`Mode: ${mode} | HasImage: ${!!sourceImageDataUrl} | Prompt: ${(prompt || '').substring(0, 30)}`, 'info');

      // ══════════════════════════════════════════════════
      // 프레임→영상 (image-to-video) 워크플로우 (새 UI)
      // 1. 메인 페이지에서 이미지 첨부 → 결과 페이지 자동 이동
      // 2. 결과 페이지 설정 패널에서 "동영상 만들기" 모드 전환
      // 3. 프롬프트 입력 + 전송 → 영상 생성
      // ══════════════════════════════════════════════════
      if (mode === 'image-video' && sourceImageDataUrl) {
        showToast('=== 프레임→영상 모드 시작 ===', 'info');

        // Step 1: 메인 페이지 확인 + 도달 검증 (결과 페이지 잔여 상태로 새 영상 2개 생성 방지)
        showToast('Step 1: 메인 페이지 확인...', 'info');
        await ensureMainPage();
        // 메인 페이지 도달 확실히 검증 — 안 됐으면 1회 더 시도
        if (!isOnMainPage()) {
          console.warn(LOG_PREFIX, 'Step 1 후에도 메인 페이지 아님 — 1회 재시도');
          await delay(1500);
          await ensureMainPage();
          if (!isOnMainPage()) {
            throw new Error('메인 페이지 이동 실패 — 다음 큐 진행');
          }
        }
        // 메인 페이지 UI 안정화 대기 (editor + file input 로드 시간)
        await delay(1200);
        checkStopped();

        // Step 2: 비디오 모드 전환 + 설정 (새 UI: 하단 바에서 직접, 구 UI: 패널)
        // 새 UI에서는 비디오 모드를 먼저 선택해야 이미지가 프레임으로 처리됨
        showToast('Step 2: 비디오 모드 전환 + 설정...', 'info');
        const switched = await switchToVideoMode(settings);
        if (!switched) throw new Error('비디오 모드 전환 실패');
        checkStopped();

        // Step 3: 이미지 먼저 첨부 (프롬프트보다 먼저 — 단일 업로드 + 업로드 완료 보장)
        // ⚠️ 핵심: 이미지가 1장만 올라가면 @참조 없이 자동으로 시작 프레임 처리됨.
        //    여러 장이면 @ 로 선택해야 전송 활성화 → 그래서 단일 업로드가 관건.
        showToast('Step 3: 이미지 첨부 중...', 'info');
        const attached = await attachImage(sourceImageDataUrl);
        if (!attached) throw new Error('이미지 첨부 실패');
        // 업로드 완료 대기 (로딩 스피너 사라질 때까지) — 미완료 시 전송 비활성
        await waitForImageUploadComplete(20000);
        // 중복 정리 — 2장 이상이면 1장만 남김 (dedupe 는 attachImage 내부에서도 1회 실행됨)
        const imgCount = countAttachedImages();
        showToast(`이미지 첨부 완료! (${imgCount}장)`, 'success');
        checkStopped();

        // Step 4: 프롬프트 입력 — 이미지가 여러 장이면 먼저 @참조 로 1장 선택
        if (imgCount > 1) {
          showToast('Step 4: 이미지 여러 장 — @참조로 선택...', 'info');
          await insertImageReference();
          await delay(400);
        }
        if (prompt?.trim()) {
          showToast('Step 4: 비디오 프롬프트 입력...', 'info');
          // @참조 칩이 이미 있으면 그 뒤에 프롬프트 append (전체 selectAll+delete 하면 칩도 지워짐)
          await typePromptAppend(prompt, imgCount > 1);
          await delay(500);
        }
        checkStopped();

        // Step 5: 전송 (이미지 첨부로 자동 전송됐으면 건너뛰기)
        if (!isOnMainPage()) {
          showToast('Step 5: 이미지 첨부로 자동 전송됨', 'info');
          window.__mangoauto_lastGrokSubmitMs = Date.now();  // 자동 전송도 lockout 마킹
        } else if (isVideoStillGenerating()) {
          // 이전 영상 진행 중이면 절대 전송 X — 그록이 '기존+새' 2개 모드로 인식
          console.warn(LOG_PREFIX, '⚠️ 메인 페이지지만 이전 영상 진행 중 감지 — 전송 skip, 결과 대기로 진행');
          showToast('이전 영상 진행 중 — 전송 skip', 'warn');
          window.__mangoauto_lastGrokSubmitMs = Date.now();
        } else {
          showToast('Step 5: 전송...', 'info');
          const submitted = await tryClickSubmit();
          if (!submitted) throw new Error('전송 실패');
        }
        checkStopped();

        // Step 6: 결과 페이지 대기
        showToast('Step 6: 결과 페이지 대기...', 'info');
        await waitForResultPage(timeoutMs);
        await delay(2000);
        checkStopped();

        // Step 7: 검열 확인
        if (isModerated()) throw new ModerationError();

        // Step 8: 비디오 생성 대기
        const videoResult = await waitForVideoReady(timeoutMs);
        if (videoResult === 'moderated') throw new ModerationError();

        // Step 8.5: 2개 영상 생성 시 선택 처리
        await handleDualVideoSelection();

        // Step 9: 비디오 URL 추출
        showToast('Step 9: 비디오 URL 추출...', 'info');
        let videoUrl = await extractVideoUrl();
        if (!videoUrl) throw new Error('비디오 URL을 찾을 수 없습니다');

        // Step 10: 업스케일 시도
        if (settings?.grok?.autoUpscale !== false && videoUrl && !videoUrl.includes('_hd')) {
          showToast('Step 10: 업스케일 시도...', 'info');
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
      // 메인 페이지에서 비디오 모드+설정 적용 → 프롬프트 → 제출 → 바로 영상 생성
      // ══════════════════════════════════════════════════
      } else if (mediaType === 'video') {
        showToast('=== 텍스트→영상 모드 시작 ===', 'info');

        await ensureMainPage();
        checkStopped();

        // Step 1: 메인 페이지에서 비디오 모드 + 설정 적용
        showToast('Step 1: 비디오 설정 적용 (메인)...', 'info');
        await applySettingsOnMainPage(settings);
        await delay(500);
        checkStopped();

        // Step 2: 프롬프트 입력 + 제출 → 바로 영상 생성
        showToast('Step 2: 프롬프트 입력...', 'info');
        await typePrompt(prompt || '');
        await delay(800 + Math.random() * 500);

        const submitted = await tryClickSubmit();
        if (!submitted) throw new Error('제출 실패');

        await waitForResultPage(timeoutMs);
        await delay(3000);
        checkStopped();

        if (isModerated()) throw new ModerationError();

        // Step 3: 영상 생성 대기 (비디오 모드로 제출했으므로 바로 영상)
        const videoResult = await waitForVideoReady(timeoutMs);
        if (videoResult === 'moderated') throw new ModerationError();

        // 2개 영상 생성 시 선택 처리
        await handleDualVideoSelection();

        let videoUrl = await extractVideoUrl();
        if (!videoUrl) throw new Error('비디오 URL을 찾을 수 없습니다');

        // Step 4: 업스케일
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
  // 🔑 /imagine 페이지가 리뉴얼되어 <textarea> 로 바뀐 UI 대응 — textarea 도 findEditor()에
  // 매칭되도록 placeholder/aria-label 휴리스틱을 후순위에 둠. TipTap 은 여전히 다른 페이지에서 사용.
  const EDITOR_SELECTORS = [
    '.tiptap.ProseMirror',
    '.ProseMirror',
    '[contenteditable="true"].tiptap',
    '[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ];

  function findEditor() {
    // 1. TipTap / ProseMirror / contenteditable 기반 (구 UI)
    for (const sel of EDITOR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // 2. 리뉴얼된 /imagine 페이지 <textarea> 대응
    const textareas = Array.from(document.querySelectorAll('textarea'));
    // 2a. placeholder/aria-label 힌트 매칭
    const hints = ['상상', '텍스트를 입력', '프롬프트', 'imagine', 'prompt', 'describe', 'type'];
    for (const ta of textareas) {
      const ph = (ta.getAttribute('placeholder') || '').toLowerCase();
      const aria = (ta.getAttribute('aria-label') || '').toLowerCase();
      if (hints.some(h => ph.includes(h) || aria.includes(h))) {
        return ta;
      }
    }
    // 2b. 첫 번째 visible textarea
    for (const ta of textareas) {
      if (ta.offsetParent !== null && !ta.disabled && !ta.readOnly) return ta;
    }
    return null;
  }

  // Find the drop-zone container (form or wrapper div surrounding editor) for file drop.
  // 리뉴얼된 UI 의 드롭 존은 textarea 주변 wrapper에 있음 — 여러 조상을 후보로 반환.
  function findDropTargets() {
    const targets = new Set();
    const editor = findEditor();
    if (editor) {
      targets.add(editor);
      // 상위로 최대 8레벨까지 form / role="form" / data-slot 계열 wrapper 후보 포함
      let cur = editor.parentElement;
      for (let i = 0; i < 8 && cur; i++) {
        const tag = cur.tagName;
        if (tag === 'FORM' || cur.getAttribute('role') === 'form') {
          targets.add(cur);
          break;
        }
        // drop zone 힌트 (class 에 drop/upload/compose/form 포함)
        const cls = (cur.className || '').toString().toLowerCase();
        if (/\b(drop|upload|compose|form|input)\b/.test(cls)) {
          targets.add(cur);
        }
        cur = cur.parentElement;
      }
    }
    // 보편적 후보
    document.querySelectorAll('form').forEach(f => targets.add(f));
    ['.tiptap', '[contenteditable="true"]', 'main', 'body'].forEach(sel => {
      const el = document.querySelector(sel);
      if (el) targets.add(el);
    });
    return Array.from(targets);
  }

  // 전송 버튼 INCLUDE 키워드 — 이게 라벨에 있으면 EXCLUDE 무시 (오제외 방지).
  const _SUBMIT_INCLUDE_KEYWORDS = [
    // KO
    '제출','전송','보내기','동영상 만들기','동영상만들기','생성',
    // EN
    'submit','send','generate','create video','create',
    // TH
    'ส่ง','สร้าง','สร้างวิดีโอ',
    // VI
    'gửi','tạo','tạo video',
  ];

  // EXCLUDE — 비영어는 substring(글자 자체가 unique), 영어는 word boundary(playback/background 오매치 방지).
  const _SUBMIT_EXCLUDE_NON_EN = [
    // KO
    '저장','북마크','공유','모델','설정','복사','다운로드','좋아요','편집','삭제','닫기','취소',
    '메뉴','더보기','업스케일','프로필','계정','뒤로','재생','일시정지','음소거','볼륨','전체화면','해제',
    // TH
    'บันทึก','แชร์','ใช้ร่วมกัน','โมเดล','การตั้งค่า','คัดลอก','ดาวน์โหลด','ถูกใจ','แก้ไข','ลบ','ปิด',
    'ยกเลิก','เมนู','เพิ่มเติม','โปรไฟล์','บัญชี','ย้อนกลับ','กลับ','เล่น','หยุดชั่วคราว','ปิดเสียง','ระดับเสียง','เต็มจอ',
    // VI
    'lưu','đã lưu','chia sẻ','mô hình','cài đặt','sao chép','tải xuống','tải về','thích','chỉnh sửa','xoá','xóa','đóng',
    'hủy','huỷ','xem thêm','hồ sơ','tài khoản','quay lại','phát','tạm dừng','tắt tiếng','âm lượng','toàn màn hình',
  ];
  const _SUBMIT_EXCLUDE_EN_WORDS = [
    'saved','save','bookmark','share','shared','model','setting','settings','copy','download','like','liked',
    'edit','delete','close','cancel','menu','options','upscale','profile','account','back','play','pause',
    'mute','unmute','volume','sound','fullscreen','full screen',
  ];
  const _SUBMIT_EXCLUDE_NON_EN_RE = new RegExp(
    _SUBMIT_EXCLUDE_NON_EN.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'i'
  );
  const _SUBMIT_EXCLUDE_EN_RE = new RegExp(
    '\\b(' + _SUBMIT_EXCLUDE_EN_WORDS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
    'i'
  );

  function _isExcludedSubmitBtn(btn) {
    const al = (btn.getAttribute('aria-label') || '').trim();
    const txt = (btn.textContent || '').trim();
    const alL = al.toLowerCase();
    const txtL = txt.toLowerCase();
    // 1) INCLUDE 우선 — 명확한 전송 라벨이면 절대 제외 안 함
    for (const k of _SUBMIT_INCLUDE_KEYWORDS) {
      const kl = k.toLowerCase();
      if (alL === kl || alL.startsWith(kl) || txtL === kl || txtL.startsWith(kl)) return false;
    }
    // 2) EXCLUDE — 비영어는 substring, 영어는 word boundary
    if (_SUBMIT_EXCLUDE_NON_EN_RE.test(al) || _SUBMIT_EXCLUDE_NON_EN_RE.test(txt)) return true;
    if (_SUBMIT_EXCLUDE_EN_RE.test(al) || _SUBMIT_EXCLUDE_EN_RE.test(txt)) return true;
    return false;
  }

  // Submit button: 그록 리뉴얼 UI 의 ↑ 화살표 버튼 대응 (2026-05). 다국어(KO/EN/TH/VI) 지원.
  function findSubmitButton() {
    // 1. aria-label 기반 (정확 일치). 제외 라벨은 스킵.
    const exactLabels = [
      // KO
      '제출', '전송', '동영상 만들기', '생성', '보내기',
      // EN
      'Submit', 'Send', 'Create video', 'Generate',
      // TH
      'ส่ง', 'สร้างวิดีโอ', 'สร้าง',
      // VI
      'Gửi', 'Tạo video', 'Tạo',
    ];
    for (const label of exactLabels) {
      const btn = document.querySelector(`button[aria-label="${label}"]`);
      if (btn && !btn.disabled && !_isExcludedSubmitBtn(btn)) return btn;
    }
    // 부분일치 aria-label
    const allBtns0 = Array.from(document.querySelectorAll('button'));
    const partials = ['submit','send','generate','create video',
                      '보내','전송','제출','생성',
                      'ส่ง','สร้าง',
                      'gửi','tạo'];
    for (const b of allBtns0) {
      if (b.disabled || _isExcludedSubmitBtn(b)) continue;
      const al = (b.getAttribute('aria-label') || '').toLowerCase();
      if (partials.some(k => al.includes(k))) return b;
    }

    // 2. type="submit"
    const typeSubmit = document.querySelector('button[type="submit"]:not([disabled])');
    if (typeSubmit && !_isExcludedSubmitBtn(typeSubmit)) return typeSubmit;

    // 3. 텍스트 기반
    const submitTexts = ['제출', 'Submit', '전송', 'Send'];
    for (const b of allBtns0) {
      if (b.disabled || _isExcludedSubmitBtn(b)) continue;
      const text = (b.textContent || '').trim();
      if (submitTexts.includes(text)) return b;
    }

    // 4. ↑ 화살표 SVG 아이콘 버튼 — 에디터와 같은 입력 바 안 + 위치 기반 선택.
    //    "저장됨" 같은 엉뚱한 버튼 오클릭 방지: editor 와 같은 행(수평) + editor 오른쪽에 있는 것만.
    const editor = findEditor();
    if (editor) {
      const edRect = editor.getBoundingClientRect();
      const scopes = [];
      const form = editor.closest && editor.closest('form');
      if (form) scopes.push(form);
      let container = editor;
      for (let i = 0; i < 6; i++) { container = container?.parentElement; if (container) scopes.push(container); }

      // 후보 수집 (제외 라벨 제거, 아이콘만 있는 버튼)
      const seen = new Set();
      const candidates = [];
      for (const scope of scopes) {
        for (const b of scope.querySelectorAll('button')) {
          if (seen.has(b) || b.disabled || _isExcludedSubmitBtn(b)) continue;
          seen.add(b);
          const noText = (b.textContent || '').trim().length === 0;
          if (!noText || !b.querySelector('svg')) continue;
          const r = b.getBoundingClientRect();
          if (r.width < 8 || r.width > 72) continue;
          const squareish = Math.abs(r.width - r.height) < 18;
          if (!squareish) continue;
          // editor 의 입력 바 영역 안 (수직으로 editor 와 겹치거나 바로 아래) + editor 오른쪽
          const sameRow = r.top < edRect.bottom + 80 && r.bottom > edRect.top - 20;
          const toRight = r.left >= edRect.left;  // editor 왼쪽 끝보다 오른쪽
          if (sameRow && toRight) {
            candidates.push({ b, r });
          }
        }
      }
      if (candidates.length) {
        // 가장 오른쪽(전송 버튼은 입력바 맨 우측) 선택
        candidates.sort((a, c) => c.r.right - a.r.right);
        const best = candidates[0].b;
        console.log(LOG_PREFIX, `전송 버튼 (위치기반 ↑, ${Math.round(candidates[0].r.width)}x${Math.round(candidates[0].r.height)}, aria="${best.getAttribute('aria-label') || ''}")`);
        return best;
      }
    }

    return null;
  }

  // ─── Enter 키 전송 fallback — 버튼 못 찾을 때 에디터에 Enter 발사 ───
  async function trySubmitByEnter() {
    const editor = findEditor();
    if (!editor) return false;
    editor.focus();
    await delay(150);
    const fire = (mod = {}) => {
      const opts = { bubbles: true, cancelable: true, composed: true,
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ...mod };
      editor.dispatchEvent(new KeyboardEvent('keydown', opts));
      editor.dispatchEvent(new KeyboardEvent('keypress', opts));
      editor.dispatchEvent(new KeyboardEvent('keyup', opts));
    };
    fire();                       // plain Enter
    await delay(250);
    fire({ ctrlKey: true });      // Ctrl+Enter (일부 UI)
    await delay(150);
    fire({ metaKey: true });      // Cmd+Enter (mac UI)
    return true;
  }

  // File input for image attachment (may be hidden). 리뉴얼 UI 대응 — 이미지 accept 포함 우선.
  function findFileInput() {
    // 1. accept 에 image/ 포함된 input 우선
    const all = Array.from(document.querySelectorAll('input[type="file"]'));
    const imgInput = all.find(i => (i.accept || '').toLowerCase().includes('image'));
    if (imgInput) return imgInput;
    // 2. name/id 에 image/upload/photo 힌트
    const hinted = all.find(i => {
      const s = ((i.name || '') + ' ' + (i.id || '') + ' ' + (i.className || '')).toLowerCase();
      return /image|upload|photo|attach|file/.test(s);
    });
    if (hinted) return hinted;
    // 3. 최후의 보편 input (숨김 포함)
    return all[0] || null;
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

  // ─── 결과 페이지: 비디오 모드 전환 + 설정 적용 (새 UI 워크플로우) ───
  // applySettingsOnMainPage()와 동일한 인프라 재사용:
  //   findButtonByTextInArea, findDropdownItem, findDropdownButtons,
  //   clickButtonInList, closeSettingsPanel
  // 워크플로우: 모달열기 → 동영상 만들기 선택 → 설정 적용 → 닫기
  async function switchToVideoMode(settings) {
    const grok = settings?.grok || {};
    const { videoDuration, videoResolution, aspectRatio } = grok;

    showToast('비디오 모드 전환 시작...', 'info');
    console.log(LOG_PREFIX, 'switchToVideoMode settings:', {
      duration: videoDuration, resolution: videoResolution, aspectRatio
    });

    // ═══ 새 UI (2026.03~): 하단 바에 인라인 버튼 ═══
    // 하단 바에 "이미지" / "비디오" 탭 + 설정 버튼이 직접 표시
    const inlineVideoBtn = findButtonByTextInArea('비디오') || findButtonByTextInArea('Video');
    if (inlineVideoBtn) {
      console.log(LOG_PREFIX, '새 UI: 하단 바 인라인 버튼 사용');
      MangoDom.simulateClick(inlineVideoBtn);
      await delay(500);
      showToast('비디오 모드 선택 완료', 'info');

      // 하단 바의 모든 설정 버튼 수집
      const barBtns = [];
      document.querySelectorAll('button').forEach(b => {
        const rect = b.getBoundingClientRect();
        const text = (b.textContent || '').trim();
        if (rect.top > window.innerHeight - 150 && text.length > 0 && text.length <= 10) {
          barBtns.push(b);
        }
      });
      const btnTexts = barBtns.map(b => (b.textContent || '').trim());
      console.log(LOG_PREFIX, `하단 바 설정 버튼 ${barBtns.length}개: [${btnTexts.join(', ')}]`);

      if (videoDuration) {
        clickButtonInList(barBtns, [`${videoDuration}s`, `${videoDuration}초`, String(videoDuration)], 'duration');
        await delay(200);
      }
      if (videoResolution) {
        clickButtonInList(barBtns, [videoResolution, videoResolution.replace('p', '')], 'resolution');
        await delay(200);
      }
      if (aspectRatio) {
        clickButtonInList(barBtns, [aspectRatio], 'aspectRatio');
        await delay(300);
        // 비율 버튼은 드롭다운 팝오버를 열 수 있음 → Escape로 닫기
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        await delay(300);
      }

      showToast('비디오 모드 전환 + 설정 완료!', 'success');
      return true;
    }

    // ═══ 구 UI 폴백: 플로팅 패널 방식 ═══
    console.log(LOG_PREFIX, '구 UI 폴백: 플로팅 패널 방식 시도');

    // Step 1: 설정 패널 트리거 버튼 찾기
    let modelBtn = document.querySelector('button[aria-label="모델 선택"]') ||
                   findButtonByTextInArea('이미지') ||
                   findButtonByTextInArea('Image');

    // 방법 2: 결과 페이지 (aria-label 기반, 하단 250px 이내)
    if (!modelBtn) {
      const ariaKeywords = ['설정', 'setting', '모드', 'mode', '모델'];
      const allBtns = document.querySelectorAll('button[aria-label]');
      for (const btn of allBtns) {
        const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (ariaKeywords.some(kw => aria.includes(kw))) {
          const rect = btn.getBoundingClientRect();
          if (rect.top > window.innerHeight - 250) {
            modelBtn = btn;
            console.log(LOG_PREFIX, `트리거 (aria): "${btn.getAttribute('aria-label')}" top=${Math.round(rect.top)}`);
            break;
          }
        }
      }
    }

    // 방법 3: 에디터 컨테이너 내 드롭다운 트리거 버튼
    if (!modelBtn) {
      const editor = findEditor();
      if (editor) {
        let container = editor;
        for (let i = 0; i < 6; i++) container = container?.parentElement;
        if (container) {
          const submitBtn = findSubmitButton();
          const candidates = Array.from(container.querySelectorAll('button'))
            .filter(b => b !== submitBtn && !b.disabled && (b.textContent || '').trim().length <= 10);
          for (const btn of candidates) {
            if (btn.getAttribute('aria-expanded') !== null || btn.getAttribute('aria-haspopup')) {
              modelBtn = btn;
              console.log(LOG_PREFIX, `트리거 (에디터 aria-expanded): "${(btn.textContent || '').trim()}"`);
              break;
            }
          }
          if (!modelBtn) {
            for (const btn of candidates) {
              if (btn.querySelector('svg')) {
                modelBtn = btn;
                console.log(LOG_PREFIX, `트리거 (에디터 SVG): "${(btn.textContent || '').trim()}"`);
                break;
              }
            }
          }
        }
      }
    }

    if (!modelBtn) {
      console.error(LOG_PREFIX, '설정 패널 트리거 버튼 못 찾음');
      showToast('설정 트리거 버튼 없음', 'error');
      const allBtns = document.querySelectorAll('button');
      console.log(LOG_PREFIX, '=== 하단바 버튼 디버그 ===');
      allBtns.forEach((b, i) => {
        const rect = b.getBoundingClientRect();
        if (rect.top > window.innerHeight - 250) {
          console.log(LOG_PREFIX, `  btn[${i}]: "${(b.textContent || '').trim().substring(0, 30)}" aria="${b.getAttribute('aria-label') || ''}" top=${Math.round(rect.top)}`);
        }
      });
      return false;
    }

    showToast(`트리거 버튼: "${(modelBtn.textContent || '').trim().substring(0, 20)}"`, 'info');
    MangoDom.simulateClick(modelBtn);
    await delay(800);

    // 설정 먼저 적용
    let dropdownBtns = findDropdownButtons();
    if (dropdownBtns.length > 0) {
      const btnTexts = dropdownBtns.map(b => (b.textContent || '').trim()).filter(t => t.length < 20);
      showToast(`패널 버튼 ${dropdownBtns.length}개: [${btnTexts.join(', ')}]`, 'info');
      if (videoDuration) {
        clickButtonInList(dropdownBtns, [`${videoDuration}s`, `${videoDuration}초`, String(videoDuration)], 'duration');
        await delay(200);
      }
      if (videoResolution) {
        clickButtonInList(dropdownBtns, [videoResolution, videoResolution.replace('p', '')], 'resolution');
        await delay(200);
      }
      if (aspectRatio) {
        clickButtonInList(dropdownBtns, [aspectRatio], 'aspectRatio');
        await delay(200);
      }
    }

    // "동영상 만들기" 모드 선택
    const videoItem = findDropdownItem('동영상 만들기') ||
                      findDropdownItem('동영상 생성') ||
                      findDropdownItem('비디오') ||
                      findDropdownItem('Video');
    if (videoItem) {
      const itemText = (videoItem.textContent || '').trim().substring(0, 30);
      showToast(`"${itemText}" 클릭`, 'info');
      MangoDom.simulateClick(videoItem);
      await delay(1000);
    } else {
      console.warn(LOG_PREFIX, '동영상 만들기 옵션 못 찾음');
      const panel = findFloatingContainer();
      if (panel) {
        const panelBtns = panel.querySelectorAll('button, [role="menuitem"], [role="option"]');
        console.log(LOG_PREFIX, `=== 패널 내 항목 ${panelBtns.length}개 ===`);
        panelBtns.forEach((b, i) => {
          console.log(LOG_PREFIX, `  [${i}]: "${(b.textContent || '').trim().substring(0, 40)}"`);
        });
      }
      await closeSettingsPanel(modelBtn);
      return false;
    }

    const editor = findEditor();
    if (editor) {
      const placeholder = editor.getAttribute('data-placeholder') || editor.textContent || '';
      console.log(LOG_PREFIX, `모드 전환 후 placeholder: "${placeholder.substring(0, 40)}"`);
    }

    showToast('비디오 모드 전환 + 설정 완료!', 'success');
    return true;
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

    // 1) SPA 라우팅 우선 시도 — 사이드바의 "Imagine" 링크 클릭 (페이지 리로드 X, 빠름)
    const sidebarLinks = document.querySelectorAll('a[href="/imagine"], a[href="https://grok.com/imagine"]');
    for (const a of sidebarLinks) {
      const rect = a.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        console.log(LOG_PREFIX, 'SPA 라우팅: Imagine 사이드바 링크 클릭');
        a.click();
        // SPA 라우팅 후 URL 변경 대기 (최대 3초)
        for (let i = 0; i < 30; i++) {
          await delay(100);
          if (isOnMainPage()) {
            console.log(LOG_PREFIX, 'SPA 라우팅 성공 — 메인 페이지 도달');
            await delay(800);  // 메인 페이지 UI 안정화
            return;
          }
        }
        break;
      }
    }

    // 2) SPA 실패 → 헤더 ← 뒤로가기 버튼 시도
    const backBtn = document.querySelector('button[aria-label*="back" i], button[aria-label*="뒤로" i]');
    if (backBtn && isOnResultPage()) {
      console.log(LOG_PREFIX, '← 뒤로가기 버튼 클릭');
      backBtn.click();
      for (let i = 0; i < 20; i++) {
        await delay(150);
        if (isOnMainPage()) {
          console.log(LOG_PREFIX, '뒤로가기 성공');
          await delay(800);
          return;
        }
      }
    }

    // 3) 최후의 수단 — window.location.href (페이지 리로드, content script 중단됨)
    console.warn(LOG_PREFIX, 'SPA / back 모두 실패 — location.href 직접 이동 (스크립트 재로드 필요)');
    window.location.href = 'https://grok.com/imagine';
    await delay(10000);
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
      if (shouldStop) throw new Error('사용자에 의해 중지됨');  // 새 작업이 오면 즉시 빠져나감
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

  // 프롬프트 append — @참조 칩을 보존한 채 뒤에 텍스트 추가 (selectAll+delete 안 함).
  // keepExisting=true 면 커서를 끝으로 옮기고 insertText 만. false 면 일반 typePrompt 위임.
  async function typePromptAppend(text, keepExisting) {
    if (!keepExisting) return typePrompt(text);
    if (!text || !text.trim()) return;
    const editor = findEditor();
    if (!editor) return typePrompt(text);
    editor.focus();
    await delay(150);
    // 커서를 끝으로 이동
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);  // 끝으로
      sel.addRange(range);
    } catch (_) {}
    // 칩 뒤에 공백 + 프롬프트
    document.execCommand('insertText', false, ' ' + text);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await delay(200);
    console.log(LOG_PREFIX, '프롬프트 append (@ 칩 보존)');
  }

  // ─── Prompt Input ───
  async function typePrompt(text) {
    if (!text || !text.trim()) {
      console.log(LOG_PREFIX, 'Empty prompt, skipping typePrompt');
      return;
    }

    // Try 1: TipTap/ProseMirror editor (contenteditable)
    const editor = findEditor();
    if (editor) {
      console.log(LOG_PREFIX, 'Editor found:', editor.className);
      editor.focus();
      await delay(100);

      // ── 방법 1: execCommand insertText (TipTap 입력 파이프라인 경유) ──
      document.execCommand('selectAll', false);
      document.execCommand('delete', false);
      await delay(100);
      document.execCommand('insertText', false, text);
      await delay(200);
      if (editor.textContent?.includes(text.substring(0, 20))) {
        console.log(LOG_PREFIX, 'Prompt typed via execCommand insertText');
        return;
      }
      console.log(LOG_PREFIX, 'execCommand insertText 실패, 클립보드 방식 시도');

      // ── 방법 2: 클립보드 copy → paste (크롬 버전 호환성 높음) ──
      try {
        const tmp = document.createElement('textarea');
        tmp.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        tmp.value = text;
        document.body.appendChild(tmp);
        tmp.focus();
        tmp.select();
        document.execCommand('copy');
        document.body.removeChild(tmp);

        editor.focus();
        await delay(100);
        document.execCommand('selectAll', false);
        await delay(50);
        const pasted = document.execCommand('paste');
        if (pasted && editor.textContent?.includes(text.substring(0, 20))) {
          console.log(LOG_PREFIX, 'Prompt typed via clipboard paste');
          return;
        }
        console.log(LOG_PREFIX, `clipboard paste=${pasted}, content="${(editor.textContent||'').substring(0,30)}"`);
      } catch (e) {
        console.log(LOG_PREFIX, 'clipboard paste 에러:', e.message);
      }

      // ── 방법 3: Selection API + insertText ──
      try {
        editor.focus();
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(editor);
          sel.addRange(range);
        }
        document.execCommand('insertText', false, text);
        await delay(200);
        if (editor.textContent?.includes(text.substring(0, 20))) {
          console.log(LOG_PREFIX, 'Prompt typed via Selection API + insertText');
          return;
        }
      } catch (e) {
        console.log(LOG_PREFIX, 'Selection API 에러:', e.message);
      }

      // ── 방법 4: DOM 직접 + InputEvent (최후 수단, TipTap 인식 불확실) ──
      const p = editor.querySelector('p');
      if (p) p.textContent = text;
      else editor.innerHTML = `<p>${text}</p>`;
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      console.log(LOG_PREFIX, 'Prompt typed via DOM fallback (TipTap 인식 불확실)');
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
    // 🔒 LOCKOUT: 최근 30초 안에 이미 submit 한 적 있으면 절대 다시 안 누름 (중복 영상 생성 차단).
    //    이전 영상 생성 중인데 또 누르면 그록이 '기존+새' 모드로 인식 → 2개 동시 생성.
    const _LOCKOUT_MS = 30000;
    if (window.__mangoauto_lastGrokSubmitMs && Date.now() - window.__mangoauto_lastGrokSubmitMs < _LOCKOUT_MS) {
      const left = Math.round((_LOCKOUT_MS - (Date.now() - window.__mangoauto_lastGrokSubmitMs)) / 1000);
      console.warn(LOG_PREFIX, `🔒 Submit lockout — 최근 ${Math.round((Date.now()-window.__mangoauto_lastGrokSubmitMs)/1000)}초 전 submit 있음, ${left}초 더 대기 (중복 차단)`);
      showToast(`전송 잠금: ${left}초 대기 (이전 전송 진행 중)`, 'warn');
      return true;  // 이미 진행 중이라는 의미로 success
    }

    // 이미 생성 진행 중이면 skip + 성공으로 처리
    if (isAutoGenerating() || isVideoStillGenerating()) {
      console.log(LOG_PREFIX, 'Auto-generating already in progress — skip submit, treat as success');
      window.__mangoauto_lastGrokSubmitMs = Date.now();  // 진행 중 표시 (lockout 갱신)
      return true;
    }

    // Wait for submit button to be enabled (이미지 업로드 중 disabled일 수 있으므로 30초 대기)
    const btn = await waitForSubmitEnabled(30000);
    if (!btn) {
      // 디버그: 전송 버튼 못 찾은 이유 파악
      console.error(LOG_PREFIX, '전송 버튼 못 찾음! 에디터 근처 버튼 목록:');
      const editor = findEditor();
      if (editor) {
        let c = editor;
        for (let i = 0; i < 5; i++) c = c?.parentElement;
        if (c) {
          c.querySelectorAll('button').forEach((b, i) => {
            const text = (b.textContent || '').trim().substring(0, 20);
            const aria = b.getAttribute('aria-label') || '';
            console.log(LOG_PREFIX, `  btn[${i}]: "${text}" aria="${aria}" disabled=${b.disabled} type=${b.type || ''}`);
          });
        }
      }
      // 버튼 못 찾음 → Enter 키 fallback
      console.warn(LOG_PREFIX, '전송 버튼 못 찾음 — Enter 키 fallback 시도');
      const ok = await trySubmitByEnter();
      if (ok) {
        await delay(1200);
        // Enter 후 페이지 전환됐으면 성공
        if (!isOnMainPage() || isAutoGenerating()) {
          console.log(LOG_PREFIX, 'Enter fallback 으로 전송 성공');
          return true;
        }
      }
      return false;
    }

    // ⚠️ 제출 버튼은 **native click() 만 단독 발사**.
    // 근본 원인: simulateClick({singleClick}) 도 사전에 mousedown/mouseup/pointerup 발사.
    // 그록 React 가 onClick + onPointerUp(또는 form onSubmit) 양쪽 핸들러를 걸어두면
    //   mouseup/pointerup → POST 1 + click → POST 2 → 영상 2개 생성 (두번째 task부터 빈발).
    // → focus + scrollIntoView 만 수동으로 하고 el.click() 만 호출 → 합성 이벤트 0개.
    try { btn.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch (_) {}
    try { btn.focus({ preventScroll: true }); } catch (_) {}
    try { btn.click(); } catch (clickErr) {
      // 만약 native click() 가 throw 하면 (extremely rare) 합성 click 1개로 폴백
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1 }));
    }
    window.__mangoauto_lastGrokSubmitMs = Date.now();  // 🔒 lockout 마킹
    console.log(LOG_PREFIX, `Submit clicked (native only): aria="${btn.getAttribute('aria-label') || ''}" text="${(btn.textContent || '').trim().substring(0, 20)}"`);
    // ❌ Enter fallback 보강 제거 — 버튼 클릭 후 Enter 추가 발사하면 영상 2번 생성 (409 Conflict).
    //    URL 변경 / isAutoGenerating 감지는 비동기라 1초 후 false negative 가능.
    //    버튼 클릭 성공 = success. 실제 결과는 waitForResultPage 에서 검증.
    return true;
  }

  function isAutoGenerating() {
    // 영상 생성 중 표시 버튼 — 명확한 라벨만 (단독 '취소'/'Cancel' 제외, 모달/사이드바 false positive 방지).
    // 다국어로도 'video'/'동영상'/'비디오'/'generation'/'생성' 같은 구체적 키워드 필수.
    const cancelLabels = [
      '동영상 취소', '비디오 취소', '생성 취소',
      'Cancel video', 'Cancel generation', 'Cancel creation',
      'ยกเลิกวิดีโอ', 'ยกเลิกการสร้าง',
      'Hủy video', 'Huỷ video', 'Hủy tạo', 'Huỷ tạo',
    ];
    const lowerSet = new Set(cancelLabels.map(s => s.toLowerCase()));
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      // visible 버튼만 (display:none, hidden DOM 제외)
      if (!btn.offsetParent && btn.offsetWidth === 0 && btn.offsetHeight === 0) continue;
      const text = (btn.textContent || '').trim().toLowerCase();
      if (lowerSet.has(text)) return true;
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
  // 🎯 React + preventDefault 핸들러 까지 확실히 통과시키는 강화 drop 시퀀스.
  // dragenter → dragover(여러번, window+target) → drop → dragleave.
  // DataTransfer 에 items + files 모두 세팅.
  async function dispatchRobustDrop(target, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    // 일부 사이트는 effectAllowed/dropEffect 를 보고 필터하므로 정상값 세팅 시도
    try { dt.effectAllowed = 'all'; } catch (_) {}

    const makeEvt = (type) => {
      const evt = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: dt,
      });
      return evt;
    };

    // React 가 window/document 에서도 drag 이벤트 리스닝하는 케이스 대응
    const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    const clientX = rect ? Math.round(rect.left + rect.width / 2) : 100;
    const clientY = rect ? Math.round(rect.top + rect.height / 2) : 100;

    // dragenter
    target.dispatchEvent(makeEvt('dragenter'));
    await delay(60);
    // dragover × 3 (React batched state 업데이트용)
    for (let i = 0; i < 3; i++) {
      const over = new DragEvent('dragover', {
        bubbles: true, cancelable: true, composed: true,
        dataTransfer: dt, clientX, clientY,
      });
      target.dispatchEvent(over);
      await delay(50);
    }
    // drop
    const dropEvt = new DragEvent('drop', {
      bubbles: true, cancelable: true, composed: true,
      dataTransfer: dt, clientX, clientY,
    });
    target.dispatchEvent(dropEvt);
    await delay(100);
    // dragleave (일부 페이지는 이걸로 hover 상태 해제 후 파일 처리)
    try { target.dispatchEvent(makeEvt('dragleave')); } catch (_) {}
  }

  // 첨부 성공 후 중복 이미지 정리 — 2장 이상이면 마지막 1장만 남기고 삭제.
  // 2번째 이미지가 업로드 완료 후 1~2초 늦게 나타날 수 있어 2초간 폴링하며 감지.
  async function dedupeAttachments() {
    let cnt = 0;
    // 최대 2.5초 폴링 — 늦게 뜨는 중복 잡기
    for (let i = 0; i < 5; i++) {
      await delay(500);
      cnt = countAttachedImages();
      if (cnt >= 2) break;
    }
    if (cnt <= 1) {
      console.log(LOG_PREFIX, `[dedupe] 첨부 ${cnt}장 — 정상`);
      return;
    }
    console.warn(LOG_PREFIX, `⚠️ 중복 첨부 감지 (${cnt}장) → 초과분 삭제 시도`);
    // 초과분 (cnt-1)개 삭제 — 여러 패스로 확실히
    for (let pass = 0; pass < 4; pass++) {
      const now = countAttachedImages();
      if (now <= 1) break;
      const btns = findAttachmentRemoveButtons();
      if (!btns.length) break;
      // 첫번째 삭제 버튼만 (보통 먼저 들어온 중복) 클릭 후 재확인
      try { MangoDom.simulateClick(btns[0]); await delay(500); } catch (_) {}
    }
    console.log(LOG_PREFIX, `중복 정리 후 ${countAttachedImages()}장`);
  }

  // 외부 진입점 — 내부 첨부 후 중복 정리까지 보장.
  async function attachImage(imageDataUrl) {
    const ok = await _attachImageInner(imageDataUrl);
    if (ok) {
      try { await dedupeAttachments(); } catch (_) {}
    }
    return ok;
  }

  async function _attachImageInner(imageDataUrl) {
    try {
      console.log(LOG_PREFIX, '=== 이미지 첨부 시작 ===');

      // Remove any existing attachment first
      await removeExistingAttachment();
      await delay(500);

      const file = MangoDom.dataUrlToFile(imageDataUrl, `image-${Date.now()}.png`);
      console.log(LOG_PREFIX, `파일 생성: ${file.name}, 크기: ${file.size}`);

      // ── Strategy 0: file input (가장 결정적 — 정확히 1개 파일만 업로드) ──
      // 🔑 클립보드 paste 가 에디터에 인라인 이미지를 삽입 → 멈춘 blob 으로 2장처럼 보이는
      //    문제(2026-05 로그 규명) 회피. file input 은 dt.files 에 1개만 세팅 → 단일 업로드.
      //    file input 이 없으면 "업로드" 버튼을 클릭해 hidden input 을 생성시킨 뒤 세팅.
      console.log(LOG_PREFIX, 'Strategy 0: file input (단일 업로드 우선)');
      const setFileInput = (fi) => {
        const dt0 = new DataTransfer();
        dt0.items.add(file);
        const proto = Object.getPrototypeOf(fi);
        const desc = Object.getOwnPropertyDescriptor(proto, 'files') ||
                     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
        if (desc && desc.set) desc.set.call(fi, dt0.files);
        else fi.files = dt0.files;
        fi.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        fi.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      };
      try {
        let fileInput = findFileInput();
        // file input 없으면 업로드 버튼 클릭해서 생성 시도
        if (!fileInput) {
          const upBtn = findUploadButton();
          if (upBtn) {
            console.log(LOG_PREFIX, '업로드 버튼 클릭 → file input 생성 시도');
            // label[for] 또는 내부 input 이면 클릭 시 파일창 뜨므로, 직접 input 찾기 우선
            MangoDom.simulateClick(upBtn);
            await delay(600);
            fileInput = findFileInput();
          }
        }
        if (fileInput) {
          console.log(LOG_PREFIX, `file input 발견: accept=${fileInput.accept || '(none)'}`);
          setFileInput(fileInput);
          await delay(3500);
          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ Strategy 0 (file input) 단일 첨부 성공');
            return true;
          }
          console.log(LOG_PREFIX, 'Strategy 0 미확인, 다음 방식 시도');
        } else {
          console.log(LOG_PREFIX, 'file input 없음 — Strategy 1 로');
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Strategy 0 (file input) 실패:', e.message);
      }

      // 이미 첨부됐으면 중단 (중복 paste 방지)
      if (checkImageAttached() || !isOnMainPage()) {
        console.log(LOG_PREFIX, '✅ Strategy 0 이후 첨부 확인됨');
        return true;
      }

      // ── Strategy 1: Clipboard Paste on TipTap editor (구 UI) ──
      // ⚠️ 주의: ProseMirror 에디터 paste 는 이미지를 prose 안에 인라인 삽입 → 멈춘 blob 유발.
      //    Strategy 0(file input) 이 성공하면 여기 도달 안 함. file input 이 정말 없을 때만 최후로.
      console.log(LOG_PREFIX, 'Strategy 1: Clipboard Paste (TipTap/contenteditable 한정)');
      try {
        const editor = findEditor();
        const isPasteCapable = editor && (
          editor.classList?.contains('tiptap') ||
          editor.classList?.contains('ProseMirror') ||
          editor.getAttribute?.('contenteditable') === 'true'
        );
        if (isPasteCapable) {
          editor.focus();
          await delay(200);

          const dt = new DataTransfer();
          dt.items.add(file);
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dt
          });
          editor.dispatchEvent(pasteEvent);
          console.log(LOG_PREFIX, 'Paste 이벤트 디스패치 완료');
          await delay(4000);

          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ Clipboard Paste로 첨부 성공');
            return true;
          }
          console.log(LOG_PREFIX, 'Paste 디스패치했으나 미확인, 다음 방식 시도');
        } else {
          console.log(LOG_PREFIX, 'Paste-capable 에디터 없음 (리뉴얼된 textarea UI), Strategy 3 직행');
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'Clipboard Paste 실패:', e.message);
      }

      // 이미 첨부됐으면 중단
      if (checkImageAttached() || !isOnMainPage()) {
        console.log(LOG_PREFIX, '✅ Strategy 1 이후 첨부 확인됨');
        return true;
      }

      // ── Strategy 2: Real Clipboard Write + Paste ──
      // 실제 시스템 클립보드에 이미지를 쓴 후 paste 이벤트 발생
      console.log(LOG_PREFIX, 'Strategy 2: 시스템 클립보드 Write + Paste');
      try {
        const editor = findEditor();
        if (editor) {
          // data URL → Blob
          const arr = imageDataUrl.split(',');
          const mime = arr[0].match(/:(.*?);/)[1];
          const bstr = atob(arr[1]);
          const u8arr = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
          const blob = new Blob([u8arr], { type: mime });

          // 시스템 클립보드에 이미지 쓰기
          await navigator.clipboard.write([
            new ClipboardItem({ [mime]: blob })
          ]);
          console.log(LOG_PREFIX, '시스템 클립보드에 이미지 기록 완료');

          editor.focus();
          await delay(300);

          // 클립보드에서 읽어서 paste 이벤트 생성
          const clipItems = await navigator.clipboard.read();
          if (clipItems.length > 0) {
            const dt2 = new DataTransfer();
            for (const item of clipItems) {
              for (const type of item.types) {
                if (type.startsWith('image/')) {
                  const b = await item.getType(type);
                  const f = new File([b], `image-${Date.now()}.png`, { type });
                  dt2.items.add(f);
                }
              }
            }
            const pasteEvent2 = new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: dt2
            });
            editor.dispatchEvent(pasteEvent2);
            console.log(LOG_PREFIX, '시스템 클립보드 paste 이벤트 디스패치 완료');
            await delay(4000);
          }

          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ 시스템 클립보드 Paste로 첨부 성공');
            return true;
          }
        }
      } catch (e) {
        console.warn(LOG_PREFIX, '시스템 클립보드 Paste 실패:', e.message);
      }

      // 이미 첨부됐으면 중단
      if (checkImageAttached() || !isOnMainPage()) {
        console.log(LOG_PREFIX, '✅ Strategy 2 이후 첨부 확인됨');
        return true;
      }

      // ── Strategy 3: Drag-and-drop on editor + wrapper candidates (리뉴얼 UI 대응) ──
      console.log(LOG_PREFIX, 'Strategy 3: Drag-and-drop (확장된 타겟 헌팅)');
      try {
        const dropTargets = findDropTargets();
        console.log(LOG_PREFIX, `드롭 후보 ${dropTargets.length}개`);

        for (const target of dropTargets) {
          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ Drag-and-drop 중 첨부 확인됨');
            return true;
          }
          const tag = target.tagName || '';
          const cls = (target.className || '').toString().substring(0, 40);
          console.log(LOG_PREFIX, `드래그 대상: ${tag}.${cls}`);
          await dispatchRobustDrop(target, file);
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

      // ── Strategy 4: DataTransfer on file input (React-compatible setter) ──
      console.log(LOG_PREFIX, 'Strategy 4: DataTransfer (file input, React setter)');
      try {
        const fileInput = findFileInput();
        if (fileInput) {
          console.log(LOG_PREFIX, `file input 발견: accept=${fileInput.accept || '(none)'}`);
          const dt = new DataTransfer();
          dt.items.add(file);
          // React 가 value 변경 감지하려면 native prototype setter 호출 필요
          const proto = Object.getPrototypeOf(fileInput);
          const desc = Object.getOwnPropertyDescriptor(proto, 'files') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
          if (desc && desc.set) {
            desc.set.call(fileInput, dt.files);
          } else {
            fileInput.files = dt.files;
          }
          fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          await delay(3000);
          if (checkImageAttached() || !isOnMainPage()) {
            console.log(LOG_PREFIX, '✅ DataTransfer + React setter 첨부 성공');
            return true;
          }
        } else {
          console.log(LOG_PREFIX, 'file input 을 찾을 수 없음');
        }
      } catch (e) {
        console.warn(LOG_PREFIX, 'DataTransfer 실패:', e.message);
      }

      console.error(LOG_PREFIX, '❌ 모든 이미지 첨부 방식 실패');
      return false;
    } catch (e) {
      console.error(LOG_PREFIX, '❌ 이미지 첨부 에러:', e);
      return false;
    }
  }

  // ─── 이미지 업로드 완료 대기 (로딩 스피너 사라질 때까지) ───
  // 그록은 첨부 직후 썸네일에 로딩 스피너를 표시 → 완료돼야 @ 참조 가능.
  async function waitForImageUploadComplete(timeoutMs = 20000) {
    const start = Date.now();
    await delay(800);
    while (Date.now() - start < timeoutMs) {
      // 첨부 영역 안 로딩 인디케이터 (스피너/progress) 검사
      const loaders = document.querySelectorAll(
        '[class*="attach"] [class*="spin"], [class*="attach"] [class*="load"], ' +
        '[class*="preview"] [class*="spin"], [class*="upload"] [class*="progress"], ' +
        '[role="progressbar"], svg[class*="animate-spin"], [class*="animate-spin"]'
      );
      // 로딩 인디케이터가 첨부 썸네일 근처에 없으면 완료로 판단
      let stillLoading = false;
      for (const ld of loaders) {
        const r = ld.getBoundingClientRect();
        // 화면 하단 입력바 영역 (대략 아래쪽 절반) 의 로더만 카운트
        if (r.width > 0 && r.top > window.innerHeight * 0.4) { stillLoading = true; break; }
      }
      if (!stillLoading) {
        console.log(LOG_PREFIX, '이미지 업로드 완료 (로더 사라짐)');
        return true;
      }
      await delay(500);
    }
    console.warn(LOG_PREFIX, '이미지 업로드 완료 대기 타임아웃 — 계속 진행');
    return false;
  }

  // ─── @ 참조 워크플로우 — 첨부 이미지를 프롬프트에 @Image 참조로 삽입 ───
  // 그록 프레임→영상: @ 입력 → 드롭다운에서 이미지 선택 → @Image 1 칩 → 그래야 전송 활성화.
  async function insertImageReference() {
    const editor = findEditor();
    if (!editor) { console.warn(LOG_PREFIX, '@참조: 에디터 없음'); return false; }
    editor.focus();
    await delay(200);

    // 1) 기존 내용 비우고 "@" 입력
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    await delay(150);
    // "@" 를 실제 키 입력처럼 — execCommand insertText 로 트리거
    document.execCommand('insertText', false, '@');
    // beforeinput/input 이벤트도 발생시켜 드롭다운 트리거 보강
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: '@', inputType: 'insertText' }));
    await delay(900);  // 드롭다운 등장 대기

    // 2) 드롭다운에서 이미지 항목 찾기 (썸네일 + "Image N" 텍스트)
    //    role=option / li / [class*=mention] / [class*=suggestion] 안에서 이미지 항목 탐색
    const start = Date.now();
    let picked = null;
    while (Date.now() - start < 4000 && !picked) {
      const candidates = document.querySelectorAll(
        '[role="option"], [role="menuitem"], [class*="mention"] li, [class*="suggestion"] li, ' +
        '[class*="popover"] button, [class*="dropdown"] button, [class*="menu"] [role="option"], ul li'
      );
      for (const c of candidates) {
        const txt = (c.textContent || '').trim();
        const hasImg = !!c.querySelector('img');
        const r = c.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        // "Image" / "이미지" 텍스트를 포함하거나 썸네일 이미지가 있는 항목
        if (hasImg || /image\s*\d|이미지\s*\d|^image|^이미지/i.test(txt)) {
          picked = c;
          break;
        }
      }
      if (!picked) await delay(300);
    }

    if (!picked) {
      console.warn(LOG_PREFIX, '@참조: 드롭다운에서 이미지 항목 못 찾음');
      return false;
    }
    console.log(LOG_PREFIX, `@참조: 이미지 항목 선택 "${(picked.textContent || '').trim().slice(0, 20)}"`);
    MangoDom.simulateClick(picked);
    await delay(600);
    return true;
  }

  // 첨부된 이미지 미리보기의 삭제(X) 버튼들을 모두 찾기 — 리뉴얼 UI 의 X 아이콘 포함.
  function findAttachmentRemoveButtons() {
    const out = [];
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      // 텍스트 "삭제" / aria-label remove·delete·삭제·제거·close·첨부 취소
      const isRemoveLabel = text === '삭제' ||
        aria.includes('remove') || aria.includes('delete') || aria.includes('삭제') ||
        aria.includes('제거') || aria.includes('첨부') || aria.includes('attachment');
      if (!isRemoveLabel) continue;
      // 이 버튼이 이미지 썸네일 근처에 있는지 확인 (오탐 방지)
      const near = btn.closest('[class*="attach"],[class*="preview"],[class*="thumb"],[class*="image"],[class*="upload"]')
                   || (btn.parentElement && btn.parentElement.querySelector('img'));
      if (near || text === '삭제') out.push(btn);
    }
    return out;
  }

  async function removeExistingAttachment() {
    // 모든 첨부 삭제 버튼 클릭 (X 아이콘 포함) — 중복 누적 방지
    let removed = 0;
    for (let pass = 0; pass < 5; pass++) {
      const btns = findAttachmentRemoveButtons();
      if (!btns.length) break;
      for (const btn of btns) {
        try { MangoDom.simulateClick(btn); removed++; await delay(400); } catch (_) {}
      }
      await delay(400);
    }
    if (removed) console.log(LOG_PREFIX, `이전 첨부 이미지 ${removed}개 삭제`);

    // Clear file input
    const fileInput = findFileInput();
    if (fileInput) {
      fileInput.value = '';
      const emptyDt = new DataTransfer();
      fileInput.files = emptyDt.files;
    }
  }

  // 첨부된 이미지 개수 카운트 (중복 감지용)
  function countAttachedImages() {
    let n = 0;
    const fileInput = findFileInput();
    if (fileInput && fileInput.files) n = Math.max(n, fileInput.files.length);

    // 미리보기 썸네일 — 다양한 셀렉터 (그록 새 UI 변경 대응)
    const seen = new Set();
    const collect = (selector) => {
      document.querySelectorAll(selector).forEach(img => {
        const src = img.src || '';
        if ((src.startsWith('blob:') || src.startsWith('data:')) && !seen.has(src)) {
          seen.add(src);
        }
      });
    };
    // 1) class 이름 기반 (구 UI)
    collect('[class*="attach" i] img[src^="blob:"]');
    collect('[class*="attach" i] img[src^="data:"]');
    collect('[class*="preview" i] img[src^="blob:"]');
    collect('[class*="preview" i] img[src^="data:"]');
    collect('[class*="thumb" i] img[src^="blob:"]');
    collect('[class*="thumb" i] img[src^="data:"]');
    // 2) 에디터 외부의 모든 blob/data 이미지 (새 UI — 첨부 영역이 클래스 이름 없는 div 일 때)
    const editor = findEditor();
    document.querySelectorAll('img[src^="blob:"], img[src^="data:"]').forEach(img => {
      if (editor && editor.contains(img)) return;  // 에디터 인라인 제외 (paste 잔재)
      // 너무 작은 아바타·아이콘 제외
      const rect = img.getBoundingClientRect();
      if (rect.width < 16 || rect.height < 16) return;
      const src = img.src || '';
      if (src && !seen.has(src)) seen.add(src);
    });
    n = Math.max(n, seen.size);
    return n;
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

    // Check 3: blob/data images — 단, **에디터 안 인라인 이미지는 제외** (ProseMirror paste 잔재).
    // 에디터 밖(첨부 영역)의 blob/data 이미지만 진짜 첨부로 인정.
    const editor = findEditor();
    const blobImgs = Array.from(document.querySelectorAll('img[src^="blob:"], img[src^="data:"]'));
    for (const img of blobImgs) {
      if (editor && editor.contains(img)) continue;  // 에디터 인라인 → 무시 (오탐 방지)
      return true;
    }

    // Check 4: thumbnail/preview images near the editor (첨부 영역)
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
        // 사이드바 제외 (사이드바를 패널로 착각하는 문제 방지)
        if (el.closest('[data-variant="sidebar"]') ||
            el.closest('[data-side]') ||
            (el.className || '').toLowerCase().includes('sidebar')) {
          continue;
        }

        // 보이는 요소만
        if (el.offsetParent !== null || el.style.display !== 'none') {
          const rect = el.getBoundingClientRect();
          // 팝업/드롭다운은 보통 뷰포트 절반보다 작음 (사이드바 = 넓음)
          if (rect.width > 50 && rect.height > 50 && rect.width < window.innerWidth * 0.6) {
            console.log(LOG_PREFIX, `Floating container found: ${sel} (${Math.round(rect.width)}x${Math.round(rect.height)})`);
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

  // ─── 2개 영상 생성 시 자동 선택 ───
  // 그록이 2개 영상을 만들면 사용자에게 선택하라고 함
  // 자동화에서는 첫 번째 영상을 선택하고 진행
  async function handleDualVideoSelection() {
    const allVideos = document.querySelectorAll('video[src]');
    const visibleVideos = Array.from(allVideos).filter(v => {
      const rect = v.getBoundingClientRect();
      const src = v.src || '';
      return rect.width > 50 && rect.height > 30 && src.startsWith('http') && !src.startsWith('blob:');
    });

    if (visibleVideos.length < 2) return false; // 2개 아니면 패스

    console.log(LOG_PREFIX, `2개 영상 감지 (${visibleVideos.length}개) — 첫 번째 영상 선택 시도`);
    showToast('2개 영상 감지 — 첫 번째 선택...', 'info');

    // 첫 번째 비디오 클릭 (선택)
    const firstVideo = visibleVideos[0];
    const clickTarget = firstVideo.closest('div[class]') || firstVideo;
    MangoDom.simulateClick(clickTarget);
    await delay(2000);

    // 선택 확인 버튼이 있으면 클릭 (예: "이 영상 사용", "Select" 등)
    const confirmKeywords = ['사용', '선택', 'select', 'use', 'choose', 'pick'];
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text.length > 0 && text.length < 30 && confirmKeywords.some(kw => text.includes(kw))) {
        // 비디오 관련 선택 버튼인지 확인 (너무 일반적인 버튼 제외)
        console.log(LOG_PREFIX, `영상 선택 확인 버튼 클릭: "${text}"`);
        MangoDom.simulateClick(btn);
        await delay(2000);
        break;
      }
    }

    console.log(LOG_PREFIX, '영상 선택 완료, 업스케일 진행');
    return true;
  }

  // ─── Wait for Video Ready ───
  // 참고자료 방식: video[src]에 UUID가 포함된 URL이 나타날 때까지 대기
  // 3초 간격 폴링, 5분 타임아웃
  // 영상이 아직 생성 중인지 감지 — visible 진행률 % element 직접 검사 (가장 정확).
  // 2개 영상 동시 생성 패턴 (43%, 52% 썸네일 + "생성 중 52% | 취소") 모두 감지.
  function isVideoStillGenerating() {
    // 1) visible 진행률 % 텍스트 element 검사 (가장 강한 신호)
    //    "43%", "52%", "29 %" 같은 짧은 텍스트가 visible 이면 진행 중.
    //    영상 컨트롤의 재생률 (79%) 과 구별 — 시간 패턴 (NN:NN) 옆에 있으면 영상 컨트롤로 간주 제외.
    const percentEls = document.querySelectorAll('span, div, p, button, b, strong');
    for (const el of percentEls) {
      const text = (el.textContent || '').trim();
      if (text.length === 0 || text.length > 30) continue;
      // % 패턴 매치 (단독 "43%" 또는 "생성 중 52%" 또는 "Generating 60%")
      if (!/\b\d{1,3}\s*%/.test(text)) continue;
      // 시간 컨트롤 제외 (예: "0:02 / 0:10")
      if (/\d+:\d+/.test(text)) continue;
      // 비디오 컨트롤 안인지 — closest video 또는 video-control 클래스
      if (el.closest('video, [class*="player-control" i], [class*="video-control" i], [class*="volume" i]')) continue;
      // visible 검사 (display:none, hidden 제외)
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // OK — 진행률 표시 element 확정
      return true;
    }

    // 2) "생성 중" / "Generating" / "Creating" 텍스트 (visible element 안에서)
    const inProgressKeywords = [
      '생성 중', '생성중', 'Generating', 'Creating video', 'Creating',
      '동영상 생성', '비디오 생성',
    ];
    for (const el of percentEls) {
      const text = (el.textContent || '').trim();
      if (text.length === 0 || text.length > 60) continue;
      if (!inProgressKeywords.some(kw => text.includes(kw))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      return true;
    }

    // 3) "취소" 버튼이 visible 이면서 영상 만들 때 흔히 같이 뜨는 패턴
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text === '취소' || text === 'cancel') {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // body 어디든 % 진행률 함께 있으면 진행 중 확정
          const bodyText = (document.body.textContent || '');
          if (/\b\d{1,3}\s*%/.test(bodyText)) return true;
        }
      }
    }

    // 4) progressbar / progress 태그
    const progressEl = document.querySelector('[role="progressbar"], progress[value]');
    if (progressEl) {
      const rect = progressEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }

  async function waitForVideoReady(timeout = 300000) {
    // 해상도에 따른 최소 대기 — 사용자 보고: 480p 1분 내, 720p 1~1.5분, 1080p 1.5~2분.
    //   설정에서 해상도 읽어 적절히. 못 읽으면 60초 안전 디폴트.
    let MIN_WAIT_MS = 60000;
    try {
      const _res = (window.__mangoauto_currentSettings?.grok?.videoResolution || '720p').toLowerCase();
      if (_res.includes('480')) MIN_WAIT_MS = 35000;        // 480p: 35초
      else if (_res.includes('720')) MIN_WAIT_MS = 60000;   // 720p: 60초
      else if (_res.includes('1080')) MIN_WAIT_MS = 90000;  // 1080p: 90초
    } catch (_) {}
    showToast(`영상 생성 대기 중... (최소 ${Math.round(MIN_WAIT_MS/1000)}초)`, 'info');
    await delay(5000);  // 초기 5초

    const start = Date.now();
    const checkInterval = 3000;

    let idleSinceMs = null;  // 진행 중 신호 없이 + result 페이지도 아닌 idle 시작 시점
    while (Date.now() - start < timeout) {
      if (shouldStop) throw new Error('사용자에 의해 중지됨');
      if (isModerated()) return 'moderated';

      const elapsed = Date.now() - start;
      const elapsedSec = Math.round(elapsed / 1000);

      // 🔑 검열/실패 자동 감지: 영상 생성 시작 후 메인 페이지로 강제 이동되면 검열 또는 실패
      //   (그록은 검열 시 result 페이지 안 만들고 main 으로 되돌림)
      if (elapsed > 15000 && isOnMainPage()) {
        // 15초 이상 지났는데 result 페이지 아닌 main 페이지 = 검열/실패 가능성
        console.warn(LOG_PREFIX, `메인 페이지로 강제 이동됨 (${elapsedSec}초 경과) — 검열/실패 추정`);
        showToast('영상 생성 실패 (메인 페이지 복귀) — 검열/오류 추정', 'warn');
        return 'moderated';  // 다음 큐로 빠르게 진행
      }

      // 진행 중 명확 신호가 있으면 무조건 계속 대기
      const stillGenerating = isVideoStillGenerating();

      // 🔑 idle timeout — result 페이지인데 진행 신호 없는 상태가 90초 이상이면 실패로 판단
      if (!stillGenerating && isOnResultPage()) {
        if (idleSinceMs === null) idleSinceMs = Date.now();
        else if (Date.now() - idleSinceMs > 90000 && elapsed > 60000) {
          // 90초 idle + 최소 1분 경과 → video 도 없으면 실패
          const vurl = getVideoUrl();
          if (!vurl) {
            console.warn(LOG_PREFIX, `idle 90초 + video 없음 (${elapsedSec}초) — 실패로 판단`);
            showToast('영상 생성 idle 90초 — 실패 판단', 'warn');
            return 'timeout';
          }
        }
      } else {
        idleSinceMs = null;  // 진행 중이면 idle 카운터 리셋
      }

      if (!stillGenerating && elapsed >= MIN_WAIT_MS) {
        // 진행 중 신호 없음 + 최소 1분 경과 → 진짜 video[src] 검사
        const videoUrl = getVideoUrl();
        if (videoUrl) {
          // 추가 검증: 진짜 완성된 video 인지 (duration > 0 + readyState >= 2 + visible)
          const allVideos = document.querySelectorAll('video');
          let completedVideo = null;
          for (const v of allVideos) {
            const rect = v.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 60) continue;
            // duration 0 / NaN → 아직 로딩 중. duration > 0 = 메타데이터 로드됨 = 완성.
            if (!v.duration || v.duration <= 0 || isNaN(v.duration)) continue;
            // readyState 0=Empty, 1=Metadata, 2=Current, 3=Future, 4=Enough. 2 이상이면 재생 가능.
            if (v.readyState < 2) continue;
            completedVideo = v;
            break;
          }
          if (completedVideo) {
            showToast(`영상 완성! (${elapsedSec}초, dur=${completedVideo.duration.toFixed(1)}s)`, 'success');
            await delay(2000);  // 로딩 안정화
            return 'ready';
          }
        }
      }

      // 진행 상태 로그 (15초마다)
      if (elapsedSec > 0 && elapsedSec % 15 === 0) {
        const stat = stillGenerating ? '생성 중' : '대기';
        showToast(`영상 ${stat} (${elapsedSec}초 경과 / 최소 60초)`, 'info');
      }

      await delay(checkInterval);
    }

    // 타임아웃: 마지막으로 확인
    const lastChance = getVideoUrl();
    if (lastChance && !isVideoStillGenerating()) {
      showToast('타임아웃 직전 영상 발견!', 'warn');
      return 'ready';
    }
    return 'timeout';
  }

  // ─── 480p → 720p Upscale (... 메뉴 → 동영상 업스케일) ───
  // 결과 페이지 구조: 비디오 오른쪽에 세로 아이콘 버튼들, 맨 아래가 "..." 버튼
  // "..." 클릭 → 팝업 메뉴: 좋아요 / 싫어요 / 동영상 업스케일
  async function tryUpscaleVideo(timeout = 300000) {
    const upscaleKeywords = ['업스케일', 'upscale'];

    // Step 1: 비디오 요소 등장 대기 (페이지 전환 후 DOM에 video 태그 로드 시간 필요)
    // 새 UI 는 결과 페이지 라우팅 후 video 태그 마운트까지 2~10초 걸림.
    let video = null;
    const _videoWaitStart = Date.now();
    const _videoWaitMax = 20000;  // 최대 20초 대기
    while (Date.now() - _videoWaitStart < _videoWaitMax && !video) {
      const allVids = document.querySelectorAll('video');
      for (const v of allVids) {
        const rect = v.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 30) {
          video = v;
          break;
        }
      }
      if (!video) {
        // 보이는 거 없으면 일단 첫 video 태그라도
        if (allVids.length > 0 && Date.now() - _videoWaitStart > 5000) {
          video = allVids[0];
          break;
        }
        await delay(800);
      }
    }

    const allVideos = document.querySelectorAll('video');
    let moreBtn = null;

    if (!video) {
      console.warn(LOG_PREFIX, `업스케일: 비디오 요소 없음 (${Math.round((Date.now()-_videoWaitStart)/1000)}초 대기 후)`);
      showToast('업스케일 실패: 비디오 요소 없음', 'warn');
      return false;
    }
    console.log(LOG_PREFIX, `업스케일 대상 비디오: ${video.src?.substring(0, 60)}, 총 ${allVideos.length}개`);

    // 🔑 비디오 위로 호버 트리거 — video 태그 자체에만 (부모 dispatch 제거: 페이지 이동 위험)
    try {
      video.scrollIntoView({ behavior: 'instant', block: 'center' });
      await delay(150);
      const vRect = video.getBoundingClientRect();
      const cx = vRect.left + vRect.width / 2;
      const cy = vRect.top + vRect.height / 2;
      // video 태그에만 호버 (부모 chain 까지 dispatch 하면 잘못된 핸들러 트리거 가능)
      video.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
      video.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: cx, clientY: cy }));
      video.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
      await delay(300);
    } catch (_) {}

    // 비디오 부모를 올라가며 "..." 버튼 찾기
    // 비디오 플레이어 컨트롤(음소거/재생/전체화면)과 구별해야 함. 다국어(KO/EN/TH/VI).
    const videoControlLabels = [
      // EN
      'mute', 'unmute', 'volume', 'sound', 'play', 'pause', 'fullscreen', 'full screen',
      // KO
      '음소거', '재생', '일시정지', '전체화면', '볼륨', '해제',
      // TH
      'ปิดเสียง', 'เปิดเสียง', 'ระดับเสียง', 'เล่น', 'หยุดชั่วคราว', 'เต็มจอ',
      // VI
      'tắt tiếng', 'bật tiếng', 'âm lượng', 'phát', 'tạm dừng', 'toàn màn hình',
    ];

    function isVideoControlBtn(btn) {
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const textContent = (btn.textContent || '').trim().toLowerCase();
      if (videoControlLabels.some(l => ariaLabel.includes(l) || textContent.includes(l))) return true;
      // 시간 표시 "0:02 / 0:10" / 퍼센트 "79%" 도 컨트롤로 간주
      if (/\d+:\d+\s*\/\s*\d+:\d+/.test(textContent)) return true;
      if (/^\d+%$/.test(textContent)) return true;
      const parent = btn.closest('video, [class*="player-control" i], [class*="video-control" i]');
      if (parent) return true;
      return false;
    }

    function isThreeDotsBtn(btn) {
      // aria-label / title 기반 (다국어)
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const title = (btn.getAttribute('title') || '').toLowerCase();
      const moreKeys = [
        'more', 'options', 'additional', 'menu',
        '더보기', '옵션', '추가', '메뉴',
        'เพิ่มเติม', 'ตัวเลือก', 'เมนู',
        'thêm', 'xem thêm', 'tùy chọn', 'tuỳ chọn',
      ];
      if (moreKeys.some(k => ariaLabel.includes(k) || title.includes(k))) return true;
      // SVG에 circle 3개 (점 세 개 패턴)
      const svg = btn.querySelector('svg');
      if (svg) {
        const circles = svg.querySelectorAll('circle');
        if (circles.length === 3) return true;
        // SVG 텍스트 (...) 패턴
        const svgText = (svg.textContent || '').trim();
        if (svgText === '...' || svgText === '⋯' || svgText === '⋮') return true;
        // SVG path 3개 (각 점이 path 일 때) + 작은 정사각형 버튼
        const paths = svg.querySelectorAll('path, rect');
        const rect = btn.getBoundingClientRect();
        const squareish = Math.abs(rect.width - rect.height) < 8 && rect.width >= 20 && rect.width <= 56;
        if (paths.length === 3 && squareish) return true;
        // viewBox 24x24 + 작은 사각 버튼 + 빈 텍스트 + 비디오 컨트롤 아님 → 점 3개 메뉴 가능성 높음
        const viewBox = svg.getAttribute('viewBox') || '';
        if (squareish && (viewBox === '0 0 24 24' || viewBox === '0 0 20 20' || viewBox === '0 0 16 16')) {
          const noText = (btn.textContent || '').trim().length === 0;
          if (noText) {
            // ellipse / horizontal-dots SVG 일 가능성 — 마지막 확인: 모든 도형이 horizontal 한 줄에 배치?
            const shapes = svg.querySelectorAll('circle, rect, ellipse');
            if (shapes.length >= 2 && shapes.length <= 4) return true;
          }
        }
      }
      return false;
    }

    // 🔑 위치 기반 필터 — 영상 근처 (오른쪽 사이드 / 위 오버레이) 버튼만 후보로.
    //    페이지 전체의 다른 점세개 (사이드바·헤더·프로젝트 메뉴) 매치 방지.
    const vRect = video.getBoundingClientRect();
    function isNearVideo(btn) {
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      // 영상 오른쪽 사이드 (right edge ~ +200px, 수직으로 영상과 겹침)
      const nearRightSide = r.left >= vRect.right - 10 && r.left <= vRect.right + 200
                          && r.top < vRect.bottom + 40 && r.bottom > vRect.top - 40;
      // 영상 위 오버레이 (영상 bbox 안)
      const insideVideo = r.left >= vRect.left - 10 && r.right <= vRect.right + 10
                       && r.top >= vRect.top - 10 && r.bottom <= vRect.bottom + 10;
      // 영상 바로 아래 (좁은 화면) — 영상 하단 ~ +120px, 수평으로 영상과 겹침
      const justBelow = r.top >= vRect.bottom - 10 && r.top <= vRect.bottom + 120
                     && r.left < vRect.right + 40 && r.right > vRect.left - 40;
      return nearRightSide || insideVideo || justBelow;
    }

    // 1차: depth 0~6 까지만 (페이지 전역 X) — isThreeDotsBtn + 위치 가까운 것
    let container = video.parentElement;
    for (let depth = 0; depth < 6 && container; depth++) {
      const btns = Array.from(container.querySelectorAll('button'));
      // isThreeDotsBtn + 위치 필터 둘 다 통과
      const dotBtn = btns.find(b => isThreeDotsBtn(b) && isNearVideo(b) && !isVideoControlBtn(b));
      if (dotBtn) {
        moreBtn = dotBtn;
        const r = dotBtn.getBoundingClientRect();
        console.log(LOG_PREFIX, `"..." 버튼 발견 (depth=${depth}, x=${Math.round(r.left)}, y=${Math.round(r.top)}): aria="${moreBtn.getAttribute('aria-label') || 'N/A'}"`);
        break;
      }
      container = container.parentElement;
    }

    // 2차 폴백: depth 0~6, 위치 가까운 버튼 중 마지막 (영상 사이드 액션 패널의 맨 아래 = 보통 ...)
    if (!moreBtn) {
      console.log(LOG_PREFIX, 'isThreeDotsBtn 매칭 실패 — 위치기반 폴백 검색...');
      container = video.parentElement;
      for (let depth = 0; depth < 6 && container; depth++) {
        const btns = Array.from(container.querySelectorAll('button'));
        // 영상 근처 + 비디오 컨트롤 아님 + 아이콘 버튼 (텍스트 짧음)
        const nearIconBtns = btns.filter(b => {
          if (!isNearVideo(b)) return false;
          if (isVideoControlBtn(b)) return false;
          const t = (b.textContent || '').trim();
          if (t.length > 6) return false;  // 짧은 라벨/빈 아이콘만
          if (b.querySelector('textarea, input')) return false;
          return true;
        });
        if (nearIconBtns.length >= 3) {
          // 사이드 액션 패널: ♥ X ↓ ⋯ ↑ — y좌표 기준 정렬 후, 다운로드 다음 (4번째 or 마지막에서 1~2번째)
          nearIconBtns.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          // 가장 아래에서 2번째 (보통 ⋯ 위치) 또는 마지막
          moreBtn = nearIconBtns[nearIconBtns.length - 2] || nearIconBtns[nearIconBtns.length - 1];
          const btnTexts = nearIconBtns.map(b => {
            const label = b.getAttribute('aria-label') || (b.textContent || '').trim().substring(0, 10);
            return `"${label}"`;
          }).join(', ');
          console.log(LOG_PREFIX, `폴백: 영상 근처 아이콘 버튼 ${nearIconBtns.length}개 발견 (depth=${depth}): [${btnTexts}]`);
          break;
        }
        container = container.parentElement;
      }
    }

    // 못 찾으면 디버그
    // ⚠️ trial&verify 자동 폴백 비활성화 (2026-05-27 — 페이지 이동 위험).
    //   그록 UI 의 정확한 점세개 aria-label / SVG 패턴 파악 전까지 보수적 운영.
    //   업스케일 못 찾으면 480p 로 진행 (안전).
    const TRIAL_VERIFY_ENABLED = false;
    if (!moreBtn && TRIAL_VERIFY_ENABLED) {
      console.log(LOG_PREFIX, '점세개 패턴 매치 실패 — trial&verify: 영상 근처 아이콘 차례 클릭');
      const candidates = [];
      let cc = video.parentElement;
      for (let depth = 0; depth < 6 && cc; depth++) {
        for (const b of cc.querySelectorAll('button')) {
          if (candidates.includes(b)) continue;
          if (!isNearVideo(b)) continue;
          if (isVideoControlBtn(b)) continue;
          const t = (b.textContent || '').trim();
          if (t.length > 6) continue;
          if (b.querySelector('textarea, input, video')) continue;
          // 명백한 다른 액션(다운로드/공유/좋아요/X공유) 사전 제외
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          if (/download|share|like|favorite|좋아요|공유|다운로드|x\.com|twitter|post on x|favorite|back|navigate|home|profile/i.test(aria)) continue;
          // <a> 태그를 감싸는 버튼은 페이지 이동 가능성 — 제외
          if (b.closest('a[href]')) continue;
          candidates.push(b);
        }
        cc = cc.parentElement;
      }
      candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
      console.log(LOG_PREFIX, `trial 후보 ${candidates.length}개 — URL 변경 안전망 + 차례 클릭`);

      const urlBeforeAll = window.location.href;
      for (const cand of candidates) {
        const urlBefore = window.location.href;
        cand.scrollIntoView({ behavior: 'instant', block: 'center' });
        await delay(100);
        cand.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        cand.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        cand.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        // URL 변경 빠른 감지 (50ms·150ms·400ms 체크)
        let urlChanged = false;
        for (const wait of [50, 100, 250]) {
          await delay(wait);
          if (window.location.href !== urlBefore) {
            urlChanged = true;
            break;
          }
        }
        if (urlChanged) {
          console.warn(LOG_PREFIX, `⚠️ trial click → URL 변경 (${window.location.href.substring(0, 80)}) — history.back() 으로 복귀`);
          try { window.history.back(); } catch (_) {}
          await delay(800);
          // 원래 URL 복귀 확인
          if (window.location.href !== urlBeforeAll) {
            console.warn(LOG_PREFIX, '복귀 실패 — trial 중단');
            break;
          }
          continue;  // 다음 후보 시도
        }
        // URL 안 바뀜 — 메뉴 검사
        await delay(450);
        const menuItems = document.querySelectorAll('[role="menuitem"], [role="menu"] button, [data-radix-popper-content-wrapper] button, [data-radix-popper-content-wrapper] [role="menuitem"]');
        let foundUpscale = false;
        for (const mi of menuItems) {
          const mt = (mi.textContent || '').trim().toLowerCase();
          if (mt.length < 30 && (mt.includes('업스케일') || mt.includes('upscale'))) {
            foundUpscale = true;
            break;
          }
        }
        if (foundUpscale) {
          moreBtn = cand;
          console.log(LOG_PREFIX, `✓ trial&verify 성공 — 점세개 발견: aria="${cand.getAttribute('aria-label') || ''}"`);
          // 메뉴 닫고 정상 menuAttempt 루프로
          document.body.click();
          await delay(400);
          break;
        } else {
          // 메뉴 닫기
          document.body.click();
          await delay(250);
        }
      }
    }

    if (!moreBtn) {
      console.warn(LOG_PREFIX, '=== UPSCALE: 비디오 근처 "..." 버튼 못 찾음 (모든 폴백 실패) ===');
      // 비디오 주변 버튼들 상세 로그
      let dbgContainer = video.parentElement;
      for (let d = 0; d < 6 && dbgContainer; d++) {
        const btns = dbgContainer.querySelectorAll('button');
        if (btns.length > 0) {
          console.log(LOG_PREFIX, `  depth=${d}: 버튼 ${btns.length}개`);
          btns.forEach((b, i) => {
            const t = (b.textContent || '').trim().substring(0, 30);
            const aria = b.getAttribute('aria-label') || '';
            const r = b.getBoundingClientRect();
            const near = isNearVideo(b);
            console.log(LOG_PREFIX, `    [${i}] "${t}" aria="${aria}" rect=${Math.round(r.width)}×${Math.round(r.height)}@${Math.round(r.left)},${Math.round(r.top)} near=${near}`);
          });
        }
        dbgContainer = dbgContainer.parentElement;
      }
      showToast('업스케일 실패: "..." 버튼 못 찾음', 'warn');
      return false;
    }

    // Step 2: "..." 메뉴 열기 전에 비디오 일시정지 (컨트롤 오버레이 방지)
    if (video && !video.paused) {
      video.pause();
      console.log(LOG_PREFIX, '비디오 일시정지 (컨트롤 오버레이 방지)');
      await delay(300);
    }
    // 비디오 영역 밖으로 마우스 이동하여 컨트롤 숨기기
    document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0, clientY: 0 }));
    await delay(300);

    let upscaleItem = null;

    for (let menuAttempt = 1; menuAttempt <= 3 && !upscaleItem; menuAttempt++) {
      console.log(LOG_PREFIX, `"..." 메뉴 열기 시도 ${menuAttempt}/3...`);
      if (menuAttempt === 1) {
        showToast('"..." 메뉴 열기...', 'info');
        // scrollIntoView 후 직접 클릭 이벤트 발생 (겹친 요소 무시)
        moreBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
        await delay(200);
        moreBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        moreBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        moreBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        // 재시도: 다른 클릭 방식 시도
        document.body.click(); // 기존 메뉴 닫기
        await delay(500);
        if (menuAttempt === 2) {
          // .click() 직접 호출
          moreBtn.click();
        } else {
          // focus + Enter 키
          moreBtn.focus();
          await delay(100);
          moreBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
          moreBtn.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        }
      }
      await delay(1200);

      // Step 3: "동영상 업스케일" 메뉴 항목 찾기
      const menuSelectors = [
        '[role="menu"]',
        '[role="listbox"]',
        '[data-radix-popper-content-wrapper]',
        '[class*="popover" i]:not([class*="sidebar" i])',
        '[class*="dropdown" i]:not([class*="sidebar" i])'
      ];
      for (const sel of menuSelectors) {
        if (upscaleItem) break;
        const menus = document.querySelectorAll(sel);
        for (const menu of menus) {
          if (menu.closest('[data-variant="sidebar"]') || menu.closest('[data-side]')) continue;
          const items = menu.querySelectorAll('button, [role="menuitem"], [role="option"], div[role="button"], span');
          for (const el of items) {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text.length > 30) continue;
            for (const kw of upscaleKeywords) {
              if (text.includes(kw)) {
                upscaleItem = el;
                console.log(LOG_PREFIX, `업스케일 항목 발견 (메뉴 내): "${text.substring(0, 30)}" (${el.tagName})`);
                break;
              }
            }
            if (upscaleItem) break;
          }
          if (upscaleItem) break;
        }
      }

      // 방법 2: 전체에서 [role="menuitem"]만
      if (!upscaleItem) {
        const menuItems = document.querySelectorAll('[role="menuitem"]');
        for (const el of menuItems) {
          const text = (el.textContent || '').trim().toLowerCase();
          for (const kw of upscaleKeywords) {
            if (text.includes(kw)) {
              upscaleItem = el;
              console.log(LOG_PREFIX, `업스케일 항목 발견 (menuitem): "${text.substring(0, 30)}"`);
              break;
            }
          }
          if (upscaleItem) break;
        }
      }

      if (!upscaleItem && menuAttempt < 3) {
        console.log(LOG_PREFIX, `메뉴 열기 실패 (시도 ${menuAttempt}) — 재시도...`);
      }
    }

    if (!upscaleItem) {
      console.warn(LOG_PREFIX, '=== 업스케일 메뉴 항목 못 찾음 (3회 시도 후) ===');
      const popups = document.querySelectorAll(
        '[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], div[class*="popover"], div[class*="dropdown"], div[class*="tooltip"]'
      );
      if (popups.length > 0) {
        popups.forEach((popup, pi) => {
          console.log(LOG_PREFIX, `  popup[${pi}]: ${popup.tagName}.${(popup.className || '').substring(0, 30)}`);
          popup.querySelectorAll('*').forEach((el, ei) => {
            const t = (el.textContent || '').trim();
            if (t && t.length < 40 && el.children.length === 0) {
              console.log(LOG_PREFIX, `    [${ei}] ${el.tagName}: "${t}"`);
            }
          });
        });
      } else {
        console.log(LOG_PREFIX, '  팝업/메뉴 요소도 없음 — "..." 클릭이 안 먹힌듯');
      }
      document.body.click();
      await delay(300);
      showToast('업스케일 실패: 메뉴 항목 못 찾음', 'warn');
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

    // ⚠️ UUID fallback 은 여기서 X — waitForVideoReady 가 가짜 URL 을 ready 로 오판함.
    //    extractVideoUrl (단계 9, 진짜 URL 못 찾은 마지막 안전망) 에만 fallback 유지.
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
    if (!isActiveInstance()) return;  // 비활성 인스턴스는 dismissal 도 skip (중복 클릭 방지)
    if (isProcessing) return;
    ['Dismiss', 'Close', 'Skip', 'No thanks', 'Maybe later'].forEach(text => {
      const btn = MangoDom.findButtonByText(text);
      if (btn) { btn.click(); console.log(LOG_PREFIX, 'Dismissed:', text); }
    });
  }, 8000);

  console.log(LOG_PREFIX, `Content script loaded (instance ${INSTANCE_ID.slice(-6)}, active=${isActiveInstance()})`);
  if (isActiveInstance()) {
    showToast(`Content script 로드 완료 (instance ${INSTANCE_ID.slice(-6)})`, 'success');
  }
})();
