// src/background/index.ts
chrome.runtime.onInstalled.addListener(() => {
  console.log("[Veo3] \uD655\uC7A5\uD504\uB85C\uADF8\uB7A8\uC774 \uC124\uCE58\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
});
chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "DOWNLOAD_VIDEO") {
    const { url, filename } = message;
    if (!url) {
      console.error("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4");
      sendResponse({ success: false, error: "URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4" });
      return true;
    }
    console.log(`[Veo3] \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791: ${filename}`);
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328:", chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else if (downloadId === void 0) {
          console.error("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC ID\uAC00 undefined\uC785\uB2C8\uB2E4");
          sendResponse({ success: false, error: "\uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328" });
        } else {
          console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791\uB428, ID: ${downloadId}`);
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }
  if (message.type === "DOWNLOAD_IMAGE") {
    const { url, filename } = message;
    console.log(`[Veo3] DOWNLOAD_IMAGE \uBA54\uC2DC\uC9C0 \uC218\uC2E0: ${filename}`);
    console.log(`[Veo3] URL \uAE38\uC774: ${(url == null ? void 0 : url.length) || 0}`);
    if (!url) {
      console.error("[Veo3] \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4");
      sendResponse({ success: false, error: "URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4" });
      return true;
    }
    console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791: ${filename}`);
    console.log(`[Veo3] URL \uC55E 100\uC790: ${url.substring(0, 100)}`);
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("[Veo3] \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328:", chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else if (downloadId === void 0) {
          console.error("[Veo3] \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC ID\uAC00 undefined\uC785\uB2C8\uB2E4");
          sendResponse({ success: false, error: "\uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328" });
        } else {
          console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791\uB428, ID: ${downloadId}`);
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }
  if (message.type === "downloadFile") {
    const { url, filename } = message;
    if (!url) {
      console.error("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4");
      sendResponse({ success: false, error: "URL\uC774 \uC5C6\uC2B5\uB2C8\uB2E4" });
      return true;
    }
    console.log(`[Veo3] \uD30C\uC77C \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791: ${filename}`);
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328:", chrome.runtime.lastError.message);
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else if (downloadId === void 0) {
          console.error("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC ID\uAC00 undefined\uC785\uB2C8\uB2E4");
          sendResponse({ success: false, error: "\uB2E4\uC6B4\uB85C\uB4DC \uC2E4\uD328" });
        } else {
          console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791\uB428, ID: ${downloadId}`);
          sendResponse({ success: true, downloadId });
        }
      }
    );
    return true;
  }
  if (message.type === "OPEN_DOWNLOAD_SETTINGS") {
    chrome.tabs.create({ url: "chrome://settings/downloads" });
    sendResponse({ success: true });
    return true;
  }
  if (message.type === "INJECT_GROK_FILE") {
    const { imageDataUrl } = message;
    console.log("[Grok] INJECT_GROK_FILE \uC218\uC2E0, dataUrl \uAE38\uC774:", (imageDataUrl == null ? void 0 : imageDataUrl.length) || 0);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      var _a;
      const tabId = (_a = tabs[0]) == null ? void 0 : _a.id;
      if (!tabId) {
        console.error("[Grok] \uD65C\uC131 \uD0ED\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        sendResponse({ success: false });
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (dataUrl) => {
          console.log("[Grok-MAIN] file input \uC778\uD130\uC149\uD130 \uC124\uC815 \uC2DC\uC791");
          const arr = dataUrl.split(",");
          const mimeMatch = arr[0].match(/:(.*?);/);
          const mime = mimeMatch ? mimeMatch[1] : "image/png";
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          const file = new File([u8arr], `grok-image-${Date.now()}.png`, { type: mime });
          console.log(`[Grok-MAIN] File \uC0DD\uC131: ${file.name}, \uD06C\uAE30: ${file.size}`);
          const origClick = HTMLInputElement.prototype.click;
          let intercepted = false;
          HTMLInputElement.prototype.click = function() {
            if (this.type === "file" && !intercepted) {
              intercepted = true;
              console.log("[Grok-MAIN] file input click \uAC00\uB85C\uCC44\uAE30 \uC131\uACF5!");
              HTMLInputElement.prototype.click = origClick;
              const dt = new DataTransfer();
              dt.items.add(file);
              this.files = dt.files;
              this.dispatchEvent(new Event("change", { bubbles: true }));
              console.log("[Grok-MAIN] \uD30C\uC77C \uC8FC\uC785 \uBC0F change \uC774\uBCA4\uD2B8 \uBC1C\uC0DD \uC644\uB8CC");
              return;
            }
            return origClick.call(this);
          };
          setTimeout(() => {
            if (!intercepted) {
              HTMLInputElement.prototype.click = origClick;
              console.log("[Grok-MAIN] \uC778\uD130\uC149\uD130 \uD0C0\uC784\uC544\uC6C3 - \uC6D0\uBCF8 \uBCF5\uC6D0");
            }
          }, 1e4);
        },
        args: [imageDataUrl]
      }).then(() => {
        console.log("[Grok] MAIN world \uC2A4\uD06C\uB9BD\uD2B8 \uC8FC\uC785 \uC131\uACF5");
        sendResponse({ success: true });
      }).catch((err) => {
        console.error("[Grok] MAIN world \uC2A4\uD06C\uB9BD\uD2B8 \uC8FC\uC785 \uC2E4\uD328:", err);
        sendResponse({ success: false, error: String(err) });
      });
    });
    return true;
  }
  if (message.type === "INJECT_FILE_INPUT") {
    const { imageDataUrl } = message;
    console.log("[Veo3] INJECT_FILE_INPUT \uC218\uC2E0, dataUrl \uAE38\uC774:", (imageDataUrl == null ? void 0 : imageDataUrl.length) || 0);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      var _a;
      const tabId = (_a = tabs[0]) == null ? void 0 : _a.id;
      if (!tabId) {
        console.error("[Veo3] \uD65C\uC131 \uD0ED\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        sendResponse({ success: false });
        return;
      }
      chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (dataUrl) => {
          console.log("[Veo3-MAIN] file input \uC778\uD130\uC149\uD130 \uC124\uC815 \uC2DC\uC791");
          const arr = dataUrl.split(",");
          const mimeMatch = arr[0].match(/:(.*?);/);
          const mime = mimeMatch ? mimeMatch[1] : "image/png";
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          const file = new File([u8arr], `frame-${Date.now()}.png`, { type: mime });
          console.log(`[Veo3-MAIN] File \uC0DD\uC131: ${file.name}, \uD06C\uAE30: ${file.size}`);
          const origClick = HTMLInputElement.prototype.click;
          let intercepted = false;
          HTMLInputElement.prototype.click = function() {
            if (this.type === "file" && !intercepted) {
              intercepted = true;
              console.log("[Veo3-MAIN] file input click \uAC00\uB85C\uCC44\uAE30 \uC131\uACF5!");
              HTMLInputElement.prototype.click = origClick;
              const dt = new DataTransfer();
              dt.items.add(file);
              this.files = dt.files;
              this.dispatchEvent(new Event("change", { bubbles: true }));
              console.log("[Veo3-MAIN] \uD30C\uC77C \uC8FC\uC785 \uBC0F change \uC774\uBCA4\uD2B8 \uBC1C\uC0DD \uC644\uB8CC");
              return;
            }
            return origClick.call(this);
          };
          setTimeout(() => {
            if (!intercepted) {
              HTMLInputElement.prototype.click = origClick;
              console.log("[Veo3-MAIN] \uC778\uD130\uC149\uD130 \uD0C0\uC784\uC544\uC6C3 - \uC6D0\uBCF8 \uBCF5\uC6D0");
            }
          }, 1e4);
        },
        args: [imageDataUrl]
      }).then(() => {
        console.log("[Veo3] MAIN world \uC2A4\uD06C\uB9BD\uD2B8 \uC8FC\uC785 \uC131\uACF5");
        sendResponse({ success: true });
      }).catch((err) => {
        console.error("[Veo3] MAIN world \uC2A4\uD06C\uB9BD\uD2B8 \uC8FC\uC785 \uC2E4\uD328:", err);
        sendResponse({ success: false, error: String(err) });
      });
    });
    return true;
  }
});
console.log("[Veo3] Background service worker \uCD08\uAE30\uD654\uB428");
