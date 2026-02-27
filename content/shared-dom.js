/**
 * MangoAuto - Shared DOM Utilities for Content Scripts
 */

const MangoDom = {
  /**
   * Wait for an element to appear in the DOM
   */
  waitForElement(selector, timeout = 15000, root = document) {
    return new Promise((resolve, reject) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element not found: ${selector} (timeout ${timeout}ms)`));
      }, timeout);

      const observer = new MutationObserver(() => {
        const el = root.querySelector(selector);
        if (el) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(root.body || root, { childList: true, subtree: true });
    });
  },

  /**
   * Wait for any element matching selectors (tries multiple)
   */
  async waitForAny(selectors, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`No element found for: ${selectors.join(', ')}`));
      }, timeout);

      // Check existing
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          clearTimeout(timer);
          return resolve(el);
        }
      }

      const observer = new MutationObserver(() => {
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) {
            clearTimeout(timer);
            observer.disconnect();
            return resolve(el);
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
    });
  },

  /**
   * Set value on an input/textarea with proper event dispatching
   */
  setInputValue(el, value) {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  /**
   * Set text on a contenteditable element
   */
  setContentEditable(el, text) {
    el.focus();
    // Clear existing content
    el.textContent = '';
    // Use execCommand for React-compatible input
    document.execCommand('insertText', false, text);
    // Also dispatch input event
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  },

  /**
   * Find a button by its text content
   */
  findButtonByText(text, exact = false) {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const btnText = btn.textContent.trim();
      if (exact ? btnText === text : btnText.includes(text)) {
        return btn;
      }
    }
    return null;
  },

  /**
   * Find a button by aria-label
   */
  findButtonByAriaLabel(label) {
    return document.querySelector(`button[aria-label="${label}"]`) ||
           document.querySelector(`button[aria-label*="${label}"]`);
  },

  /**
   * Click an element with human-like behavior
   */
  clickElement(el) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  },

  /**
   * Watch for new elements matching selector via MutationObserver
   * Returns a promise that resolves with the new element
   */
  watchForNew(selector, timeout = 120000, ignoreExisting = true) {
    return new Promise((resolve, reject) => {
      const existingSet = new Set();
      if (ignoreExisting) {
        document.querySelectorAll(selector).forEach(el => existingSet.add(el));
      }

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`New element not found: ${selector} (timeout ${timeout}ms)`));
      }, timeout);

      const observer = new MutationObserver(() => {
        const all = document.querySelectorAll(selector);
        for (const el of all) {
          if (!existingSet.has(el)) {
            clearTimeout(timer);
            observer.disconnect();
            return resolve(el);
          }
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  },

  /**
   * Watch for multiple new elements (e.g., batch image generation)
   */
  watchForNewMultiple(selector, minCount, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const existingSet = new Set();
      document.querySelectorAll(selector).forEach(el => existingSet.add(el));

      const timer = setTimeout(() => {
        observer.disconnect();
        const found = [...document.querySelectorAll(selector)].filter(el => !existingSet.has(el));
        if (found.length > 0) resolve(found);
        else reject(new Error(`New elements not found: ${selector}`));
      }, timeout);

      const observer = new MutationObserver(() => {
        const newEls = [...document.querySelectorAll(selector)].filter(el => !existingSet.has(el));
        if (newEls.length >= minCount) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(newEls);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
  },

  /**
   * Wait for text to appear in the page
   */
  waitForText(texts, timeout = 30000) {
    if (typeof texts === 'string') texts = [texts];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Text not found: ${texts.join(', ')}`));
      }, timeout);

      const check = () => {
        const body = document.body.innerText;
        for (const t of texts) {
          if (body.includes(t)) {
            clearTimeout(timer);
            observer.disconnect();
            return resolve(t);
          }
        }
        return null;
      };

      if (check()) return;

      const observer = new MutationObserver(() => check());
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  },

  /**
   * Convert image element to data URL
   */
  async imageToDataUrl(imgEl) {
    // If it's already a data URL or blob URL
    if (imgEl.src.startsWith('data:') || imgEl.src.startsWith('blob:')) {
      const resp = await fetch(imgEl.src);
      const blob = await resp.blob();
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }

    // Use canvas
    const canvas = document.createElement('canvas');
    canvas.width = imgEl.naturalWidth || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0);
    return canvas.toDataURL('image/png');
  },

  /**
   * Fetch URL as data URL (for cross-origin images with proper CORS)
   */
  async fetchAsDataUrl(url) {
    const resp = await fetch(url);
    const blob = await resp.blob();
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  },

  /**
   * Convert a data URL to a File object
   */
  dataUrlToFile(dataUrl, filename = 'image.png') {
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    const u8arr = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) {
      u8arr[i] = bstr.charCodeAt(i);
    }
    return new File([u8arr], filename, { type: mime });
  },

  /**
   * Attach a file to a file input element by dispatching a synthetic change event.
   * Finds <input type="file"> and sets it via DataTransfer.
   */
  async attachFileToInput(fileInputEl, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInputEl.files = dt.files;
    fileInputEl.dispatchEvent(new Event('change', { bubbles: true }));
    fileInputEl.dispatchEvent(new Event('input', { bubbles: true }));
  },

  /**
   * Find a file input on the page (visible or hidden)
   */
  findFileInput() {
    // Visible file inputs
    const visible = document.querySelector('input[type="file"]:not([disabled])');
    if (visible) return visible;
    // Hidden file inputs (often used by drag-drop or button-triggered uploads)
    const all = document.querySelectorAll('input[type="file"]');
    for (const el of all) {
      if (!el.disabled) return el;
    }
    return null;
  },

  /**
   * Simulate drag-and-drop of a file onto a target element.
   * Used when there's no accessible file input.
   */
  async dropFileOnElement(targetEl, file) {
    const dt = new DataTransfer();
    dt.items.add(file);

    const events = ['dragenter', 'dragover', 'drop'];
    for (const evtName of events) {
      const evt = new DragEvent(evtName, {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt
      });
      targetEl.dispatchEvent(evt);
      await new Promise(r => setTimeout(r, 100));
    }
  },

  /**
   * Evaluate XPath and return first matching element
   */
  getByXPath(xpath) {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    } catch (e) {
      console.warn('[MangoDom] XPath error:', e.message);
      return null;
    }
  },

  /**
   * Evaluate XPath and return all matching elements
   */
  getAllByXPath(xpath) {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i++) {
        nodes.push(result.snapshotItem(i));
      }
      return nodes;
    } catch (e) {
      console.warn('[MangoDom] XPath error:', e.message);
      return [];
    }
  },

  /**
   * Click with PointerEvent sequence (more reliable for React apps)
   */
  simulateClick(el) {
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  },

  /**
   * Set textarea value with React-compatible native setter
   */
  setTextareaValue(textarea, text) {
    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(textarea, '');
      nativeSetter.call(textarea, text);
    } else {
      textarea.value = text;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  },

  /**
   * Attach image to the current page using the best available method:
   * 1. Try finding a file input and setting files
   * 2. Try clicking an upload/attach button then setting file input
   * 3. Fall back to drag-and-drop on the main area
   */
  async attachImage(imageDataUrl, filename = 'source.png') {
    const file = this.dataUrlToFile(imageDataUrl, filename);

    // Strategy 1: Find existing file input
    let fileInput = this.findFileInput();
    if (fileInput) {
      console.log('[MangoDom] Attaching via file input');
      await this.attachFileToInput(fileInput, file);
      return true;
    }

    // Strategy 2: Click an upload/attach button to trigger file input creation
    const uploadBtnSelectors = [
      'button[aria-label*="upload" i]',
      'button[aria-label*="attach" i]',
      'button[aria-label*="image" i]',
      'button[aria-label*="photo" i]',
      '[class*="upload"]',
      '[class*="attach"]'
    ];
    for (const sel of uploadBtnSelectors) {
      const btn = document.querySelector(sel);
      if (btn) {
        console.log('[MangoDom] Clicking upload button:', sel);
        btn.click();
        await new Promise(r => setTimeout(r, 800));
        fileInput = this.findFileInput();
        if (fileInput) {
          await this.attachFileToInput(fileInput, file);
          return true;
        }
      }
    }

    // Strategy 3: Drag-and-drop on main content area
    const dropTargets = [
      document.querySelector('[class*="drop"]'),
      document.querySelector('[class*="upload"]'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
      document.body
    ];
    for (const target of dropTargets) {
      if (target) {
        console.log('[MangoDom] Attempting drag-drop on:', target.tagName);
        await this.dropFileOnElement(target, file);
        return true;
      }
    }

    return false;
  }
};

