/**
 * MangoAuto - Google Flow / Veo3 Automation
 * Content script for labs.google/fx/tools/flow & video-fx
 * Based on verified selectors from working Veo3 automation extension
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

  // ─── XPath Selectors (verified) ───
  const SELECTORS = {
    PROMPT_TEXTAREA_ID: 'PINHOLE_TEXT_AREA_ELEMENT_ID',

    GENERATE_BUTTON_XPATH:
      "//button[.//i[text()='arrow_forward']] | " +
      "(//button[.//i[normalize-space(text())='arrow_forward']])",

    VIDEOS_TAB_XPATH:
      "//button[@role='radio' and contains(., 'Videos')]",

    IMAGES_TAB_XPATH:
      "//button[@role='radio' and contains(., 'Images')]",

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

  async function handleExecutePrompt(msg) {
    if (isProcessing) throw new Error('Already processing');
    isProcessing = true;
    lastApiResult = null;

    try {
      const { prompt, mediaType, sourceImageDataUrl, settings } = msg;
      const mode = settings?._mode || 'image-video';
      console.log(LOG_PREFIX, 'Mode:', mode, '| Prompt:', prompt.substring(0, 60));

      // Step 1: Switch to correct mode (이미지 만들기 / 텍스트 동영상 변환 / 프레임 동영상 변환)
      await switchMode(mode);
      await delay(1000);

      // Step 2: Apply settings via tune button (이미지 모드일 때)
      if (mode.includes('image') && !imageSettingsApplied) {
        await applyImageSettings(settings);
        imageSettingsApplied = true;
        await delay(500);
      }

      // Step 3: Upload source image (for frame-to-video or image-to-image mode)
      if ((mode === 'image-video' || mode === 'image-image') && sourceImageDataUrl) {
        console.log(LOG_PREFIX, 'Uploading source image...');
        const uploaded = await uploadFrame(sourceImageDataUrl, 'first');
        if (uploaded) {
          console.log(LOG_PREFIX, 'Frame uploaded');
          await delay(2000);
        } else {
          console.warn(LOG_PREFIX, 'Frame upload failed');
        }
      }

      // Step 4: Snapshot existing media (생성 전 기존 미디어 기록)
      snapshotExistingMedia();

      // Step 5: Fill prompt
      await typePrompt(prompt);
      await delay(600 + Math.random() * 400);

      // Step 6: Click generate
      await clickGenerate();

      // Step 7: Wait for generation complete
      const isImageMode = mode.includes('image');
      const timeoutMin = isImageMode ? (settings?.flowTimeout || 3) : (settings?.veo?.frameDuration || 10);
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
        error: err.message
      });
      return { error: err.message };
    } finally {
      isProcessing = false;
    }
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
      const buttons = document.querySelectorAll('button[role="radio"]');
      for (const btn of buttons) {
        if (btn.textContent.includes(tabName)) {
          MangoDom.simulateClick(btn);
          console.log(LOG_PREFIX, `Clicked tab via text: ${tabName}`);
          await delay(300);
          return;
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

  // ─── Prompt Input ───
  function findPromptTextarea() {
    // Primary: by ID (most reliable)
    let textarea = document.getElementById(SELECTORS.PROMPT_TEXTAREA_ID);
    if (textarea) return textarea;

    // Fallback: any textarea
    textarea = document.querySelector('textarea');
    return textarea;
  }

  async function typePrompt(text) {
    const textarea = findPromptTextarea();
    if (!textarea) throw new Error('Cannot find prompt textarea');

    textarea.click();
    await delay(100);
    textarea.focus();

    // Use React-compatible native setter
    MangoDom.setTextareaValue(textarea, text);

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

  async function uploadFrame(imageDataUrl, position = 'first') {
    // Step 1: Click the "add" button for the frame slot
    const addBtn = findAddButton(position);
    if (!addBtn) {
      console.warn(LOG_PREFIX, 'Add button not found for frame');
      return false;
    }

    MangoDom.simulateClick(addBtn);
    await delay(500);

    // Step 2: Look for upload option in menu
    const uploadItems = document.querySelectorAll('[role="menuitem"], button');
    for (const item of uploadItems) {
      const text = (item.textContent || '').trim();
      const icon = item.querySelector('i');
      if (icon?.textContent?.trim() === 'upload' || text.includes('업로드') || text.includes('Upload')) {
        MangoDom.simulateClick(item);
        await delay(500);
        break;
      }
    }

    // Step 3: Inject file via background script (MAIN world injection)
    try {
      await chrome.runtime.sendMessage({
        type: 'INJECT_FILE_INPUT',
        imageDataUrl
      });
      console.log(LOG_PREFIX, 'File injection requested');
    } catch (e) {
      console.warn(LOG_PREFIX, 'Background inject failed:', e.message);
      // Fallback: try direct file input
      const fileInput = MangoDom.findFileInput();
      if (fileInput) {
        const file = MangoDom.dataUrlToFile(imageDataUrl, `frame-${Date.now()}.png`);
        await MangoDom.attachFileToInput(fileInput, file);
      } else {
        return false;
      }
    }

    // Step 4: Wait for upload + handle crop dialog
    const uploaded = await waitForFrameUploaded(position, 20000);

    return uploaded;
  }

  async function waitForFrameUploaded(position, timeout = 20000) {
    const start = Date.now();
    const targetText = position === 'first' ? '첫 번째 프레임' : '마지막 프레임';

    while (Date.now() - start < timeout) {
      // Check if image is already attached
      if (isFrameAttached(position)) return true;

      // Handle crop dialog if it appears
      await handleCropDialog();

      await delay(500);
    }

    return false;
  }

  function isFrameAttached(position) {
    const container = findFrameContainer();
    const buttons = (container || document).querySelectorAll('button');
    const targetText = position === 'first' ? '첫 번째 프레임' : '마지막 프레임';

    for (const btn of buttons) {
      if ((btn.textContent || '').trim().includes(targetText)) return true;
    }
    return false;
  }

  async function handleCropDialog() {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (text.includes('자르기 및 저장') || text.includes('Crop and save')) {
        MangoDom.simulateClick(btn);
        console.log(LOG_PREFIX, 'Crop dialog handled');
        await delay(1000);
        return;
      }
    }
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

  async function waitForGenerationComplete(timeoutMin) {
    const timeout = (timeoutMin || 10) * 60 * 1000;
    console.log(LOG_PREFIX, `Waiting for generation (timeout: ${timeoutMin}min)...`);

    const start = Date.now();
    const checkInterval = 5000;

    // Give it time to start
    await delay(5000);

    while (Date.now() - start < timeout) {
      // Check for errors
      const err = checkForErrors();
      if (err) throw new Error(`Generation error: ${err}`);

      // Check if API result arrived (from inject.js)
      if (lastApiResult) {
        if (lastApiResult.ok && lastApiResult.hasMedia) {
          console.log(LOG_PREFIX, 'Generation complete (API result)');
          return;
        }
        if (!lastApiResult.ok) {
          throw new Error(`API error: ${lastApiResult.error || 'Unknown'}`);
        }
      }

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

  // ─── Image Settings Application (tune button) ───
  let imageSettingsApplied = false;

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
