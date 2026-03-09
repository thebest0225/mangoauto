/**
 * MangoAuto - Google Flow Automation
 * Content script for labs.google/fx/tools/flow & video-fx
 * Handles text-to-video, image-to-video, text-to-image, image-to-image
 *
 * Key selectors:
 *   Prompt: #PINHOLE_TEXT_AREA_ELEMENT_ID
 *   Generate: XPath button with arrow_forward icon
 *   Mode dropdown: button[role="combobox"]
 *   Mode options: role="option" with Material icons
 *   Settings: button with "tune" icon
 *   Progress: "progress_activity" icon text or percentage text
 *   Frame upload: button with "add" icon near "swap_horiz" icon
 *   Download: button with "download" icon → menuitem "다운로드 1K"
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Flow]';
  let isProcessing = false;
  let shouldStop = false;

  // ─── XPath Selectors (verified) ───
  const SELECTORS = {
    PROMPT_TEXTAREA_ID: 'PINHOLE_TEXT_AREA_ELEMENT_ID',

    GENERATE_BUTTON_XPATH:
      "//button[.//i[text()='arrow_forward']] | " +
      "(//button[.//i[normalize-space(text())='arrow_forward']])",

    VIDEOS_TAB_XPATH:
      "//button[@role='radio' and (contains(., 'Videos') or contains(., '동영상'))]",

    IMAGES_TAB_XPATH:
      "//button[@role='radio' and (contains(., 'Images') or contains(., '이미지'))]",

    MODE_DROPDOWN_XPATH:
      "//button[@role='combobox']",

    TEXT_TO_VIDEO_OPTION_XPATH:
      "//div[@role='option' and .//i[normalize-space(text())='text_analysis']]",

    IMAGE_TO_VIDEO_OPTION_XPATH:
      "//div[@role='option' and .//i[normalize-space(text())='photo_spark']]",

    TEXT_TO_IMAGE_OPTION_XPATH:
      "//div[@role='option' and .//i[normalize-space(text())='add_photo_alternate']]",

    SETTINGS_BUTTON_XPATH:
      "//button[.//i[normalize-space(text())='tune']]",

    DOWNLOAD_BUTTON_XPATH:
      "//button[.//i[normalize-space()='download']]"
  };

  const ERROR_PHRASES = [
    'could not generate', 'unable to generate', 'violates', 'policy',
    'try again', 'something went wrong', 'error generating', 'content policy',
    'failed', 'audio generation failed', 'generation failed',
    '생성할 수 없', '정책', '다시 시도', '오류', '실패'
  ];

  // 2차 탐색(plain div/span)에서도 감지할 강한 에러 패턴
  // 주의: 'failed', 'policies' 같은 단독 단어는 Flow UI 정상 텍스트에서 false positive 발생
  const STRONG_ERROR_PATTERNS = [
    'generation failed', 'audio generation failed', 'video generation failed',
    'something went wrong', 'could not generate', 'unable to generate',
    'error generating', 'violate our policies', 'might violate',
    'content policy violation', 'against our content policy'
  ];

  // ─── Error Classification ───
  function classifyError(errorText) {
    const lower = (errorText || '').toLowerCase();
    if (lower.includes('audio') && lower.includes('failed')) return 'AUDIO_FAILED';
    if (lower.includes('something went wrong')) return 'SOMETHING_WRONG';
    if (lower.includes('violat') || lower.includes('policies') || lower.includes('policy') ||
        lower.includes('harmful') || lower.includes('content filter') ||
        lower.includes('prohibited') || lower.includes('not allowed') ||
        lower.includes('inappropriate') || lower.includes('safety')) return 'CENSORSHIP';
    return 'GENERATION_FAILED';
  }

  // ─── Click Retry button in video area ───
  async function clickRetryButton() {
    // 1. "retry" / "다시 시도" 텍스트 버튼
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent?.trim().toLowerCase() || '';
      if (text.includes('retry') || text.includes('다시 시도') || text.includes('재시도')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          MangoDom.simulateClick(btn);
          console.log(LOG_PREFIX, `Clicked Retry button: "${btn.textContent.trim()}"`);
          return true;
        }
      }
    }
    // 2. Material icon "refresh" / "replay" / "restart_alt" 버튼
    const icons = document.querySelectorAll('i, mat-icon, .material-icons, .material-symbols-outlined');
    for (const icon of icons) {
      const text = icon.textContent?.trim().toLowerCase() || '';
      if (text === 'refresh' || text === 'replay' || text === 'restart_alt') {
        const btn = icon.closest('button') || icon;
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          MangoDom.simulateClick(btn);
          console.log(LOG_PREFIX, `Clicked retry icon button: "${text}"`);
          return true;
        }
      }
    }
    return false;
  }

  // ─── Message Handler ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXECUTE_PROMPT') {
      handleExecutePrompt(msg).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, site: 'flow' });
      return;
    }
    if (msg.type === 'STOP_GENERATION') {
      shouldStop = true;
      isProcessing = false;
      imageSettingsApplied = false;
      videoSettingsApplied = false;
      // 중지 시 다이얼로그 자동처리도 멈춤
      if (window.MangoDialogDismisser) window.MangoDialogDismisser.stop();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'RESET_SETTINGS') {
      imageSettingsApplied = false;
      videoSettingsApplied = false;
      sendResponse({ ok: true });
      return;
    }
  });

  // ─── Listen for messages from inject.js (MAIN world) ───
  let lastApiResult = null;
  let lastUpscaledDataUrl = null;  // inject.js가 캡처한 업스케일 이미지 blob
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'VEO3_API_RESULT') {
      console.log(LOG_PREFIX, 'API result received:', event.data);
      lastApiResult = event.data;
    }
    if (event.data?.type === 'SET_FLOW_PROMPT_RESULT') {
      console.log(LOG_PREFIX, 'Prompt injection confirmed by inject.js:', event.data.ok);
    }
    if (event.data?.type === 'UPSCALED_IMAGE_BLOB') {
      lastUpscaledDataUrl = event.data.dataUrl;
      console.log(LOG_PREFIX, `업스케일 이미지 수신: ${Math.round(event.data.size / 1024)}KB`);
    }
  });

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getByXPath(xpath) {
    return MangoDom.getByXPath(xpath);
  }

  function checkStopped() {
    if (shouldStop) throw new Error('Stopped by user');
  }

  async function handleExecutePrompt(msg) {
    if (isProcessing) throw new Error('Already processing');
    isProcessing = true;
    shouldStop = false;
    lastApiResult = null;
    // 자동화 시작 시 다이얼로그 자동처리 재개
    if (window.MangoDialogDismisser) {
      window.MangoDialogDismisser.disabled = false;
    }

    try {
      const { prompt, mediaType, sourceImageDataUrl, settings } = msg;
      const mode = settings?._mode || 'image-video';
      console.log(LOG_PREFIX, 'Mode:', mode, '| Prompt:', prompt.substring(0, 60));

      // Step 0: 메인 페이지면 새 프로젝트로 이동
      await ensureProjectPage();
      checkStopped();

      // Step 1+2: Switch mode + apply settings via settings panel (New UI Feb 2026)
      const isImageOutput = (mediaType === 'image');
      await applyAllSettings(mode, settings, isImageOutput);
      await delay(500);
      checkStopped();

      // Step 3: Upload source image (for frame-to-video or image-to-image mode)
      if ((mode === 'image-video' || mode === 'image-image') && sourceImageDataUrl) {
        console.log(LOG_PREFIX, 'Uploading source image...');
        const uploaded = await uploadFrame(sourceImageDataUrl, 'first');
        if (uploaded) {
          console.log(LOG_PREFIX, 'Frame uploaded');
          await delay(2000);
        } else {
          // 이미지 없이 생성하면 전혀 다른 결과가 나오므로 에러 처리
          // "image rejected" 키워드 포함 → background에서 재시도 스킵
          const err = new Error('Image rejected - 이미지 업로드 거부 (서버 400)');
          err.errorCode = 'IMAGE_REJECTED';
          throw err;
        }
      }
      checkStopped();

      // Step 4: Snapshot existing media (생성 전 기존 미디어 기록)
      lastApiResult = null; // 이전 아이템의 결과 초기화
      snapshotExistingMedia();

      // Step 5: Fill prompt (DOM + MAIN world injection)
      await typePrompt(prompt);
      await delay(600 + Math.random() * 400);
      checkStopped();

      // Step 5.5: Send prompt to inject.js (MAIN world) for fetch interception
      // inject.js will inject this prompt into the outgoing API request body
      // This bypasses Lit framework internal state desync issue
      window.postMessage({ type: 'SET_FLOW_PROMPT', text: prompt }, '*');
      console.log(LOG_PREFIX, 'Prompt sent to inject.js for fetch injection');
      await delay(200);

      // Step 6: Click generate
      await clickGenerate();
      checkStopped();

      // Step 7: Wait for generation complete
      const timeoutMin = isImageOutput ? (settings?.flowTimeout || 3) : (settings?.flowVideo?.frameDuration || settings?.veo?.frameDuration || 10);
      await waitForGenerationComplete(timeoutMin);

      // Step 8: Extract result + Download
      if (mediaType === 'video' || mode.includes('video')) {
        // 비디오: URL 직접 전달 (dataUrl 변환 시 50MB+ 메모리 이슈 방지)
        let videoUrl = '';
        if (lastApiResult?.ok && lastApiResult.mediaUrls?.length > 0) {
          console.log(LOG_PREFIX, 'Using API-intercepted video URL');
          videoUrl = lastApiResult.mediaUrls[0];
        } else {
          videoUrl = await getVideoUrl() || '';
          if (!videoUrl) {
            console.warn(LOG_PREFIX, 'Video URL not found via API/DOM — UI 다운로드로 진행');
          }
        }

        // UI 다운로드: ⋮ → 다운로드 → 1080p (브라우저 네이티브 다운로드)
        console.log(LOG_PREFIX, '1080p UI 다운로드 시도...');
        const downloaded = await downloadVideoViaMenu();
        if (downloaded) {
          console.log(LOG_PREFIX, '✓ 1080p 다운로드 트리거됨');
        } else {
          console.warn(LOG_PREFIX, '⚠ UI 다운로드 실패');
          // URL도 없고 UI 다운로드도 실패하면 에러
          if (!videoUrl) throw new Error('비디오 다운로드 실패: URL 없음 + UI 다운로드 실패');
        }

        chrome.runtime.sendMessage({
          type: 'GENERATION_COMPLETE',
          mediaUrl: videoUrl || 'ui-download',
          mediaType: 'video'
        });
      } else {
        // 이미지: 품질 설정에 따라 UI 메뉴 다운로드 or dataUrl 변환
        const imageQuality = settings?.download?.imageQuality || '1k';
        console.log(LOG_PREFIX, `이미지 다운로드 품질: ${imageQuality}`);

        if (imageQuality !== '1k') {
          // 2K/4K: UI 호버 메뉴를 통해 업스케일 다운로드
          lastUpscaledDataUrl = null; // 이전 캡처 초기화
          console.log(LOG_PREFIX, `${imageQuality} UI 다운로드 시도...`);
          const downloaded = await downloadImageViaMenu(imageQuality);

          if (downloaded) {
            // inject.js의 FileReader가 비동기이므로 dataUrl 수신 대기 (최대 10초)
            if (!lastUpscaledDataUrl) {
              console.log(LOG_PREFIX, '업스케일 blob dataUrl 대기 중...');
              for (let i = 0; i < 20 && !lastUpscaledDataUrl; i++) {
                await delay(500);
              }
            }
            // inject.js가 blob을 가로채서 dataUrl로 변환한 것이 있으면 사용 (2K)
            // 없으면 원본 API URL로 폴백 (1K)
            let mediaDataUrl = lastUpscaledDataUrl || null;
            if (mediaDataUrl) {
              console.log(LOG_PREFIX, `✓ 업스케일 이미지 캡처 성공 (${Math.round(mediaDataUrl.length / 1024)}KB) → MangoHub + 프로젝트 폴더에 2K 저장`);
            } else {
              console.log(LOG_PREFIX, '업스케일 blob 캡처 안 됨 → 원본 API URL 폴백');
              let imgUrl = '';
              if (lastApiResult?.ok && lastApiResult.mediaUrls?.length > 0) {
                imgUrl = lastApiResult.mediaUrls[0];
              } else {
                imgUrl = await getGeneratedImageUrl() || '';
              }
              if (imgUrl) {
                try {
                  mediaDataUrl = await MangoDom.fetchAsDataUrl(imgUrl);
                  console.log(LOG_PREFIX, `원본 이미지 dataUrl (${Math.round(mediaDataUrl.length / 1024)}KB)`);
                } catch (e) {
                  console.warn(LOG_PREFIX, `원본 이미지 fetch 실패: ${e.message}`);
                }
              }
            }
            chrome.runtime.sendMessage({
              type: 'GENERATION_COMPLETE',
              mediaDataUrl: mediaDataUrl || null,
              mediaType: 'image',
              uiDownloaded: true
            });
          } else {
            // UI 다운로드 실패 → dataUrl 폴백
            console.warn(LOG_PREFIX, `⚠ ${imageQuality} UI 다운로드 실패, dataUrl 폴백`);
            if (!imgUrl) throw new Error('Cannot find generated image');
            const mediaDataUrl = await MangoDom.fetchAsDataUrl(imgUrl);
            chrome.runtime.sendMessage({
              type: 'GENERATION_COMPLETE',
              mediaDataUrl,
              mediaType: 'image'
            });
          }
        } else {
          // 1K: 기존 방식 (dataUrl 변환)
          let mediaDataUrl;
          if (lastApiResult?.ok && lastApiResult.mediaUrls?.length > 0) {
            console.log(LOG_PREFIX, 'Using API-intercepted image URL');
            mediaDataUrl = await MangoDom.fetchAsDataUrl(lastApiResult.mediaUrls[0]);
          } else {
            const imgUrl = await getGeneratedImageUrl();
            if (!imgUrl) throw new Error('Cannot find generated image');
            mediaDataUrl = await MangoDom.fetchAsDataUrl(imgUrl);
          }
          chrome.runtime.sendMessage({
            type: 'GENERATION_COMPLETE',
            mediaDataUrl,
            mediaType: 'image'
          });
        }
      }

      return { ok: true };
    } catch (err) {
      console.error(LOG_PREFIX, 'Error:', err);
      chrome.runtime.sendMessage({
        type: 'GENERATION_ERROR',
        error: err.message,
        errorCode: err.errorCode || ''
      });
      return { error: err.message, errorCode: err.errorCode || '' };
    } finally {
      isProcessing = false;
    }
  }

  // ─── Ensure we're on a project page (not the main/landing page) ───
  async function ensureProjectPage() {
    const url = window.location.href;
    // 프로젝트 페이지: /flow/project/ 포함
    if (url.includes('/project/')) {
      console.log(LOG_PREFIX, 'Already on project page');
      return;
    }

    console.log(LOG_PREFIX, 'On main page, clicking "새 프로젝트"...');

    // "새 프로젝트" 또는 "+ 새 프로젝트" 버튼 찾기
    const buttons = document.querySelectorAll('button');
    let newProjectBtn = null;
    for (const btn of buttons) {
      const text = btn.textContent?.trim() || '';
      if (text.includes('새 프로젝트') || text.includes('New project') ||
          text.includes('add') && text.includes('프로젝트')) {
        newProjectBtn = btn;
        break;
      }
    }

    // 아이콘 기반 fallback: add 아이콘 + "프로젝트" 텍스트
    if (!newProjectBtn) {
      const links = document.querySelectorAll('a[href*="project"]');
      if (links.length > 0) {
        newProjectBtn = links[0];
      }
    }

    if (!newProjectBtn) {
      console.warn(LOG_PREFIX, 'Cannot find "새 프로젝트" button, trying direct navigation');
      // URL 기반 이동
      window.location.href = url.replace(/\/flow\/?$/, '/flow/project/new');
      await delay(3000);
      // 페이지 로드 대기
      await waitForElement(() => findPromptTextarea(), 15000);
      return;
    }

    MangoDom.simulateClick(newProjectBtn);
    console.log(LOG_PREFIX, 'Clicked "새 프로젝트" button');

    // 프로젝트 페이지 로드 대기 (프롬프트 입력창이 나타날 때까지)
    await waitForElement(() => document.getElementById('PINHOLE_TEXT_AREA_ELEMENT_ID'), 15000);
    await delay(1000);
    console.log(LOG_PREFIX, 'Project page loaded');
  }

  async function waitForElement(finder, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // 대기 중 다이얼로그 자동 처리 (disabled 체크는 내부에서)
      const el = finder();
      if (el) return el;
      await delay(500);
    }
    return null;
  }

  // ─── Mode Switching ───
  async function switchMode(mode) {
    // Step 1: Click the right tab (Videos or Images)
    if (mode.includes('video')) {
      await clickTab(SELECTORS.VIDEOS_TAB_XPATH, 'Videos');
    } else if (mode.includes('image')) {
      await clickTab(SELECTORS.IMAGES_TAB_XPATH, 'Images');
    }
    await delay(500);

    // Step 2: Select the right mode from dropdown
    // image-image: Images 탭 선택만으로 충분 (드롭다운 불필요 - 참고자료 방식)
    if (mode === 'image-image') {
      console.log(LOG_PREFIX, 'Image-to-image: Images tab selected, no dropdown needed');
      return;
    }

    const optionXPaths = {
      'text-video': SELECTORS.TEXT_TO_VIDEO_OPTION_XPATH,
      'image-video': SELECTORS.IMAGE_TO_VIDEO_OPTION_XPATH,
      'text-image': SELECTORS.TEXT_TO_IMAGE_OPTION_XPATH
    };

    const targetXPath = optionXPaths[mode];
    if (!targetXPath) {
      console.log(LOG_PREFIX, 'Unknown mode:', mode, '- using default');
      return;
    }

    await selectModeOption(targetXPath, mode);
  }

  async function clickTab(tabXPath, tabName) {
    const tab = getByXPath(tabXPath);
    if (tab) {
      // Check if already selected
      if (tab.getAttribute('aria-checked') === 'true') {
        console.log(LOG_PREFIX, `Tab ${tabName} already selected`);
        return;
      }
      MangoDom.simulateClick(tab);
      console.log(LOG_PREFIX, `Clicked tab: ${tabName}`);
      await delay(300);
    } else {
      // Fallback: find by text
      const tabAliases = {
        'Videos': ['Videos', '동영상'],
        'Images': ['Images', '이미지']
      };
      const names = tabAliases[tabName] || [tabName];
      const buttons = document.querySelectorAll('button[role="radio"]');
      for (const btn of buttons) {
        for (const name of names) {
          if (btn.textContent.includes(name)) {
            MangoDom.simulateClick(btn);
            console.log(LOG_PREFIX, `Clicked tab via text: ${name}`);
            await delay(300);
            return;
          }
        }
      }
      console.warn(LOG_PREFIX, `Tab not found: ${tabName}`);
    }
  }

  async function selectModeOption(optionXPath, modeName) {
    // Open mode dropdown
    const dropdown = getByXPath(SELECTORS.MODE_DROPDOWN_XPATH);
    if (dropdown) {
      MangoDom.simulateClick(dropdown);
      await delay(300);
    } else {
      console.warn(LOG_PREFIX, 'Mode dropdown not found');
      return;
    }

    // Select option
    const option = getByXPath(optionXPath);
    if (option) {
      MangoDom.simulateClick(option);
      console.log(LOG_PREFIX, `Selected mode: ${modeName}`);
      await delay(300);
    } else {
      // Close dropdown by clicking elsewhere
      document.body.click();
      console.warn(LOG_PREFIX, `Mode option not found: ${modeName}`);
    }
  }

  // ─── Settings Panel (New UI - Feb 2026) ───
  // Settings badge at bottom: "🔥 Nano Banana Pro ▢ x1" → click to open panel
  // Panel: Image/Video tabs, Landscape/Portrait, x1-x4, model dropdown
  // Model dropdown: click trigger → floating option list appears
  // 주의: 패널 내부 요소가 <button>이 아닐 수 있음 → XPath 텍스트 검색 필요

  // Broad selector for all clickable-looking elements
  const PANEL_CLICKABLE_SEL = 'button, [role="button"], [role="tab"], [role="radio"], [role="option"], [role="switch"], [role="menuitemradio"], [tabindex="0"], [tabindex="-1"]';

  // XPath로 정확한 텍스트를 가진 요소 찾기 (element type 무관)
  function findElementByExactText(text, context = document.body) {
    // 정확히 일치하는 텍스트 노드의 부모 (가장 작은 단위)
    const xpath = `.//text()[normalize-space()='${text}']/..`;
    try {
      const result = document.evaluate(xpath, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      // 가장 작은 (leaf에 가까운) 요소 반환
      let best = null;
      for (let i = 0; i < result.snapshotLength; i++) {
        const el = result.snapshotItem(i);
        const rect = el.getBoundingClientRect();
        // 보이는 요소만 (너비/높이 > 0)
        if (rect.width < 5 || rect.height < 5) continue;
        // 너무 큰 컨테이너 제외 (패널 전체가 잡히는 것 방지)
        if (rect.width > 300 || rect.height > 200) continue;
        if (!best || el.children.length < best.children.length) {
          best = el;
        }
      }
      return best;
    } catch (e) {
      return null;
    }
  }

  function isSettingsPanelOpen() {
    // 방법 1: 기존 broad selector로 x1~x4 검색
    const elements = document.querySelectorAll(PANEL_CLICKABLE_SEL);
    let xCount = 0;
    for (const el of elements) {
      if (/^x[1-4]$/.test(el.textContent?.trim())) xCount++;
    }
    if (xCount >= 2) return true;

    // 방법 2: XPath로 x1~x4 텍스트 검색 (비표준 요소 대응)
    let xpathCount = 0;
    for (let i = 1; i <= 4; i++) {
      if (findElementByExactText(`x${i}`)) xpathCount++;
    }
    if (xpathCount >= 2) return true;

    // 방법 3: Image/Video + Landscape/Portrait 조합 감지
    const hasMedia = findElementByExactText('Image') || findElementByExactText('Video');
    const hasAspect = findElementByExactText('Landscape') || findElementByExactText('Portrait');
    if (hasMedia && hasAspect) return true;

    return false;
  }

  function findSettingsTrigger() {
    // 하단 배지 버튼: 모델명 + xN이 포함된 버튼 (프롬프트 텍스트에어리어 근처)
    // 예: "🔥 Nano Banana 2 crop_16_9 x1" (이미지), "Video crop_16_9 x1" (비디오)
    // textContent에서 아이콘 리거쳐가 공백 없이 연결될 수 있음: "Videocrop_16_9x1"
    const genBtn = findGenerateButton();
    const buttons = document.querySelectorAll('button, [role="button"]');
    const modelKw = ['Nano', 'Imagen', 'Veo', 'Banana'];

    // 1차: 모델명 또는 미디어타입 + xN 패턴
    for (const btn of buttons) {
      if (btn === genBtn) continue;
      const text = btn.textContent || '';
      if (text.length > 80 || text.length < 3) continue;
      // Video/Image가 텍스트 어딘가에 포함 (^앵커 제거 - 연결된 텍스트 대응)
      const hasModelOrMedia = modelKw.some(kw => text.includes(kw)) ||
                              /Video|Image/i.test(text);
      if (hasModelOrMedia && /x[1-4]/.test(text)) {
        console.log(LOG_PREFIX, `[trigger] 배지 발견: "${text.trim().substring(0, 50)}"`);
        return btn;
      }
    }

    // 2차: crop 아이콘 + xN 패턴 (모델명/미디어타입 없이 배지인 경우)
    for (const btn of buttons) {
      if (btn === genBtn) continue;
      const text = btn.textContent || '';
      if (text.length > 80 || text.length < 3) continue;
      if (text.includes('arrow_drop_down')) continue;
      if (/crop/.test(text) && /x[1-4]/.test(text)) {
        console.log(LOG_PREFIX, `[trigger] crop+xN 배지 발견: "${text.trim().substring(0, 50)}"`);
        return btn;
      }
    }

    // 3차: 모델명만 있는 버튼 (x숫자 없을 수도, 패널 내 드롭다운 제외)
    for (const btn of buttons) {
      if (btn === genBtn) continue;
      const text = btn.textContent || '';
      if (text.length > 80 || text.length < 3) continue;
      if (text.includes('arrow_drop_down')) continue;
      if (modelKw.some(kw => text.includes(kw)) && !btn.querySelector('textarea')) {
        console.log(LOG_PREFIX, `[trigger] 모델 버튼 발견: "${text.trim().substring(0, 50)}"`);
        return btn;
      }
    }

    console.warn(LOG_PREFIX, '[trigger] 못찾음. 버튼 목록:',
      [...buttons].map(b => `"${b.textContent?.trim()?.substring(0, 30)}"`).filter(t => t.length < 35).join(', '));
    return null;
  }

  async function openSettingsPanel() {
    if (isSettingsPanelOpen()) {
      console.log(LOG_PREFIX, '[panel] 이미 열려있음');
      return true;
    }
    const trigger = findSettingsTrigger();
    if (!trigger) {
      console.warn(LOG_PREFIX, '[panel] 트리거 못찾음');
      return false;
    }
    console.log(LOG_PREFIX, '[panel] 열기:', trigger.textContent?.trim()?.substring(0, 40));
    MangoDom.simulateClick(trigger);
    await delay(600);
    const open = isSettingsPanelOpen();
    console.log(LOG_PREFIX, `[panel] 열림 상태: ${open}`);
    if (!open) {
      // 재시도: 일반 click
      trigger.click();
      await delay(600);
      return isSettingsPanelOpen();
    }
    return true;
  }

  async function closeSettingsPanel() {
    if (!isSettingsPanelOpen()) return;
    // 1차: 배지 다시 클릭 (토글)
    const trigger = findSettingsTrigger();
    if (trigger) {
      MangoDom.simulateClick(trigger);
      await delay(400);
      if (!isSettingsPanelOpen()) { console.log(LOG_PREFIX, '[panel] 닫힘 (배지)'); return; }
    }
    // 2차: Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(400);
    if (!isSettingsPanelOpen()) { console.log(LOG_PREFIX, '[panel] 닫힘 (Esc)'); return; }
    // 3차: 프롬프트 영역 클릭 (패널 외부)
    const promptEl = findPromptTextarea() || document.querySelector('[contenteditable]');
    if (promptEl) {
      MangoDom.simulateClick(promptEl);
      await delay(400);
      if (!isSettingsPanelOpen()) { console.log(LOG_PREFIX, '[panel] 닫힘 (프롬프트 클릭)'); return; }
    }
    // 4차: body 클릭
    document.body.click();
    await delay(400);
    console.log(LOG_PREFIX, `[panel] 닫기 시도 후 상태: ${isSettingsPanelOpen() ? '열림' : '닫힘'}`);
  }

  // 패널 내 버튼 클릭 (Image/Video, Landscape/Portrait 등)
  function isButtonSelected(btn) {
    // aria 속성 확인
    if (btn.getAttribute('aria-selected') === 'true') return true;
    if (btn.getAttribute('aria-pressed') === 'true') return true;
    if (btn.getAttribute('aria-checked') === 'true') return true;
    // CSS 클래스 확인
    const cl = btn.className || '';
    if (/selected|active|checked/i.test(cl)) return true;
    // computedStyle: 배경색 차이로 감지 (선택된 버튼은 보통 밝은 배경)
    try {
      const style = window.getComputedStyle(btn);
      const bg = style.backgroundColor;
      // 투명이 아닌 배경 = 선택 상태일 가능성
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        // 이것만으로 판단하진 않지만, 로그에 기록
      }
    } catch (e) {}
    return false;
  }

  // 패널 내 버튼 클릭 — 좌표 포함 + 여러 방법 시도
  async function panelClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const evtOpts = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: x, screenY: y };

    // 방법 1: PointerEvent + MouseEvent (좌표 포함)
    el.dispatchEvent(new PointerEvent('pointerdown', { ...evtOpts, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', evtOpts));
    await delay(50);
    el.dispatchEvent(new PointerEvent('pointerup', { ...evtOpts, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', evtOpts));
    el.dispatchEvent(new MouseEvent('click', evtOpts));

    // 방법 2: native el.click() (isTrusted: true)
    await delay(50);
    el.click();

    // 방법 3: focus + keyboard Enter/Space
    await delay(50);
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
  }

  async function clickSettingsButton(texts, settingName) {
    const elements = document.querySelectorAll(PANEL_CLICKABLE_SEL);

    // ── 1단계: XPath 정확 텍스트 (비표준 요소 대응, 가장 정확) ──
    for (const text of texts) {
      const el = findElementByExactText(text);
      if (el) {
        if (isButtonSelected(el)) {
          console.log(LOG_PREFIX, `[btn] ${settingName} 이미 선택 (xpath): "${text}"`);
          return true;
        }
        await panelClick(el);
        await delay(300);
        console.log(LOG_PREFIX, `[btn] ${settingName} 클릭 (xpath): "${text}" tag=${el.tagName}`);
        return true;
      }
    }

    // ── 2단계: Broad selector 정확 일치 ──
    for (const el of elements) {
      const elText = el.textContent?.trim() || '';
      for (const text of texts) {
        if (elText === text) {
          if (isButtonSelected(el)) {
            console.log(LOG_PREFIX, `[btn] ${settingName} 이미 선택: "${elText}"`);
            return true;
          }
          await panelClick(el);
          await delay(300);
          console.log(LOG_PREFIX, `[btn] ${settingName} 클릭: "${elText}" → selected=${isButtonSelected(el)}`);
          return true;
        }
      }
    }

    // ── 3단계: Broad selector 부분 일치 (배지 버튼 제외) ──
    for (const el of elements) {
      const elText = el.textContent?.trim() || '';
      // 배지 버튼 제외: crop 아이콘 + xN 패턴이 함께 있으면 배지
      if (/crop.*x[1-4]|x[1-4].*crop/.test(elText)) continue;
      for (const text of texts) {
        if (elText.includes(text) && elText.length < text.length + 15) {
          if (isButtonSelected(el)) {
            console.log(LOG_PREFIX, `[btn] ${settingName} 이미 선택 (fuzzy): "${elText}"`);
            return true;
          }
          await panelClick(el);
          await delay(300);
          console.log(LOG_PREFIX, `[btn] ${settingName} 클릭 (fuzzy): "${elText}"`);
          return true;
        }
      }
    }

    console.warn(LOG_PREFIX, `[btn] ${settingName} 못찾음: ${texts.join('/')}`);
    return false;
  }

  async function setMediaType(mode) {
    if (mode.includes('video')) {
      return await clickSettingsButton(['Video', '동영상', 'Videos'], 'Media type');
    }
    return await clickSettingsButton(['Image', '이미지', 'Images'], 'Media type');
  }

  async function setVideoSubMode(mode) {
    if (mode === 'image-video') {
      return await clickSettingsButton(['Frames', 'Frame', '프레임'], 'Video sub-mode');
    }
    // ingredients 모드는 추후 구현
    return false;
  }

  async function setAspectRatioNew(ratio) {
    const map = {
      '16:9': ['Landscape', '가로'],
      '9:16': ['Portrait', '세로'],
      '1:1': ['Square', '정사각형']
    };
    if (map[ratio]) return await clickSettingsButton(map[ratio], 'Aspect ratio');
    return false;
  }

  async function setOutputCountNew(count) {
    const target = `x${count}`;

    // 방법 1: Broad selector
    const elements = document.querySelectorAll(PANEL_CLICKABLE_SEL);
    for (const el of elements) {
      if (el.textContent?.trim() === target) {
        if (isButtonSelected(el)) {
          console.log(LOG_PREFIX, `[count] 이미 선택: ${target}`);
          return true;
        }
        await panelClick(el);
        await delay(300);
        console.log(LOG_PREFIX, `[count] 클릭: ${target} → selected=${isButtonSelected(el)}`);
        return true;
      }
    }

    // 방법 2: XPath fallback
    const el = findElementByExactText(target);
    if (el) {
      if (isButtonSelected(el)) {
        console.log(LOG_PREFIX, `[count] 이미 선택 (xpath): ${target}`);
        return true;
      }
      await panelClick(el);
      await delay(300);
      console.log(LOG_PREFIX, `[count] 클릭 (xpath): ${target} tag=${el.tagName}`);
      return true;
    }

    console.warn(LOG_PREFIX, `[count] ${target} 못찾음`);
    return false;
  }

  async function setModelNew(model) {
    const defs = {
      'imagen4':          { match: ['Imagen 4'], exclude: [] },
      'nano-banana-pro':  { match: ['Nano Banana Pro'], exclude: ['2'] },
      'nano-banana-2':    { match: ['Nano Banana 2'], exclude: [] },
      'nano-banana':      { match: ['Nano Banana'], exclude: ['Pro', '2'] },
      'veo-3':            { match: ['Veo 3'], exclude: ['3.1'] },
      'veo-3.1-fast':     { match: ['Veo 3.1', 'Fast'], exclude: [] },
      'veo-3.1-quality':  { match: ['Veo 3.1', 'Quality'], exclude: [] }
    };
    const def = defs[model] || { match: [model], exclude: [] };
    const matchesModel = (text) => {
      const l = text.toLowerCase();
      return def.match.every(n => l.includes(n.toLowerCase())) &&
             !def.exclude.some(ex => l.includes(ex.toLowerCase()));
    };

    console.log(LOG_PREFIX, `[model] 설정 시작: ${model}, 매칭 키워드: ${def.match.join('+')}`);

    // ── Step 1: 모델 드롭다운 트리거 찾기 ──
    // 패널 안에서 모델명이 적힌 드롭다운 (▼ 아이콘 포함)
    // x1~x4 버튼이나 Image/Video/Landscape/Portrait 버튼은 제외
    const skipTexts = ['Image', 'Video', 'Landscape', 'Portrait', '가로', '세로', '이미지', '동영상'];
    const modelKw = ['Nano', 'Banana', 'Imagen', 'Veo'];

    // DOM 스냅샷: 클릭 전 모든 요소 기록
    const beforeElems = new Set(document.querySelectorAll('*'));

    let dropdownTrigger = null;

    // 방법 1: 모든 클릭 가능 요소 중 모델 키워드가 있고, 설정 버튼이 아닌 것
    const clickables = document.querySelectorAll('button, [role="button"], [role="combobox"], [role="listbox"], [tabindex]');
    console.log(LOG_PREFIX, `[model] 클릭 가능 요소: ${clickables.length}개`);

    for (const el of clickables) {
      const text = el.textContent?.trim() || '';
      if (text.length > 80 || text.length < 3) continue;
      if (/^x[1-4]$/.test(text)) continue;
      if (skipTexts.some(s => text === s)) continue;

      if (modelKw.some(kw => text.includes(kw))) {
        // 이미 원하는 모델인지 확인
        if (matchesModel(text)) {
          console.log(LOG_PREFIX, `[model] 이미 선택됨: "${text.substring(0, 40)}"`);
          return;
        }
        // 배지 (하단 바)가 아닌, 패널 내부의 드롭다운인지 구별
        // 배지는 xN을 포함하고, 드롭다운은 모델명만 있음
        if (/x[1-4]/.test(text)) {
          console.log(LOG_PREFIX, `[model] 배지 스킵 (xN 포함): "${text.substring(0, 40)}"`);
          continue;
        }
        console.log(LOG_PREFIX, `[model] 드롭다운 후보: tag=${el.tagName}, role=${el.getAttribute('role')}, text="${text.substring(0, 40)}", classes="${(el.className || '').substring(0, 60)}"`);
        dropdownTrigger = el;
        break;
      }
    }

    // 방법 2: aria-haspopup 속성이 있는 요소
    if (!dropdownTrigger) {
      const popups = document.querySelectorAll('[aria-haspopup="true"], [aria-haspopup="listbox"], [aria-haspopup="menu"]');
      for (const el of popups) {
        const text = el.textContent?.trim() || '';
        if (modelKw.some(kw => text.includes(kw))) {
          console.log(LOG_PREFIX, `[model] aria-haspopup 발견: "${text.substring(0, 40)}"`);
          dropdownTrigger = el;
          break;
        }
      }
    }

    // 방법 3: arrow_drop_down 아이콘 근처
    if (!dropdownTrigger) {
      const icons = document.querySelectorAll('i, mat-icon');
      for (const icon of icons) {
        const iconText = icon.textContent?.trim();
        if (iconText === 'arrow_drop_down' || iconText === 'expand_more' || iconText === 'keyboard_arrow_down') {
          const parent = icon.closest('button, [role="button"], [tabindex]') || icon.parentElement;
          if (parent && modelKw.some(kw => parent.textContent?.includes(kw))) {
            console.log(LOG_PREFIX, `[model] 화살표 아이콘 근처 발견: "${parent.textContent?.trim()?.substring(0, 40)}"`);
            dropdownTrigger = parent;
            break;
          }
        }
      }
    }

    if (!dropdownTrigger) {
      // 진단: 패널의 모든 요소 덤프
      console.warn(LOG_PREFIX, '[model] 드롭다운 트리거 못찾음! 패널 내 요소 덤프:');
      const allBtns = document.querySelectorAll('button, [role="button"], [role="combobox"], [tabindex]');
      for (const b of allBtns) {
        const t = b.textContent?.trim() || '';
        if (t.length > 0 && t.length < 60) {
          console.log(LOG_PREFIX, `  - tag=${b.tagName} role=${b.getAttribute('role')} text="${t}" class="${(b.className||'').substring(0,40)}"`);
        }
      }
      return;
    }

    // ── Step 2: 드롭다운 열기 ──
    console.log(LOG_PREFIX, `[model] 드롭다운 클릭: "${dropdownTrigger.textContent?.trim()?.substring(0, 40)}"`);
    MangoDom.simulateClick(dropdownTrigger);
    await delay(500);

    // ── Step 3: 옵션 찾기 ──
    // 방법 A: 새로 나타난 요소 (DOM diff) — 리프 노드 우선
    const afterElems = document.querySelectorAll('*');
    const newElems = [];
    for (const el of afterElems) {
      if (!beforeElems.has(el)) newElems.push(el);
    }
    console.log(LOG_PREFIX, `[model] 새로 나타난 요소: ${newElems.length}개`);

    // 새 요소 중 모델명 매칭되는 것 수집 → 자식 수 적은 순 (리프 우선)
    // 여러 모델명을 가진 컨테이너 DIV는 제외
    const allModelKw = ['Nano Banana Pro', 'Nano Banana 2', 'Nano Banana', 'Imagen', 'Veo 3.1', 'Veo 3'];
    const countModelNames = (t) => {
      const lower = t.toLowerCase();
      return allModelKw.filter(kw => lower.includes(kw.toLowerCase())).length;
    };
    const newMatches = [];
    for (const el of newElems) {
      const text = el.textContent?.trim() || '';
      if (text.length > 80 || text.length < 3) continue;
      // 여러 모델명이 있는 컨테이너는 건너뛰기
      if (countModelNames(text) > 1) continue;
      if (matchesModel(text)) {
        newMatches.push({ el, text, children: el.children.length });
      }
    }
    newMatches.sort((a, b) => a.children - b.children);
    console.log(LOG_PREFIX, `[model] DOM diff 매칭: ${newMatches.length}개`);
    for (const m of newMatches) {
      console.log(LOG_PREFIX, `  - tag=${m.el.tagName} children=${m.children} text="${m.text.substring(0, 50)}"`);
    }
    // 리프 노드 클릭 (children 가장 적은 것, 트리거 자체 제외)
    for (const m of newMatches) {
      if (m.el === dropdownTrigger || dropdownTrigger.contains(m.el)) continue;
      console.log(LOG_PREFIX, `[model] ✓ DOM diff 선택: tag=${m.el.tagName}, children=${m.children}, text="${m.text.substring(0, 40)}"`);
      MangoDom.simulateClick(m.el);
      await delay(400);
      return;
    }

    // 새 요소 로그 (매칭 실패 시)
    if (newElems.length > 0 && newElems.length < 50) {
      console.log(LOG_PREFIX, '[model] 새 요소 전체 목록:');
      for (const el of newElems) {
        const t = el.textContent?.trim() || '';
        if (t.length > 0 && t.length < 60) {
          console.log(LOG_PREFIX, `  - tag=${el.tagName} children=${el.children.length} text="${t}" class="${(el.className||'').substring(0,40)}"`);
        }
      }
    }

    // 방법 B: Angular Material 오버레이 컨테이너
    const overlayContainers = document.querySelectorAll('.cdk-overlay-container, [class*="overlay"], [class*="popover"], [class*="dropdown-menu"], [class*="listbox"]');
    console.log(LOG_PREFIX, `[model] 오버레이 컨테이너: ${overlayContainers.length}개`);
    for (const container of overlayContainers) {
      const items = container.querySelectorAll('*');
      for (const item of items) {
        const text = item.textContent?.trim() || '';
        if (text.length > 60 || text.length < 3) continue;
        if (matchesModel(text) && item.offsetParent !== null) {
          console.log(LOG_PREFIX, `[model] ✓ 오버레이 매칭: tag=${item.tagName}, text="${text.substring(0, 40)}"`);
          MangoDom.simulateClick(item);
          await delay(400);
          return;
        }
      }
    }

    // 방법 C: role="option", role="menuitem" 등 표준 셀렉터
    const stdOptions = document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], mat-option');
    console.log(LOG_PREFIX, `[model] 표준 옵션 요소: ${stdOptions.length}개`);
    for (const opt of stdOptions) {
      const text = opt.textContent?.trim() || '';
      if (matchesModel(text)) {
        console.log(LOG_PREFIX, `[model] ✓ 표준 셀렉터 매칭: "${text.substring(0, 40)}"`);
        MangoDom.simulateClick(opt);
        await delay(400);
        return;
      }
    }

    // 방법 D: 가장 넓은 탐색 — 모든 요소 중 모델명 + 클릭 가능 (자식 없는 리프 노드)
    const allElements = document.querySelectorAll('div, span, li, a, button, p');
    let candidates = [];
    for (const el of allElements) {
      const text = el.textContent?.trim() || '';
      if (text.length > 60 || text.length < 3) continue;
      if (!matchesModel(text)) continue;
      if (el.offsetParent === null) continue; // hidden
      // 리프에 가까운 요소 우선 (자식 요소 수가 적은)
      const childCount = el.children.length;
      candidates.push({ el, text, childCount });
    }
    // 자식 수가 적은 순으로 정렬 (가장 구체적인 요소 우선)
    candidates.sort((a, b) => a.childCount - b.childCount);
    console.log(LOG_PREFIX, `[model] 전체 탐색 후보: ${candidates.length}개`);
    for (const c of candidates.slice(0, 5)) {
      console.log(LOG_PREFIX, `  - tag=${c.el.tagName} children=${c.childCount} text="${c.text.substring(0, 40)}" class="${(c.el.className||'').substring(0,40)}"`);
    }
    // 드롭다운 트리거 자체는 제외하고 클릭
    for (const c of candidates) {
      if (c.el === dropdownTrigger || dropdownTrigger.contains(c.el)) continue;
      console.log(LOG_PREFIX, `[model] ✓ 전체탐색 클릭: tag=${c.el.tagName}, text="${c.text.substring(0, 40)}"`);
      MangoDom.simulateClick(c.el);
      await delay(400);
      return;
    }

    // 실패
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(200);
    console.error(LOG_PREFIX, `[model] ✗ 옵션 못찾음: ${model}`);
  }

  async function applyAllSettings(mode, settings, isImageOutput) {
    const relevant = isImageOutput ?
      settings?.flowImage : (settings?.flowVideo || settings?.veo);
    const already = isImageOutput ? imageSettingsApplied : videoSettingsApplied;

    console.log(LOG_PREFIX, `[settings] mode=${mode}, isImage=${isImageOutput}, already=${already}, relevant=${JSON.stringify(relevant)?.substring(0, 100)}`);

    const opened = await openSettingsPanel();
    if (!opened) {
      console.warn(LOG_PREFIX, '[settings] 패널 못열음 → legacy fallback');
      await switchMode(mode);
      if (!already && relevant) {
        if (isImageOutput) { await applyImageSettings(settings); imageSettingsApplied = true; }
        else { await applyVideoSettings(settings); videoSettingsApplied = true; }
      }
      return;
    }

    await setMediaType(mode);
    await delay(300);

    // Video 서브모드 선택 (Frame / Ingredients)
    if (mode.includes('video')) {
      await setVideoSubMode(mode);
      await delay(300);
    }

    if (!already && relevant) {
      console.log(LOG_PREFIX, `[settings] 적용: model=${relevant.model}, ratio=${relevant.aspectRatio}, count=${relevant.outputCount}`);
      // 모델을 먼저 변경 (모델 변경 시 ratio/count가 리셋될 수 있음)
      if (relevant.model) { await setModelNew(relevant.model); await delay(500); }
      if (relevant.aspectRatio) await setAspectRatioNew(relevant.aspectRatio);
      if (relevant.outputCount) await setOutputCountNew(relevant.outputCount);
      if (isImageOutput) imageSettingsApplied = true;
      else videoSettingsApplied = true;
    }

    await closeSettingsPanel();
    console.log(LOG_PREFIX, 'Settings applied');
  }

  // ─── Prompt Input ───
  function findPromptTextarea() {
    // 1. by ID (PINHOLE_TEXT_AREA_ELEMENT_ID)
    let el = document.getElementById(SELECTORS.PROMPT_TEXTAREA_ID);
    if (el) { console.log(LOG_PREFIX, '[prompt] ID로 발견'); return el; }

    // 2. placeholder/aria-label 속성으로 textarea 검색
    el = document.querySelector(
      'textarea[placeholder*="create" i], textarea[placeholder*="만들"], textarea[placeholder*="want" i], ' +
      'textarea[aria-label*="create" i], textarea[aria-label*="prompt" i], textarea[aria-label*="만들"]'
    );
    if (el) { console.log(LOG_PREFIX, '[prompt] 속성으로 발견:', el.tagName); return el; }

    // 3. 생성 버튼(arrow_forward) 근처의 textarea 검색
    const genBtn = findGenerateButton();
    if (genBtn) {
      let container = genBtn.parentElement;
      for (let i = 0; i < 6 && container; i++) {
        const ta = container.querySelector('textarea:not([id*="recaptcha"])');
        if (ta) { console.log(LOG_PREFIX, '[prompt] 생성버튼 근처 textarea 발견'); return ta; }
        container = container.parentElement;
      }
    }

    // 4. 보이는 textarea 중 recaptcha 제외
    const allTextareas = document.querySelectorAll('textarea');
    for (const ta of allTextareas) {
      if ((ta.id || '').includes('recaptcha')) continue;
      if (ta.type === 'hidden') continue;
      if (ta.offsetHeight > 10 && ta.offsetWidth > 50) {
        console.log(LOG_PREFIX, `[prompt] 보이는 textarea: id="${ta.id}", ${ta.offsetWidth}x${ta.offsetHeight}`);
        return ta;
      }
    }

    // 5. 생성 버튼 근처의 contenteditable
    if (genBtn) {
      let container = genBtn.parentElement;
      for (let i = 0; i < 6 && container; i++) {
        const ce = container.querySelector('[contenteditable="true"]');
        if (ce && ce.offsetHeight > 10) {
          console.log(LOG_PREFIX, '[prompt] 생성버튼 근처 contenteditable 발견');
          return ce;
        }
        container = container.parentElement;
      }
    }

    // 6. 페이지 하단 근처의 contenteditable (프롬프트 영역)
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const ce of editables) {
      if (ce.offsetHeight > 10 && ce.offsetWidth > 100) {
        console.log(LOG_PREFIX, '[prompt] 보이는 contenteditable 발견');
        return ce;
      }
    }

    // 7. 디버그: 모든 textarea/contenteditable 덤프
    console.warn(LOG_PREFIX, '[prompt] 못찾음! textarea 목록:');
    for (const ta of allTextareas) {
      console.log(LOG_PREFIX, `  textarea: id="${ta.id}" placeholder="${(ta.placeholder||'').substring(0,30)}" size=${ta.offsetWidth}x${ta.offsetHeight}`);
    }
    for (const ce of document.querySelectorAll('[contenteditable="true"]')) {
      console.log(LOG_PREFIX, `  contenteditable: tag=${ce.tagName} id="${ce.id}" size=${ce.offsetWidth}x${ce.offsetHeight} text="${(ce.textContent||'').substring(0,30)}"`);
    }
    return null;
  }

  async function typePrompt(text) {
    // 설정 패널이 열려있으면 먼저 닫기
    await closeSettingsPanel();
    await delay(300);

    const input = findPromptTextarea();
    if (!input) throw new Error('Cannot find prompt input');

    const isTextarea = (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT');
    console.log(LOG_PREFIX, `[prompt] 발견: ${input.tagName}#${input.id}, isTextarea=${isTextarea}`);

    input.click();
    await delay(200);
    input.focus();
    await delay(100);

    if (isTextarea) {
      MangoDom.setTextareaValue(input, text);
    } else {
      // contenteditable div: 여러 방법 시도
      await typeIntoContentEditable(input, text);
    }
    await delay(300);

    // 검증
    const actual = isTextarea ? (input.value || '') : (input.textContent || '');
    if (actual.includes(text.substring(0, 20))) {
      console.log(LOG_PREFIX, `[prompt] 검증 OK: "${actual.substring(0, 40)}..."`);
    } else {
      console.warn(LOG_PREFIX, `[prompt] 검증 실패: "${actual.substring(0, 40)}"`);
    }
  }

  async function typeIntoContentEditable(input, text) {
    // Slate.js 에디터: 직접 DOM 조작(firstChild.remove()) 금지!
    // Slate가 추적하는 노드를 직접 삭제하면 React 재렌더 시 removeChild 크래시 발생
    // 반드시 execCommand 또는 clipboard API를 통해 Slate의 이벤트 핸들러 경유

    input.click();
    await delay(300);
    input.focus();
    await delay(200);

    // ── Slate-safe: execCommand로 기존 내용 선택 ──
    document.execCommand('selectAll', false, null);
    await delay(50);

    console.log(LOG_PREFIX, `[prompt] Slate 에디터 감지, execCommand 방식 사용`);

    // ── 방법 1: 클립보드 copy → paste (Slate-safe) ──
    try {
      const tmp = document.createElement('textarea');
      tmp.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
      tmp.value = text;
      document.body.appendChild(tmp);
      tmp.focus();
      tmp.select();
      document.execCommand('copy');
      document.body.removeChild(tmp);

      input.focus();
      await delay(100);
      // selectAll again (focus change might have deselected)
      document.execCommand('selectAll', false, null);
      await delay(50);
      const pasted = document.execCommand('paste');
      if (pasted && (input.textContent || '').includes(text.substring(0, 15))) {
        console.log(LOG_PREFIX, '[prompt] ✓ 방법1 성공 (Slate-safe clipboard paste)');
        return;
      }
      console.log(LOG_PREFIX, `[prompt] 방법1 paste=${pasted}, content="${(input.textContent||'').substring(0,30)}"`);
    } catch (e) {
      console.log(LOG_PREFIX, `[prompt] 방법1 에러: ${e.message}`);
    }

    // ── 방법 2: execCommand insertText (Slate-safe) ──
    try {
      input.focus();
      await delay(50);
      document.execCommand('selectAll', false, null);
      await delay(50);
      document.execCommand('insertText', false, text);
      await delay(200);
      if ((input.textContent || '').includes(text.substring(0, 15))) {
        console.log(LOG_PREFIX, '[prompt] ✓ 방법2 성공 (Slate-safe insertText)');
        return;
      }
      console.log(LOG_PREFIX, `[prompt] 방법2 content="${(input.textContent||'').substring(0,30)}"`);
    } catch (e) {
      console.log(LOG_PREFIX, `[prompt] 방법2 에러: ${e.message}`);
    }

    // ── 방법 3: Selection API + insertText (최후 수단) ──
    try {
      input.focus();
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const range = document.createRange();
        range.selectNodeContents(input);
        sel.addRange(range);
      }
      document.execCommand('insertText', false, text);
      console.log(LOG_PREFIX, '[prompt] 방법3 완료 (Selection API + insertText)');
    } catch (e) {
      console.log(LOG_PREFIX, `[prompt] 방법3 에러: ${e.message}`);
    }
  }

  // ─── Generate Button ───
  function findGenerateButton() {
    // Primary: XPath (button with arrow_forward icon)
    const byXPath = getByXPath(SELECTORS.GENERATE_BUTTON_XPATH);
    if (byXPath) return byXPath;

    // Fallback: find button with arrow_forward text in icon
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const icons = btn.querySelectorAll('i');
      for (const icon of icons) {
        if (icon.textContent.trim() === 'arrow_forward') return btn;
      }
    }

    // Fallback: text match
    for (const btn of buttons) {
      const text = btn.textContent || '';
      if ((text.includes('만들기') || text.includes('Create')) &&
          text.includes('arrow_forward')) {
        return btn;
      }
    }

    return null;
  }

  async function clickGenerate() {
    // Wait for button to be enabled
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const btn = findGenerateButton();
      if (btn && !btn.disabled) {
        MangoDom.simulateClick(btn);
        console.log(LOG_PREFIX, 'Generate button clicked');
        await delay(1000);
        return;
      }
      await delay(300);
    }
    throw new Error('Cannot find or click generate button');
  }

  // ─── Frame Upload (Image-to-Video) — New UI (Mar 2026) ───
  // 업로드 방법 우선순위: ClipboardEvent paste → file input → drag-drop
  // 프로그래밍 방식 DragEvent는 isTrusted=false라 Chrome이 파일 데이터 차단
  // 사용자 확인: Ctrl+C/V 붙여넣기는 동작함 → paste 방식 우선

  // 갤러리에 새 이미지 등장 대기 헬퍼
  async function waitForGalleryImage(countBefore, timeoutMs = 10000, prevSrcs = null) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // 방법 1: 갤러리 이미지 수 증가
      if (countGalleryImages() > countBefore) return true;
      // 방법 2: 새로운 src 등장 (갤러리 수 고정/교체 시)
      if (prevSrcs && prevSrcs.size > 0) {
        let hasNew = false;
        document.querySelectorAll('img[src]').forEach(img => {
          if (isGalleryImage(img) && !prevSrcs.has(img.src)) hasNew = true;
        });
        if (hasNew) return true;
      }
      await delay(500);
    }
    return false;
  }

  let _lastUploadedSourceUrl = null;  // 마지막 업로드한 소스 이미지 추적

  async function uploadFrame(imageDataUrl, position = 'first') {
    // 설정 패널이 열려있으면 갤러리 이미지를 가리므로 닫기
    if (isSettingsPanelOpen()) {
      console.log(LOG_PREFIX, '[frame] 설정 패널 열림 → 닫기 시도');
      await closeSettingsPanel();
      await delay(500);
    }

    // 소스 이미지 URL 추적 (HTTP URL 기준, dataUrl이면 앞부분 비교)
    const sourceKey = imageDataUrl.startsWith('http') ? imageDataUrl : imageDataUrl.substring(0, 200);
    const isNewSource = _lastUploadedSourceUrl !== null && _lastUploadedSourceUrl !== sourceKey;
    const isSameRetry = !isNewSource && _lastUploadedSourceUrl !== null;

    // HTTP URL → dataUrl 변환 (MangoHub 이미지)
    if (imageDataUrl.startsWith('http')) {
      console.log(LOG_PREFIX, '[frame] HTTP URL → dataURL 변환');
      try {
        const resp = await fetch(imageDataUrl);
        const blob = await resp.blob();
        imageDataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.error(LOG_PREFIX, '[frame] URL→dataURL 변환 실패:', e);
        return false;
      }
    }

    const imgCountBefore = countGalleryImages();
    // 업로드 전 갤러리 이미지 src 스냅샷 (새 이미지 식별용)
    const prevGallerySrcs = new Set();
    document.querySelectorAll('img[src]').forEach(img => {
      if (isGalleryImage(img)) prevGallerySrcs.add(img.src);
    });
    console.log(LOG_PREFIX, `[frame] 갤러리 이미지: ${imgCountBefore}개 (src ${prevGallerySrcs.size}종), 새소스=${isNewSource}, 재시도=${isSameRetry}`);

    // 재시도(같은 이미지) + 갤러리에 이미지 있으면 업로드 스킵
    // 새 소스이미지면 갤러리 상태 무관하게 항상 업로드
    const shouldUpload = isNewSource || imgCountBefore === 0;
    if (shouldUpload) {
      const file = MangoDom.dataUrlToFile(imageDataUrl, `frame-${Date.now()}.png`);
      console.log(LOG_PREFIX, `[frame] 업로드 시작: ${file.name}, ${file.size}bytes`);
      let uploaded = false;
      let apiTriggered = false;  // API가 호출되었는지 (400이면 재시도 무의미)

      // ── 방법 1 (우선): hidden file input (확인된 방법 — 실제 uploadImage API 호출) ──
      const fileInput = MangoDom.findFileInput();
      if (fileInput) {
        console.log(LOG_PREFIX, '[frame] file input으로 업로드:', fileInput.accept || 'any');
        apiTriggered = true;  // file input은 확실히 API 호출
        await MangoDom.attachFileToInput(fileInput, file);
        uploaded = await waitForGalleryImage(imgCountBefore, 12000, prevGallerySrcs);
        if (uploaded) {
          console.log(LOG_PREFIX, '[frame] ✓ file input 업로드 성공');
        } else {
          // API는 호출됐으나 갤러리 미등장 → 서버가 이미지 거부 (400 등)
          console.error(LOG_PREFIX, '[frame] ✗ 서버가 이미지 거부 (API 호출됨, 갤러리 미등장)');
          // 다른 방법 시도해봤자 같은 결과 → 바로 실패 반환
          return false;
        }
      }

      // ── 방법 2: ClipboardEvent paste (file input 없을 때만) ──
      if (!uploaded && !apiTriggered) {
        console.log(LOG_PREFIX, '[frame] 방법2: ClipboardEvent paste');
        try {
          const textarea = findPromptTextarea();
          const pasteTarget = textarea || document.querySelector('[contenteditable]') || document.body;
          if (textarea) { textarea.focus(); await delay(100); }
          const dt = new DataTransfer();
          dt.items.add(file);
          pasteTarget.dispatchEvent(new ClipboardEvent('paste', {
            bubbles: true, cancelable: true, clipboardData: dt
          }));
          console.log(LOG_PREFIX, '[frame] paste 이벤트 발송 → 대기...');
          uploaded = await waitForGalleryImage(imgCountBefore, 10000, prevGallerySrcs);
          if (uploaded) console.log(LOG_PREFIX, '[frame] ✓ paste 성공');
        } catch (e) {
          console.warn(LOG_PREFIX, '[frame] paste 실패:', e.message);
        }
      }

      // ── 방법 3: drag-drop (위 방법 모두 실패 시) ──
      if (!uploaded && !apiTriggered) {
        console.log(LOG_PREFIX, '[frame] 방법3: drag-drop');
        const textarea = findPromptTextarea();
        const targets = [
          textarea,
          document.querySelector('[class*="drop"]'),
          document.querySelector('main'),
          document.body
        ].filter(Boolean);
        for (const target of targets) {
          const dt = new DataTransfer();
          dt.items.add(file);
          for (const evtName of ['dragenter', 'dragover', 'drop']) {
            target.dispatchEvent(new DragEvent(evtName, {
              bubbles: true, cancelable: true, dataTransfer: dt
            }));
            await delay(100);
          }
          await delay(2000);
          if (countGalleryImages() > imgCountBefore) {
            uploaded = true;
            console.log(LOG_PREFIX, `[frame] ✓ drag-drop 성공: ${target.tagName}`);
            break;
          }
        }
      }

      if (!uploaded) {
        console.error(LOG_PREFIX, '[frame] ✗ 이미지 업로드 실패');
      }
      await delay(1000);
    } else {
      console.log(LOG_PREFIX, '[frame] 갤러리에 이미지 존재 → 업로드 스킵, 프롬프트에 추가만 수행');
    }

    // 업로드 성공 또는 기존 이미지 사용 → 소스 추적 업데이트
    _lastUploadedSourceUrl = sourceKey;

    // 업로드 후 새로 추가된 이미지 찾기 (스냅샷 비교)
    let newlyUploadedImg = null;
    if (shouldUpload) {
      document.querySelectorAll('img[src]').forEach(img => {
        if (isGalleryImage(img) && !prevGallerySrcs.has(img.src)) {
          newlyUploadedImg = img;
        }
      });
      if (newlyUploadedImg) {
        console.log(LOG_PREFIX, `[frame] 새로 업로드된 이미지 식별: ${newlyUploadedImg.src.substring(0, 80)}`);
      } else {
        console.warn(LOG_PREFIX, '[frame] 새 이미지 src 변경 감지 실패 → 갤러리 마지막 이미지 사용');
      }
    }

    // 항상 실행: ⋮ 메뉴 → "Animate" (프레임을 영상 생성용으로 설정)
    // 새로 업로드한 이미지를 명시적으로 전달하여 정확한 이미지에 Animate 실행
    const animated = await addImageToPromptViaMenu(newlyUploadedImg);
    if (animated) {
      console.log(LOG_PREFIX, '[frame] ✓ Animate 완료');
      return true;
    }

    console.error(LOG_PREFIX, '[frame] ✗ Animate 실패');
    return false;
  }

  function isGalleryImage(img) {
    const src = img.src || '';
    if (!src) return false;
    // 아바타 제외
    if (src.includes('googleusercontent.com') && src.includes('/a/')) return false;
    // SVG 아이콘 제외
    if (src.startsWith('data:image/svg')) return false;
    // 크기 기반 감지: 갤러리 이미지는 80px 이상, 아이콘/아바타는 작음
    const w = img.naturalWidth || img.offsetWidth || img.width || 0;
    const h = img.naturalHeight || img.offsetHeight || img.height || 0;
    if (w > 80 && h > 80) return true;
    // URL 패턴 폴백 (크기 정보 없을 때)
    if (src.includes('googleapis.com')) return true;
    if (src.includes('googleusercontent.com')) return true;
    if (src.startsWith('blob:')) return true;
    return false;
  }

  function countGalleryImages() {
    let count = 0;
    document.querySelectorAll('img[src]').forEach(img => {
      if (isGalleryImage(img)) count++;
    });
    if (count === 0) {
      // 디버그: 왜 0인지 확인
      const allImgs = document.querySelectorAll('img[src]');
      if (allImgs.length > 0) {
        console.log(LOG_PREFIX, `[gallery] img 총 ${allImgs.length}개, 갤러리 매칭 0. 샘플:`,
          [...allImgs].slice(0, 5).map(i => `${i.offsetWidth}x${i.offsetHeight} src=${(i.src||'').substring(0, 80)}`).join(' | '));
      }
    }
    return count;
  }

  async function addImageToPromptViaMenu(specificImage = null) {
    let targetImg = null;

    if (specificImage) {
      // 명시적으로 전달된 이미지 사용 (새로 업로드한 이미지)
      const rect = specificImage.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        targetImg = specificImage;
        console.log(LOG_PREFIX, `[frame] 명시된 이미지 사용: ${specificImage.src.substring(0, 80)}`);
      } else {
        console.warn(LOG_PREFIX, '[frame] 명시된 이미지가 보이지 않음 → 갤러리에서 검색');
      }
    }

    if (!targetImg) {
      // 갤러리 이미지 찾기 — 가장 최근 (마지막) 이미지
      const galleryImages = [];
      const allGalleryImages = [];
      document.querySelectorAll('img[src]').forEach(img => {
        if (isGalleryImage(img)) {
          allGalleryImages.push(img);
          if (img.offsetParent !== null && img.offsetWidth > 50) {
            galleryImages.push(img);
          }
        }
      });

      const candidates = galleryImages.length > 0 ? galleryImages : allGalleryImages;
      if (candidates.length === 0) {
        console.warn(LOG_PREFIX, '[frame] 갤러리에 이미지 없음');
        return false;
      }

      targetImg = candidates[candidates.length - 1];
    }
    const imgRect = targetImg.getBoundingClientRect();
    console.log(LOG_PREFIX, `[frame] 대상 이미지: ${targetImg.src.substring(0, 80)}... (${Math.round(imgRect.width)}x${Math.round(imgRect.height)} at ${Math.round(imgRect.left)},${Math.round(imgRect.top)})`);

    // 이미지 위에 직접 호버 (⋮ 버튼 표시 트리거)
    // 이미지 + 부모 레벨들에 호버 이벤트 전파
    const hoverTargets = [targetImg];
    let parent = targetImg.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      hoverTargets.push(parent);
      parent = parent.parentElement;
    }

    function dispatchHover(targets, x, y) {
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
      const pOpts = { ...opts, pointerId: 1, pointerType: 'mouse' };
      for (const t of targets) {
        t.dispatchEvent(new PointerEvent('pointerenter', pOpts));
        t.dispatchEvent(new PointerEvent('pointerover', pOpts));
        t.dispatchEvent(new PointerEvent('pointermove', pOpts));
        t.dispatchEvent(new MouseEvent('mouseenter', opts));
        t.dispatchEvent(new MouseEvent('mouseover', opts));
        t.dispatchEvent(new MouseEvent('mousemove', opts));
      }
    }

    // 1차 호버: 이미지 중앙
    dispatchHover(hoverTargets, imgRect.left + imgRect.width / 2, imgRect.top + imgRect.height / 2);
    await delay(600);

    // ⋮ 버튼 찾기: 이미지에 가장 가까운 more 버튼 (근접도 기반)
    let moreBtn = findClosestMoreButton(targetImg);

    if (!moreBtn) {
      // 2차 호버: 이미지 우상단 (⋮ 버튼이 보통 여기에 나타남)
      console.log(LOG_PREFIX, '[frame] ⋮ 버튼 없음 → 우상단 호버 재시도');
      dispatchHover(hoverTargets, imgRect.right - 20, imgRect.top + 20);
      await delay(800);
      moreBtn = findClosestMoreButton(targetImg);
    }

    if (!moreBtn) {
      // 디버그: 페이지 내 모든 ⋮ 후보 출력
      const allBtns = findAllMoreButtons();
      console.error(LOG_PREFIX, `[frame] ⋮ 버튼 최종 실패. 페이지 내 more 버튼 ${allBtns.length}개:`,
        allBtns.map(({ btn, dist }) => {
          const r = btn.getBoundingClientRect();
          return `"${btn.textContent?.trim()?.substring(0, 15)}" dist=${Math.round(dist)} pos=(${Math.round(r.left)},${Math.round(r.top)})`;
        }).join(' | '));
      return false;
    }

    const moreBtnRect = moreBtn.getBoundingClientRect();
    console.log(LOG_PREFIX, `[frame] ⋮ 버튼 발견 (이미지 근접): text="${moreBtn.textContent?.trim()?.substring(0, 20)}", pos=(${Math.round(moreBtnRect.left)},${Math.round(moreBtnRect.top)})`);

    // 클릭 전 <a> 부모 네비게이션 차단
    const anchorParent = moreBtn.closest('a');
    const preventNav = (e) => { e.preventDefault(); e.stopPropagation(); };
    if (anchorParent) {
      anchorParent.addEventListener('click', preventNav, { capture: true });
    }

    // 전체 마우스 이벤트 시퀀스
    const btnX = moreBtnRect.left + moreBtnRect.width / 2;
    const btnY = moreBtnRect.top + moreBtnRect.height / 2;
    const clickOpts = { bubbles: true, cancelable: true, clientX: btnX, clientY: btnY, button: 0 };
    const ptrOpts = { ...clickOpts, pointerId: 1, pointerType: 'mouse' };
    moreBtn.dispatchEvent(new PointerEvent('pointerdown', ptrOpts));
    moreBtn.dispatchEvent(new MouseEvent('mousedown', clickOpts));
    await delay(80);
    moreBtn.dispatchEvent(new PointerEvent('pointerup', ptrOpts));
    moreBtn.dispatchEvent(new MouseEvent('mouseup', clickOpts));
    moreBtn.dispatchEvent(new MouseEvent('click', clickOpts));
    await delay(800);

    // 메뉴 열림 확인 → 안 열렸으면 .click() 폴백
    let menuOpened = hasMenuOverlay();
    if (!menuOpened) {
      console.log(LOG_PREFIX, '[frame] 이벤트 시퀀스로 메뉴 안 열림 → .click() 폴백');
      moreBtn.click();
      await delay(800);
      menuOpened = hasMenuOverlay();
    }

    if (anchorParent) {
      anchorParent.removeEventListener('click', preventNav, { capture: true });
    }

    // 메뉴가 열렸는지 확인 (Rename/Delete가 아닌 Animate가 있어야 함)
    if (menuOpened) {
      const menuItems = getVisibleMenuItems();
      console.log(LOG_PREFIX, `[frame] 메뉴 아이템: ${menuItems.map(t => `"${t}"`).join(', ')}`);
      // Rename/Delete만 있으면 잘못된 ⋮ 버튼 (프로젝트 메뉴)
      if (menuItems.some(t => /rename/i.test(t)) && !menuItems.some(t => /animate|애니메이션/i.test(t))) {
        console.warn(LOG_PREFIX, '[frame] 프로젝트 메뉴 열림 (Rename/Delete) → 닫고 실패 처리');
        document.body.click(); // 메뉴 닫기
        await delay(300);
        return false;
      }
    }

    return await clickAnimateMenuItem();
  }

  // 모든 ⋮ (more) 버튼을 찾아 이미지와의 거리 포함 반환
  function findAllMoreButtons() {
    const results = [];
    document.querySelectorAll('button').forEach(btn => {
      const icon = btn.querySelector('i, mat-icon, .material-icons');
      const iconText = icon?.textContent?.trim() || '';
      const text = btn.textContent?.trim() || '';
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      const isMore = iconText === 'more_vert' || iconText === 'more_horiz' ||
        text === '⋮' || text === '⋯' || text === 'more_vert' || text === 'more_horiz' ||
        /^more_vert/i.test(text) ||
        label.includes('more') || label.includes('옵션') || label.includes('메뉴');
      if (isMore) {
        const r = btn.getBoundingClientRect();
        results.push({ btn, rect: r, dist: 0 });
      }
    });
    return results;
  }

  // 대상 이미지에 가장 가까운 ⋮ 버튼 찾기 (이미지 영역 내부/근접 우선)
  function findClosestMoreButton(targetImg) {
    const imgRect = targetImg.getBoundingClientRect();
    const imgCx = imgRect.left + imgRect.width / 2;
    const imgCy = imgRect.top + imgRect.height / 2;
    const allBtns = findAllMoreButtons();
    for (const item of allBtns) {
      const r = item.rect;
      // 이미지 영역 내에 있는지 (마진 30px)
      item.insideImage = r.left >= imgRect.left - 30 && r.right <= imgRect.right + 30 &&
                         r.top >= imgRect.top - 30 && r.bottom <= imgRect.bottom + 30;
      item.dist = Math.hypot(
        (r.left + r.width / 2) - imgCx,
        (r.top + r.height / 2) - imgCy
      );
    }
    // 이미지 내부 버튼 우선, 그 다음 거리순
    allBtns.sort((a, b) => {
      if (a.insideImage && !b.insideImage) return -1;
      if (!a.insideImage && b.insideImage) return 1;
      return a.dist - b.dist;
    });
    // 이미지 내부 버튼만 반환 (외부 버튼은 프로젝트 메뉴일 가능성 높음)
    const inside = allBtns.filter(b => b.insideImage);
    if (inside.length > 0) return inside[0].btn;
    // 이미지 내부에 없으면 매우 가까운 것만 (100px 이내)
    const nearby = allBtns.filter(b => b.dist < 100);
    return nearby.length > 0 ? nearby[0].btn : null;
  }

  // 메뉴 오버레이가 열려있는지 확인
  function hasMenuOverlay() {
    const overlays = document.querySelectorAll('[role="menu"], [role="listbox"], .cdk-overlay-pane, .mat-mdc-menu-panel, .mdc-menu-surface');
    return [...overlays].some(o => o.children.length > 0 && o.offsetParent !== null);
  }

  // 현재 열린 메뉴의 아이템 텍스트 목록
  function getVisibleMenuItems() {
    const texts = [];
    document.querySelectorAll('[role="menuitem"], [role="option"]').forEach(el => {
      if (el.offsetParent !== null) {
        const t = el.textContent?.trim();
        if (t && t.length < 50) texts.push(t);
      }
    });
    return texts;
  }

  async function clickAnimateMenuItem() {
    // 우선순위: Animate (이미지→영상) > Add to Prompt (폴백)
    const animateTexts = ['Animate', '애니메이션', '애니메이트'];
    const addTexts = ['Add to Prompt', 'Add to prompt', '프롬프트에 추가'];

    // 메뉴가 나타날 때까지 대기 + 텍스트 매칭
    for (let attempt = 0; attempt < 8; attempt++) {
      // 메뉴/오버레이 컨테이너 (⋮ 클릭 후 드롭다운)
      const menuSel = '[role="menu"], [role="listbox"], [role="dialog"], .cdk-overlay-pane, .mat-mdc-menu-panel, .mdc-menu-surface';
      const menuContainers = document.querySelectorAll(menuSel);
      // 메뉴 컨테이너 내 아이템 + 전체 검색
      const allElements = [];
      menuContainers.forEach(mc => {
        mc.querySelectorAll('[role="menuitem"], [role="option"], button, li, a, div[tabindex], span').forEach(el => allElements.push(el));
      });
      // 전역 폴백
      document.querySelectorAll('[role="menuitem"], [role="option"]').forEach(el => {
        if (!allElements.includes(el)) allElements.push(el);
      });

      // 디버그: 첫 시도에서 메뉴 아이템 목록 출력
      if (attempt === 0) {
        const menuItems = [...allElements].filter(el => el.offsetParent !== null && el.textContent?.trim().length > 0 && el.textContent.trim().length < 50);
        console.log(LOG_PREFIX, `[frame] 메뉴 아이템 ${menuItems.length}개:`,
          menuItems.slice(0, 10).map(el => `"${el.textContent.trim().substring(0, 30)}" [${el.tagName}${el.getAttribute('role') ? ' role=' + el.getAttribute('role') : ''}]`).join(', '));
      }

      // 1차: Animate 우선 검색
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        if (animateTexts.some(t => text.includes(t)) && el.offsetParent !== null) {
          console.log(LOG_PREFIX, `[frame] "Animate" 발견: "${text.substring(0, 40)}"`);
          el.click();
          await delay(500);
          return true;
        }
      }
      // 2차: Add to Prompt 폴백
      for (const el of allElements) {
        const text = el.textContent?.trim() || '';
        if (addTexts.some(t => text.includes(t)) && el.offsetParent !== null) {
          console.log(LOG_PREFIX, `[frame] "Add to Prompt" 발견 (폴백): "${text.substring(0, 40)}"`);
          el.click();
          await delay(500);
          return true;
        }
      }
      await delay(400);
    }

    // 방법 2: 아이콘 기반 매칭 (animation/add 아이콘)
    const items = document.querySelectorAll('[role="menuitem"], li, div, button');
    for (const item of items) {
      const icon = item.querySelector('i, mat-icon, .material-icons');
      const iconText = icon?.textContent?.trim();
      const text = item.textContent?.trim() || '';
      if ((iconText === 'animation' || iconText === 'slow_motion_video' || iconText === 'movie' ||
           iconText === 'animated_images' || iconText === 'play_arrow') &&
          text.length < 50 && item.offsetParent !== null) {
        console.log(LOG_PREFIX, `[frame] animation 아이콘 메뉴: icon="${iconText}", text="${text.substring(0, 40)}"`);
        item.click();
        await delay(500);
        return true;
      }
    }

    // 방법 3: XPath 텍스트 매칭
    for (const txt of ['Animate', '애니메이션']) {
      const el = findElementByExactText(txt);
      if (el && el.offsetParent !== null) {
        console.log(LOG_PREFIX, `[frame] XPath "${txt}" 발견`);
        el.click();
        await delay(500);
        return true;
      }
    }

    // 디버그: 화면 전체 메뉴 요소 덤프
    const allMenuItems = document.querySelectorAll('[role="menuitem"], [role="option"], .cdk-overlay-pane *, .mat-mdc-menu-panel *');
    console.error(LOG_PREFIX, `[frame] "Animate" 메뉴 못찾음. 전체 메뉴요소 ${allMenuItems.length}개:`,
      [...allMenuItems].filter(el => el.textContent?.trim().length > 0 && el.textContent.trim().length < 50)
        .slice(0, 15).map(el => `"${el.textContent.trim().substring(0, 30)}" [${el.tagName}]`).join(', '));
    return false;
  }

  function isFrameAttached() {
    // 프롬프트 영역 근처에 프레임 이미지가 첨부되었는지 확인
    // 프롬프트 입력 영역 근처에 작은 이미지 썸네일이 보이면 첨부된 상태
    const textarea = findPromptTextarea();
    if (!textarea) return false;
    let container = textarea;
    for (let i = 0; i < 6; i++) {
      container = container.parentElement;
      if (!container) break;
      const imgs = container.querySelectorAll('img');
      for (const img of imgs) {
        if (img.offsetWidth > 20 && img.offsetWidth < 200 && img.offsetParent !== null) {
          return true;
        }
      }
    }
    return false;
  }

  // ─── Generation Progress Detection ───
  function countGeneratingItems() {
    let count = 0;

    // Method 1: progress_activity icons
    const icons = document.querySelectorAll('i');
    for (const icon of icons) {
      if (icon.textContent?.trim() === 'progress_activity') count++;
    }

    // Method 2: percentage text (24%, 45%, etc.)
    if (count === 0) {
      const allElements = document.querySelectorAll('div, span');
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        if (/^\d{1,3}%$/.test(text) && el.children.length === 0) count++;
      }
    }

    return count;
  }

  // 이전 에러 텍스트 스냅샷 (새 에러만 감지하기 위해)
  let _errorSnapshotTexts = new Set();

  // 화면에 남아있는 에러/경고 DOM 요소 강제 제거 + 스냅샷
  function dismissVisibleErrors() {
    const selectors = [
      '[role="alert"]', '[class*="snackbar"]', '[class*="snack"]',
      'mat-snack-bar', '[class*="toast"]',
      '[class*="error"]', '[class*="warning"]'
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => {
        const text = el.textContent.trim().toLowerCase();
        for (const phrase of ERROR_PHRASES) {
          if (text.includes(phrase.toLowerCase())) {
            el.remove();
            console.log(LOG_PREFIX, 'Removed lingering error DOM:', text.substring(0, 50));
            return;
          }
        }
      });
    }

    // 현재 보이는 에러 텍스트를 스냅샷 (제거 안 되는 것도 기록하여 이후 무시)
    _errorSnapshotTexts.clear();
    const candidates = document.querySelectorAll('div, span, p, h1, h2, h3');
    for (const el of candidates) {
      if (el.offsetParent === null) continue;
      if (el.children.length > 5) continue; // checkForErrors와 동일 기준
      const text = el.textContent?.trim() || '';
      if (text.length < 3 || text.length > 500) continue;
      const lower = text.toLowerCase();
      // 모든 STRONG_ERROR_PATTERNS으로 스냅샷 (검열, 실패 등 모두 포함)
      for (const pattern of STRONG_ERROR_PATTERNS) {
        if (lower.includes(pattern)) {
          _errorSnapshotTexts.add(text);
          console.log(LOG_PREFIX, `Snapshot existing error: "${text.substring(0, 80)}"`);
          break;
        }
      }
    }
  }

  async function waitForGenerationComplete(timeoutMin) {
    const timeout = (timeoutMin || 10) * 60 * 1000;
    console.log(LOG_PREFIX, `Waiting for generation (timeout: ${timeoutMin}min)...`);

    // 이전 에러 DOM이 남아있으면 제거 (재시도 시 중요)
    dismissVisibleErrors();

    const start = Date.now();
    const checkInterval = 5000;
    let inlineRetryCount = 0; // Audio failed 등 인라인 재시도 횟수

    // Give it time to start
    await delay(5000);

    while (Date.now() - start < timeout) {
      checkStopped();

      // Check if API result arrived first (inject.js가 가장 신뢰할 수 있음)
      if (lastApiResult) {
        if (lastApiResult.ok && lastApiResult.hasMedia) {
          console.log(LOG_PREFIX, 'Generation complete (API result)');
          return;
        }
        // 비디오 완료됨 (URL은 못 찾았지만 생성 자체는 성공)
        if (lastApiResult.ok && lastApiResult.videoCompleted) {
          console.log(LOG_PREFIX, 'Generation complete (API: videoCompleted, URL은 DOM에서 탐색)');
          return;
        }
        if (!lastApiResult.ok) {
          // API 에러도 인라인 복구 시도
          const apiErrText = lastApiResult.error || 'Unknown';
          const apiErrType = classifyError(apiErrText);
          console.log(LOG_PREFIX, `API error: type=${apiErrType}, "${apiErrText.substring(0, 80)}"`);

          if (apiErrType === 'AUDIO_FAILED' && inlineRetryCount < 2) {
            console.log(LOG_PREFIX, `Audio failed (API) → Retry 버튼 클릭 시도 (${inlineRetryCount + 1}/2)...`);
            lastApiResult = null; // API 결과 초기화
            await delay(2000);
            const clicked = await clickRetryButton();
            if (clicked) {
              inlineRetryCount++;
              await delay(5000);
              continue;
            }
          }

          const e = new Error(`API error: ${apiErrText}`);
          e.errorCode = lastApiResult.errorCode || apiErrType;
          throw e;
        }
        // API 200 OK이지만 미디어 없음 → DOM에서도 확인 후 판단
        if (lastApiResult.ok && !lastApiResult.hasMedia) {
          const hasNewMedia = checkForNewMedia();
          if (hasNewMedia) {
            console.log(LOG_PREFIX, 'Generation complete (API ok + DOM media detected)');
            return;
          }
          // DOM에도 없으면 좀 더 기다려봄 (즉시 에러 던지지 않음)
          console.log(LOG_PREFIX, 'API ok but no media yet, waiting for DOM...');
        }
      }

      // Check progress indicators FIRST (생성 진행 중이면 DOM 에러 무시)
      const generating = countGeneratingItems();
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (generating > 0) {
        console.log(LOG_PREFIX, `Generating... ${elapsed}s (${generating} items in progress)`);

        // 20초 이상: 스피너 있어도 DOM 에러 체크 (생성 실패 시 스피너와 에러가 공존)
        if (elapsed > 20) {
          const errText = checkForErrors();
          if (errText) {
            const recovered = await tryInlineRecovery(errText, inlineRetryCount);
            if (recovered) {
              inlineRetryCount++;
              continue;
            }
            const errType = classifyError(errText);
            console.log(LOG_PREFIX, `Generation error (spinner+): type=${errType}, "${errText.substring(0, 80)}"`);
            const e = new Error(`Generation error: ${errText}`);
            e.errorCode = errType;
            throw e;
          }
        }

        // 60초 이상: 스피너 있어도 미디어 체크 (스피너가 사라지지 않는 경우 대비)
        if (elapsed > 60) {
          const hasNewMedia = checkForNewMedia();
          if (hasNewMedia) {
            console.log(LOG_PREFIX, 'Generation complete (media detected despite progress indicators)');
            return;
          }
        }
      } else {
        // 진행 표시 없을 때만 DOM 에러 체크 (API result보다 후순위)
        const errText = checkForErrors();
        if (errText) {
          const recovered = await tryInlineRecovery(errText, inlineRetryCount);
          if (recovered) {
            inlineRetryCount++;
            continue;
          }
          const errType = classifyError(errText);
          console.log(LOG_PREFIX, `Generation error: type=${errType}, "${errText.substring(0, 80)}"`);
          const e = new Error(`Generation error: ${errText}`);
          e.errorCode = errType;
          throw e;
        }

        if (elapsed > 10) {
          // No progress indicators and no API result - check for new videos/images
          const hasNewMedia = checkForNewMedia();
          if (hasNewMedia) {
            console.log(LOG_PREFIX, 'Generation complete (media detected)');
            return;
          }
        }
      }

      await delay(checkInterval);
    }

    throw new Error('Generation timed out');
  }

  // ─── Inline Recovery: 에러 타입에 따라 flow.js 내에서 복구 시도 ───
  async function tryInlineRecovery(errorText, retryCount) {
    const errType = classifyError(errorText);

    // AUDIO_FAILED → Retry 버튼 클릭 (최대 2회)
    if (errType === 'AUDIO_FAILED' && retryCount < 2) {
      console.log(LOG_PREFIX, `Audio failed → Retry 버튼 클릭 시도 (${retryCount + 1}/2)...`);
      _errorSnapshotTexts.add(errorText); // 이 에러 텍스트 이후 무시
      lastApiResult = null; // API 결과 초기화 (재생성 감지를 위해)
      await delay(1000);
      const clicked = await clickRetryButton();
      if (clicked) {
        console.log(LOG_PREFIX, 'Retry 버튼 클릭 성공 → 재생성 대기');
        await delay(5000); // 재시작 대기
        return true;
      }
      console.log(LOG_PREFIX, 'Retry 버튼 못 찾음 → 에러 throw');
    }

    // SOMETHING_WRONG, CENSORSHIP, GENERATION_FAILED → background.js에서 처리 (full retry)
    return false;
  }

  let existingVideos = new Set();
  let existingImages = new Set();

  function snapshotExistingMedia() {
    document.querySelectorAll('video[src]').forEach(el => existingVideos.add(el.src));
    document.querySelectorAll('video source[src]').forEach(el => existingVideos.add(el.src));
    document.querySelectorAll('img[src]').forEach(el => existingImages.add(el.src));
  }

  function checkForNewMedia() {
    // 새 비디오 감지 (storage.googleapis.com 또는 기타 http URL)
    const videos = document.querySelectorAll('video[src]');
    for (const v of videos) {
      if (v.src && !existingVideos.has(v.src) &&
          v.src.startsWith('http') && !v.src.startsWith('blob:')) {
        console.log(LOG_PREFIX, `New video detected: ${v.src.substring(0, 80)}`);
        return true;
      }
    }
    // video > source 엘리먼트 체크
    const sources = document.querySelectorAll('video source[src]');
    for (const s of sources) {
      if (s.src && !existingVideos.has(s.src) && s.src.startsWith('http')) {
        console.log(LOG_PREFIX, `New video source detected: ${s.src.substring(0, 80)}`);
        return true;
      }
    }
    // 새 이미지 감지
    const images = document.querySelectorAll('img[src]');
    for (const img of images) {
      if (img.src && !existingImages.has(img.src) &&
          img.src.includes('storage.googleapis.com')) {
        return true;
      }
    }
    return false;
  }

  // ─── Video URL Extraction ───
  async function getVideoUrl() {
    // Method 1: API result
    if (lastApiResult?.ok && lastApiResult.mediaUrls?.length > 0) {
      return lastApiResult.mediaUrls[0];
    }

    // Method 2: Find video elements (resolved .src property, not getAttribute)
    const videos = document.querySelectorAll('video[src]');
    for (const video of videos) {
      const src = video.src; // resolved absolute URL
      if (src && !src.startsWith('blob:') && !src.startsWith('data:') &&
          src.includes('storage.googleapis.com')) {
        return src;
      }
    }

    // Method 3: Any new video with http URL
    for (const video of videos) {
      const src = video.src; // resolved absolute URL
      if (src && src.startsWith('http') && !existingVideos.has(src)) {
        return src;
      }
    }

    return null;
  }

  // ─── Image URL Extraction ───
  async function getGeneratedImageUrl() {
    // Method 1: API result
    if (lastApiResult?.ok && lastApiResult.mediaUrls?.length > 0) {
      return lastApiResult.mediaUrls[0];
    }

    // Method 2: Find new large images
    const images = document.querySelectorAll('img[src]');
    for (const img of images) {
      const src = img.getAttribute('src');
      if (src && !existingImages.has(src) &&
          (src.includes('storage.googleapis.com') || src.includes('generated'))) {
        return src;
      }
    }

    return null;
  }

  // ─── Settings Application (tune button) ───
  let imageSettingsApplied = false;
  let videoSettingsApplied = false;

  async function applyImageSettings(settings) {
    const imageSettings = settings?.flowImage;
    if (!imageSettings) {
      console.log(LOG_PREFIX, 'No flowImage settings to apply');
      return;
    }

    console.log(LOG_PREFIX, 'Applying Flow image settings:', imageSettings);

    // Open settings panel via tune button
    const settingsBtn = getByXPath(SELECTORS.SETTINGS_BUTTON_XPATH);
    if (!settingsBtn) {
      console.warn(LOG_PREFIX, 'Settings (tune) button not found');
      return;
    }

    MangoDom.simulateClick(settingsBtn);
    await delay(500);

    // Set image model
    if (imageSettings.model) {
      await setImageModel(imageSettings.model);
    }

    // Set aspect ratio
    if (imageSettings.aspectRatio) {
      await setComboboxByLabel(
        ['가로세로', '비율', 'aspect', 'ratio'],
        imageSettings.aspectRatio,
        '화면비'
      );
    }

    // Set output count
    if (imageSettings.outputCount) {
      await setComboboxByLabel(
        ['출력', 'output', /^\s*\d+\s*$/],
        String(imageSettings.outputCount),
        '출력 개수'
      );
    }

    // Close settings panel
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(300);
    console.log(LOG_PREFIX, 'Image settings applied');
  }

  async function applyVideoSettings(settings) {
    const videoSettings = settings?.flowVideo || settings?.veo;
    if (!videoSettings) {
      console.log(LOG_PREFIX, 'No flowVideo settings to apply');
      return;
    }

    console.log(LOG_PREFIX, 'Applying Flow video settings:', videoSettings);

    const settingsBtn = getByXPath(SELECTORS.SETTINGS_BUTTON_XPATH);
    if (!settingsBtn) {
      console.warn(LOG_PREFIX, 'Settings (tune) button not found');
      return;
    }

    MangoDom.simulateClick(settingsBtn);
    await delay(500);

    // Set video model
    if (videoSettings.model) {
      await setVideoModel(videoSettings.model);
    }

    // Set aspect ratio
    if (videoSettings.aspectRatio) {
      await setComboboxByLabel(
        ['가로세로', '비율', 'aspect', 'ratio'],
        videoSettings.aspectRatio,
        '비디오 화면비'
      );
    }

    // Set output count
    if (videoSettings.outputCount) {
      await setComboboxByLabel(
        ['출력', 'output', /^\s*\d+\s*$/],
        String(videoSettings.outputCount),
        '비디오 출력 개수'
      );
    }

    // Close settings panel
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(300);
    console.log(LOG_PREFIX, 'Video settings applied');
  }

  async function setImageModel(model) {
    // 모델명 매칭 정의 (참고자료 방식)
    const modelDefs = {
      'imagen4':          { match: ['Imagen 4', 'imagen4', 'Imagen4'] },
      'nano-banana-pro':  { match: ['Nano Banana Pro', 'nano-banana-pro'], exclude: ['2'] },
      'nano-banana-2':    { match: ['Nano Banana 2', 'nano-banana-2'] },
      'nano-banana':      { match: ['Nano Banana', 'nano-banana'], exclude: ['Pro', '2'] }
    };
    const def = modelDefs[model] || { match: [model] };

    const matchesModel = (text) => {
      const lower = text.toLowerCase();
      const hasMatch = def.match.some(name => lower.includes(name.toLowerCase()));
      if (!hasMatch) return false;
      if (def.exclude) {
        return !def.exclude.some(ex => lower.includes(ex.toLowerCase()));
      }
      return true;
    };

    const comboboxes = document.querySelectorAll('[role="combobox"]');
    for (const combobox of comboboxes) {
      const text = combobox.textContent || '';
      if (text.includes('Imagen') || text.includes('Nano') || text.includes('Banana') ||
          text.includes('모델') || text.includes('Model')) {
        if (matchesModel(text)) {
          console.log(LOG_PREFIX, `Image model already set: ${model}`);
          return;
        }
        combobox.click();
        await delay(300);
        const options = document.querySelectorAll('[role="option"]');
        for (const option of options) {
          if (matchesModel(option.textContent || '')) {
            console.log(LOG_PREFIX, `Image model selected: ${option.textContent.trim()}`);
            option.click();
            await delay(300);
            return;
          }
        }
        // 못 찾으면 드롭다운 닫기
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await delay(200);
        break;
      }
    }
    console.warn(LOG_PREFIX, `Image model not found: ${model}`);
  }

  async function setVideoModel(model) {
    const modelDefs = {
      'veo-3':            { match: ['Veo 3'], exclude: ['3.1', 'Fast', 'Quality'] },
      'veo-3.1-fast':     { match: ['Veo 3.1', 'Fast'] },
      'veo-3.1-quality':  { match: ['Veo 3.1', 'Quality'] }
    };
    const def = modelDefs[model] || { match: [model] };

    const matchesModel = (text) => {
      const lower = text.toLowerCase();
      const hasMatch = def.match.every(name => lower.includes(name.toLowerCase()));
      if (!hasMatch) return false;
      if (def.exclude) {
        return !def.exclude.some(ex => lower.includes(ex.toLowerCase()));
      }
      return true;
    };

    const comboboxes = document.querySelectorAll('[role="combobox"]');
    for (const combobox of comboboxes) {
      const text = combobox.textContent || '';
      if (text.includes('Veo') || text.includes('veo') || text.includes('모델') || text.includes('Model')) {
        if (matchesModel(text)) {
          console.log(LOG_PREFIX, `Video model already set: ${model}`);
          return;
        }
        combobox.click();
        await delay(300);
        const options = document.querySelectorAll('[role="option"]');
        for (const option of options) {
          if (matchesModel(option.textContent || '')) {
            console.log(LOG_PREFIX, `Video model selected: ${option.textContent.trim()}`);
            option.click();
            await delay(300);
            return;
          }
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await delay(200);
        break;
      }
    }
    console.warn(LOG_PREFIX, `Video model not found: ${model}`);
  }

  async function setComboboxByLabel(labelPatterns, targetValue, settingName) {
    const comboboxes = document.querySelectorAll('[role="combobox"]');
    for (const combobox of comboboxes) {
      const text = (combobox.textContent || '').trim();

      // 라벨 패턴 매칭
      const isMatch = labelPatterns.some(p => {
        if (p instanceof RegExp) return p.test(text);
        return text.toLowerCase().includes(p.toLowerCase());
      });
      if (!isMatch) continue;

      // 이미 선택된 값인지 확인
      if (text.includes(targetValue)) {
        console.log(LOG_PREFIX, `${settingName} already set: ${targetValue}`);
        return;
      }

      combobox.click();
      await delay(300);

      const options = document.querySelectorAll('[role="option"]');
      for (const option of options) {
        const optText = (option.textContent || '').trim();
        if (optText.includes(targetValue) || optText === targetValue) {
          console.log(LOG_PREFIX, `${settingName} selected: ${optText}`);
          option.click();
          await delay(300);
          return;
        }
      }

      // 못 찾으면 닫기
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(200);
      break;
    }
    console.warn(LOG_PREFIX, `${settingName} combobox not found for: ${targetValue}`);
  }

  // ─── Error Detection ───
  function checkForErrors() {
    // 1차: 시맨틱 셀렉터 (alert, error class 등)
    const alerts = document.querySelectorAll(
      '[role="alert"], [class*="error"], [class*="warning"], ' +
      '.snackbar, [class*="snack"], mat-snack-bar, [class*="toast"]'
    );
    for (const el of alerts) {
      const text = el.textContent.trim().toLowerCase();
      if (text.length > 0 && text.length < 300) {
        for (const phrase of ERROR_PHRASES) {
          if (text.includes(phrase.toLowerCase())) return el.textContent.trim();
        }
      }
    }

    // 2차: 에러 텍스트가 포함된 일반 DOM 영역 탐색 (Flow 비디오 생성 실패/검열 패턴)
    // Flow는 비디오 영역에 "Failed\nAudio generation failed..." 또는
    // "This prompt might violate our policies..." 같은 텍스트를 직접 표시 (role="alert" 없이)
    const candidates = document.querySelectorAll('div, span, p, h1, h2, h3');
    for (const el of candidates) {
      if (el.offsetParent === null) continue;
      if (el.children.length > 5) continue; // 큰 컨테이너 제외
      const text = el.textContent?.trim() || '';
      if (text.length < 3 || text.length > 500) continue;
      const lower = text.toLowerCase();

      // 이전 생성의 에러 텍스트인지 확인 (스냅샷에 있으면 무시)
      if (_errorSnapshotTexts.has(text)) continue;

      // STRONG_ERROR_PATTERNS 매칭 (false positive 낮은 패턴만)
      for (const pattern of STRONG_ERROR_PATTERNS) {
        if (lower.includes(pattern)) {
          return text;
        }
      }
    }

    return null;
  }

  // ─── Download via UI: ⋮ → 다운로드 → 1080p/720p (New UI Mar 2026) ───
  async function downloadVideoViaMenu() {
    // 생성된 비디오 요소를 우선 탐색 (이미지 ⋮와 비디오 ⋮의 메뉴가 다름)
    let target = null;

    // 디버그: 페이지의 모든 video 요소 확인
    const allVideos = document.querySelectorAll('video');
    console.log(LOG_PREFIX, `[download] 페이지 video 요소: ${allVideos.length}개`);
    allVideos.forEach((v, i) => {
      const rect = v.getBoundingClientRect();
      const src = v.src || v.querySelector('source')?.src || '(no src)';
      console.log(LOG_PREFIX, `[download]   video[${i}]: ${Math.round(rect.width)}x${Math.round(rect.height)} at (${Math.round(rect.left)},${Math.round(rect.top)}), src=${src.substring(0, 60)}, inExisting=${existingVideos.has(v.src)}`);
    });

    // 1순위: 새로 생성된 <video> 요소 또는 그 부모 컨테이너
    // Flow는 <video>를 0x0으로 숨기고 썸네일 <img>로 표시하므로, 부모를 올라가야 함
    for (const v of allVideos) {
      const src = v.src || v.querySelector('source')?.src || '';
      if (!src || existingVideos.has(src)) continue;

      const vRect = v.getBoundingClientRect();
      // video 자체가 보이면 직접 사용
      if (vRect.width > 50 && vRect.height > 30) {
        target = v;
        console.log(LOG_PREFIX, `[download] 비디오 직접 사용: ${Math.round(vRect.width)}x${Math.round(vRect.height)}`);
        break;
      }

      // video가 0x0이면 보이는 부모 컨테이너를 찾아 올라감
      console.log(LOG_PREFIX, `[download] 비디오 0x0, 부모 컨테이너 탐색...`);
      let parent = v.parentElement;
      for (let i = 0; i < 10 && parent; i++) {
        const pRect = parent.getBoundingClientRect();
        if (pRect.width > 100 && pRect.height > 80 && pRect.top >= 0) {
          target = parent;
          console.log(LOG_PREFIX, `[download] 비디오 부모 컨테이너: ${parent.tagName}.${parent.className?.substring?.(0, 30) || ''}, ${Math.round(pRect.width)}x${Math.round(pRect.height)} at (${Math.round(pRect.left)},${Math.round(pRect.top)})`);
          break;
        }
        parent = parent.parentElement;
      }
      if (target) break;
    }

    // 2순위: 이미지 중 비디오가 아닌 새로 생성된 것 (비디오 <video> 자체를 못 찾을 때)
    if (!target) {
      console.log(LOG_PREFIX, '[download] video 부모도 못 찾음, 이미지로 폴백');
      const mediaElements = findGeneratedMediaElements();
      target = mediaElements.length > 0 ? mediaElements[mediaElements.length - 1] : null;
    }

    if (!target) {
      console.warn(LOG_PREFIX, '[download] 생성된 미디어 없음');
      return false;
    }

    const targetRect = target.getBoundingClientRect();
    console.log(LOG_PREFIX, `[download] 대상: ${target.tagName}, ${Math.round(targetRect.width)}x${Math.round(targetRect.height)}, src=${(target.src || '').substring(0, 60)}`);

    // 호버 (이미지/비디오 + 부모 레벨에 PointerEvent + MouseEvent)
    const hoverTargets = [target];
    let parent = target.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      hoverTargets.push(parent);
      parent = parent.parentElement;
    }
    const cx = targetRect.left + targetRect.width / 2;
    const cy = targetRect.top + targetRect.height / 2;
    const hOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    const pOpts = { ...hOpts, pointerId: 1, pointerType: 'mouse' };
    for (const t of hoverTargets) {
      t.dispatchEvent(new PointerEvent('pointerenter', pOpts));
      t.dispatchEvent(new PointerEvent('pointermove', pOpts));
      t.dispatchEvent(new MouseEvent('mouseenter', hOpts));
      t.dispatchEvent(new MouseEvent('mouseover', hOpts));
    }
    await delay(600);

    // ⋮ 버튼: 미디어에 가장 가까운 것 (근접도 기반)
    let moreBtn = findClosestMoreButton(target);
    if (!moreBtn) {
      // 우상단 호버 재시도
      const hOpts2 = { bubbles: true, cancelable: true, clientX: targetRect.right - 20, clientY: targetRect.top + 20 };
      for (const t of hoverTargets) {
        t.dispatchEvent(new PointerEvent('pointermove', { ...hOpts2, pointerId: 1, pointerType: 'mouse' }));
        t.dispatchEvent(new MouseEvent('mousemove', hOpts2));
      }
      await delay(600);
      moreBtn = findClosestMoreButton(target);
    }
    if (!moreBtn) {
      console.warn(LOG_PREFIX, '[download] ⋮ 버튼 못찾음');
      return false;
    }

    // ⋮ 클릭 (<a> 네비게이션 차단 포함)
    const anchorP = moreBtn.closest('a');
    if (anchorP) anchorP.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); }, { capture: true, once: true });
    const btnRect = moreBtn.getBoundingClientRect();
    const btnX = btnRect.left + btnRect.width / 2;
    const btnY = btnRect.top + btnRect.height / 2;
    const clickOpts = { bubbles: true, cancelable: true, clientX: btnX, clientY: btnY, button: 0 };
    moreBtn.dispatchEvent(new PointerEvent('pointerdown', { ...clickOpts, pointerId: 1, pointerType: 'mouse' }));
    moreBtn.dispatchEvent(new MouseEvent('mousedown', clickOpts));
    await delay(80);
    moreBtn.dispatchEvent(new PointerEvent('pointerup', { ...clickOpts, pointerId: 1, pointerType: 'mouse' }));
    moreBtn.dispatchEvent(new MouseEvent('mouseup', clickOpts));
    moreBtn.dispatchEvent(new MouseEvent('click', clickOpts));
    await delay(600);
    if (!hasMenuOverlay()) { moreBtn.click(); await delay(600); }
    console.log(LOG_PREFIX, '[download] ⋮ 클릭 완료');

    // "Download" / "다운로드" 메뉴 아이템 찾기
    const downloadItem = findMenuItemByText(['Download', '다운로드']);
    if (!downloadItem) {
      const items = getVisibleMenuItems();
      console.warn(LOG_PREFIX, `[download] 다운로드 메뉴 못찾음. 메뉴: ${items.join(', ')}`);
      document.body.click();
      return false;
    }
    console.log(LOG_PREFIX, `[download] "Download" 발견: "${downloadItem.textContent?.trim()?.substring(0, 30)}", tag=${downloadItem.tagName}, role=${downloadItem.getAttribute('role')}`);

    // Download 아이템에 호버 → 서브메뉴 열기 시도
    const diRect = downloadItem.getBoundingClientRect();
    const diX = diRect.left + diRect.width / 2;
    const diY = diRect.top + diRect.height / 2;
    const diOpts = { bubbles: true, cancelable: true, clientX: diX, clientY: diY };
    downloadItem.dispatchEvent(new PointerEvent('pointerenter', { ...diOpts, pointerId: 1, pointerType: 'mouse' }));
    downloadItem.dispatchEvent(new PointerEvent('pointermove', { ...diOpts, pointerId: 1, pointerType: 'mouse' }));
    downloadItem.dispatchEvent(new MouseEvent('mouseenter', diOpts));
    downloadItem.dispatchEvent(new MouseEvent('mouseover', diOpts));
    downloadItem.dispatchEvent(new MouseEvent('mousemove', diOpts));
    await delay(800);

    // 서브메뉴 확인 (품질 옵션이 있는지)
    let quality1080 = findMenuItemByText(['1080p', '1080']);
    let quality720 = findMenuItemByText(['720p', '720']);

    // 서브메뉴 안 열렸으면 클릭으로 시도
    if (!quality1080 && !quality720) {
      console.log(LOG_PREFIX, '[download] 호버로 서브메뉴 안 열림, 클릭 시도');
      downloadItem.click();
      await delay(800);
      quality1080 = findMenuItemByText(['1080p', '1080']);
      quality720 = findMenuItemByText(['720p', '720']);
    }

    // 여전히 없으면 오른쪽 가장자리로 호버 (서브메뉴 트리거)
    if (!quality1080 && !quality720) {
      const rightOpts = { bubbles: true, cancelable: true, clientX: diRect.right - 2, clientY: diY };
      downloadItem.dispatchEvent(new PointerEvent('pointermove', { ...rightOpts, pointerId: 1, pointerType: 'mouse' }));
      downloadItem.dispatchEvent(new MouseEvent('mousemove', rightOpts));
      await delay(800);
      quality1080 = findMenuItemByText(['1080p', '1080']);
      quality720 = findMenuItemByText(['720p', '720']);
    }

    const subItems = getVisibleMenuItems();
    console.log(LOG_PREFIX, `[download] 서브메뉴: ${subItems.join(', ')}`);

    // 1080p 선택 (단, "Upgrade" 버튼 있으면 스킵)
    if (quality1080) {
      const hasUpgrade = quality1080.querySelector('button') ||
        /upgrade/i.test(quality1080.textContent || '');
      if (!hasUpgrade) {
        console.log(LOG_PREFIX, '[download] 1080p 선택 (Upgrade 없음)');
        quality1080.click();
        await delay(1000);
        return true;
      }
      console.log(LOG_PREFIX, '[download] 1080p에 Upgrade 버튼 → 720p로 폴백');
    }

    // 720p 폴백
    if (quality720) {
      console.log(LOG_PREFIX, '[download] 720p 선택');
      quality720.click();
      await delay(1000);
      return true;
    }

    // 아무 품질이라도 선택 (270p 등)
    const anyQuality = findMenuItemByText(['270p', 'Original', 'original']);
    if (anyQuality) {
      console.log(LOG_PREFIX, `[download] 대체 품질 선택: "${anyQuality.textContent?.trim()?.substring(0, 30)}"`);
      anyQuality.click();
      await delay(1000);
      return true;
    }

    // 품질 서브메뉴 없음 — Download 자체를 클릭 (직접 다운로드 지원하는 경우)
    console.log(LOG_PREFIX, '[download] 품질 서브메뉴 없음, Download 직접 클릭');
    downloadItem.click();
    await delay(1000);

    // 클릭 후 품질 옵션이 나타났는지 다시 확인
    quality1080 = findMenuItemByText(['1080p', '1080']);
    quality720 = findMenuItemByText(['720p', '720']);
    if (quality1080 || quality720) {
      const qualityBtn = quality720 || quality1080; // 720p 우선 (안전)
      const hasUpgrade1080 = quality1080 && (/upgrade/i.test(quality1080.textContent || ''));
      const finalBtn = (quality1080 && !hasUpgrade1080) ? quality1080 : qualityBtn;
      console.log(LOG_PREFIX, `[download] 품질 선택: "${finalBtn.textContent?.trim()?.substring(0, 20)}"`);
      finalBtn.click();
      await delay(1000);
      return true;
    }

    console.warn(LOG_PREFIX, '[download] 품질 옵션 못찾음');
    document.body.click();
    return false;
  }

  /**
   * 이미지 호버 메뉴를 통해 지정 품질(1K/2K/4K)로 다운로드
   * downloadVideoViaMenu와 동일한 UI 인터랙션 패턴 사용
   */
  async function downloadImageViaMenu(quality = '1k') {
    // 최신 갤러리 이미지 찾기
    let target = null;
    const allImgs = document.querySelectorAll('img[src]');
    for (const img of allImgs) {
      if (!isGalleryImage(img)) continue;
      const src = img.src || '';
      if (!existingImages.has(src)) {
        target = img;
      }
    }
    // 새 이미지 못 찾으면 마지막 갤러리 이미지 사용
    if (!target) {
      for (const img of allImgs) {
        if (isGalleryImage(img)) target = img;
      }
    }
    if (!target) {
      console.warn(LOG_PREFIX, '[img-download] 갤러리 이미지 없음');
      return false;
    }

    const targetRect = target.getBoundingClientRect();
    console.log(LOG_PREFIX, `[img-download] 대상: ${Math.round(targetRect.width)}x${Math.round(targetRect.height)}, quality=${quality}`);

    // 호버 (이미지 + 부모 계층)
    const hoverTargets = [target];
    let parent = target.parentElement;
    for (let i = 0; i < 5 && parent; i++) {
      hoverTargets.push(parent);
      parent = parent.parentElement;
    }
    const cx = targetRect.left + targetRect.width / 2;
    const cy = targetRect.top + targetRect.height / 2;
    const hOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    const pOpts = { ...hOpts, pointerId: 1, pointerType: 'mouse' };
    for (const t of hoverTargets) {
      t.dispatchEvent(new PointerEvent('pointerenter', pOpts));
      t.dispatchEvent(new PointerEvent('pointermove', pOpts));
      t.dispatchEvent(new MouseEvent('mouseenter', hOpts));
      t.dispatchEvent(new MouseEvent('mouseover', hOpts));
    }
    await delay(600);

    // ⋮ 버튼 찾기
    let moreBtn = findClosestMoreButton(target);
    if (!moreBtn) {
      const hOpts2 = { bubbles: true, cancelable: true, clientX: targetRect.right - 20, clientY: targetRect.top + 20 };
      for (const t of hoverTargets) {
        t.dispatchEvent(new PointerEvent('pointermove', { ...hOpts2, pointerId: 1, pointerType: 'mouse' }));
        t.dispatchEvent(new MouseEvent('mousemove', hOpts2));
      }
      await delay(600);
      moreBtn = findClosestMoreButton(target);
    }
    if (!moreBtn) {
      console.warn(LOG_PREFIX, '[img-download] ⋮ 버튼 못찾음');
      return false;
    }

    // ⋮ 클릭
    const anchorP = moreBtn.closest('a');
    if (anchorP) anchorP.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); }, { capture: true, once: true });
    const btnRect = moreBtn.getBoundingClientRect();
    const btnX = btnRect.left + btnRect.width / 2;
    const btnY = btnRect.top + btnRect.height / 2;
    const clickOpts = { bubbles: true, cancelable: true, clientX: btnX, clientY: btnY, button: 0 };
    moreBtn.dispatchEvent(new PointerEvent('pointerdown', { ...clickOpts, pointerId: 1, pointerType: 'mouse' }));
    moreBtn.dispatchEvent(new MouseEvent('mousedown', clickOpts));
    await delay(80);
    moreBtn.dispatchEvent(new PointerEvent('pointerup', { ...clickOpts, pointerId: 1, pointerType: 'mouse' }));
    moreBtn.dispatchEvent(new MouseEvent('mouseup', clickOpts));
    moreBtn.dispatchEvent(new MouseEvent('click', clickOpts));
    await delay(600);
    if (!hasMenuOverlay()) { moreBtn.click(); await delay(600); }
    console.log(LOG_PREFIX, '[img-download] ⋮ 클릭 완료');

    // "다운로드" 메뉴 아이템 찾기
    const downloadItem = findMenuItemByText(['Download', '다운로드']);
    if (!downloadItem) {
      const items = getVisibleMenuItems();
      console.warn(LOG_PREFIX, `[img-download] 다운로드 메뉴 못찾음. 메뉴: ${items.join(', ')}`);
      document.body.click();
      return false;
    }
    console.log(LOG_PREFIX, `[img-download] "Download" 발견: "${downloadItem.textContent?.trim()?.substring(0, 30)}"`);

    // Download 아이템에 호버 → 서브메뉴 열기
    const diRect = downloadItem.getBoundingClientRect();
    const diX = diRect.left + diRect.width / 2;
    const diY = diRect.top + diRect.height / 2;
    const diOpts = { bubbles: true, cancelable: true, clientX: diX, clientY: diY };
    downloadItem.dispatchEvent(new PointerEvent('pointerenter', { ...diOpts, pointerId: 1, pointerType: 'mouse' }));
    downloadItem.dispatchEvent(new PointerEvent('pointermove', { ...diOpts, pointerId: 1, pointerType: 'mouse' }));
    downloadItem.dispatchEvent(new MouseEvent('mouseenter', diOpts));
    downloadItem.dispatchEvent(new MouseEvent('mouseover', diOpts));
    downloadItem.dispatchEvent(new MouseEvent('mousemove', diOpts));
    await delay(800);

    // 품질 매핑: '1k' → ['1K', '1k', 'Original'], '2k' → ['2K', '2k'], '4k' → ['4K', '4k']
    const qualityMap = {
      '1k': ['1K', '1k', 'Original', 'original'],
      '2k': ['2K', '2k'],
      '4k': ['4K', '4k']
    };
    const targetTexts = qualityMap[quality] || qualityMap['1k'];

    // 서브메뉴에서 품질 옵션 찾기
    let qualityBtn = findMenuItemByText(targetTexts);

    // 서브메뉴 안 열렸으면 클릭으로 시도
    if (!qualityBtn) {
      console.log(LOG_PREFIX, '[img-download] 호버로 서브메뉴 안 열림, 클릭 시도');
      downloadItem.click();
      await delay(800);
      qualityBtn = findMenuItemByText(targetTexts);
    }

    // 오른쪽 가장자리 호버 재시도
    if (!qualityBtn) {
      const rightOpts = { bubbles: true, cancelable: true, clientX: diRect.right - 2, clientY: diY };
      downloadItem.dispatchEvent(new PointerEvent('pointermove', { ...rightOpts, pointerId: 1, pointerType: 'mouse' }));
      downloadItem.dispatchEvent(new MouseEvent('mousemove', rightOpts));
      await delay(800);
      qualityBtn = findMenuItemByText(targetTexts);
    }

    const subItems = getVisibleMenuItems();
    console.log(LOG_PREFIX, `[img-download] 서브메뉴: ${subItems.join(', ')}`);

    if (qualityBtn) {
      // Upgrade 버튼 있으면 해당 품질 사용 불가 → 한 단계 낮은 품질로 폴백
      const hasUpgrade = qualityBtn.querySelector('button') ||
        /upgrade|업그레이드/i.test(qualityBtn.textContent || '');
      if (hasUpgrade) {
        console.log(LOG_PREFIX, `[img-download] ${quality}에 Upgrade 버튼 → 폴백`);
        // 4k → 2k → 1k 순으로 폴백
        const fallbackOrder = quality === '4k' ? ['2k', '1k'] : ['1k'];
        for (const fb of fallbackOrder) {
          const fbTexts = qualityMap[fb];
          const fbBtn = findMenuItemByText(fbTexts);
          if (fbBtn) {
            const fbUpgrade = fbBtn.querySelector('button') || /upgrade|업그레이드/i.test(fbBtn.textContent || '');
            if (!fbUpgrade) {
              console.log(LOG_PREFIX, `[img-download] 폴백 ${fb} 선택`);
              fbBtn.click();
              await delay(1000);
              return true;
            }
          }
        }
      } else {
        console.log(LOG_PREFIX, `[img-download] ${quality} 선택`);
        qualityBtn.click();
        // 2K/4K는 업스케일 후 다운로드이므로 충분히 대기
        if (quality !== '1k') {
          console.log(LOG_PREFIX, `[img-download] 업스케일 대기 중... (${quality})`);
          await waitForUpscaleComplete(60000);
        } else {
          await delay(1000);
        }
        return true;
      }
    }

    // 원하는 품질 못 찾으면 아무 품질이나 선택
    const any1k = findMenuItemByText(['1K', '1k', 'Original', 'original']);
    if (any1k) {
      console.log(LOG_PREFIX, `[img-download] 대체: 1K 선택`);
      any1k.click();
      await delay(1000);
      return true;
    }

    // 품질 서브메뉴 없음 — Download 직접 클릭
    console.log(LOG_PREFIX, '[img-download] 품질 서브메뉴 없음, Download 직접 클릭');
    downloadItem.click();
    await delay(1000);

    // 클릭 후 품질 옵션 재확인
    qualityBtn = findMenuItemByText(targetTexts);
    if (qualityBtn) {
      const hasUpgrade = qualityBtn.querySelector('button') || /upgrade|업그레이드/i.test(qualityBtn.textContent || '');
      if (!hasUpgrade) {
        qualityBtn.click();
        await delay(1000);
        return true;
      }
    }

    console.warn(LOG_PREFIX, '[img-download] 품질 옵션 못찾음');
    document.body.click();
    return false;
  }

  /**
   * 업스케일 완료 대기: "Upscaling" 토스트가 사라지고 다운로드 완료될 때까지 대기
   */
  async function waitForUpscaleComplete(timeoutMs = 60000) {
    const start = Date.now();
    let sawUpscaling = false;

    while (Date.now() - start < timeoutMs) {
      // 페이지의 모든 텍스트에서 업스케일 관련 메시지 감지
      const allText = document.body.innerText || '';
      const isUpscaling = allText.includes('Upscaling') || allText.includes('업스케일');
      const isComplete = allText.includes('downloaded') || allText.includes('다운로드되었습니다') ||
                         allText.includes('다운로드됐습니다') || allText.includes('완료되었으며');

      if (isUpscaling) {
        if (!sawUpscaling) {
          console.log(LOG_PREFIX, '[img-download] 업스케일 진행 중 감지');
          sawUpscaling = true;
        }
      }

      // 업스케일 완료 메시지가 나타났거나, 업스케일 시작 후 메시지가 사라졌으면 완료
      if (isComplete) {
        console.log(LOG_PREFIX, '[img-download] 업스케일 + 다운로드 완료 감지');
        await delay(2000); // 다운로드 안정화 대기
        return true;
      }

      if (sawUpscaling && !isUpscaling) {
        console.log(LOG_PREFIX, '[img-download] 업스케일 메시지 사라짐 → 완료 추정');
        await delay(3000); // 다운로드 안정화 대기
        return true;
      }

      await delay(1000);
    }

    console.warn(LOG_PREFIX, '[img-download] 업스케일 대기 타임아웃');
    await delay(3000); // 타임아웃이어도 좀 더 대기
    return false;
  }

  function findGeneratedMediaElements() {
    const results = [];
    // 비디오 요소
    document.querySelectorAll('video').forEach(v => {
      if (v.offsetParent !== null && v.offsetWidth > 50) results.push(v);
    });
    // 갤러리 이미지 (크기 기반 — 생성된 미디어는 100px 이상)
    document.querySelectorAll('img[src]').forEach(img => {
      if (img.offsetParent !== null && img.offsetWidth > 100 && img.offsetHeight > 80) {
        const src = img.src || '';
        // 아바타/아이콘 제외
        if (src.includes('googleusercontent.com') && src.includes('/a/')) return;
        if (src.startsWith('data:image/svg')) return;
        if (src.includes('placeholder')) return;
        results.push(img);
      }
    });
    return results;
  }

  function findMenuItemByText(texts) {
    // role="menuitem" 또는 일반 클릭 가능 요소에서 텍스트 매칭
    const candidates = document.querySelectorAll(
      '[role="menuitem"], [role="option"], li, button, a, div[tabindex]'
    );
    for (const el of candidates) {
      const elText = el.textContent?.trim() || '';
      if (el.offsetParent === null) continue;
      for (const text of texts) {
        if (elText.includes(text) && elText.length < text.length + 30) {
          return el;
        }
      }
    }
    return null;
  }

  // ─── Ensure inject.js (MAIN world) is loaded ───
  // background의 tabs.onUpdated로만 주입하면 서비스 워커 비활성 시 누락될 수 있음
  // content script에서 직접 <script> 태그로 주입하면 확실하게 로딩됨
  function ensureInjectScript() {
    if (document.querySelector('script[data-mangoauto-inject]')) return;
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('content/inject.js');
      script.dataset.mangoautoInject = 'true';
      (document.head || document.documentElement).appendChild(script);
      console.log(LOG_PREFIX, 'inject.js (MAIN world) 주입 완료');
    } catch (e) {
      console.warn(LOG_PREFIX, 'inject.js 주입 실패:', e.message);
    }
  }
  ensureInjectScript();

  // Snapshot existing media on load
  setTimeout(() => snapshotExistingMedia(), 2000);

  console.log(LOG_PREFIX, 'Content script loaded (verified selectors)');
})();
