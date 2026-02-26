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
    '생성할 수 없', '정책', '다시 시도', '오류'
  ];

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

  // ─── Listen for API results from inject.js ───
  let lastApiResult = null;
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'VEO3_API_RESULT') {
      console.log(LOG_PREFIX, 'API result received:', event.data);
      lastApiResult = event.data;
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
    // 매 스텝마다 알림/동의 다이얼로그 자동 처리
    if (window.MangoDialogDismisser) {
      window.MangoDialogDismisser.tryDismiss();
    }
  }

  async function handleExecutePrompt(msg) {
    if (isProcessing) throw new Error('Already processing');
    isProcessing = true;
    shouldStop = false;
    lastApiResult = null;

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
          throw new Error('Frame upload failed - 이미지 업로드 실패');
        }
      }
      checkStopped();

      // Step 4: Snapshot existing media (생성 전 기존 미디어 기록)
      snapshotExistingMedia();

      // Step 5: Fill prompt
      await typePrompt(prompt);
      await delay(600 + Math.random() * 400);
      checkStopped();

      // Step 6: Click generate
      await clickGenerate();
      checkStopped();

      // Step 7: Wait for generation complete
      const timeoutMin = isImageOutput ? (settings?.flowTimeout || 3) : (settings?.flowVideo?.frameDuration || settings?.veo?.frameDuration || 10);
      await waitForGenerationComplete(timeoutMin);

      // Step 8: Extract result
      if (mediaType === 'video' || mode.includes('video')) {
        // 비디오: URL 직접 전달 (dataUrl 변환 시 50MB+ 메모리 이슈 방지)
        let videoUrl;
        if (lastApiResult?.ok && lastApiResult.mediaUrls?.length > 0) {
          console.log(LOG_PREFIX, 'Using API-intercepted video URL');
          videoUrl = lastApiResult.mediaUrls[0];
        } else {
          videoUrl = await getVideoUrl();
          if (!videoUrl) throw new Error('Cannot find video URL');
        }
        chrome.runtime.sendMessage({
          type: 'GENERATION_COMPLETE',
          mediaUrl: videoUrl,
          mediaType: 'video'
        });
      } else {
        // 이미지: dataUrl로 변환
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
      // 대기 중 다이얼로그 자동 처리
      if (window.MangoDialogDismisser) window.MangoDialogDismisser.tryDismiss();
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
  // Settings accessed via model badge near prompt (e.g., "Nano Banana □ x2")
  // Panel: Image/Video tabs, Landscape/Portrait, x1-x4, model dropdown

  function isSettingsPanelOpen() {
    const buttons = document.querySelectorAll('button');
    let countBtns = 0;
    for (const btn of buttons) {
      if (/^x[1-4]$/.test(btn.textContent?.trim())) countBtns++;
    }
    if (countBtns >= 2) return true;
    let hasLandscape = false, hasPortrait = false;
    for (const btn of buttons) {
      const t = btn.textContent?.trim() || '';
      if (t.includes('Landscape') || t === '가로') hasLandscape = true;
      if (t.includes('Portrait') || t === '세로') hasPortrait = true;
    }
    return hasLandscape && hasPortrait;
  }

  function findSettingsTrigger() {
    const genBtn = findGenerateButton();
    const clickables = document.querySelectorAll('button, [role="button"]');
    const modelKeywords = ['Nano', 'Imagen', 'Veo', 'Banana', '모델', 'Model'];

    // 1차: 모델명 + xN 패턴
    for (const el of clickables) {
      if (el === genBtn) continue;
      const text = el.textContent || '';
      if (text.length < 80 && modelKeywords.some(kw => text.includes(kw))) {
        console.log(LOG_PREFIX, `Settings trigger found (model): "${text.trim().substring(0, 40)}"`);
        return el;
      }
    }
    // 2차: xN 패턴 (프롬프트 입력 근처)
    const textarea = findPromptTextarea();
    if (textarea) {
      let container = textarea.parentElement;
      for (let i = 0; i < 8 && container; i++) container = container.parentElement;
      if (container) {
        for (const el of container.querySelectorAll('button, [role="button"]')) {
          if (el === genBtn) continue;
          const text = el.textContent || '';
          if (/x\d/.test(text) && text.length < 60 && !el.querySelector('textarea')) {
            console.log(LOG_PREFIX, `Settings trigger found (xN): "${text.trim().substring(0, 40)}"`);
            return el;
          }
        }
      }
    }
    // 3차: 프롬프트 입력 영역 근처의 아이콘 버튼 (화살표 제외)
    if (textarea) {
      let row = textarea.closest('div');
      for (let i = 0; i < 5 && row; i++) {
        const btns = row.querySelectorAll('button');
        for (const btn of btns) {
          if (btn === genBtn) continue;
          const text = (btn.textContent || '').trim();
          const icons = btn.querySelectorAll('i, mat-icon, svg');
          // tune 아이콘 또는 settings 아이콘
          if (text === 'tune' || text === 'settings' || text === '⚙') {
            console.log(LOG_PREFIX, `Settings trigger found (icon): "${text}"`);
            return btn;
          }
        }
        row = row.parentElement;
      }
    }
    console.warn(LOG_PREFIX, 'Settings trigger not found. Buttons:',
      [...clickables].map(b => b.textContent?.trim()?.substring(0, 30)).filter(t => t && t.length < 30).join(' | '));
    return null;
  }

  async function openSettingsPanel() {
    if (isSettingsPanelOpen()) {
      console.log(LOG_PREFIX, 'Settings panel already open');
      return true;
    }
    const trigger = findSettingsTrigger();
    if (trigger) {
      console.log(LOG_PREFIX, 'Opening settings:', trigger.textContent?.trim()?.substring(0, 30));
      MangoDom.simulateClick(trigger);
      await delay(600);
      if (isSettingsPanelOpen()) return true;
    }
    // Legacy: tune button
    const tuneBtn = getByXPath(SELECTORS.SETTINGS_BUTTON_XPATH);
    if (tuneBtn) {
      MangoDom.simulateClick(tuneBtn);
      await delay(500);
      return true;
    }
    console.warn(LOG_PREFIX, 'Cannot open settings panel');
    return false;
  }

  async function closeSettingsPanel() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!isSettingsPanelOpen()) {
        console.log(LOG_PREFIX, 'Settings panel closed');
        return;
      }
      if (attempt === 0) {
        const trigger = findSettingsTrigger();
        if (trigger) {
          MangoDom.simulateClick(trigger);
          await delay(400);
          continue;
        }
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(400);
    }
    // 최후 수단: 빈 곳 클릭
    if (isSettingsPanelOpen()) {
      document.body.click();
      await delay(300);
      console.log(LOG_PREFIX, 'Settings panel force close attempt');
    }
  }

  async function clickSettingsButton(texts, settingName) {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const btnText = btn.textContent?.trim() || '';
      for (const text of texts) {
        if (btnText === text || (btnText.includes(text) && btnText.length < text.length + 30)) {
          // 이미 선택된 상태 감지 (aria 속성 또는 시각적 스타일)
          const isSelected = btn.getAttribute('aria-selected') === 'true' ||
              btn.getAttribute('aria-pressed') === 'true' ||
              btn.getAttribute('aria-checked') === 'true' ||
              btn.classList.contains('selected') ||
              btn.classList.contains('active');
          if (isSelected) {
            console.log(LOG_PREFIX, `${settingName} already selected: ${btnText}`);
            return true;
          }
          MangoDom.simulateClick(btn);
          console.log(LOG_PREFIX, `${settingName} clicked: ${btnText}`);
          await delay(300);
          return true;
        }
      }
    }
    console.warn(LOG_PREFIX, `${settingName} not found: ${texts.join('/')}. Available buttons:`,
      [...buttons].map(b => b.textContent?.trim()?.substring(0, 20)).filter(t => t && t.length < 20).join(' | '));
    return false;
  }

  async function setMediaType(mode) {
    if (mode.includes('video')) {
      return await clickSettingsButton(['Video', '동영상', 'Videos'], 'Media type');
    }
    return await clickSettingsButton(['Image', '이미지', 'Images'], 'Media type');
  }

  async function setAspectRatioNew(ratio) {
    const map = {
      '16:9': ['Landscape', '가로'],
      '9:16': ['Portrait', '세로'],
      '1:1': ['Square', '정사각형']
    };
    if (map[ratio]) return await clickSettingsButton(map[ratio], 'Aspect ratio');
    console.warn(LOG_PREFIX, 'Unknown aspect ratio:', ratio);
    return false;
  }

  async function setOutputCountNew(count) {
    // 정확 매칭: 버튼 텍스트가 정확히 "x1", "x2" 등이어야 함
    const target = `x${count}`;
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const btnText = btn.textContent?.trim() || '';
      if (btnText === target) {
        const isSelected = btn.getAttribute('aria-selected') === 'true' ||
            btn.getAttribute('aria-pressed') === 'true' ||
            btn.classList.contains('selected') || btn.classList.contains('active');
        if (isSelected) {
          console.log(LOG_PREFIX, `Output count already: ${target}`);
          return true;
        }
        MangoDom.simulateClick(btn);
        console.log(LOG_PREFIX, `Output count clicked: ${target}`);
        await delay(300);
        return true;
      }
    }
    console.warn(LOG_PREFIX, `Output count not found: ${target}`);
    return false;
  }

  async function setModelNew(model) {
    const defs = {
      'imagen4':          { match: ['Imagen 4', 'imagen4'], exclude: [] },
      'nano-banana-pro':  { match: ['Nano Banana Pro'], exclude: [] },
      'nano-banana':      { match: ['Nano Banana'], exclude: ['Pro'] },
      'veo-3':            { match: ['Veo 3'], exclude: ['3.1', 'Fast', 'Quality'] },
      'veo-3.1-fast':     { match: ['Veo 3.1', 'Fast'], exclude: [] },
      'veo-3.1-quality':  { match: ['Veo 3.1', 'Quality'], exclude: [] }
    };
    const def = defs[model] || { match: [model], exclude: [] };
    const matchesModel = (text) => {
      const l = text.toLowerCase();
      const ok = def.match.every(n => l.includes(n.toLowerCase()));
      if (!ok) return false;
      return !def.exclude.some(ex => l.includes(ex.toLowerCase()));
    };

    // 모델 드롭다운 트리거 찾기: 모델 키워드가 있는 요소 (드롭다운 화살표 ▼ 포함)
    const modelKeywords = ['Imagen', 'Nano', 'Banana', 'Veo', '모델', 'Model'];
    const allElements = document.querySelectorAll('[role="combobox"], [role="listbox"], button, [class*="dropdown"], [class*="select"]');
    let dropdownTrigger = null;

    for (const el of allElements) {
      const text = el.textContent || '';
      if (text.length > 100) continue;
      if (!modelKeywords.some(kw => text.includes(kw))) continue;
      // 이미 선택된 모델인지 확인
      if (matchesModel(text)) {
        console.log(LOG_PREFIX, `Model already set: ${model} (text: "${text.trim().substring(0, 40)}")`);
        return;
      }
      dropdownTrigger = el;
      break;
    }

    if (!dropdownTrigger) {
      console.warn(LOG_PREFIX, `Model dropdown trigger not found for: ${model}`);
      return;
    }

    console.log(LOG_PREFIX, `Model dropdown click: "${dropdownTrigger.textContent?.trim()?.substring(0, 40)}"`);
    MangoDom.simulateClick(dropdownTrigger);
    await delay(500);

    // 옵션 탐색: role="option", role="menuitem", 또는 일반 div/li 등 모든 클릭 가능 요소
    const optionSelectors = '[role="option"], [role="menuitem"], [role="listbox"] > *, [class*="option"], [class*="menu-item"], li';
    const options = document.querySelectorAll(optionSelectors);
    console.log(LOG_PREFIX, `Model options found: ${options.length} (selectors: ${optionSelectors})`);

    for (const opt of options) {
      const optText = opt.textContent || '';
      if (matchesModel(optText)) {
        MangoDom.simulateClick(opt);
        console.log(LOG_PREFIX, `Model selected: ${optText.trim().substring(0, 40)}`);
        await delay(400);
        return;
      }
    }

    // 폭넓은 탐색: 새로 나타난 모든 요소 중 모델명이 포함된 것
    const allVisible = document.querySelectorAll('div, span, button, a');
    for (const el of allVisible) {
      const text = el.textContent?.trim() || '';
      // 직접 텍스트가 모델명이고 길이가 짧은 요소 (하위 요소 텍스트가 아닌)
      const directText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
      const checkText = directText || text;
      if (checkText.length > 60) continue;
      if (matchesModel(checkText) && el.offsetParent !== null) {
        MangoDom.simulateClick(el);
        console.log(LOG_PREFIX, `Model selected (broad): ${checkText.substring(0, 40)}`);
        await delay(400);
        return;
      }
    }

    // 닫기
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(200);
    console.warn(LOG_PREFIX, `Model option not found: ${model}. Visible options:`,
      [...options].map(o => o.textContent?.trim()?.substring(0, 30)).join(' | '));
  }

  async function applyAllSettings(mode, settings, isImageOutput) {
    const relevant = isImageOutput ?
      settings?.flowImage : (settings?.flowVideo || settings?.veo);
    const already = isImageOutput ? imageSettingsApplied : videoSettingsApplied;

    const opened = await openSettingsPanel();
    if (!opened) {
      console.warn(LOG_PREFIX, 'Panel unavailable, legacy fallback');
      await switchMode(mode);
      if (!already && relevant) {
        if (isImageOutput) { await applyImageSettings(settings); imageSettingsApplied = true; }
        else { await applyVideoSettings(settings); videoSettingsApplied = true; }
      }
      return;
    }

    await setMediaType(mode);
    await delay(300);

    if (!already && relevant) {
      if (relevant.aspectRatio) await setAspectRatioNew(relevant.aspectRatio);
      if (relevant.outputCount) await setOutputCountNew(relevant.outputCount);
      if (relevant.model) await setModelNew(relevant.model);
      if (isImageOutput) imageSettingsApplied = true;
      else videoSettingsApplied = true;
    }

    await closeSettingsPanel();
    console.log(LOG_PREFIX, 'Settings applied');
  }

  // ─── Prompt Input ───
  function findPromptTextarea() {
    // Primary: by ID
    let textarea = document.getElementById(SELECTORS.PROMPT_TEXTAREA_ID);
    if (textarea) return textarea;

    // Fallback: textarea with creation placeholder
    textarea = document.querySelector('textarea[placeholder*="create" i], textarea[placeholder*="만들"]');
    if (textarea) return textarea;

    // Fallback: any textarea
    textarea = document.querySelector('textarea');
    if (textarea) return textarea;

    // Fallback: contenteditable element
    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const el of editables) {
      const hint = (el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
      if (hint.includes('create') || hint.includes('만들')) return el;
    }
    return null;
  }

  async function typePrompt(text) {
    // 설정 패널이 열려있으면 먼저 닫기
    await closeSettingsPanel();
    await delay(300);

    const textarea = findPromptTextarea();
    if (!textarea) throw new Error('Cannot find prompt textarea');

    console.log(LOG_PREFIX, `Prompt textarea found: ${textarea.tagName}#${textarea.id}, placeholder="${(textarea.placeholder || '').substring(0, 30)}"`);

    textarea.click();
    await delay(200);
    textarea.focus();
    await delay(100);

    // Use React-compatible native setter
    MangoDom.setTextareaValue(textarea, text);
    await delay(200);

    // 확인: 값이 실제로 설정되었는지
    const actual = textarea.value || textarea.textContent || '';
    if (!actual.includes(text.substring(0, 20))) {
      console.warn(LOG_PREFIX, `Prompt not set properly. Expected start: "${text.substring(0, 30)}", Got: "${actual.substring(0, 30)}"`);
      // 재시도: dispatchEvent 방식
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      await delay(200);
    }

    console.log(LOG_PREFIX, 'Prompt typed');
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

  // ─── Frame Upload (Image-to-Video) ───
  function findFrameContainer() {
    // Look for the frame area by finding swap_horiz icon and walking up
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const icon = btn.querySelector('i');
      if (icon?.textContent?.trim() === 'swap_horiz') {
        let container = btn.parentElement;
        for (let level = 0; level < 10 && container; level++) {
          const icons = container.querySelectorAll('button i');
          let hasAddIcon = false;
          for (const icn of icons) {
            if (icn.textContent?.trim() === 'add') {
              hasAddIcon = true;
              break;
            }
          }
          if (hasAddIcon) return container;
          container = container.parentElement;
        }
      }
    }
    return null;
  }

  function findAddButton(position) {
    const container = findFrameContainer();
    const searchRoot = container || document;
    const buttons = searchRoot.querySelectorAll('button');
    const addButtons = [];

    for (const btn of buttons) {
      const icon = btn.querySelector('i');
      if (icon?.textContent?.trim() === 'add') {
        addButtons.push(btn);
      }
    }

    if (addButtons.length === 0) return null;
    return position === 'first' ? addButtons[0] : addButtons[addButtons.length - 1];
  }

  function findUploadButton() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const icon = btn.querySelector('i');
      if (icon?.textContent?.trim() === 'upload') return btn;
      const text = (btn.textContent || '').trim();
      if (text.includes('업로드') || text.includes('Upload')) return btn;
    }
    return null;
  }

  async function uploadFrame(imageDataUrl, position = 'first') {
    // HTTP URL → dataUrl 변환 (MangoHub 이미지)
    if (imageDataUrl.startsWith('http')) {
      console.log(LOG_PREFIX, 'HTTP URL → dataURL 변환');
      try {
        const resp = await fetch(imageDataUrl);
        const blob = await resp.blob();
        imageDataUrl = await new Promise(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
      } catch (e) {
        console.error(LOG_PREFIX, 'URL→dataURL 변환 실패:', e);
        return false;
      }
    }

    // 기존 이미지 제거
    if (isFrameAttached(position)) {
      console.log(LOG_PREFIX, '기존 이미지 제거 중...');
      await removeAttachedImage(position);
      await delay(500);
    }

    const addBtn = findAddButton(position);
    if (!addBtn) {
      console.warn(LOG_PREFIX, 'Add button not found for frame');
      return false;
    }

    // File 객체 생성
    const file = MangoDom.dataUrlToFile(imageDataUrl, `frame-${Date.now()}.png`);
    console.log(LOG_PREFIX, `File 객체 생성: ${file.name}, ${file.size}bytes`);

    // MutationObserver로 file input 감지 준비
    const fileInputDetected = new Promise(resolve => {
      let resolved = false;
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node instanceof HTMLInputElement && node.type === 'file') {
              observer.disconnect();
              if (!resolved) { resolved = true; resolve(node); }
              return;
            }
            if (node instanceof HTMLElement) {
              const inp = node.querySelector('input[type="file"]');
              if (inp) {
                observer.disconnect();
                if (!resolved) { resolved = true; resolve(inp); }
                return;
              }
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
      setTimeout(() => { observer.disconnect(); if (!resolved) { resolved = true; resolve(null); } }, 8000);
    });

    // Step 1: add 버튼 클릭
    console.log(LOG_PREFIX, 'add 버튼 클릭');
    addBtn.click();

    // Step 2: upload 버튼 찾기 (최대 3초 대기)
    let uploadBtn = null;
    for (let i = 0; i < 15; i++) {
      await delay(200);
      uploadBtn = findUploadButton();
      if (uploadBtn) break;
    }
    if (!uploadBtn) {
      console.error(LOG_PREFIX, '업로드 버튼 못 찾음');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    // Step 3: background에서 file input 인터셉터 설치
    try {
      await chrome.runtime.sendMessage({ type: 'INJECT_FILE_INPUT', imageDataUrl });
      console.log(LOG_PREFIX, 'File injection requested');
    } catch (e) {
      console.warn(LOG_PREFIX, 'Background inject failed:', e.message);
    }
    await delay(300);

    // Step 4: upload 버튼 클릭 (file chooser 트리거)
    console.log(LOG_PREFIX, '업로드 버튼 클릭');
    uploadBtn.click();

    // Step 5: MutationObserver로 file input 감지 → 직접 파일 주입
    const detectedInput = await fileInputDetected;
    if (detectedInput) {
      console.log(LOG_PREFIX, 'MutationObserver로 file input 감지됨');
      try {
        const dt = new DataTransfer();
        dt.items.add(file);
        detectedInput.files = dt.files;
        detectedInput.dispatchEvent(new Event('change', { bubbles: true }));
        console.log(LOG_PREFIX, 'file input에 직접 파일 주입 완료');

        const cropResult = await handleCropDialog();
        if (cropResult) {
          return await waitForFrameUploaded(position, 15000);
        }
        return true;
      } catch (err) {
        console.warn(LOG_PREFIX, 'file input 직접 주입 실패:', err);
      }
    }

    // Step 6: 폴백 - DOM에서 input[type=file] 검색
    console.log(LOG_PREFIX, '폴백: DOM에서 input[type=file] 검색');
    for (let i = 0; i < 10; i++) {
      await delay(500);
      const inputs = document.querySelectorAll('input[type="file"]');
      if (inputs.length > 0) {
        console.log(LOG_PREFIX, `폴백으로 file input 발견 (시도 ${i + 1})`);
        const dt = new DataTransfer();
        dt.items.add(file);
        inputs[0].files = dt.files;
        inputs[0].dispatchEvent(new Event('change', { bubbles: true }));

        const cropResult = await handleCropDialog();
        if (cropResult) {
          return await waitForFrameUploaded(position, 15000);
        }
        return true;
      }
    }

    // Step 7: 최종 폴백 - drag-and-drop 시뮬레이션
    console.warn(LOG_PREFIX, 'file input 감지 실패, drag-and-drop 시도');
    return await uploadViaDropSimulation(file, position);
  }

  async function uploadViaDropSimulation(file, position) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await delay(300);
    const dropTarget = findAddButton(position) || document.querySelector('textarea') || document.body;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    for (const eventName of ['dragenter', 'dragover', 'drop']) {
      dropTarget.dispatchEvent(new DragEvent(eventName, { bubbles: true, cancelable: true, dataTransfer }));
      await delay(100);
    }
    await delay(2000);
    if (isFrameAttached(position)) {
      console.log(LOG_PREFIX, 'drag-and-drop 업로드 성공');
      return true;
    }
    console.error(LOG_PREFIX, 'drag-and-drop 업로드도 실패');
    return false;
  }

  function isFrameAttached(position) {
    const container = findFrameContainer();
    const buttons = (container || document).querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.includes('첫 번째 프레임') || text.includes('First frame') ||
          text.includes('마지막 프레임') || text.includes('Last frame')) {
        return true;
      }
    }
    // 이미지가 이미 첨부되면 add 대신 close/delete 아이콘으로 바뀜
    const icons = (container || document).querySelectorAll('button i');
    for (const icon of icons) {
      if (icon.textContent?.trim() === 'close' || icon.textContent?.trim() === 'delete') {
        return true;
      }
    }
    return false;
  }

  async function removeAttachedImage(position) {
    const container = findFrameContainer();
    const buttons = (container || document).querySelectorAll('button');
    for (const btn of buttons) {
      const icon = btn.querySelector('i');
      if (icon?.textContent?.trim() === 'close' || icon?.textContent?.trim() === 'delete') {
        btn.click();
        await delay(500);
        return;
      }
    }
  }

  async function handleCropDialog() {
    console.log(LOG_PREFIX, '자르기 및 저장 다이얼로그 대기...');
    for (let i = 0; i < 30; i++) {
      await delay(500);
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text.includes('자르기 및 저장') || text.includes('crop and save') ||
            (text.includes('crop') && text.includes('save'))) {
          console.log(LOG_PREFIX, `"자르기 및 저장" 버튼 발견 (시도 ${i + 1})`);
          btn.click();
          await delay(2000);
          return true;
        }
      }
    }
    console.warn(LOG_PREFIX, '자르기 및 저장 다이얼로그 타임아웃 (15초)');
    return false;
  }

  async function waitForFrameUploaded(position, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (isFrameAttached(position)) {
        console.log(LOG_PREFIX, '프레임 이미지 첨부 확인됨');
        return true;
      }
      await delay(500);
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

  // 화면에 남아있는 에러/경고 DOM 요소 강제 제거
  function dismissVisibleErrors() {
    const selectors = [
      '[role="alert"]', '[class*="snackbar"]', '[class*="snack"]',
      'mat-snack-bar', '[class*="toast"]'
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
    // MangoDialogDismisser로도 한번 시도
    if (window.MangoDialogDismisser) {
      window.MangoDialogDismisser.tryDismiss();
    }
  }

  async function waitForGenerationComplete(timeoutMin) {
    const timeout = (timeoutMin || 10) * 60 * 1000;
    console.log(LOG_PREFIX, `Waiting for generation (timeout: ${timeoutMin}min)...`);

    // 이전 에러 DOM이 남아있으면 제거 (재시도 시 중요)
    dismissVisibleErrors();

    const start = Date.now();
    const checkInterval = 5000;

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
        if (!lastApiResult.ok) {
          const e = new Error(`API error: ${lastApiResult.error || 'Unknown'}`);
          e.errorCode = lastApiResult.errorCode || '';
          throw e;
        }
        // API 200 OK이지만 미디어 없음 → 생성 실패 (검열 등)
        if (lastApiResult.ok && !lastApiResult.hasMedia) {
          const e = new Error('생성 실패: 미디어 없이 완료됨 (검열 가능성)');
          e.errorCode = 'NO_MEDIA';
          throw e;
        }
      }

      // Check for errors (API result보다 후순위)
      const err = checkForErrors();
      if (err) throw new Error(`Generation error: ${err}`);

      // Check progress indicators
      const generating = countGeneratingItems();
      if (generating > 0) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(LOG_PREFIX, `Generating... ${elapsed}s (${generating} items in progress)`);
      } else if (Date.now() - start > 10000) {
        // No progress indicators and no API result - check for new videos/images
        const hasNewMedia = checkForNewMedia();
        if (hasNewMedia) {
          console.log(LOG_PREFIX, 'Generation complete (media detected)');
          return;
        }
      }

      await delay(checkInterval);
    }

    throw new Error('Generation timed out');
  }

  let existingVideos = new Set();
  let existingImages = new Set();

  function snapshotExistingMedia() {
    document.querySelectorAll('video[src]').forEach(el => existingVideos.add(el.src));
    document.querySelectorAll('img[src]').forEach(el => existingImages.add(el.src));
  }

  function checkForNewMedia() {
    // 새 비디오 감지
    const videos = document.querySelectorAll('video[src]');
    for (const v of videos) {
      if (v.src && !existingVideos.has(v.src) && v.src.includes('storage.googleapis.com')) {
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

    // Method 2: Find video elements with storage.googleapis.com URLs
    const videos = document.querySelectorAll('video[src]');
    for (const video of videos) {
      const src = video.getAttribute('src');
      if (src && !src.startsWith('blob:') && !src.startsWith('data:') &&
          src.includes('storage.googleapis.com')) {
        return src;
      }
    }

    // Method 3: Any new video with http URL
    for (const video of videos) {
      const src = video.getAttribute('src');
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
      'nano-banana-pro':  { match: ['Nano Banana Pro', 'nano-banana-pro'] },
      'nano-banana':      { match: ['Nano Banana', 'nano-banana'], exclude: ['Pro'] }
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
    return null;
  }

  // ─── Download via UI (alternative to direct URL fetch) ───
  async function clickDownloadButton() {
    const dlBtns = MangoDom.getAllByXPath(SELECTORS.DOWNLOAD_BUTTON_XPATH);
    if (dlBtns.length === 0) return false;

    // Click the last download button (most recent result)
    const btn = dlBtns[dlBtns.length - 1];
    MangoDom.simulateClick(btn);
    await delay(500);

    // Look for "다운로드 1K" menu item
    const menuItems = document.querySelectorAll('[role="menuitem"]');
    for (const item of menuItems) {
      if (item.textContent.includes('다운로드 1K') || item.textContent.includes('Download 1K')) {
        MangoDom.simulateClick(item);
        console.log(LOG_PREFIX, 'Download 1K clicked');
        return true;
      }
    }

    // Click first menu item as fallback
    if (menuItems.length > 0) {
      MangoDom.simulateClick(menuItems[0]);
      return true;
    }

    return false;
  }

  // Snapshot existing media on load
  setTimeout(() => snapshotExistingMedia(), 2000);

  console.log(LOG_PREFIX, 'Content script loaded (verified selectors)');
})();
