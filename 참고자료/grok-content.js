"use strict";
(() => {
  // src/utils/grok-controller.ts
  var GrokController = class {
    // ==================== 유틸리티 ====================
    isReady() {
      return window.location.href.includes("grok.com/imagine");
    }
    isOnMainPage() {
      const url = window.location.href;
      return url.includes("grok.com/imagine") && !url.includes("/post/");
    }
    isOnResultPage() {
      return window.location.href.includes("grok.com/imagine/post/");
    }
    async delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    // ==================== 요소 찾기 ====================
    findEditor() {
      return document.querySelector(".tiptap.ProseMirror");
    }
    findSubmitButton() {
      var _a;
      let btn = document.querySelector('button[aria-label="\uC81C\uCD9C"]');
      if (btn) return btn;
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        const text = ((_a = b.textContent) == null ? void 0 : _a.trim()) || "";
        if (text === "\uC81C\uCD9C" || text === "Submit") return b;
      }
      return null;
    }
    findButtonByText(text) {
      var _a;
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        if ((_a = btn.textContent) == null ? void 0 : _a.trim().includes(text)) return btn;
      }
      return null;
    }
    findMenuItemByText(text) {
      var _a;
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if ((_a = item.textContent) == null ? void 0 : _a.trim().includes(text)) return item;
      }
      return null;
    }
    findFileInput() {
      return document.querySelector('input[type="file"]');
    }
    // React 앱에서 .click()만으로는 이벤트가 트리거되지 않는 경우가 있음
    // pointerdown → pointerup → click 시퀀스를 dispatch하여 해결
    simulateClick(element) {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
    // ==================== TipTap 에디터 입력 ====================
    async typePrompt(text) {
      var _a;
      const editor = this.findEditor();
      if (!editor) throw new Error("[Grok] TipTap \uC5D0\uB514\uD130\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
      editor.focus();
      await this.delay(100);
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
      await this.delay(100);
      document.execCommand("insertText", false, text);
      await this.delay(200);
      const currentText = ((_a = editor.textContent) == null ? void 0 : _a.trim()) || "";
      if (currentText !== text.trim()) {
        console.log("[Grok] execCommand \uC2E4\uD328, fallback \uC2DC\uB3C4");
        const p = editor.querySelector("p");
        if (p) {
          p.textContent = text;
        } else {
          editor.innerHTML = `<p>${text}</p>`;
        }
        editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        await this.delay(200);
      }
      console.log(`[Grok] \uD504\uB86C\uD504\uD2B8 \uC785\uB825 \uC644\uB8CC: "${text.substring(0, 50)}..."`);
    }
    // ==================== 자동 생성 감지 ====================
    // "업로드 시 자동 비디오 생성" 모드가 활성화되면 이미지 첨부 후
    // "동영상 취소" 버튼이 나타남 (메인 페이지에서 자동으로 생성 시작)
    isAutoGenerating() {
      var _a;
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = ((_a = btn.textContent) == null ? void 0 : _a.trim()) || "";
        if (text === "\uB3D9\uC601\uC0C1 \uCDE8\uC18C" || text === "Cancel video") return true;
      }
      return false;
    }
    // ==================== 제출 ====================
    // 제출 시도 (자동 생성 모드에서는 버튼이 비활성화됨 → false 반환)
    async tryClickSubmit() {
      if (this.isAutoGenerating()) {
        console.log("[Grok] \uC790\uB3D9 \uC0DD\uC131 \uBAA8\uB4DC \uAC10\uC9C0 - \uC81C\uCD9C \uAC74\uB108\uB700");
        return false;
      }
      const btn = await this.waitForSubmitEnabled(5e3);
      if (!btn) {
        console.log("[Grok] \uC81C\uCD9C \uBC84\uD2BC \uBE44\uD65C\uC131\uD654 \uB610\uB294 \uC5C6\uC74C - \uC790\uB3D9 \uC0DD\uC131 \uBAA8\uB4DC\uC77C \uC218 \uC788\uC74C");
        return false;
      }
      btn.click();
      console.log("[Grok] \uC81C\uCD9C \uBC84\uD2BC \uD074\uB9AD \uC644\uB8CC");
      await this.delay(1e3);
      return true;
    }
    async waitForSubmitEnabled(timeout = 5e3) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        if (this.isAutoGenerating()) return null;
        const btn = this.findSubmitButton();
        if (btn && !btn.disabled) return btn;
        await this.delay(300);
      }
      return null;
    }
    // ==================== 이미지 첨부 ====================
    // 기존 첨부된 이미지를 제거 (다음 이미지 첨부 전 호출)
    async removeExistingAttachment() {
      var _a;
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        if (((_a = btn.textContent) == null ? void 0 : _a.trim()) === "\uC0AD\uC81C") {
          btn.click();
          console.log("[Grok] \uC774\uC804 \uCCA8\uBD80 \uC774\uBBF8\uC9C0 \uC0AD\uC81C");
          await this.delay(1e3);
          break;
        }
      }
      const fileInput = this.findFileInput();
      if (fileInput) {
        fileInput.value = "";
        const emptyDt = new DataTransfer();
        fileInput.files = emptyDt.files;
      }
    }
    async attachImage(imageDataUrl) {
      try {
        await this.removeExistingAttachment();
        await this.delay(500);
        const fileInput = this.findFileInput();
        if (!fileInput) throw new Error("file input\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
        const file = this.dataUrlToFile(imageDataUrl, `image-${Date.now()}.png`);
        console.log(`[Grok] \uC0C8 \uC774\uBBF8\uC9C0 \uCCA8\uBD80 \uC2DC\uB3C4: ${file.name}, \uD06C\uAE30: ${file.size}`);
        fileInput.value = "";
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event("change", { bubbles: true }));
        fileInput.dispatchEvent(new Event("input", { bubbles: true }));
        await this.delay(2e3);
        const attached = this.checkImageAttached();
        if (attached) {
          console.log("[Grok] \uC774\uBBF8\uC9C0 \uCCA8\uBD80 \uC131\uACF5");
          return true;
        }
        console.warn("[Grok] \uC774\uBBF8\uC9C0 \uCCA8\uBD80 \uD655\uC778 \uC2E4\uD328, \uADF8\uB798\uB3C4 \uC9C4\uD589");
        if (fileInput.files && fileInput.files.length > 0) {
          return true;
        }
      } catch (e) {
        console.error("[Grok] \uC774\uBBF8\uC9C0 \uCCA8\uBD80 \uC2E4\uD328:", e);
      }
      return false;
    }
    checkImageAttached() {
      var _a;
      const deleteBtn = document.querySelector("button");
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = ((_a = btn.textContent) == null ? void 0 : _a.trim()) || "";
        if (text === "\uC0AD\uC81C") return true;
      }
      const images = document.querySelectorAll('img[src^="blob:"], img[src^="data:"]');
      if (images.length > 0) return true;
      return false;
    }
    dataUrlToFile(dataUrl, filename) {
      const arr = dataUrl.split(",");
      const mimeMatch = arr[0].match(/:(.*?);/);
      const mime = mimeMatch ? mimeMatch[1] : "image/png";
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      return new File([u8arr], filename, { type: mime });
    }
    // ==================== 모델/설정 적용 ====================
    async applySettings(settings) {
      const modelBtn = document.querySelector('button[aria-label="\uBAA8\uB378 \uC120\uD0DD"]') || this.findButtonByText("\uBAA8\uB378 \uC120\uD0DD");
      if (!modelBtn) {
        console.warn("[Grok] \uBAA8\uB378 \uC120\uD0DD \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        return;
      }
      modelBtn.click();
      await this.delay(500);
      const videoItem = this.findMenuItemByText("\uBE44\uB514\uC624");
      if (videoItem) {
        videoItem.click();
        await this.delay(300);
      }
      modelBtn.click();
      await this.delay(500);
      const durationBtn = this.findSettingButton(settings.videoDuration);
      if (durationBtn) {
        durationBtn.click();
        await this.delay(200);
      }
      const resBtn = this.findSettingButton(settings.videoResolution);
      if (resBtn) {
        resBtn.click();
        await this.delay(200);
      }
      const ratioBtn = this.findSettingButton(settings.aspectRatio);
      if (ratioBtn) {
        ratioBtn.click();
        await this.delay(200);
      }
      document.body.click();
      await this.delay(300);
      console.log(`[Grok] \uC124\uC815 \uC801\uC6A9 \uC644\uB8CC: ${settings.videoDuration}, ${settings.videoResolution}, ${settings.aspectRatio}`);
    }
    findSettingButton(text) {
      var _a;
      const menu = document.querySelector('[role="menu"]');
      if (!menu) return null;
      const buttons = menu.querySelectorAll("button");
      for (const btn of buttons) {
        if (((_a = btn.textContent) == null ? void 0 : _a.trim()) === text) return btn;
      }
      return null;
    }
    // ==================== 자동 비디오 생성 설정 ====================
    // 설정 > 동작 > "자동 비디오 생성 활성화" 스위치를 원하는 상태로 전환
    async setAutoVideoGeneration(enabled) {
      var _a, _b, _c;
      const pfpBtn = ((_a = document.querySelector('img[alt="pfp"]')) == null ? void 0 : _a.closest("button")) || document.querySelector('button[aria-label="pfp"]');
      if (!pfpBtn) {
        console.warn("[Grok] \uD504\uB85C\uD544 \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        return;
      }
      this.simulateClick(pfpBtn);
      await this.delay(800);
      const settingsItem = this.findMenuItemByText("\uC124\uC815");
      if (!settingsItem) {
        console.warn("[Grok] \uC124\uC815 \uBA54\uB274\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        document.body.click();
        return;
      }
      this.simulateClick(settingsItem);
      await this.delay(800);
      const dialog = document.querySelector('dialog, [role="dialog"]');
      if (!dialog) {
        console.warn("[Grok] \uC124\uC815 \uB2E4\uC774\uC5BC\uB85C\uADF8\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        return;
      }
      const dialogButtons = dialog.querySelectorAll("button");
      let behaviorTab = null;
      for (const btn of dialogButtons) {
        if (((_b = btn.textContent) == null ? void 0 : _b.trim()) === "\uB3D9\uC791" || ((_c = btn.textContent) == null ? void 0 : _c.trim()) === "Behavior") {
          behaviorTab = btn;
          break;
        }
      }
      if (!behaviorTab) {
        console.warn("[Grok] \uB3D9\uC791 \uD0ED\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        this.closeSettingsDialog(dialog);
        return;
      }
      this.simulateClick(behaviorTab);
      await this.delay(500);
      const switches = dialog.querySelectorAll('[role="switch"]');
      let autoVideoSwitch = null;
      for (const sw of switches) {
        const label = sw.getAttribute("aria-label") || "";
        if (label.includes("\uC790\uB3D9 \uBE44\uB514\uC624 \uC0DD\uC131") || label.includes("auto video") || label.includes("Auto video")) {
          autoVideoSwitch = sw;
          break;
        }
      }
      if (!autoVideoSwitch) {
        console.warn("[Grok] \uC790\uB3D9 \uBE44\uB514\uC624 \uC0DD\uC131 \uC2A4\uC704\uCE58\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        this.closeSettingsDialog(dialog);
        return;
      }
      const isChecked = autoVideoSwitch.getAttribute("aria-checked") === "true";
      if (isChecked !== enabled) {
        this.simulateClick(autoVideoSwitch);
        await this.delay(300);
        console.log(`[Grok] \uC790\uB3D9 \uBE44\uB514\uC624 \uC0DD\uC131: ${isChecked ? "ON\u2192OFF" : "OFF\u2192ON"}`);
      } else {
        console.log(`[Grok] \uC790\uB3D9 \uBE44\uB514\uC624 \uC0DD\uC131: \uC774\uBBF8 ${enabled ? "ON" : "OFF"} \uC0C1\uD0DC`);
      }
      this.closeSettingsDialog(dialog);
      await this.delay(300);
      this.closeSidebar();
      await this.delay(300);
    }
    closeSidebar() {
      const isSidebarOpen = Array.from(document.querySelectorAll("a")).some(
        (a) => {
          var _a;
          return ((_a = a.textContent) == null ? void 0 : _a.trim()) === "\uCC44\uD305";
        }
      );
      if (!isSidebarOpen) return;
      const toggleBtn = document.querySelector('button[aria-label="\uC0AC\uC774\uB4DC\uBC14 \uC804\uD658"]');
      if (toggleBtn) {
        this.simulateClick(toggleBtn);
        console.log("[Grok] \uC0AC\uC774\uB4DC\uBC14 \uB2EB\uAE30");
      }
    }
    closeSettingsDialog(dialog) {
      var _a, _b;
      const closeBtn = dialog.querySelector("button");
      if (closeBtn && (((_a = closeBtn.textContent) == null ? void 0 : _a.trim()) === "\uB2EB\uAE30" || ((_b = closeBtn.textContent) == null ? void 0 : _b.trim()) === "Close" || closeBtn.getAttribute("aria-label") === "\uB2EB\uAE30")) {
        this.simulateClick(closeBtn);
      } else {
        const firstBtn = dialog.querySelector("button");
        if (firstBtn) this.simulateClick(firstBtn);
      }
    }
    // ==================== 검열 감지 ====================
    // 결과 페이지에서 이미지가 검열(Moderated)되었는지 확인
    isModerated() {
      const images = document.querySelectorAll('img[alt="Moderated"]');
      return images.length > 0;
    }
    // ==================== 결과 페이지 대기 ====================
    // 자동 생성 모드: 메인 페이지에서 생성 완료 후 자동으로 결과 페이지(/post/{UUID})로 이동
    // 수동 제출 모드: 제출 직후 바로 결과 페이지로 이동
    // 따라서 타임아웃은 비디오 생성 시간만큼 길어야 함
    async waitForResultPage(timeout = 3e5) {
      const startTime = Date.now();
      console.log(`[Grok] \uACB0\uACFC \uD398\uC774\uC9C0 \uC774\uB3D9 \uB300\uAE30... (\uD0C0\uC784\uC544\uC6C3: ${Math.round(timeout / 1e3)}\uCD08)`);
      while (Date.now() - startTime < timeout) {
        if (this.isOnResultPage()) {
          console.log("[Grok] \uACB0\uACFC \uD398\uC774\uC9C0 \uC774\uB3D9 \uC644\uB8CC:", window.location.href);
          return true;
        }
        const elapsed = Math.round((Date.now() - startTime) / 1e3);
        if (elapsed > 0 && elapsed % 30 === 0) {
          const isAutoGen = this.isAutoGenerating();
          console.log(`[Grok] \uACB0\uACFC \uD398\uC774\uC9C0 \uB300\uAE30 \uC911... (${elapsed}\uCD08 \uACBD\uACFC, \uC790\uB3D9\uC0DD\uC131=${isAutoGen})`);
        }
        await this.delay(2e3);
      }
      console.warn("[Grok] \uACB0\uACFC \uD398\uC774\uC9C0 \uC774\uB3D9 \uD0C0\uC784\uC544\uC6C3");
      return false;
    }
    // ==================== 비디오 생성 완료 대기 (결과 페이지) ====================
    // 반환값: 'ready' | 'moderated' | 'timeout'
    async waitForVideoReady(timeout = 3e5) {
      const startTime = Date.now();
      const checkInterval = 3e3;
      console.log("[Grok] \uBE44\uB514\uC624 \uC0DD\uC131 \uC644\uB8CC \uB300\uAE30 \uC911...");
      await this.delay(5e3);
      while (Date.now() - startTime < timeout) {
        if (this.isModerated()) {
          console.warn("[Grok] \uAC80\uC5F4 \uAC10\uC9C0 (Moderated) - \uC989\uC2DC \uAC74\uB108\uB6F0\uAE30");
          return "moderated";
        }
        const videoUrl = this.getVideoUrlFromResultPage();
        if (videoUrl) {
          console.log("[Grok] \uBE44\uB514\uC624 \uC0DD\uC131 \uC644\uB8CC! (video[src] \uAC10\uC9C0):", videoUrl.substring(0, 80));
          return "ready";
        }
        const elapsed = Math.round((Date.now() - startTime) / 1e3);
        if (elapsed % 15 === 0 && elapsed > 0) {
          console.log(`[Grok] \uBE44\uB514\uC624 \uC0DD\uC131 \uB300\uAE30 \uC911... (${elapsed}\uCD08 \uACBD\uACFC)`);
        }
        await this.delay(checkInterval);
      }
      console.warn("[Grok] \uBE44\uB514\uC624 \uC0DD\uC131 \uD0C0\uC784\uC544\uC6C3");
      return "timeout";
    }
    // ==================== 결과 페이지 프롬프트 입력 & 동영상 만들기 ====================
    // 결과 페이지의 textarea 찾기
    findResultPageTextarea() {
      return document.querySelector("textarea");
    }
    // 결과 페이지의 "동영상 만들기" 버튼 찾기
    findCreateVideoButton() {
      var _a;
      let btn = document.querySelector('button[aria-label="\uB3D9\uC601\uC0C1 \uB9CC\uB4E4\uAE30"]');
      if (btn) return btn;
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        const text = ((_a = b.textContent) == null ? void 0 : _a.trim()) || "";
        if (text === "\uB3D9\uC601\uC0C1 \uB9CC\uB4E4\uAE30" || text === "Create video") return b;
      }
      return null;
    }
    // 결과 페이지에서 textarea에 프롬프트 입력
    async typePromptOnResultPage(text) {
      var _a;
      const textarea = this.findResultPageTextarea();
      if (!textarea) throw new Error("[Grok] \uACB0\uACFC \uD398\uC774\uC9C0 textarea\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
      textarea.focus();
      await this.delay(100);
      const nativeInputValueSetter = (_a = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )) == null ? void 0 : _a.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(textarea, text);
      } else {
        textarea.value = text;
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
      await this.delay(300);
      console.log(`[Grok] \uACB0\uACFC \uD398\uC774\uC9C0 \uD504\uB86C\uD504\uD2B8 \uC785\uB825 \uC644\uB8CC: "${text.substring(0, 50)}..."`);
    }
    // 결과 페이지에서 "동영상 만들기" 버튼 클릭
    async clickCreateVideo() {
      const startTime = Date.now();
      const timeout = 5e3;
      while (Date.now() - startTime < timeout) {
        const btn = this.findCreateVideoButton();
        if (btn && !btn.disabled) {
          btn.click();
          console.log('[Grok] "\uB3D9\uC601\uC0C1 \uB9CC\uB4E4\uAE30" \uBC84\uD2BC \uD074\uB9AD \uC644\uB8CC');
          await this.delay(1e3);
          return true;
        }
        await this.delay(300);
      }
      console.warn('[Grok] "\uB3D9\uC601\uC0C1 \uB9CC\uB4E4\uAE30" \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uAC70\uB098 \uBE44\uD65C\uC131\uD654 \uC0C1\uD0DC');
      return false;
    }
    // ==================== 결과 페이지에서 비디오 URL 추출 ====================
    // 현재 URL에서 post UUID를 추출
    getCurrentPostUUID() {
      const match = window.location.href.match(/\/post\/([a-f0-9-]+)/);
      return match ? match[1] : null;
    }
    getVideoUrlFromResultPage() {
      const uuid = this.getCurrentPostUUID();
      if (!uuid) {
        console.log("[Grok] \uACB0\uACFC \uD398\uC774\uC9C0\uAC00 \uC544\uB2D9\uB2C8\uB2E4 (UUID \uC5C6\uC74C)");
        return null;
      }
      const videos = document.querySelectorAll("video[src]");
      let hdUrl = null;
      let normalUrl = null;
      for (const video of videos) {
        const src = video.src;
        if (!src || !src.includes(uuid)) continue;
        if (src.includes("_hd.mp4")) {
          hdUrl = src;
        } else if (src.includes(".mp4")) {
          normalUrl = src;
        }
      }
      if (hdUrl) return hdUrl;
      if (normalUrl) return normalUrl;
      return null;
    }
    // ==================== 뒤로가기 ====================
    async goBack() {
      const backBtn = document.querySelector('button[aria-label="\uB4A4\uB85C\uAC00\uAE30"]');
      if (backBtn) {
        backBtn.click();
        console.log("[Grok] \uB4A4\uB85C\uAC00\uAE30 \uBC84\uD2BC \uD074\uB9AD (aria-label)");
      } else {
        window.history.back();
        console.log("[Grok] history.back() \uC2E4\uD589");
      }
      await this.delay(1e3);
    }
    // ==================== 메인 페이지 복귀 대기 ====================
    async waitForMainPage(timeout = 15e3) {
      const startTime = Date.now();
      console.log("[Grok] \uBA54\uC778 \uD398\uC774\uC9C0 \uBCF5\uADC0 \uB300\uAE30...");
      while (Date.now() - startTime < timeout) {
        if (this.isOnMainPage() && this.findEditor()) {
          console.log("[Grok] \uBA54\uC778 \uD398\uC774\uC9C0 \uBCF5\uADC0 \uC644\uB8CC");
          await this.delay(500);
          return true;
        }
        await this.delay(500);
      }
      console.warn("[Grok] \uBA54\uC778 \uD398\uC774\uC9C0 \uBCF5\uADC0 \uD0C0\uC784\uC544\uC6C3");
      return false;
    }
  };

  // src/content/grok-content.ts
  var controller = new GrokController();
  var isProcessing = false;
  var shouldStop = false;
  function requestImageData(index) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_IMAGE_DATA", index, field: "imageFile", platform: "grok" }, (response) => {
        resolve((response == null ? void 0 : response.dataUrl) || "");
      });
    });
  }
  function generateFilename(promptIndex, extension) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let random = "";
    for (let i = 0; i < 8; i++) random += chars.charAt(Math.floor(Math.random() * chars.length));
    return `${String(promptIndex).padStart(3, "0")}-${random}.${extension}`;
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log("[Grok] \uBA54\uC2DC\uC9C0 \uC218\uC2E0:", message.type);
    switch (message.type) {
      case "GROK_START_QUEUE":
        startGrokQueue(message.settings);
        sendResponse({ success: true });
        return true;
      case "GROK_STOP_QUEUE":
        shouldStop = true;
        sendResponse({ success: true });
        return true;
      case "GROK_GET_STATUS":
        sendResponse({ ready: controller.isReady(), processing: isProcessing });
        return true;
    }
  });
  async function ensureMainPage() {
    if (controller.isOnMainPage()) return;
    console.log("[Grok] \uBA54\uC778 \uD398\uC774\uC9C0\uAC00 \uC544\uB2D9\uB2C8\uB2E4. \uB4A4\uB85C\uAC00\uAE30...");
    await controller.goBack();
    const ready = await controller.waitForMainPage(15e3);
    if (!ready) throw new Error("\uBA54\uC778 \uD398\uC774\uC9C0 \uBCF5\uADC0 \uC2E4\uD328");
  }
  async function processOneItem(item, index, timeoutMs) {
    var _a;
    await ensureMainPage();
    const imageDataUrl = await requestImageData(index);
    if (imageDataUrl) {
      const attached = await controller.attachImage(imageDataUrl);
      if (!attached) throw new Error("\uC774\uBBF8\uC9C0 \uCCA8\uBD80 \uC2E4\uD328");
      await controller.delay(2e3);
    }
    console.log(`[Grok] \uACB0\uACFC \uD398\uC774\uC9C0 \uB300\uAE30 (\uD0C0\uC784\uC544\uC6C3: ${Math.round(timeoutMs / 1e3)}\uCD08)`);
    const resultReady = await controller.waitForResultPage(timeoutMs);
    if (!resultReady) throw new Error("\uACB0\uACFC \uD398\uC774\uC9C0 \uC774\uB3D9 \uC2E4\uD328");
    await controller.delay(3e3);
    if (controller.isModerated()) throw new ModerationError();
    if ((_a = item.text) == null ? void 0 : _a.trim()) {
      await controller.typePromptOnResultPage(item.text);
      await controller.delay(500);
    }
    const videoCreated = await controller.clickCreateVideo();
    if (!videoCreated) throw new Error('"\uB3D9\uC601\uC0C1 \uB9CC\uB4E4\uAE30" \uBC84\uD2BC \uD074\uB9AD \uC2E4\uD328');
    const result = await controller.waitForVideoReady(timeoutMs);
    if (result === "moderated") throw new ModerationError();
    if (result === "timeout") throw new Error("\uBE44\uB514\uC624 \uC0DD\uC131 \uD0C0\uC784\uC544\uC6C3");
    downloadVideo(index);
    await controller.delay(2e3);
    await controller.goBack();
    await controller.waitForMainPage(15e3);
  }
  function downloadVideo(index) {
    let videoUrl = controller.getVideoUrlFromResultPage();
    if (!videoUrl) {
      const match = window.location.href.match(/\/post\/([a-f0-9-]+)/);
      if (match) videoUrl = `https://imagine-public.x.ai/imagine-public/share-videos/${match[1]}.mp4`;
    }
    if (videoUrl) {
      const filename = generateFilename(index + 1, "mp4");
      chrome.runtime.sendMessage({ type: "DOWNLOAD_VIDEO", url: videoUrl, filename });
      console.log(`[Grok] \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD: ${filename}`);
    } else {
      console.warn("[Grok] \uBE44\uB514\uC624 URL\uC744 \uCD94\uCD9C\uD560 \uC218 \uC5C6\uC74C");
    }
  }
  var ModerationError = class extends Error {
    constructor() {
      super("\uAC80\uC5F4\uB428 (Moderated)");
    }
  };
  async function startGrokQueue(settings) {
    if (isProcessing) {
      console.warn("[Grok] \uC774\uBBF8 \uCC98\uB9AC \uC911\uC785\uB2C8\uB2E4");
      return;
    }
    isProcessing = true;
    shouldStop = false;
    console.log("[Grok] \uB300\uAE30\uC5F4 \uCC98\uB9AC \uC2DC\uC791");
    try {
      await ensureMainPage();
      await controller.setAutoVideoGeneration(false);
      await controller.delay(500);
      await controller.applySettings(settings);
      await controller.delay(1e3);
      await processQueue(settings);
    } catch (error) {
      console.error("[Grok] \uCC98\uB9AC \uC911 \uC624\uB958:", error);
      await chrome.storage.local.set({ grokStatus: "error" });
    } finally {
      isProcessing = false;
      shouldStop = false;
      console.log("[Grok] \uB300\uAE30\uC5F4 \uCC98\uB9AC \uC885\uB8CC");
    }
  }
  async function processQueue(settings) {
    var _a;
    const timeoutMs = settings.generationTimeout * 60 * 1e3;
    const maxRetries = settings.retryOnFail ? settings.maxRetries : 0;
    while (!shouldStop) {
      const storage = await chrome.storage.local.get(["grokPrompts", "grokCurrentIndex", "grokStatus"]);
      const prompts = storage.grokPrompts;
      const currentIndex = storage.grokCurrentIndex || 0;
      if (storage.grokStatus !== "running" || !prompts || currentIndex >= prompts.length) {
        console.log("[Grok] \uB300\uAE30\uC5F4 \uC644\uB8CC");
        await chrome.storage.local.set({ grokStatus: "idle" });
        break;
      }
      const item = prompts[currentIndex];
      prompts[currentIndex].status = "running";
      await chrome.storage.local.set({ grokPrompts: prompts, grokCurrentIndex: currentIndex });
      console.log(`[Grok] \uCC98\uB9AC \uC911: ${currentIndex + 1}/${prompts.length} - "${(_a = item.text) == null ? void 0 : _a.substring(0, 30)}..."`);
      let success = false;
      let retries = 0;
      while (!success && retries <= maxRetries && !shouldStop) {
        try {
          await processOneItem(item, currentIndex, timeoutMs);
          success = true;
          prompts[currentIndex].status = "done";
          console.log(`[Grok] ${currentIndex + 1}\uBC88 \uC644\uB8CC`);
        } catch (error) {
          const isModerated = error instanceof ModerationError;
          retries++;
          console.error(`[Grok] ${currentIndex + 1}\uBC88 \uC624\uB958 (\uC2DC\uB3C4 ${retries}/${maxRetries + 1}, \uAC80\uC5F4=${isModerated}):`, error);
          if (isModerated || retries > maxRetries) {
            prompts[currentIndex].status = "error";
            console.error(`[Grok] ${currentIndex + 1}\uBC88 \uCD5C\uC885 \uC2E4\uD328`);
            break;
          }
          if (!controller.isOnMainPage()) {
            await controller.delay(2e3);
            await controller.goBack();
            await controller.waitForMainPage(1e4);
          }
        }
      }
      await chrome.storage.local.set({ grokPrompts: prompts, grokCurrentIndex: currentIndex + 1 });
      if (shouldStop) {
        console.log("[Grok] \uC0AC\uC6A9\uC790\uC5D0 \uC758\uD574 \uC911\uC9C0\uB428");
        await chrome.storage.local.set({ grokStatus: "idle" });
        break;
      }
      if (currentIndex + 1 < prompts.length) {
        const delaySeconds = settings.promptDelay || 30;
        console.log(`[Grok] \uB2E4\uC74C \uC544\uC774\uD15C\uAE4C\uC9C0 ${delaySeconds}\uCD08 \uB300\uAE30`);
        await controller.delay(delaySeconds * 1e3);
      }
    }
  }
  console.log("[Grok] Content script \uB85C\uB4DC\uB428:", window.location.href);
})();
