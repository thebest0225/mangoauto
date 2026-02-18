/**
 * MangoAuto - Google Veo (VideoFX) Automation
 * Content script for labs.google/fx/tools/video-fx
 */

(() => {
  const LOG_PREFIX = '[MangoAuto:Veo]';
  let isProcessing = false;

  const ERROR_PHRASES = [
    'could not generate', 'unable to generate', 'violates', 'policy',
    'try again', 'something went wrong', 'error generating'
  ];

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXECUTE_PROMPT') {
      handleExecutePrompt(msg).then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
      });
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true, site: 'veo' });
      return;
    }
  });

  async function handleExecutePrompt(msg) {
    if (isProcessing) throw new Error('Already processing');
    isProcessing = true;

    try {
      const { prompt, sourceImageDataUrl, settings } = msg;
      console.log(LOG_PREFIX, 'Executing:', prompt.substring(0, 60));

      // Apply platform settings
      if (settings?.veo) {
        await applySettings(settings.veo);
      }

      // Attach source image if provided
      if (sourceImageDataUrl) {
        console.log(LOG_PREFIX, 'Attaching source image...');
        const attached = await MangoDom.attachImage(sourceImageDataUrl, 'source.png');
        if (attached) {
          console.log(LOG_PREFIX, 'Source image attached');
          await MangoUtils.sleep(1500);
        } else {
          console.warn(LOG_PREFIX, 'Could not attach source image');
        }
      }

      await fillPrompt(prompt);
      await MangoUtils.sleep(600 + Math.random() * 400);

      await clickGenerate();

      const result = await waitForVideo(settings?.grok?.timeout || 10);

      const mediaDataUrl = await extractVideo(result);

      chrome.runtime.sendMessage({
        type: 'GENERATION_COMPLETE',
        mediaDataUrl,
        mediaType: 'video'
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

  // ─── Apply Settings ───
  async function applySettings(veoSettings) {
    try {
      // Try to select model
      if (veoSettings.model) {
        const modelLabels = {
          'veo-3': 'Veo 3',
          'veo-3.1-fast': 'Veo 3.1',
          'veo-3.1-quality': 'Veo 3.1'
        };
        const label = modelLabels[veoSettings.model] || veoSettings.model;
        const btn = MangoDom.findButtonByText(label);
        if (btn) {
          btn.click();
          await MangoUtils.sleep(300);
        }
      }

      // Try to set aspect ratio
      if (veoSettings.aspectRatio) {
        await trySetAspectRatio(veoSettings.aspectRatio);
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Settings partial/failed:', e.message);
    }
  }

  async function trySetAspectRatio(ratio) {
    const labels = { '16:9': ['16:9', 'Landscape', '가로'], '9:16': ['9:16', 'Portrait', '세로'], '1:1': ['1:1', 'Square', '정사각'] };
    const texts = labels[ratio] || [ratio];
    for (const text of texts) {
      const el = document.querySelector(`[data-value="${ratio}"]`) || MangoDom.findButtonByText(text);
      if (el) {
        el.click();
        await MangoUtils.sleep(300);
        return;
      }
    }
  }

  // ─── Fill prompt ───
  async function fillPrompt(text) {
    const inputSelectors = [
      'textarea[aria-label*="prompt" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea[placeholder*="describe" i]',
      'textarea',
      '[contenteditable="true"]',
      '[role="textbox"]'
    ];

    let input = null;
    for (const sel of inputSelectors) {
      input = document.querySelector(sel);
      if (input) break;
    }
    if (!input) input = await MangoDom.waitForAny(inputSelectors, 10000);
    if (!input) throw new Error('Cannot find prompt input');

    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.focus();
      input.value = '';
      const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      MangoDom.setContentEditable(input, text);
    }
    await MangoUtils.sleep(300);
  }

  // ─── Click generate ───
  async function clickGenerate() {
    const strategies = [
      () => MangoDom.findButtonByText('Generate'),
      () => MangoDom.findButtonByText('Create'),
      () => document.querySelector('button[aria-label*="generate" i]'),
      () => document.querySelector('button[type="submit"]'),
    ];
    let btn = null;
    for (const s of strategies) {
      btn = s();
      if (btn && !btn.disabled) break;
      btn = null;
    }
    if (!btn) throw new Error('Cannot find generate button');
    MangoDom.clickElement(btn);
    await MangoUtils.sleep(1000);
  }

  // ─── Wait for video ───
  async function waitForVideo(timeoutMin) {
    const timeout = (timeoutMin || 10) * 60000;
    const existingVideos = new Set();
    document.querySelectorAll('video').forEach(el => existingVideos.add(el));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect(); clearInterval(errorChecker); clearInterval(progressLogger);
        reject(new Error('Video generation timed out'));
      }, timeout);

      const errorChecker = setInterval(() => {
        const err = checkForErrors();
        if (err) {
          clearTimeout(timer); clearInterval(errorChecker); clearInterval(progressLogger);
          observer.disconnect();
          reject(new Error(`Generation error: ${err}`));
        }
      }, 3000);

      const startTime = Date.now();
      const progressLogger = setInterval(() => {
        console.log(LOG_PREFIX, `Waiting... ${Math.round((Date.now() - startTime) / 1000)}s`);
      }, 15000);

      const observer = new MutationObserver(() => {
        const allVideos = document.querySelectorAll('video');
        for (const video of allVideos) {
          if (existingVideos.has(video)) continue;
          const src = video.src || video.querySelector('source')?.src || '';
          if (src && (src.includes('blob:') || src.includes('http'))) {
            clearTimeout(timer); clearInterval(errorChecker); clearInterval(progressLogger);
            observer.disconnect();
            if (video.readyState >= 2) {
              setTimeout(() => resolve({ element: video, src }), 1000);
            } else {
              video.addEventListener('canplay', () => setTimeout(() => resolve({ element: video, src }), 1000), { once: true });
              setTimeout(() => resolve({ element: video, src }), 15000);
            }
            return;
          }
        }

        const links = document.querySelectorAll('a[download], a[href*="blob:"]');
        for (const a of links) {
          if (a.href && (a.href.includes('blob:') || a.href.includes('.mp4'))) {
            clearTimeout(timer); clearInterval(errorChecker); clearInterval(progressLogger);
            observer.disconnect();
            setTimeout(() => resolve({ src: a.href, isLink: true }), 1000);
            return;
          }
        }
      });

      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'href']
      });
    });
  }

  async function extractVideo(result) {
    const src = result.src || result.element?.src || result.element?.querySelector('source')?.src;
    if (!src) throw new Error('Cannot find video source');
    return await MangoDom.fetchAsDataUrl(src);
  }

  function checkForErrors() {
    const alerts = document.querySelectorAll('[role="alert"], [class*="error"], [class*="warning"], .snackbar');
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

  console.log(LOG_PREFIX, 'Content script loaded');
})();