if (typeof window !== 'undefined') {
  window.MangoDom = MangoDom;
}

// ─── Auto Dialog Dismisser ───
// Automatically handles popups, consent dialogs, cookie banners, etc.
const MangoDialogDismisser = {
  disabled: false,
  _intervalId: null,
  _initialTimerId: null,
  _dismissed: new WeakSet(), // 이미 클릭한 버튼 추적 (재클릭 방지)

  // Common dismiss/accept button texts across platforms
  ACCEPT_TEXTS: [
    // English
    'Accept', 'Accept all', 'I agree', 'OK', 'Got it', 'Understood',
    'Continue', 'Dismiss', 'Close', 'Skip', 'No thanks', 'Not now',
    'Allow', 'Agree', 'Yes', 'Confirm',
    // Korean
    '동의', '동의함', '확인', '닫기', '건너뛰기', '수락', '모두 수락',
    '계속', '허용', '알겠습니다', '이해했습니다'
  ],

  // Selectors for common dialog/overlay elements
  DIALOG_SELECTORS: [
    // Cookie consent banners
    '[class*="cookie"] button',
    '[class*="consent"] button',
    '[id*="cookie"] button',
    '[id*="consent"] button',
    // Google-specific
    '[class*="glue-cookie"] button',
    'tp-yt-paper-dialog button',
    // Generic overlays
    '[role="dialog"] button',
    '[class*="modal"] button',
    '[class*="overlay"] button',
    '[class*="banner"] button',
    '[class*="popup"] button',
    '[class*="snackbar"] button',
    '[class*="toast"] button'
  ],

  // Stop periodic dismissal
  stop() {
    this.disabled = true;
    if (this._intervalId) { clearInterval(this._intervalId); this._intervalId = null; }
    if (this._initialTimerId) { clearTimeout(this._initialTimerId); this._initialTimerId = null; }
    console.log('[MangoDialog] Stopped');
  },

  // Resume periodic dismissal
  resume() {
    this.disabled = false;
    this.startAutoDismisal();
    console.log('[MangoDialog] Resumed');
  },

  // Try to find and click an accept/dismiss button
  tryDismiss() {
    if (this.disabled) return false;
    // Strategy 1: Known dialog selectors
    for (const sel of this.DIALOG_SELECTORS) {
      const buttons = document.querySelectorAll(sel);
      for (const btn of buttons) {
        if (this._dismissed.has(btn)) continue; // 이미 클릭한 버튼 건너뛰기
        const text = btn.textContent.trim();
        if (text.length > 0 && text.length < 30) {
          for (const acceptText of this.ACCEPT_TEXTS) {
            if (text.toLowerCase() === acceptText.toLowerCase() ||
                text.toLowerCase().includes(acceptText.toLowerCase())) {
              btn.click();
              this._dismissed.add(btn);
              console.log('[MangoDialog] Dismissed:', text);
              return true;
            }
          }
        }
      }
    }

    // Strategy 2: aria-label on close buttons
    const closeButtons = document.querySelectorAll(
      'button[aria-label="Close"], button[aria-label="Dismiss"], ' +
      'button[aria-label="닫기"], button[aria-label="확인"], ' +
      '[class*="close-btn"], [class*="dismiss"]'
    );
    for (const btn of closeButtons) {
      if (this._dismissed.has(btn)) continue;
      if (btn.offsetParent !== null) { // visible
        btn.click();
        this._dismissed.add(btn);
        console.log('[MangoDialog] Closed via aria-label/class');
        return true;
      }
    }

    return false;
  },

  // Start periodic checking
  startAutoDismisal(intervalMs = 4000) {
    // Clear existing timers first
    if (this._intervalId) clearInterval(this._intervalId);
    if (this._initialTimerId) clearTimeout(this._initialTimerId);

    // Initial check after page load
    this._initialTimerId = setTimeout(() => this.tryDismiss(), 2000);

    // Periodic check
    this._intervalId = setInterval(() => this.tryDismiss(), intervalMs);
  }
};

if (typeof window !== 'undefined') {
  window.MangoDialogDismisser = MangoDialogDismisser;
  // Auto-start dialog dismissal on all platforms
  MangoDialogDismisser.startAutoDismisal();
}
