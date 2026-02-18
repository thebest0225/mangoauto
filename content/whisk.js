/**
 * MangoAuto - Google Whisk (ImageFX) Automation
 * Content script for labs.google/fx/tools/image-fx
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Whisk]';
  let isProcessing = false;

  const ERROR_PHRASES = [
    'could not generate',
    'unable to generate',
    'violates',
    'policy',
    'try again',
    'something went wrong',
    'error'
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
      sendResponse({ ok: true, site: 'whisk' });
      return;
    }
  });

  async function handleExecutePrompt(msg) {
    if (isProcessing) throw new Error('Already processing');
    isProcessing = true;

    try {
      const { prompt, settings } = msg;
      console.log(LOG_PREFIX, 'Executing prompt:', prompt.substring(0, 60));

      // Apply image settings
      if (settings?.image) {
        try {
          if (settings.image.aspectRatio) {
            const labels = { '16:9': ['16:9', 'Landscape', '가로'], '9:16': ['9:16', 'Portrait', '세로'], '1:1': ['1:1', 'Square', '정사각'] };
            const texts = labels[settings.image.aspectRatio] || [settings.image.aspectRatio];
            for (const text of texts) {
              const el = document.querySelector(`[data-value="${settings.image.aspectRatio}"]`) || MangoDom.findButtonByText(text);
              if (el) { el.click(); await MangoUtils.sleep(300); break; }
            }
          }
        } catch (e) { console.warn(LOG_PREFIX, 'Settings partial:', e.message); }
      }

      // Fill prompt
      await fillPrompt(prompt);
      await MangoUtils.sleep(600 + Math.random() * 400);

      // Click generate
      await clickGenerate();

      // Step 3: Wait for images
      const result = await waitForImages();

      // Step 4: Extract first image
      const mediaDataUrl = await extractImage(result);

      chrome.runtime.sendMessage({
        type: 'GENERATION_COMPLETE',
        mediaDataUrl,
        mediaType: 'image'
      });

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

  // ─── Fill prompt ───
  async function fillPrompt(text) {
    // ImageFX uses textarea or contenteditable for prompt input
    const inputSelectors = [
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]',
      'input[type="text"]'
    ];

    let input = null;
    for (const sel of inputSelectors) {
      input = document.querySelector(sel);
      if (input) break;
    }

    if (!input) {
      input = await MangoDom.waitForAny(inputSelectors, 10000);
    }
    if (!input) throw new Error('Cannot find prompt input');

    console.log(LOG_PREFIX, 'Found input:', input.tagName);

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.focus();
      // Clear existing
      input.value = '';
      // React-compatible value setter
      const proto = input.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(input, text);
      } else {
        input.value = text;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      MangoDom.setContentEditable(input, text);
    }

    await MangoUtils.sleep(300);
  }

  // ─── Click generate button ───
  async function clickGenerate() {
    const strategies = [
      () => MangoDom.findButtonByText('Generate'),
      () => MangoDom.findButtonByText('Create'),
      () => document.querySelector('button[aria-label*="generate" i]'),
      () => document.querySelector('button[aria-label*="create" i]'),
      () => document.querySelector('button[type="submit"]'),
      () => {
        // Look for primary/action button
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          const style = getComputedStyle(btn);
          if (style.backgroundColor && !btn.disabled &&
              btn.offsetWidth > 60 && btn.textContent.trim()) {
            return btn;
          }
        }
        return null;
      }
    ];

    let btn = null;
    for (const strategy of strategies) {
      btn = strategy();
      if (btn && !btn.disabled) break;
      btn = null;
    }

    if (!btn) throw new Error('Cannot find generate button');

    console.log(LOG_PREFIX, 'Clicking generate:', btn.textContent.trim());
    MangoDom.clickElement(btn);
    await MangoUtils.sleep(1000);
  }

  // ─── Wait for generated images ───
  async function waitForImages() {
    console.log(LOG_PREFIX, 'Waiting for image generation...');
    const timeout = 120000;

    // Track existing images
    const existingImages = new Set();
    document.querySelectorAll('img').forEach(el => existingImages.add(el));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        clearInterval(errorChecker);
        reject(new Error('Generation timed out'));
      }, timeout);

      const errorChecker = setInterval(() => {
        const err = checkForErrors();
        if (err) {
          clearTimeout(timer);
          clearInterval(errorChecker);
          observer.disconnect();
          reject(new Error(`Generation error: ${err}`));
        }
      }, 2000);

      const observer = new MutationObserver(() => {
        const allImgs = document.querySelectorAll('img');
        for (const img of allImgs) {
          if (existingImages.has(img)) continue;
          // Filter for generated images (reasonably large)
          if ((img.naturalWidth >= 200 || img.width >= 200 || !img.complete) &&
              !img.src.includes('icon') && !img.src.includes('logo') &&
              !img.src.includes('avatar')) {
            clearTimeout(timer);
            clearInterval(errorChecker);
            observer.disconnect();

            // Wait for image to fully load
            const onLoad = () => {
              setTimeout(() => resolve({ element: img }), 500);
            };
            if (img.complete && img.naturalWidth > 0) {
              onLoad();
            } else {
              img.addEventListener('load', onLoad, { once: true });
              setTimeout(() => resolve({ element: img }), 8000);
            }
            return;
          }
        }
      });

      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src']
      });
    });
  }

  // ─── Extract image ───
  async function extractImage(result) {
    try {
      return await MangoDom.imageToDataUrl(result.element);
    } catch {
      if (result.element.src) {
        return await MangoDom.fetchAsDataUrl(result.element.src);
      }
      throw new Error('Cannot extract image');
    }
  }

  // ─── Error detection ───
  function checkForErrors() {
    const alerts = document.querySelectorAll(
      '[role="alert"], [class*="error"], [class*="warning"], .snackbar, [class*="snack"]'
    );
    for (const el of alerts) {
      const text = el.textContent.trim().toLowerCase();
      if (text.length > 0 && text.length < 300) {
        for (const phrase of ERROR_PHRASES) {
          if (text.includes(phrase.toLowerCase())) {
            return el.textContent.trim();
          }
        }
      }
    }
    return null;
  }

  console.log(LOG_PREFIX, 'Content script loaded');
})();
