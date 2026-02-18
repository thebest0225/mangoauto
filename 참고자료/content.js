"use strict";
(() => {
  // src/utils/veo3-controller.ts
  var Veo3Controller = class {
    defaultTimeout = 3e4;
    // ==================== 셀렉터 (snapgenflow 참고) ====================
    SELECTORS = {
      // 프롬프트 입력창 ID
      PROMPT_TEXTAREA_ID: "PINHOLE_TEXT_AREA_ELEMENT_ID",
      // XPath 셀렉터들
      GENERATE_BUTTON_XPATH: "//button[.//i[text()='arrow_forward']] | (//button[.//i[normalize-space(text())='arrow_forward']])",
      // 탭 버튼 (Videos / Images)
      VIDEOS_TAB_XPATH: "//button[@role='radio' and contains(., 'Videos')]",
      IMAGES_TAB_XPATH: "//button[@role='radio' and contains(., 'Images')]",
      // 모드 드롭다운 (combobox)
      MODE_DROPDOWN_XPATH: "//button[@role='combobox']",
      // 모드 옵션들 (드롭다운 내부)
      // 텍스트→비디오: text_analysis 아이콘
      TEXT_TO_VIDEO_OPTION_XPATH: "//div[@role='option' and .//i[normalize-space(text())='text_analysis']]",
      // 이미지→비디오: photo_spark 아이콘 (프레임 동영상 변환)
      IMAGE_TO_VIDEO_OPTION_XPATH: "//div[@role='option' and .//i[normalize-space(text())='photo_spark']]",
      // 애셋→비디오: "애셋으로 동영상 만들기" 텍스트로 찾기
      ASSET_TO_VIDEO_OPTION_XPATH: "//div[@role='option' and contains(., '\uC560\uC14B\uC73C\uB85C \uB3D9\uC601\uC0C1 \uB9CC\uB4E4\uAE30')]",
      // 텍스트→이미지: add_photo_alternate 아이콘
      TEXT_TO_IMAGE_OPTION_XPATH: "//div[@role='option' and .//i[normalize-space(text())='add_photo_alternate']]",
      // 설정 버튼
      SETTINGS_BUTTON_XPATH: "//button[.//i[normalize-space(text())='tune']]"
    };
    // ==================== XPath 유틸리티 ====================
    getElementByXPath(xpath) {
      const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      return result.singleNodeValue;
    }
    // ==================== 기본 메서드 ====================
    // Flow 페이지인지 확인
    isReady() {
      return window.location.href.includes("labs.google") && window.location.href.includes("flow");
    }
    async delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
    // ==================== 프롬프트 입력 ====================
    // ID로 프롬프트 입력창 찾기 (snapgenflow 방식)
    findPromptTextarea() {
      const byId = document.getElementById(this.SELECTORS.PROMPT_TEXTAREA_ID);
      if (byId && byId.tagName === "TEXTAREA") {
        console.log("[Veo3] ID\uB85C textarea \uCC3E\uC74C");
        return byId;
      }
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        if (ta.className.includes("recaptcha")) continue;
        const placeholder = ta.placeholder || "";
        if (placeholder.includes("\uB3D9\uC601\uC0C1") || placeholder.includes("\uC774\uBBF8\uC9C0") || placeholder.includes("\uD14D\uC2A4\uD2B8 \uBC0F \uCC38\uACE0") || placeholder.includes("video") || placeholder.includes("image") || placeholder.includes("prompt")) {
          console.log("[Veo3] placeholder\uB85C textarea \uCC3E\uC74C:", placeholder.substring(0, 30));
          return ta;
        }
      }
      for (const ta of textareas) {
        if (!ta.className.includes("recaptcha")) {
          console.log("[Veo3] fallback textarea \uC0AC\uC6A9");
          return ta;
        }
      }
      return null;
    }
    // React 호환 값 설정 (snapgenflow 방식)
    setTextareaValue(textarea, value) {
      var _a;
      const nativeSetter = (_a = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )) == null ? void 0 : _a.set;
      if (nativeSetter) {
        nativeSetter.call(textarea, value);
      } else {
        textarea.value = value;
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // 프롬프트 입력 (비디오/이미지 공통)
    async typePrompt(text) {
      console.log("[Veo3] \uD504\uB86C\uD504\uD2B8 \uC785\uB825 \uC2DC\uC791:", text.substring(0, 50));
      const textarea = this.findPromptTextarea();
      if (!textarea) {
        throw new Error("\uD504\uB86C\uD504\uD2B8 \uC785\uB825\uCC3D\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4");
      }
      textarea.click();
      await this.delay(100);
      textarea.focus();
      await this.delay(100);
      this.setTextareaValue(textarea, "");
      await this.delay(100);
      this.setTextareaValue(textarea, text);
      await this.delay(300);
      console.log("[Veo3] \uD504\uB86C\uD504\uD2B8 \uC785\uB825 \uC644\uB8CC, \uD604\uC7AC \uAC12:", textarea.value.substring(0, 30));
    }
    // 이미지 프롬프트 입력 (typePrompt와 동일)
    async typeImagePrompt(text) {
      return this.typePrompt(text);
    }
    // ==================== 만들기 버튼 ====================
    // XPath로 만들기 버튼 찾기
    findGenerateButton() {
      const byXPath = this.getElementByXPath(this.SELECTORS.GENERATE_BUTTON_XPATH);
      if (byXPath) {
        console.log("[Veo3] XPath\uB85C \uB9CC\uB4E4\uAE30 \uBC84\uD2BC \uCC3E\uC74C");
        return byXPath;
      }
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.textContent || "";
        if ((text.includes("\uB9CC\uB4E4\uAE30") || text.includes("Create") || text.includes("Generate")) && text.includes("arrow_forward")) {
          console.log("[Veo3] \uD14D\uC2A4\uD2B8\uB85C \uB9CC\uB4E4\uAE30 \uBC84\uD2BC \uCC3E\uC74C");
          return btn;
        }
      }
      for (const btn of buttons) {
        const text = btn.textContent || "";
        if (text.includes("arrow_forward")) {
          return btn;
        }
      }
      return null;
    }
    // 만들기 버튼이 활성화될 때까지 대기
    async waitForButtonEnabled(timeout = 5e3) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        const btn = this.findGenerateButton();
        if (btn && !btn.disabled) {
          return btn;
        }
        await this.delay(200);
      }
      throw new Error("\uB9CC\uB4E4\uAE30 \uBC84\uD2BC\uC774 \uD65C\uC131\uD654\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4");
    }
    // 만들기 버튼 클릭
    async clickCreate() {
      console.log("[Veo3] \uB9CC\uB4E4\uAE30 \uBC84\uD2BC \uD65C\uC131\uD654 \uB300\uAE30 \uC911...");
      const button = await this.waitForButtonEnabled(5e3);
      console.log("[Veo3] \uB9CC\uB4E4\uAE30 \uBC84\uD2BC \uCC3E\uC74C, disabled:", button.disabled);
      button.click();
      console.log("[Veo3] \uB9CC\uB4E4\uAE30 \uBC84\uD2BC \uD074\uB9AD \uC644\uB8CC");
    }
    // ==================== 모드 전환 ====================
    // 탭 클릭 (Videos / Images)
    async clickTab(tabXPath, tabName) {
      var _a;
      let tab = this.getElementByXPath(tabXPath);
      if (!tab) {
        const radios = document.querySelectorAll('[role="radio"]');
        for (const radio of radios) {
          if ((_a = radio.textContent) == null ? void 0 : _a.includes(tabName)) {
            tab = radio;
            break;
          }
        }
      }
      if (tab) {
        tab.click();
        await this.delay(500);
        console.log(`[Veo3] ${tabName} \uD0ED \uD074\uB9AD \uC644\uB8CC`);
        return true;
      }
      console.warn(`[Veo3] ${tabName} \uD0ED\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C`);
      return false;
    }
    // 모드 드롭다운에서 옵션 선택
    async selectModeOption(optionXPath, modeName) {
      var _a;
      const dropdown = this.getElementByXPath(this.SELECTORS.MODE_DROPDOWN_XPATH);
      if (!dropdown) {
        const comboboxes = document.querySelectorAll('[role="combobox"]');
        if (comboboxes.length > 0) {
          comboboxes[0].click();
          await this.delay(300);
        } else {
          console.warn("[Veo3] \uBAA8\uB4DC \uB4DC\uB86D\uB2E4\uC6B4\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
          return false;
        }
      } else {
        dropdown.click();
        await this.delay(300);
      }
      const option = this.getElementByXPath(optionXPath);
      if (option) {
        option.click();
        await this.delay(300);
        console.log(`[Veo3] ${modeName} \uBAA8\uB4DC \uC120\uD0DD \uC644\uB8CC`);
        return true;
      }
      const options = document.querySelectorAll('[role="option"]');
      for (const opt of options) {
        if ((_a = opt.textContent) == null ? void 0 : _a.includes(modeName)) {
          opt.click();
          await this.delay(300);
          console.log(`[Veo3] ${modeName} \uBAA8\uB4DC \uC120\uD0DD \uC644\uB8CC (\uD14D\uC2A4\uD2B8 \uB9E4\uCE6D)`);
          return true;
        }
      }
      console.warn(`[Veo3] ${modeName} \uC635\uC158\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C`);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      return false;
    }
    // 텍스트→비디오 모드로 전환
    async switchToTextToVideoMode() {
      console.log("[Veo3] \uD14D\uC2A4\uD2B8\u2192\uBE44\uB514\uC624 \uBAA8\uB4DC\uB85C \uC804\uD658 \uC2DC\uC791");
      await this.clickTab(this.SELECTORS.VIDEOS_TAB_XPATH, "Videos");
      await this.selectModeOption(
        this.SELECTORS.TEXT_TO_VIDEO_OPTION_XPATH,
        "\uD14D\uC2A4\uD2B8 \uB3D9\uC601\uC0C1 \uBCC0\uD658"
      );
      console.log("[Veo3] \uD14D\uC2A4\uD2B8\u2192\uBE44\uB514\uC624 \uBAA8\uB4DC \uC804\uD658 \uC644\uB8CC");
    }
    // 이미지→비디오 모드로 전환
    async switchToImageToVideoMode() {
      console.log("[Veo3] \uC774\uBBF8\uC9C0\u2192\uBE44\uB514\uC624 \uBAA8\uB4DC\uB85C \uC804\uD658 \uC2DC\uC791");
      await this.clickTab(this.SELECTORS.VIDEOS_TAB_XPATH, "Videos");
      await this.selectModeOption(
        this.SELECTORS.IMAGE_TO_VIDEO_OPTION_XPATH,
        "\uD504\uB808\uC784 \uB3D9\uC601\uC0C1 \uBCC0\uD658"
      );
      console.log("[Veo3] \uC774\uBBF8\uC9C0\u2192\uBE44\uB514\uC624 \uBAA8\uB4DC \uC804\uD658 \uC644\uB8CC");
    }
    // 애셋→비디오 모드로 전환 (Ingredients)
    async switchToAssetToVideoMode() {
      console.log("[Veo3] \uC560\uC14B\u2192\uBE44\uB514\uC624 \uBAA8\uB4DC\uB85C \uC804\uD658 \uC2DC\uC791");
      await this.clickTab(this.SELECTORS.VIDEOS_TAB_XPATH, "Videos");
      await this.selectModeOption(
        this.SELECTORS.ASSET_TO_VIDEO_OPTION_XPATH,
        "\uC560\uC14B\uC73C\uB85C \uB3D9\uC601\uC0C1 \uB9CC\uB4E4\uAE30"
      );
      console.log("[Veo3] \uC560\uC14B\u2192\uBE44\uB514\uC624 \uBAA8\uB4DC \uC804\uD658 \uC644\uB8CC");
    }
    // 텍스트→이미지 모드로 전환
    async switchToTextToImageMode() {
      console.log("[Veo3] \uD14D\uC2A4\uD2B8\u2192\uC774\uBBF8\uC9C0 \uBAA8\uB4DC\uB85C \uC804\uD658 \uC2DC\uC791");
      await this.selectModeOption(
        this.SELECTORS.TEXT_TO_IMAGE_OPTION_XPATH,
        "\uC774\uBBF8\uC9C0 \uB9CC\uB4E4\uAE30"
      );
      console.log("[Veo3] \uD14D\uC2A4\uD2B8\u2192\uC774\uBBF8\uC9C0 \uBAA8\uB4DC \uC804\uD658 \uC644\uB8CC");
    }
    // 이미지→이미지 모드로 전환
    async switchToImageToImageMode() {
      console.log("[Veo3] \uC774\uBBF8\uC9C0\u2192\uC774\uBBF8\uC9C0 \uBAA8\uB4DC\uB85C \uC804\uD658 \uC2DC\uC791");
      await this.clickTab(this.SELECTORS.IMAGES_TAB_XPATH, "Images");
      console.log("[Veo3] \uC774\uBBF8\uC9C0\u2192\uC774\uBBF8\uC9C0 \uBAA8\uB4DC \uC804\uD658 \uC644\uB8CC");
    }
    // 이미지 모드로 전환 (레거시 호환)
    async switchToImageMode() {
      return this.switchToTextToImageMode();
    }
    // 비디오 모드로 전환 (레거시 호환)
    async switchToVideoMode() {
      return this.switchToTextToVideoMode();
    }
    // ==================== 설정 ====================
    // 설정 적용 (비디오)
    async applySettings(settings) {
      console.log("[Veo3] \uBE44\uB514\uC624 \uC124\uC815 \uC801\uC6A9 \uC2DC\uC791:", settings);
      const settingsBtn = this.getElementByXPath(this.SELECTORS.SETTINGS_BUTTON_XPATH);
      if (settingsBtn) {
        settingsBtn.click();
        await this.delay(500);
        if (settings.videoOutputCount) {
          await this.setOutputCount(settings.videoOutputCount);
        }
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await this.delay(300);
      } else {
        console.warn("[Veo3] \uC124\uC815 \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
      }
      console.log("[Veo3] \uBE44\uB514\uC624 \uC124\uC815 \uC801\uC6A9 \uC644\uB8CC");
    }
    // 설정 적용 (이미지)
    async applyImageSettings(settings) {
      console.log("[Veo3] \uC774\uBBF8\uC9C0 \uC124\uC815 \uC801\uC6A9 \uC2DC\uC791:", settings);
      const settingsBtn = this.getElementByXPath(this.SELECTORS.SETTINGS_BUTTON_XPATH);
      if (settingsBtn) {
        settingsBtn.click();
        await this.delay(500);
        await this.setImageModel(settings.imageModel);
        await this.setOutputCount(settings.outputCount);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await this.delay(300);
      } else {
        console.warn("[Veo3] \uC124\uC815 \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
      }
      console.log("[Veo3] \uC774\uBBF8\uC9C0 \uC124\uC815 \uC801\uC6A9 \uC644\uB8CC");
    }
    // 이미지 모델 설정
    async setImageModel(model) {
      console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uBAA8\uB378 \uC124\uC815: ${model}`);
      const modelDefs = {
        "imagen4": { match: ["Imagen 4", "imagen4", "Imagen4"] },
        "nano-banana-pro": { match: ["Nano Banana Pro", "nano-banana-pro"] },
        "nano-banana": { match: ["Nano Banana", "nano-banana"], exclude: ["Pro"] }
      };
      const def = modelDefs[model] || { match: [model] };
      const matchesModel = (text) => {
        const lower = text.toLowerCase();
        const hasMatch = def.match.some((name) => lower.includes(name.toLowerCase()));
        if (!hasMatch) return false;
        if (def.exclude) {
          return !def.exclude.some((ex) => lower.includes(ex.toLowerCase()));
        }
        return true;
      };
      const comboboxes = document.querySelectorAll('[role="combobox"]');
      for (const combobox of comboboxes) {
        const text = combobox.textContent || "";
        if (text.includes("Imagen") || text.includes("Nano") || text.includes("\uBAA8\uB378") || text.includes("Model")) {
          if (matchesModel(text)) {
            console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uBAA8\uB378\uC774 \uC774\uBBF8 ${model}\uB85C \uC124\uC815\uB428`);
            return;
          }
          ;
          combobox.click();
          await this.delay(300);
          const options = document.querySelectorAll('[role="option"]');
          for (const option of options) {
            const optionText = option.textContent || "";
            if (matchesModel(optionText)) {
              console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uBAA8\uB378 ${optionText} \uC120\uD0DD`);
              option.click();
              await this.delay(300);
              return;
            }
          }
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
          await this.delay(200);
          break;
        }
      }
      console.warn(`[Veo3] \uC774\uBBF8\uC9C0 \uBAA8\uB378 \uC124\uC815\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C: ${model}`);
    }
    // 프롬프트당 출력 개수 설정
    async setOutputCount(count) {
      console.log(`[Veo3] \uCD9C\uB825 \uAC1C\uC218 \uC124\uC815: ${count}`);
      const comboboxes = document.querySelectorAll('[role="combobox"]');
      for (const combobox of comboboxes) {
        const text = combobox.textContent || "";
        if (text.includes("\uCD9C\uB825") || /^\s*\d+\s*$/.test(text)) {
          const currentValue = parseInt(text.replace(/\D/g, ""), 10);
          if (currentValue === count) {
            console.log(`[Veo3] \uCD9C\uB825 \uAC1C\uC218\uAC00 \uC774\uBBF8 ${count}\uB85C \uC124\uC815\uB428`);
            return;
          }
          ;
          combobox.click();
          await this.delay(300);
          const options = document.querySelectorAll('[role="option"]');
          for (const option of options) {
            const optionText = option.textContent || "";
            if (optionText.trim() === String(count)) {
              console.log(`[Veo3] \uCD9C\uB825 \uAC1C\uC218 ${count} \uC120\uD0DD`);
              option.click();
              await this.delay(300);
              return;
            }
          }
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
          break;
        }
      }
      const labels = document.querySelectorAll("label, span, div");
      for (const label of labels) {
        const text = label.textContent || "";
        if (text.includes("\uD504\uB86C\uD504\uD2B8\uB2F9 \uCD9C\uB825") || text.includes("\uCD9C\uB825 \uAC1C\uC218")) {
          const parent = label.closest("div");
          if (parent) {
            const combobox = parent.querySelector('[role="combobox"]');
            if (combobox) {
              ;
              combobox.click();
              await this.delay(300);
              const options = document.querySelectorAll('[role="option"]');
              for (const option of options) {
                const optionText = option.textContent || "";
                if (optionText.trim() === String(count)) {
                  console.log(`[Veo3] \uCD9C\uB825 \uAC1C\uC218 ${count} \uC120\uD0DD (\uB77C\uBCA8\uB85C \uCC3E\uC74C)`);
                  option.click();
                  await this.delay(300);
                  return;
                }
              }
              document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            }
          }
        }
      }
      console.warn(`[Veo3] \uCD9C\uB825 \uAC1C\uC218 \uC124\uC815\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C`);
    }
    // ==================== 생성 완료 대기 ====================
    // 생성 중인 항목 수 확인
    // MCP 분석: DOM 구조 = <div>"24" + "%"</div> (자식 텍스트 노드 2개)
    // 부모 요소의 textContent가 "숫자%" 패턴인지 확인
    countGeneratingItems() {
      var _a, _b;
      let count = 0;
      const icons = document.querySelectorAll("i");
      for (const icon of icons) {
        if (((_a = icon.textContent) == null ? void 0 : _a.trim()) === "progress_activity") {
          count++;
        }
      }
      const allElements = document.querySelectorAll("div, span");
      for (const el of allElements) {
        const text = ((_b = el.textContent) == null ? void 0 : _b.trim()) || "";
        if (/^\d{1,3}%$/.test(text)) {
          const hasElementChildren = Array.from(el.children).length > 0;
          if (!hasElementChildren) {
            count++;
            console.log(`[Veo3] \uC0DD\uC131 \uC9C4\uD589 \uC911 \uAC10\uC9C0: ${text}`);
          }
        }
      }
      console.log(`[Veo3] countGeneratingItems: ${count}\uAC1C \uAC10\uC9C0`);
      return count;
    }
    // 모든 생성 완료 대기 (비디오)
    async waitForAllGenerationsComplete(expectedCount) {
      console.log(`[Veo3] ${expectedCount}\uAC1C \uBE44\uB514\uC624 \uC0DD\uC131 \uC644\uB8CC \uB300\uAE30 \uC2DC\uC791`);
      const maxWaitTime = 10 * 60 * 1e3;
      const checkInterval = 5e3;
      const startTime = Date.now();
      while (Date.now() - startTime < maxWaitTime) {
        await this.delay(checkInterval);
        const generatingCount = this.countGeneratingItems();
        console.log(`[Veo3] \uD604\uC7AC \uC0DD\uC131 \uC911: ${generatingCount}\uAC1C`);
        if (generatingCount === 0) {
          console.log("[Veo3] \uBAA8\uB4E0 \uBE44\uB514\uC624 \uC0DD\uC131 \uC644\uB8CC!");
          return;
        }
      }
      throw new Error("\uBE44\uB514\uC624 \uC0DD\uC131 \uB300\uAE30 \uC2DC\uAC04 \uCD08\uACFC (10\uBD84)");
    }
    // 이미지 생성 완료 대기
    async waitForImageGenerationsComplete(expectedCount) {
      console.log(`[Veo3] ${expectedCount}\uAC1C \uC774\uBBF8\uC9C0 \uC0DD\uC131 \uC644\uB8CC \uB300\uAE30 \uC2DC\uC791`);
      const maxWaitTime = 3 * 60 * 1e3;
      const checkInterval = 2e3;
      const startTime = Date.now();
      while (Date.now() - startTime < maxWaitTime) {
        await this.delay(checkInterval);
        const generatingCount = this.countGeneratingItems();
        console.log(`[Veo3] \uD604\uC7AC \uC0DD\uC131 \uC911: ${generatingCount}\uAC1C`);
        if (generatingCount === 0) {
          console.log("[Veo3] \uBAA8\uB4E0 \uC774\uBBF8\uC9C0 \uC0DD\uC131 \uC644\uB8CC!");
          return;
        }
      }
      throw new Error("\uC774\uBBF8\uC9C0 \uC0DD\uC131 \uB300\uAE30 \uC2DC\uAC04 \uCD08\uACFC (3\uBD84)");
    }
    // ==================== 다운로드 ====================
    // 비디오 다운로드 URL 추출
    async getVideoDownloadUrls(count) {
      console.log(`[Veo3] ${count}\uAC1C\uC758 \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC URL \uCD94\uCD9C \uC2DC\uC791`);
      const urls = [];
      const videos = document.querySelectorAll('video[src^="http"]');
      for (const video of videos) {
        const src = video.getAttribute("src");
        if (src && !src.startsWith("blob:") && !urls.includes(src)) {
          urls.push(src);
          if (urls.length >= count) break;
        }
      }
      console.log(`[Veo3] \uCD94\uCD9C\uB41C URL: ${urls.length}\uAC1C`);
      return urls.slice(0, count);
    }
    // 비디오 다운로드 URL 순서대로 추출 (첫 번째 생성 → 마지막 생성)
    // 이미지와 동일하게 스크롤하면서 모든 비디오 수집
    async getVideoDownloadUrlsInOrder(count) {
      console.log(`[Veo3] ${count}\uAC1C\uC758 \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC URL \uC21C\uC11C\uB300\uB85C \uCD94\uCD9C \uC2DC\uC791`);
      const orderedUrls = [];
      const seenUrls = /* @__PURE__ */ new Set();
      const collectCurrentVideosInOrder = () => {
        const videos = document.querySelectorAll("video[src]");
        for (const video of videos) {
          const src = video.getAttribute("src");
          if (src && !src.startsWith("blob:") && !src.startsWith("data:") && src.includes("storage.googleapis.com")) {
            if (!seenUrls.has(src)) {
              seenUrls.add(src);
              orderedUrls.push(src);
            }
          }
        }
      };
      const scrollContainer = this.findScrollableContainer();
      if (!scrollContainer) {
        console.warn("[Veo3] \uC2A4\uD06C\uB864 \uCEE8\uD14C\uC774\uB108\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C, \uD604\uC7AC \uD654\uBA74\uB9CC \uC2A4\uCE94");
        collectCurrentVideosInOrder();
        return orderedUrls.slice(0, count);
      }
      console.log(`[Veo3] \uC2A4\uD06C\uB864 \uCEE8\uD14C\uC774\uB108 \uCC3E\uC74C: scrollHeight=${scrollContainer.scrollHeight}, clientHeight=${scrollContainer.clientHeight}`);
      const originalScrollTop = scrollContainer.scrollTop;
      const scrollStep = 250;
      const scrollDelay = 400;
      console.log("[Veo3] 1\uB2E8\uACC4: \uB9E8 \uC704\uB85C \uC2A4\uD06C\uB864");
      scrollContainer.scrollTop = 0;
      await this.delay(800);
      collectCurrentVideosInOrder();
      console.log(`[Veo3] \uB9E8 \uC704 \uC218\uC9D1 \uD6C4 \uBE44\uB514\uC624 URL \uAC1C\uC218: ${orderedUrls.length}\uAC1C`);
      console.log("[Veo3] 2\uB2E8\uACC4: \uC544\uB798\uB85C \uC2A4\uD06C\uB864\uD558\uBA74\uC11C \uC21C\uC11C\uB300\uB85C \uC218\uC9D1");
      let scrollAttempts = 0;
      const maxScrollAttempts = 500;
      let consecutiveNoNew = 0;
      let scrollPos = 0;
      while (scrollAttempts < maxScrollAttempts) {
        const prevCount = orderedUrls.length;
        scrollPos += scrollStep;
        scrollContainer.scrollTop = scrollPos;
        await this.delay(scrollDelay);
        collectCurrentVideosInOrder();
        if (orderedUrls.length === prevCount) {
          consecutiveNoNew++;
        } else {
          consecutiveNoNew = 0;
        }
        const atBottom = scrollContainer.scrollTop >= scrollContainer.scrollHeight - scrollContainer.clientHeight - 10;
        if (atBottom) {
          await this.delay(1e3);
          collectCurrentVideosInOrder();
          if (consecutiveNoNew >= 3) {
            console.log(`[Veo3] \uB9E8 \uC544\uB798 \uB3C4\uB2EC + \uC0C8 \uBE44\uB514\uC624 \uC5C6\uC74C (\uC218\uC9D1: ${orderedUrls.length}\uAC1C)`);
            break;
          }
        }
        scrollAttempts++;
        if (scrollAttempts % 20 === 0) {
          console.log(`[Veo3] \uC2A4\uD06C\uB864 \uC9C4\uD589: ${scrollAttempts}\uD68C, \uC218\uC9D1 \uBE44\uB514\uC624 URL: ${orderedUrls.length}\uAC1C`);
        }
      }
      console.log("[Veo3] 3\uB2E8\uACC4: \uC704\uB85C \uC2A4\uD06C\uB864\uD558\uBA74\uC11C \uB204\uB77D \uBE44\uB514\uC624 \uBCF4\uCDA9");
      scrollAttempts = 0;
      while (scrollAttempts < maxScrollAttempts) {
        scrollPos -= scrollStep;
        if (scrollPos < 0) scrollPos = 0;
        scrollContainer.scrollTop = scrollPos;
        await this.delay(scrollDelay);
        collectCurrentVideosInOrder();
        if (scrollPos <= 0) {
          console.log("[Veo3] \uB9E8 \uC704 \uB3C4\uB2EC");
          break;
        }
        scrollAttempts++;
      }
      scrollContainer.scrollTop = originalScrollTop;
      console.log(`[Veo3] \uCD1D \uC218\uC9D1\uB41C \uBE44\uB514\uC624 URL: ${orderedUrls.length}\uAC1C (\uC694\uCCAD: ${count}\uAC1C)`);
      if (orderedUrls.length > 0) {
        console.log("[Veo3] \uC218\uC9D1\uB41C \uBE44\uB514\uC624 URL (DOM \uC704\u2192\uC544\uB798 \uC21C\uC11C, \uCC98\uC74C 3\uAC1C):");
        orderedUrls.slice(0, 3).forEach((url, idx) => {
          console.log(`  ${idx + 1}: ${url.substring(0, 80)}...`);
        });
      }
      return orderedUrls.slice(0, count);
    }
    // 다운로드 버튼 찾기 (여러 방법 시도)
    findDownloadButtons() {
      const buttons = [];
      const xpaths = [
        "//button[.//i[normalize-space()='download']]",
        "//button[contains(., 'download') and contains(., '\uB2E4\uC6B4\uB85C\uB4DC')]",
        "//button[contains(@class, 'download')]"
      ];
      for (const xpath of xpaths) {
        try {
          const result = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null
          );
          for (let i = 0; i < result.snapshotLength; i++) {
            const btn = result.snapshotItem(i);
            if (btn && !buttons.includes(btn)) {
              buttons.push(btn);
            }
          }
        } catch (e) {
          console.log("[Veo3] XPath \uAC80\uC0C9 \uC2E4\uD328:", xpath);
        }
      }
      const allButtons = document.querySelectorAll("button");
      for (const btn of allButtons) {
        const text = btn.textContent || "";
        if (text.includes("download") && text.includes("\uB2E4\uC6B4\uB85C\uB4DC") || text.includes("download") && !text.includes("arrow")) {
          if (!buttons.includes(btn)) {
            buttons.push(btn);
          }
        }
      }
      console.log(`[Veo3] \uCC3E\uC740 \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC \uC218: ${buttons.length}`);
      return buttons;
    }
    // 다운로드 1K 메뉴 아이템 클릭
    async clickDownload1KMenuItem() {
      await this.delay(300);
      const xpaths = [
        "//div[@role='menuitem' and contains(., '\uB2E4\uC6B4\uB85C\uB4DC 1K')]",
        "//div[@role='menuitem' and .//text()[contains(., '1K')]]",
        "//div[@role='menuitem'][1]"
        // 첫 번째 메뉴 아이템 (보통 1K)
      ];
      for (const xpath of xpaths) {
        try {
          const menuItem = this.getElementByXPath(xpath);
          if (menuItem) {
            console.log("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC 1K \uBA54\uB274 \uCC3E\uC74C");
            menuItem.click();
            return true;
          }
        } catch (e) {
        }
      }
      const menuItems = document.querySelectorAll('[role="menuitem"]');
      for (const item of menuItems) {
        const text = item.textContent || "";
        if (text.includes("1K") || text.includes("\uB2E4\uC6B4\uB85C\uB4DC")) {
          console.log("[Veo3] querySelectorAll\uB85C \uB2E4\uC6B4\uB85C\uB4DC \uBA54\uB274 \uCC3E\uC74C:", text);
          item.click();
          return true;
        }
      }
      console.warn("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC 1K \uBA54\uB274\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C");
      return false;
    }
    // 다운로드 버튼들 클릭 (비디오/이미지 공통)
    async clickDownloadButtons(count) {
      var _a;
      console.log(`[Veo3] ${count}\uAC1C \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC \uD074\uB9AD \uC2DC\uC791`);
      const buttons = this.findDownloadButtons();
      if (buttons.length === 0) {
        console.warn("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        return 0;
      }
      const targetButtons = buttons.slice(-count);
      let clickedCount = 0;
      for (const btn of targetButtons) {
        try {
          console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC \uD074\uB9AD: ${(_a = btn.textContent) == null ? void 0 : _a.substring(0, 30)}`);
          btn.click();
          const menuClicked = await this.clickDownload1KMenuItem();
          if (menuClicked) {
            clickedCount++;
          }
          await this.delay(1500);
        } catch (e) {
          console.error("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC \uD074\uB9AD \uC2E4\uD328:", e);
        }
      }
      console.log(`[Veo3] ${clickedCount}\uAC1C \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC \uD074\uB9AD \uC644\uB8CC`);
      return clickedCount;
    }
    // 이미지 다운로드 버튼들 클릭
    async clickImageDownloadButtons(count) {
      return this.clickDownloadButtons(count);
    }
    // 이미지 다운로드 버튼 순서대로 클릭 (첫 번째 → 마지막)
    async clickImageDownloadButtonsInOrder(count) {
      console.log(`[Veo3] ${count}\uAC1C \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC \uC21C\uC11C\uB300\uB85C \uD074\uB9AD \uC2DC\uC791`);
      const buttons = this.findDownloadButtons();
      if (buttons.length === 0) {
        console.warn("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        return 0;
      }
      const targetButtons = buttons.slice(0, count);
      let clickedCount = 0;
      for (let i = 0; i < targetButtons.length; i++) {
        const btn = targetButtons[i];
        try {
          console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC ${i + 1}/${targetButtons.length} \uD074\uB9AD`);
          btn.click();
          const menuClicked = await this.clickDownload1KMenuItem();
          if (menuClicked) {
            clickedCount++;
          }
          await this.delay(1500);
        } catch (e) {
          console.error("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC \uD074\uB9AD \uC2E4\uD328:", e);
        }
      }
      console.log(`[Veo3] ${clickedCount}\uAC1C \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uBC84\uD2BC \uD074\uB9AD \uC644\uB8CC (\uC21C\uC11C\uB300\uB85C)`);
      return clickedCount;
    }
    // 이미지 URL 추출 (다운로드용)
    async getImageDownloadUrls(count) {
      console.log(`[Veo3] ${count}\uAC1C\uC758 \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC URL \uCD94\uCD9C \uC2DC\uC791`);
      const urls = [];
      const images = document.querySelectorAll("img[src]");
      for (const img of images) {
        const src = img.getAttribute("src");
        if (src && !src.startsWith("data:") && src.includes("storage.googleapis.com") && src.includes("/image/")) {
          if (!urls.includes(src)) {
            urls.push(src);
            if (urls.length >= count) break;
          }
        }
      }
      console.log(`[Veo3] \uCD94\uCD9C\uB41C \uC774\uBBF8\uC9C0 URL: ${urls.length}\uAC1C`);
      return urls.slice(0, count);
    }
    // Flow 페이지에서 생성된 이미지 스캔 (Start-End 모드에서 끝 이미지 선택용)
    scanGeneratedImages() {
      console.log("[Veo3] \uC0DD\uC131\uB41C \uC774\uBBF8\uC9C0 \uC2A4\uCE94 \uC2DC\uC791");
      const results = [];
      const images = document.querySelectorAll("img[src]");
      let id = 0;
      for (const img of images) {
        const src = img.getAttribute("src");
        if (src && !src.startsWith("data:") && src.includes("storage.googleapis.com") && (src.includes("/image/") || src.includes("ai-sandbox"))) {
          if (!results.some((r) => r.url === src)) {
            results.push({
              id: id++,
              url: src,
              thumbnail: src
              // 썸네일도 같은 URL 사용
            });
          }
        }
      }
      console.log(`[Veo3] \uC2A4\uCE94 \uC644\uB8CC: ${results.length}\uAC1C \uC774\uBBF8\uC9C0 \uBC1C\uACAC`);
      return results;
    }
    // 이미지 다운로드 URL 순서대로 추출 (첫 번째 생성 → 마지막 생성)
    // 중요: DOM 순서 기반으로 수집 - 맨 위부터 아래로 스크롤하면서 순서대로 수집
    async getImageDownloadUrlsInOrder(count) {
      console.log(`[Veo3] ${count}\uAC1C\uC758 \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC URL \uC21C\uC11C\uB300\uB85C \uCD94\uCD9C \uC2DC\uC791`);
      const orderedUrls = [];
      const seenUrls = /* @__PURE__ */ new Set();
      const collectCurrentImagesInOrder = () => {
        const images = document.querySelectorAll("img[src]");
        for (const img of images) {
          const src = img.getAttribute("src");
          if (src && !src.startsWith("data:") && src.includes("storage.googleapis.com") && src.includes("/image/")) {
            if (!seenUrls.has(src)) {
              seenUrls.add(src);
              orderedUrls.push(src);
            }
          }
        }
      };
      const scrollContainer = this.findScrollableContainer();
      if (!scrollContainer) {
        console.warn("[Veo3] \uC2A4\uD06C\uB864 \uCEE8\uD14C\uC774\uB108\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C, \uD604\uC7AC \uD654\uBA74\uB9CC \uC2A4\uCE94");
        return this.collectVisibleImageUrls(count);
      }
      console.log(`[Veo3] \uC2A4\uD06C\uB864 \uCEE8\uD14C\uC774\uB108 \uCC3E\uC74C: scrollHeight=${scrollContainer.scrollHeight}, clientHeight=${scrollContainer.clientHeight}`);
      const originalScrollTop = scrollContainer.scrollTop;
      const scrollStep = 200;
      const scrollDelay = 400;
      console.log("[Veo3] 1\uB2E8\uACC4: \uB9E8 \uC704\uB85C \uC2A4\uD06C\uB864");
      scrollContainer.scrollTop = 0;
      await this.delay(800);
      collectCurrentImagesInOrder();
      console.log(`[Veo3] \uB9E8 \uC704 \uC218\uC9D1 \uD6C4 URL \uAC1C\uC218: ${orderedUrls.length}\uAC1C (\uD544\uC694: ${count}\uAC1C)`);
      if (orderedUrls.length >= count) {
        console.log(`[Veo3] \uD544\uC694\uD55C \uAC1C\uC218(${count}\uAC1C) \uC218\uC9D1 \uC644\uB8CC, \uC2A4\uD06C\uB864 \uC911\uB2E8`);
        scrollContainer.scrollTop = originalScrollTop;
        return orderedUrls.slice(0, count);
      }
      console.log("[Veo3] 2\uB2E8\uACC4: \uC544\uB798\uB85C \uC2A4\uD06C\uB864\uD558\uBA74\uC11C \uC218\uC9D1");
      let scrollAttempts = 0;
      const maxScrollAttempts = 500;
      let consecutiveNoNewImages = 0;
      let scrollPos = 0;
      while (scrollAttempts < maxScrollAttempts && orderedUrls.length < count) {
        const prevCount = orderedUrls.length;
        scrollPos += scrollStep;
        scrollContainer.scrollTop = scrollPos;
        await this.delay(scrollDelay);
        collectCurrentImagesInOrder();
        if (orderedUrls.length === prevCount) {
          consecutiveNoNewImages++;
        } else {
          consecutiveNoNewImages = 0;
        }
        if (orderedUrls.length >= count) {
          console.log(`[Veo3] \uD544\uC694\uD55C \uAC1C\uC218(${count}\uAC1C) \uC218\uC9D1 \uC644\uB8CC, \uC2A4\uD06C\uB864 \uC911\uB2E8`);
          break;
        }
        const atBottom = scrollContainer.scrollTop >= scrollContainer.scrollHeight - scrollContainer.clientHeight - 10;
        if (atBottom) {
          await this.delay(1e3);
          collectCurrentImagesInOrder();
          if (consecutiveNoNewImages >= 5) {
            console.log(`[Veo3] \uB9E8 \uC544\uB798 \uB3C4\uB2EC + \uC0C8 \uC774\uBBF8\uC9C0 \uC5C6\uC74C (\uC218\uC9D1: ${orderedUrls.length}\uAC1C)`);
            break;
          }
        }
        scrollAttempts++;
        if (scrollAttempts % 20 === 0) {
          console.log(`[Veo3] \uC2A4\uD06C\uB864 \uC9C4\uD589: \uC218\uC9D1 ${orderedUrls.length}/${count}\uAC1C, \uC2DC\uB3C4 ${scrollAttempts}`);
        }
      }
      scrollContainer.scrollTop = originalScrollTop;
      console.log(`[Veo3] \uCD1D \uC218\uC9D1\uB41C \uC774\uBBF8\uC9C0 URL: ${orderedUrls.length}\uAC1C (\uC694\uCCAD: ${count}\uAC1C)`);
      console.log(`[Veo3] \uC218\uC9D1\uB41C URL: ${orderedUrls.length}\uAC1C (DOM \uC704\u2192\uC544\uB798 \uC21C\uC11C)`);
      if (orderedUrls.length > 0) {
        console.log("[Veo3] \uC218\uC9D1\uB41C URL (\uCC98\uC74C 3\uAC1C = DOM \uC704\uCABD, \uCD5C\uC2E0):");
        orderedUrls.slice(0, 3).forEach((url, idx) => {
          console.log(`  ${idx + 1}: ${url.substring(url.lastIndexOf("/") + 1, url.lastIndexOf("/") + 50)}...`);
        });
      }
      return orderedUrls.slice(0, count);
    }
    // 스크롤 가능한 컨테이너 찾기
    findScrollableContainer() {
      const candidates = [
        // 일반적인 스크롤 컨테이너 선택자들
        document.querySelector("main"),
        document.querySelector('[role="main"]'),
        document.querySelector(".overflow-auto"),
        document.querySelector(".overflow-y-auto"),
        document.querySelector("[data-radix-scroll-area-viewport]")
      ];
      for (const el of candidates) {
        if (el && el.scrollHeight > el.clientHeight) {
          return el;
        }
      }
      const divs = document.querySelectorAll("div");
      for (const div of divs) {
        const style = window.getComputedStyle(div);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") && div.scrollHeight > div.clientHeight + 100) {
          return div;
        }
      }
      if (document.documentElement.scrollHeight > document.documentElement.clientHeight) {
        return document.documentElement;
      }
      return document.body;
    }
    // ==================== 이미지 업로드 (I2V 모드) ====================
    // dataURL을 File 객체로 변환
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
    // 프레임 컨테이너 찾기 (swap_horiz 버튼이 있는 영역)
    // add 버튼이 포함된 상위 요소까지 탐색
    findFrameContainer() {
      var _a, _b;
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const icon = btn.querySelector("i");
        if (((_a = icon == null ? void 0 : icon.textContent) == null ? void 0 : _a.trim()) === "swap_horiz") {
          let container = btn.parentElement;
          for (let level = 0; level < 10 && container; level++) {
            const icons = container.querySelectorAll("button i");
            let hasAddIcon = false;
            for (const icn of icons) {
              if (((_b = icn.textContent) == null ? void 0 : _b.trim()) === "add") {
                hasAddIcon = true;
                break;
              }
            }
            if (hasAddIcon) {
              console.log(`[Veo3] \uD504\uB808\uC784 \uCEE8\uD14C\uC774\uB108 \uCC3E\uC74C (\uB808\uBCA8 ${level})`);
              return container;
            }
            container = container.parentElement;
          }
        }
      }
      console.warn("[Veo3] \uD504\uB808\uC784 \uCEE8\uD14C\uC774\uB108\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C");
      return null;
    }
    // add 버튼 클릭 (시작/끝 프레임)
    // position: 'first' = 시작 프레임 (왼쪽), 'last' = 끝 프레임 (오른쪽)
    findAddButton(position) {
      var _a;
      const container = this.findFrameContainer();
      const searchArea = container || document;
      const buttons = searchArea.querySelectorAll("button");
      const addButtons = [];
      for (const btn of buttons) {
        const icon = btn.querySelector("i");
        const iconText = ((_a = icon == null ? void 0 : icon.textContent) == null ? void 0 : _a.trim()) || "";
        if (iconText === "add") {
          addButtons.push(btn);
          console.log(`[Veo3] add \uBC84\uD2BC \uBC1C\uACAC: ${addButtons.length}\uBC88\uC9F8`);
        }
      }
      console.log(`[Veo3] \uD504\uB808\uC784 \uC601\uC5ED \uB0B4 add \uBC84\uD2BC \uAC1C\uC218: ${addButtons.length}`);
      if (addButtons.length === 0) return null;
      if (position === "first") {
        console.log("[Veo3] \uCCAB \uBC88\uC9F8 add \uBC84\uD2BC (\uC2DC\uC791 \uD504\uB808\uC784) \uC120\uD0DD");
        return addButtons[0];
      } else {
        console.log("[Veo3] \uB9C8\uC9C0\uB9C9 add \uBC84\uD2BC (\uB05D \uD504\uB808\uC784) \uC120\uD0DD");
        return addButtons[addButtons.length - 1];
      }
    }
    // 업로드 버튼 찾기 (메뉴 내부)
    findUploadButton() {
      var _a;
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.textContent || "";
        const icon = btn.querySelector("i");
        const iconText = ((_a = icon == null ? void 0 : icon.textContent) == null ? void 0 : _a.trim()) || "";
        if (iconText === "upload") {
          console.log("[Veo3] upload \uC544\uC774\uCF58\uC73C\uB85C \uC5C5\uB85C\uB4DC \uBC84\uD2BC \uCC3E\uC74C");
          return btn;
        }
        if (text.includes("\uC5C5\uB85C\uB4DC") || text.includes("Upload")) {
          console.log("[Veo3] \uD14D\uC2A4\uD2B8\uB85C \uC5C5\uB85C\uB4DC \uBC84\uD2BC \uCC3E\uC74C:", text.substring(0, 30));
          return btn;
        }
      }
      return null;
    }
    // 이미지가 이미 첨부되었는지 확인
    // MCP 분석: 이미지 설정됨 → 버튼 텍스트가 "첫 번째 프레임" 또는 "마지막 프레임"으로 바뀜
    isImageAlreadyAttached(position) {
      const container = this.findFrameContainer();
      const searchArea = container || document;
      const buttons = searchArea.querySelectorAll("button");
      const targetText = position === "first" ? "\uCCAB \uBC88\uC9F8 \uD504\uB808\uC784" : "\uB9C8\uC9C0\uB9C9 \uD504\uB808\uC784";
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim();
        if (text.includes(targetText)) {
          console.log(`[Veo3] ${position} \uD504\uB808\uC784\uC5D0 \uC774\uBBF8\uC9C0\uAC00 \uC774\uBBF8 \uCCA8\uBD80\uB418\uC5B4 \uC788\uC74C`);
          return true;
        }
      }
      return false;
    }
    // 프레임 업로드 중인지 확인 (progress_activity 아이콘)
    isFrameUploading() {
      var _a;
      const container = this.findFrameContainer();
      const searchArea = container || document;
      const buttons = searchArea.querySelectorAll("button");
      for (const btn of buttons) {
        const icon = btn.querySelector("i");
        const iconText = ((_a = icon == null ? void 0 : icon.textContent) == null ? void 0 : _a.trim()) || "";
        if (iconText === "progress_activity") {
          return true;
        }
      }
      return false;
    }
    // 프레임에 이미지가 업로드 완료될 때까지 대기
    // MCP 분석: 업로드 완료 시 버튼 텍스트가 "첫 번째 프레임"/"마지막 프레임"으로 바뀜
    // 업로드 중: progress_activity 아이콘 (disabled)
    async waitForFrameImageUploaded(position, timeout = 2e4) {
      console.log(`[Veo3] ${position} \uD504\uB808\uC784 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC644\uB8CC \uB300\uAE30 \uC911...`);
      const startTime = Date.now();
      const targetText = position === "first" ? "\uCCAB \uBC88\uC9F8 \uD504\uB808\uC784" : "\uB9C8\uC9C0\uB9C9 \uD504\uB808\uC784";
      while (Date.now() - startTime < timeout) {
        if (this.isImageAlreadyAttached(position)) {
          console.log(`[Veo3] ${position} \uD504\uB808\uC784 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC644\uB8CC \uD655\uC778! (\uBC84\uD2BC: "${targetText}")`);
          return true;
        }
        if (this.isFrameUploading()) {
          console.log("[Veo3] \uC5C5\uB85C\uB4DC \uC9C4\uD589 \uC911 (progress_activity)...");
        }
        const cropButtons = document.querySelectorAll("button");
        let cropDialogOpen = false;
        for (const btn of cropButtons) {
          const text = (btn.textContent || "").trim();
          if (text.includes("\uC790\uB974\uAE30 \uBC0F \uC800\uC7A5") || text.includes("Crop and save") || text.includes("crop") && text.includes("\uC790\uB974\uAE30")) {
            cropDialogOpen = true;
            break;
          }
        }
        if (cropDialogOpen) {
          console.log("[Veo3] crop \uB2E4\uC774\uC5BC\uB85C\uADF8\uAC00 \uC544\uC9C1 \uC5F4\uB824\uC788\uC74C, \uD074\uB9AD \uC2DC\uB3C4...");
          await this.handleCropAndSaveDialog();
        }
        await this.delay(500);
      }
      console.warn(`[Veo3] ${position} \uD504\uB808\uC784 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC644\uB8CC \uB300\uAE30 \uD0C0\uC784\uC544\uC6C3`);
      return false;
    }
    // 첨부된 이미지 제거 (close 버튼 클릭)
    async removeAttachedImage(position) {
      var _a;
      const container = this.findFrameContainer();
      const searchArea = container || document;
      const buttons = searchArea.querySelectorAll("button");
      const closeButtons = [];
      for (const btn of buttons) {
        const icon = btn.querySelector("i");
        const iconText = ((_a = icon == null ? void 0 : icon.textContent) == null ? void 0 : _a.trim()) || "";
        if (iconText === "close") {
          closeButtons.push(btn);
          console.log(`[Veo3] close \uBC84\uD2BC \uBC1C\uACAC: ${closeButtons.length}\uBC88\uC9F8`);
        }
      }
      console.log(`[Veo3] \uD504\uB808\uC784 \uC601\uC5ED \uB0B4 close \uBC84\uD2BC \uAC1C\uC218: ${closeButtons.length}`);
      if (closeButtons.length > 0) {
        const idx = position === "first" ? 0 : closeButtons.length - 1;
        closeButtons[idx].click();
        await this.delay(300);
        console.log(`[Veo3] ${position} \uD504\uB808\uC784 \uC774\uBBF8\uC9C0 \uC81C\uAC70 \uC644\uB8CC`);
      }
    }
    // I2V 모드: 이미지 업로드 (시작 프레임)
    async uploadStartFrameImage(imageDataUrl) {
      return this.uploadFrameImage(imageDataUrl, "first");
    }
    // I2V 모드: 이미지 업로드 (끝 프레임)
    async uploadEndFrameImage(imageDataUrl) {
      return this.uploadFrameImage(imageDataUrl, "last");
    }
    // 애셋(Ingredients) 모드: 여러 재료 이미지 업로드 (1~3개)
    // MCP 분석: add 버튼 클릭 → 업로드 → 이미지 버튼 추가 → add 버튼 여전히 있음 → 반복
    async uploadIngredientImages(dataUrls) {
      console.log(`[Veo3] Ingredients \uBAA8\uB4DC: ${dataUrls.length}\uAC1C \uC7AC\uB8CC \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC2DC\uC791`);
      if (dataUrls.length === 0) {
        console.warn("[Veo3] \uC5C5\uB85C\uB4DC\uD560 \uC774\uBBF8\uC9C0\uAC00 \uC5C6\uC74C");
        return false;
      }
      if (dataUrls.length > 3) {
        console.warn("[Veo3] \uCD5C\uB300 3\uAC1C\uAE4C\uC9C0\uB9CC \uC5C5\uB85C\uB4DC \uAC00\uB2A5, \uCD08\uACFC\uBD84 \uBB34\uC2DC");
        dataUrls = dataUrls.slice(0, 3);
      }
      await this.clearIngredientImages();
      for (let i = 0; i < dataUrls.length; i++) {
        console.log(`[Veo3] \uC7AC\uB8CC \uC774\uBBF8\uC9C0 ${i + 1}/${dataUrls.length} \uC5C5\uB85C\uB4DC \uC911...`);
        const success = await this.uploadSingleIngredient(dataUrls[i]);
        if (!success) {
          console.error(`[Veo3] \uC7AC\uB8CC \uC774\uBBF8\uC9C0 ${i + 1} \uC5C5\uB85C\uB4DC \uC2E4\uD328`);
          return false;
        }
        await this.waitForIngredientCount(i + 1);
        await this.delay(500);
      }
      console.log(`[Veo3] \uBAA8\uB4E0 \uC7AC\uB8CC \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC644\uB8CC (${dataUrls.length}\uAC1C)`);
      return true;
    }
    // 애셋 모드: 기존 재료 이미지 모두 제거
    async clearIngredientImages() {
      const container = this.findIngredientContainer();
      if (!container) return;
      console.log("[Veo3] \uAE30\uC874 \uC7AC\uB8CC \uC774\uBBF8\uC9C0 \uC81C\uAC70 (\uAD6C\uD604 \uC608\uC815)");
    }
    // 애셋 모드: 단일 재료 이미지 업로드
    async uploadSingleIngredient(imageDataUrl) {
      console.log("[Veo3] \uB2E8\uC77C \uC7AC\uB8CC \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC2DC\uC791");
      if (imageDataUrl.startsWith("http")) {
        console.log("[Veo3] HTTP URL \u2192 dataURL \uBCC0\uD658");
        try {
          const response = await fetch(imageDataUrl);
          const blob = await response.blob();
          imageDataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
        } catch (error) {
          console.error("[Veo3] HTTP URL \uBCC0\uD658 \uC2E4\uD328:", error);
          return false;
        }
      }
      const addBtn = this.findIngredientAddButton();
      if (!addBtn) {
        console.error("[Veo3] \uC7AC\uB8CC add \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        return false;
      }
      const fileInputDetected = new Promise((resolve) => {
        let resolved = false;
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node instanceof HTMLInputElement && node.type === "file") {
                observer.disconnect();
                if (!resolved) {
                  resolved = true;
                  resolve(node);
                }
                return;
              }
              if (node instanceof HTMLElement) {
                const inp = node.querySelector('input[type="file"]');
                if (inp) {
                  observer.disconnect();
                  if (!resolved) {
                    resolved = true;
                    resolve(inp);
                  }
                  return;
                }
              }
            }
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }, 8e3);
      });
      console.log("[Veo3] add \uBC84\uD2BC \uD074\uB9AD");
      addBtn.click();
      let uploadBtn = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        await this.delay(200);
        uploadBtn = this.findUploadButton();
        if (uploadBtn) break;
      }
      if (!uploadBtn) {
        console.error("[Veo3] \uC5C5\uB85C\uB4DC \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return false;
      }
      console.log("[Veo3] background\uC5D0 INJECT_FILE_INPUT \uC694\uCCAD");
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "INJECT_FILE_INPUT", imageDataUrl }, () => resolve());
      });
      await this.delay(300);
      console.log("[Veo3] \uC5C5\uB85C\uB4DC \uBC84\uD2BC \uD074\uB9AD");
      uploadBtn.click();
      const detectedInput = await fileInputDetected;
      if (detectedInput) {
        console.log("[Veo3] file input \uAC10\uC9C0\uB428, \uC9C1\uC811 \uD30C\uC77C \uC8FC\uC785 \uC2DC\uB3C4");
        try {
          const file = this.dataUrlToFile(imageDataUrl, `ingredient-${Date.now()}.png`);
          const dt = new DataTransfer();
          dt.items.add(file);
          detectedInput.files = dt.files;
          detectedInput.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) {
          console.warn("[Veo3] \uC9C1\uC811 \uD30C\uC77C \uC8FC\uC785 \uC2E4\uD328:", e);
        }
      }
      await this.delay(1e3);
      const cropSaveBtn = await this.waitForCropDialog(5e3);
      if (cropSaveBtn) {
        console.log("[Veo3] \uD06C\uB86D \uB2E4\uC774\uC5BC\uB85C\uADF8 \uC800\uC7A5 \uBC84\uD2BC \uD074\uB9AD");
        cropSaveBtn.click();
        await this.delay(1e3);
      }
      return true;
    }
    // 애셋 모드: 재료 이미지 컨테이너 찾기
    findIngredientContainer() {
      const comboboxes = document.querySelectorAll('[role="combobox"]');
      for (const cb of comboboxes) {
        const text = cb.textContent || "";
        if (text.includes("\uC560\uC14B\uC73C\uB85C \uB3D9\uC601\uC0C1 \uB9CC\uB4E4\uAE30")) {
          return cb.closest("div");
        }
      }
      return null;
    }
    // 애셋 모드: add 버튼 찾기
    findIngredientAddButton() {
      var _a;
      const buttons = document.querySelectorAll("button");
      let lastAddBtn = null;
      for (const btn of buttons) {
        const icon = btn.querySelector("i");
        const iconText = ((_a = icon == null ? void 0 : icon.textContent) == null ? void 0 : _a.trim()) || "";
        const btnText = (btn.textContent || "").trim();
        if (iconText === "add" || btnText === "add") {
          lastAddBtn = btn;
        }
      }
      if (lastAddBtn) {
        console.log("[Veo3] \uC7AC\uB8CC add \uBC84\uD2BC \uCC3E\uC74C");
      }
      return lastAddBtn;
    }
    // 애셋 모드: 재료 이미지 개수 대기
    async waitForIngredientCount(expectedCount, timeout = 1e4) {
      console.log(`[Veo3] \uC7AC\uB8CC \uC774\uBBF8\uC9C0 ${expectedCount}\uAC1C \uC5C5\uB85C\uB4DC \uC644\uB8CC \uB300\uAE30 \uC911...`);
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        const currentCount = this.countIngredientImages();
        if (currentCount >= expectedCount) {
          console.log(`[Veo3] \uC7AC\uB8CC \uC774\uBBF8\uC9C0 ${expectedCount}\uAC1C \uC5C5\uB85C\uB4DC \uC644\uB8CC!`);
          return true;
        }
        await this.delay(500);
      }
      console.warn(`[Veo3] \uC7AC\uB8CC \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uD0C0\uC784\uC544\uC6C3`);
      return false;
    }
    // 애셋 모드: 현재 첨부된 재료 이미지 개수 확인
    countIngredientImages() {
      const buttons = document.querySelectorAll("button");
      let count = 0;
      for (const btn of buttons) {
        const text = (btn.textContent || "").trim();
        if (text.includes("\uC7AC\uB8CC\uB97C \uD65C\uC6A9\uD574\uC11C") || text.includes("ingredient")) {
          count++;
        }
      }
      return count;
    }
    // 크롭 다이얼로그 대기
    async waitForCropDialog(timeout = 5e3) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = (btn.textContent || "").trim();
          if (text.includes("\uC790\uB974\uAE30 \uBC0F \uC800\uC7A5") || text.includes("Crop and save")) {
            return btn;
          }
        }
        await this.delay(200);
      }
      return null;
    }
    // I2V 모드: 프레임 이미지 업로드 공통 로직
    // 전략: add 버튼 → 업로드 메뉴 클릭 → file chooser가 열리면
    // background에서 chrome.scripting.executeScript(MAIN world)로 file input에 파일 주입
    async uploadFrameImage(imageDataUrl, position) {
      console.log(`[Veo3] ${position} \uD504\uB808\uC784 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC2DC\uC791`);
      if (imageDataUrl.startsWith("http")) {
        console.log("[Veo3] HTTP URL \u2192 dataURL \uBCC0\uD658 \uC2DC\uB3C4");
        try {
          const response = await fetch(imageDataUrl);
          const blob = await response.blob();
          imageDataUrl = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.readAsDataURL(blob);
          });
          console.log("[Veo3] dataURL \uBCC0\uD658 \uC644\uB8CC, \uAE38\uC774:", imageDataUrl.length);
        } catch (error) {
          console.error("[Veo3] HTTP URL \u2192 dataURL \uBCC0\uD658 \uC2E4\uD328:", error);
          return false;
        }
      }
      if (this.isImageAlreadyAttached(position)) {
        console.log(`[Veo3] ${position} \uAE30\uC874 \uC774\uBBF8\uC9C0 \uC81C\uAC70 \uC911...`);
        await this.removeAttachedImage(position);
        await this.delay(500);
      }
      const addBtn = this.findAddButton(position);
      if (!addBtn) {
        console.error(`[Veo3] ${position} add \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C`);
        return false;
      }
      const file = this.dataUrlToFile(imageDataUrl, `frame-${Date.now()}.png`);
      console.log(`[Veo3] File \uAC1D\uCCB4 \uC0DD\uC131: ${file.name}, \uD06C\uAE30: ${file.size}\uBC14\uC774\uD2B8, type: ${file.type}`);
      const fileInputDetected = new Promise((resolve) => {
        let resolved = false;
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node instanceof HTMLInputElement && node.type === "file") {
                observer.disconnect();
                if (!resolved) {
                  resolved = true;
                  resolve(node);
                }
                return;
              }
              if (node instanceof HTMLElement) {
                const inp = node.querySelector('input[type="file"]');
                if (inp) {
                  observer.disconnect();
                  if (!resolved) {
                    resolved = true;
                    resolve(inp);
                  }
                  return;
                }
              }
            }
            if (mutation.type === "attributes" && mutation.target instanceof HTMLInputElement) {
              if (mutation.target.type === "file") {
                observer.disconnect();
                if (!resolved) {
                  resolved = true;
                  resolve(mutation.target);
                }
                return;
              }
            }
          }
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["type"]
        });
        setTimeout(() => {
          observer.disconnect();
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }, 8e3);
      });
      console.log("[Veo3] add \uBC84\uD2BC \uD074\uB9AD");
      addBtn.click();
      let uploadBtn = null;
      for (let attempt = 0; attempt < 15; attempt++) {
        await this.delay(200);
        uploadBtn = this.findUploadButton();
        if (uploadBtn) {
          console.log(`[Veo3] \uC5C5\uB85C\uB4DC \uBC84\uD2BC \uCC3E\uC74C (\uC2DC\uB3C4 ${attempt + 1})`);
          break;
        }
      }
      if (!uploadBtn) {
        console.error("[Veo3] \uC5C5\uB85C\uB4DC \uBC84\uD2BC\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC74C (\uD0C0\uC784\uC544\uC6C3)");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        return false;
      }
      console.log("[Veo3] background\uC5D0 INJECT_FILE_INPUT \uC694\uCCAD");
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "INJECT_FILE_INPUT",
          imageDataUrl
        }, () => {
          console.log("[Veo3] INJECT_FILE_INPUT \uC751\uB2F5 \uC218\uC2E0");
          resolve();
        });
      });
      await this.delay(300);
      console.log("[Veo3] \uC5C5\uB85C\uB4DC \uBC84\uD2BC \uD074\uB9AD");
      uploadBtn.click();
      const detectedInput = await fileInputDetected;
      if (detectedInput) {
        console.log("[Veo3] MutationObserver\uB85C file input \uAC10\uC9C0\uB428");
        try {
          const dt = new DataTransfer();
          dt.items.add(file);
          detectedInput.files = dt.files;
          detectedInput.dispatchEvent(new Event("change", { bubbles: true }));
          console.log("[Veo3] file input\uC5D0 \uC9C1\uC811 \uD30C\uC77C \uC8FC\uC785 \uC644\uB8CC");
          const cropResult = await this.handleCropAndSaveDialog();
          if (cropResult) {
            const uploadComplete = await this.waitForFrameImageUploaded(position, 15e3);
            return uploadComplete;
          }
          return true;
        } catch (err) {
          console.warn("[Veo3] file input \uC9C1\uC811 \uC8FC\uC785 \uC2E4\uD328:", err);
        }
      }
      console.log("[Veo3] \uD3F4\uBC31: DOM\uC5D0\uC11C input[type=file] \uAC80\uC0C9");
      for (let attempt = 0; attempt < 10; attempt++) {
        await this.delay(500);
        const inputs = document.querySelectorAll('input[type="file"]');
        if (inputs.length > 0) {
          const inp = inputs[0];
          console.log(`[Veo3] \uD3F4\uBC31\uC73C\uB85C file input \uBC1C\uACAC (\uC2DC\uB3C4 ${attempt + 1})`);
          const dt = new DataTransfer();
          dt.items.add(file);
          inp.files = dt.files;
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          const cropResult = await this.handleCropAndSaveDialog();
          if (cropResult) {
            const uploadComplete = await this.waitForFrameImageUploaded(position, 15e3);
            return uploadComplete;
          }
          return true;
        }
      }
      console.warn("[Veo3] file input \uAC10\uC9C0 \uC2E4\uD328, drag-and-drop \uC2DC\uBBAC\uB808\uC774\uC158 \uC2DC\uB3C4");
      return await this.uploadViaDropSimulation(file, position);
    }
    // "자르기 및 저장" 다이얼로그 처리
    // 파일 업로드 후 나타나는 크롭 다이얼로그에서 "자르기 및 저장" 버튼을 클릭
    async handleCropAndSaveDialog() {
      console.log("[Veo3] \uC790\uB974\uAE30 \uBC0F \uC800\uC7A5 \uB2E4\uC774\uC5BC\uB85C\uADF8 \uB300\uAE30 \uC911...");
      for (let attempt = 0; attempt < 30; attempt++) {
        await this.delay(500);
        const allButtons = document.querySelectorAll("button");
        for (const btn of allButtons) {
          const text = (btn.textContent || "").trim();
          const isCropButton = text.includes("\uC790\uB974\uAE30 \uBC0F \uC800\uC7A5") || // 한국어
          text.includes("Crop and save") || // 영어
          text.includes("Crop and Save") || // 영어 대문자
          text.includes("crop") && text.includes("\uC790\uB974\uAE30") || // crop 아이콘 + 자르기 (공백 있음)
          text.includes("crop") && text.includes("\uC800\uC7A5") || // crop 아이콘 + 저장
          text.includes("crop") && text.includes("save");
          if (isCropButton) {
            console.log(`[Veo3] "\uC790\uB974\uAE30 \uBC0F \uC800\uC7A5" \uBC84\uD2BC \uBC1C\uACAC (\uC2DC\uB3C4 ${attempt + 1}): "${text.substring(0, 30)}"`);
            btn.click();
            console.log('[Veo3] "\uC790\uB974\uAE30 \uBC0F \uC800\uC7A5" \uBC84\uD2BC \uD074\uB9AD \uC644\uB8CC');
            await this.delay(2e3);
            return true;
          }
        }
        if (attempt > 0 && attempt % 10 === 0) {
          console.log(`[Veo3] \uC790\uB974\uAE30 \uBC0F \uC800\uC7A5 \uBC84\uD2BC \uD0D0\uC0C9 \uC911... (${attempt}\uD68C \uC2DC\uB3C4)`);
        }
      }
      console.warn('[Veo3] "\uC790\uB974\uAE30 \uBC0F \uC800\uC7A5" \uB2E4\uC774\uC5BC\uB85C\uADF8\uB97C \uCC3E\uC9C0 \uBABB\uD568 (\uD0C0\uC784\uC544\uC6C3 15\uCD08)');
      return false;
    }
    // drag-and-drop 시뮬레이션으로 파일 업로드 (폴백)
    async uploadViaDropSimulation(file, position) {
      console.log("[Veo3] drag-and-drop \uC2DC\uBBAC\uB808\uC774\uC158 \uC2DC\uC791");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await this.delay(300);
      const addBtn = this.findAddButton(position);
      const dropTarget = addBtn || document.querySelector("textarea") || document.body;
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const events = ["dragenter", "dragover", "drop"];
      for (const eventName of events) {
        const event = new DragEvent(eventName, {
          bubbles: true,
          cancelable: true,
          dataTransfer
        });
        dropTarget.dispatchEvent(event);
        await this.delay(100);
      }
      await this.delay(2e3);
      const attached = this.isImageAlreadyAttached(position);
      if (attached) {
        console.log("[Veo3] drag-and-drop \uC5C5\uB85C\uB4DC \uC131\uACF5");
        return true;
      }
      console.error("[Veo3] drag-and-drop \uC5C5\uB85C\uB4DC\uB3C4 \uC2E4\uD328");
      return false;
    }
    // ==================== 생성 실패 감지 ====================
    // DOM에서 실패한 프롬프트 텍스트들 추출 (역방향 감지)
    // 에러 키워드 대신, 결과물(img/video)이 없는 프롬프트 카드를 실패로 간주
    // maxCards: 최신 N개 카드만 확인 (배치 크기 전달 시 이전 배치 결과 혼입 방지)
    detectPolicyViolations(maxCards) {
      var _a, _b;
      console.log(`[Veo3] \uC2E4\uD328 \uD504\uB86C\uD504\uD2B8 \uAC10\uC9C0 \uC2DC\uC791 (\uC5ED\uBC29\uD5A5${maxCards ? `, \uCD5C\uB300 ${maxCards}\uCE74\uB4DC` : ""})`);
      const failedPrompts = [];
      let cardsSeen = 0;
      const promptGroups = document.querySelectorAll("[data-item-index]");
      console.log(`[Veo3] \uBC1C\uACAC\uB41C \uD504\uB86C\uD504\uD2B8 \uADF8\uB8F9 \uAC1C\uC218: ${promptGroups.length}`);
      for (const group of promptGroups) {
        if (maxCards && cardsSeen >= maxCards) break;
        if (!this.isPromptCardGroup(group)) continue;
        const cardsContainer = (_b = (_a = group.children[0]) == null ? void 0 : _a.children[0]) == null ? void 0 : _b.children[0];
        if (cardsContainer) {
          for (const card of cardsContainer.children) {
            if (maxCards && cardsSeen >= maxCards) break;
            cardsSeen++;
            const cardHasImg = card.querySelector('img[src*="storage.googleapis.com"]') !== null;
            const cardHasVid = card.querySelector('video[src*="storage.googleapis.com"]') !== null;
            if (!cardHasImg && !cardHasVid) {
              this.extractFailedPromptFromElement(card, failedPrompts);
            }
          }
        } else {
          if (maxCards) cardsSeen++;
          const hasVideo = group.querySelector('video[src*="storage.googleapis.com"]') !== null;
          const hasImage = group.querySelector('img[src*="storage.googleapis.com"]') !== null;
          if (!hasVideo && !hasImage) {
            this.extractFailedPromptFromElement(group, failedPrompts);
          }
        }
      }
      console.log(`[Veo3] \uC2E4\uD328 \uD504\uB86C\uD504\uD2B8 \uAC10\uC9C0 \uC644\uB8CC: ${failedPrompts.length}\uAC1C \uBC1C\uACAC (${cardsSeen}\uCE74\uB4DC \uD655\uC778)`);
      return failedPrompts;
    }
    // 프롬프트 카드 그룹인지 확인 (날짜 구분선 등 제외)
    isPromptCardGroup(group) {
      const text = group.textContent || "";
      return text.includes("\uD504\uB86C\uD504\uD2B8 \uC7AC\uC0AC\uC6A9") || text.includes("wrap_text") || text.includes("\uC635\uC158 \uB354\uBCF4\uAE30") || text.includes("more_vert") || text.includes("Reuse prompt") || text.includes("More options");
    }
    // 요소에서 실패한 프롬프트 텍스트 추출
    extractFailedPromptFromElement(element, failedPrompts) {
      const buttons = element.querySelectorAll("button");
      for (const btn of buttons) {
        const btnText = (btn.textContent || "").trim();
        if (btnText.length > 5 && !btnText.includes("expand") && !btnText.includes("close") && !btnText.includes("download") && !btnText.includes("arrow") && !btnText.includes("favorite") && !btnText.includes("more_vert") && !btnText.includes("wrap_text") && !btnText.includes("\uD504\uB86C\uD504\uD2B8\uC5D0 \uCD94\uAC00") && !btnText.includes("prompt_suggestion") && !btnText.includes("\uC7A5\uBA74\uC5D0 \uCD94\uAC00") && !btnText.includes("transition_push") && !btnText.includes("\uD504\uB86C\uD504\uD2B8 \uC7AC\uC0AC\uC6A9") && !btnText.includes("\uC635\uC158 \uB354\uBCF4\uAE30") && !btnText.includes("\uC758\uACAC") && !btnText.includes("Reuse prompt") && !btnText.includes("More options")) {
          const promptText = btnText.trim();
          if (promptText.length > 3) {
            console.log(`[Veo3] \uC2E4\uD328 \uD504\uB86C\uD504\uD2B8 \uBC1C\uACAC (\uACB0\uACFC\uBB3C \uC5C6\uC74C): "${promptText.substring(0, 50)}..."`);
            failedPrompts.push(promptText);
          }
          break;
        }
      }
    }
    // 현재 보이는 이미지 URL만 수집 (폴백)
    collectVisibleImageUrls(count) {
      const urls = [];
      const images = document.querySelectorAll("img[src]");
      for (const img of images) {
        const src = img.getAttribute("src");
        if (src && !src.startsWith("data:") && src.includes("storage.googleapis.com") && src.includes("/image/")) {
          if (!urls.includes(src)) {
            urls.push(src);
          }
        }
      }
      return urls.slice(0, count);
    }
  };

  // src/content/index.ts
  var controller = new Veo3Controller();
  var isProcessing = false;
  var shouldStop = false;
  var currentPrompts = null;
  var apiResults = [];
  var expectedSeq = 0;
  var pendingBySeq = /* @__PURE__ */ new Map();
  var allMediaUrls = /* @__PURE__ */ new Map();
  var apiResponseCount = 0;
  function injectFetchInterceptor() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
    console.log("[Veo3] Fetch \uC778\uD130\uC149\uD130 inject \uC644\uB8CC");
  }
  window.addEventListener("message", async (event) => {
    var _a;
    if (event.source !== window || ((_a = event.data) == null ? void 0 : _a.type) !== "VEO3_API_RESULT") return;
    const result = {
      prompt: event.data.prompt || "",
      status: event.data.status,
      ok: event.data.ok,
      hasMedia: event.data.hasMedia,
      error: event.data.error,
      errorCode: event.data.errorCode,
      mediaUrls: event.data.mediaUrls || [],
      isVideo: event.data.isVideo || false,
      timestamp: Date.now()
    };
    apiResults.push(result);
    apiResponseCount++;
    const seq = event.data.seq;
    const promptIdx = pendingBySeq.get(seq);
    if (promptIdx !== void 0 && currentPrompts) {
      pendingBySeq.delete(seq);
      const prompt = currentPrompts[promptIdx];
      if (prompt) {
        if (!result.ok || !result.hasMedia) {
          const reason = result.errorCode || result.error || `HTTP ${result.status}`;
          console.log(`[Veo3] API \uC2E4\uC2DC\uAC04: \uD504\uB86C\uD504\uD2B8 ${promptIdx + 1} \uC2E4\uD328 (${reason}) [seq=${seq}]`);
          prompt.status = "error";
        } else {
          console.log(`[Veo3] API \uC2E4\uC2DC\uAC04: \uD504\uB86C\uD504\uD2B8 ${promptIdx + 1} \uC131\uACF5 (\uBBF8\uB514\uC5B4 ${result.mediaUrls.length}\uAC1C) [seq=${seq}]`);
          prompt.status = "done";
          allMediaUrls.set(promptIdx, result.mediaUrls);
        }
        chrome.storage.local.set({ prompts: currentPrompts });
      }
    } else {
      console.log(`[Veo3] API \uACB0\uACFC \uC218\uC2E0 (\uB9E4\uCE6D \uC5C6\uC74C): seq=${seq}, status=${result.status}, ok=${result.ok}`);
    }
  });
  function waitForApiResponses(count, timeoutMs = 18e4) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        if (apiResponseCount >= count || Date.now() - startTime > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  }
  function resetApiBatch(clearUrls = true) {
    apiResults.length = 0;
    pendingBySeq.clear();
    if (clearUrls) allMediaUrls.clear();
    apiResponseCount = 0;
  }
  injectFetchInterceptor();
  async function requestImageData(index, field = "imageFile") {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_IMAGE_DATA", index, field }, (response) => {
        resolve((response == null ? void 0 : response.dataUrl) || "");
      });
    });
  }
  async function requestIngredientData(index) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_IMAGE_DATA", index, field: "ingredientFiles" }, (response) => {
        resolve((response == null ? void 0 : response.dataUrls) || []);
      });
    });
  }
  function generateRandomString(length = 8) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
  function generateFilename(promptIndex, extension, subIndex) {
    const paddedIndex = String(promptIndex).padStart(3, "0");
    const randomStr = generateRandomString();
    if (subIndex !== void 0) {
      return `${paddedIndex}-${subIndex}-${randomStr}.${extension}`;
    }
    return `${paddedIndex}-${randomStr}.${extension}`;
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log("[Veo3] \uBA54\uC2DC\uC9C0 \uC218\uC2E0:", message.type);
    switch (message.type) {
      case "START_QUEUE":
        console.log("[Veo3] START_QUEUE \uC218\uC2E0, \uC124\uC815:", message.settings, "\uBAA8\uB4DC:", message.mode, "frameMode:", message.frameMode, "imageMode:", message.imageMode);
        startQueueProcessing(message.settings, message.mode, message.frameMode, message.imageMode);
        sendResponse({ success: true });
        return true;
      case "STOP_QUEUE":
        console.log("[Veo3] STOP_QUEUE \uC218\uC2E0");
        shouldStop = true;
        sendResponse({ success: true });
        return true;
      case "GET_STATUS":
        const isReady = controller.isReady();
        console.log("[Veo3] GET_STATUS \uC751\uB2F5:", { ready: isReady, processing: isProcessing });
        sendResponse({ ready: isReady, processing: isProcessing });
        return true;
      case "SCAN_GENERATED_IMAGES":
        console.log("[Veo3] SCAN_GENERATED_IMAGES \uC218\uC2E0");
        try {
          const images = controller.scanGeneratedImages();
          console.log(`[Veo3] \uC2A4\uCE94\uB41C \uC774\uBBF8\uC9C0: ${images.length}\uAC1C`);
          sendResponse({ success: true, images });
        } catch (error) {
          console.error("[Veo3] \uC774\uBBF8\uC9C0 \uC2A4\uCE94 \uC624\uB958:", error);
          sendResponse({ success: false, images: [], error: String(error) });
        }
        return true;
      case "DOWNLOAD_ALL_IMAGES":
        console.log("[Veo3] DOWNLOAD_ALL_IMAGES \uC218\uC2E0, outputCount:", message.outputCount);
        (async () => {
          try {
            const count = await downloadAllExistingImages(message.outputCount || 1);
            sendResponse({ success: true, count });
          } catch (error) {
            console.error("[Veo3] \uC804\uCCB4 \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC624\uB958:", error);
            sendResponse({ success: false, error: String(error) });
          }
        })();
        return true;
      // 비동기 응답을 위해 true 반환
      case "DOWNLOAD_ALL_VIDEOS":
        console.log("[Veo3] DOWNLOAD_ALL_VIDEOS \uC218\uC2E0");
        (async () => {
          try {
            const count = await downloadAllExistingVideos();
            sendResponse({ success: true, count });
          } catch (error) {
            console.error("[Veo3] \uC804\uCCB4 \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC \uC624\uB958:", error);
            sendResponse({ success: false, error: String(error) });
          }
        })();
        return true;
      default:
        console.log("[Veo3] \uC54C \uC218 \uC5C6\uB294 \uBA54\uC2DC\uC9C0 \uD0C0\uC785:", message.type);
        return false;
    }
  });
  function getRandomWaitTime(min, max) {
    return (Math.floor(Math.random() * (max - min + 1)) + min) * 1e3;
  }
  async function detectAndUpdatePolicyViolations(prompts, batchStart, batchEnd) {
    const batchSize = batchStart !== void 0 && batchEnd !== void 0 ? batchEnd - batchStart : void 0;
    const rangeStr = batchStart !== void 0 ? ` (\uBC94\uC704: ${batchStart + 1}~${batchEnd})` : " (\uC804\uCCB4)";
    console.log(`[Veo3] \uC2E4\uD328 \uAC10\uC9C0 \uC2DC\uC791...${rangeStr}`);
    const failedPromptTexts = controller.detectPolicyViolations(batchSize);
    if (failedPromptTexts.length > 0) {
      console.log(`[Veo3] ${failedPromptTexts.length}\uAC1C \uC2E4\uD328 \uAC10\uC9C0\uB428`);
      const startIdx = batchStart ?? 0;
      const endIdx = batchEnd ?? prompts.length;
      const alreadyMarked = /* @__PURE__ */ new Set();
      for (const failedText of failedPromptTexts) {
        const failedTrimmed = failedText.trim();
        for (let i = startIdx; i < endIdx; i++) {
          if (alreadyMarked.has(i)) continue;
          const promptText = prompts[i].text.trim();
          const isMatch = failedTrimmed.includes(promptText) || promptText.includes(failedTrimmed) || failedTrimmed.substring(0, 50) === promptText.substring(0, 50);
          if (isMatch && (prompts[i].status === "done" || prompts[i].status === "running")) {
            console.log(`[Veo3] \uD504\uB86C\uD504\uD2B8 ${i + 1} \uC2E4\uD328\uB85C \uC0C1\uD0DC \uBCC0\uACBD: "${promptText.substring(0, 30)}..."`);
            prompts[i].status = "error";
            alreadyMarked.add(i);
            break;
          }
        }
      }
      await chrome.storage.local.set({ prompts });
    }
  }
  async function startQueueProcessing(settings, mode, frameMode, imageMode) {
    if (isProcessing) {
      console.log("[Veo3] \uC774\uBBF8 \uCC98\uB9AC \uC911\uC785\uB2C8\uB2E4");
      return;
    }
    isProcessing = true;
    shouldStop = false;
    console.log(`[Veo3] \uB300\uAE30\uC5F4 \uCC98\uB9AC \uC2DC\uC791 (\uBAA8\uB4DC: ${mode}, frameMode: ${frameMode}, imageMode: ${imageMode})`);
    try {
      if (mode === "text2video") {
        await controller.switchToTextToVideoMode();
        await controller.delay(500);
        await processVideoQueue(settings);
      } else if (mode === "frame2video") {
        await controller.switchToImageToVideoMode();
        await controller.delay(500);
        await processI2VQueue(settings, frameMode || "single");
      } else if (mode === "asset2video") {
        await controller.switchToAssetToVideoMode();
        await controller.delay(500);
        await processI2VQueue(settings, "ingredients");
      } else if (mode === "image") {
        if (imageMode === "text2image") {
          await controller.switchToTextToImageMode();
          await controller.delay(500);
          await processImageQueue(settings);
        } else if (imageMode === "image2image") {
          await controller.switchToImageToImageMode();
          await controller.delay(500);
          await processI2IQueue(settings);
        }
      } else {
        await processVideoQueue(settings);
      }
    } catch (error) {
      console.error("[Veo3] \uCC98\uB9AC \uC911 \uC624\uB958:", error);
      await chrome.storage.local.set({ status: "error" });
    } finally {
      isProcessing = false;
      shouldStop = false;
      console.log("[Veo3] \uB300\uAE30\uC5F4 \uCC98\uB9AC \uC885\uB8CC");
    }
  }
  async function processVideoQueue(settings) {
    await controller.applySettings(settings);
    while (!shouldStop) {
      const storage = await chrome.storage.local.get(["prompts", "currentIndex", "status"]);
      const prompts = storage.prompts;
      const currentIndex = storage.currentIndex || 0;
      const status = storage.status;
      if (status !== "running" || !prompts || !Array.isArray(prompts) || currentIndex >= prompts.length) {
        console.log("[Veo3] \uBE44\uB514\uC624 \uB300\uAE30\uC5F4 \uCC98\uB9AC \uC644\uB8CC");
        await chrome.storage.local.set({ status: "idle" });
        break;
      }
      currentPrompts = prompts;
      const batchSize = Math.min(5, prompts.length - currentIndex);
      console.log(`[Veo3] \uBE44\uB514\uC624 \uBC30\uCE58 \uCC98\uB9AC: ${currentIndex + 1}~${currentIndex + batchSize}/${prompts.length}`);
      resetApiBatch();
      let apiRequestCount = 0;
      for (let i = 0; i < batchSize && !shouldStop; i++) {
        const idx = currentIndex + i;
        const item = prompts[idx];
        prompts[idx].status = "running";
        await chrome.storage.local.set({ prompts, currentIndex: idx });
        let retries = 0;
        let success = false;
        while (!success && retries <= (settings.retryOnFail ? settings.maxRetries : 0)) {
          try {
            if (retries > 0) {
              console.log(`[Veo3] \uC7AC\uC2DC\uB3C4 ${retries}/${settings.maxRetries}: ${item.text}`);
            }
            const thisSeq = ++expectedSeq;
            pendingBySeq.set(thisSeq, idx);
            await controller.typePrompt(item.text);
            await controller.delay(500);
            await controller.clickCreate();
            const waitTime = getRandomWaitTime(settings.waitTimeMin, settings.waitTimeMax);
            console.log(`[Veo3] \uB300\uAE30: ${waitTime / 1e3}\uCD08 [seq=${thisSeq}]`);
            await controller.delay(waitTime);
            success = true;
            apiRequestCount++;
          } catch (error) {
            console.error(`[Veo3] \uC5D0\uB7EC:`, error);
            pendingBySeq.delete(expectedSeq);
            expectedSeq--;
            retries++;
            if (retries > (settings.retryOnFail ? settings.maxRetries : 0)) {
              prompts[idx].status = "error";
            }
          }
        }
        await chrome.storage.local.set({ prompts });
      }
      if (apiRequestCount > 0) {
        console.log(`[Veo3] \uBE44\uB514\uC624 API \uC751\uB2F5 \uB300\uAE30 \uC911... (${apiRequestCount}\uAC1C)`);
        await waitForApiResponses(apiRequestCount);
        console.log(`[Veo3] \uBE44\uB514\uC624 \uBC30\uCE58 API \uC751\uB2F5 \uC644\uB8CC (${apiResponseCount}\uAC1C \uC218\uC2E0)`);
      }
      if (apiRequestCount > 0 && apiResponseCount === 0) {
        console.log("[Veo3] API \uACB0\uACFC \uC5C6\uC74C, DOM \uAE30\uBC18 fallback");
        await detectAndUpdatePolicyViolations(prompts);
      }
      for (let i = 0; i < batchSize; i++) {
        const safeIdx = currentIndex + i;
        if (prompts[safeIdx] && prompts[safeIdx].status === "running") {
          console.log(`[Veo3] \uD504\uB86C\uD504\uD2B8 ${safeIdx + 1}: API \uC751\uB2F5 \uC5C6\uC74C - error \uCC98\uB9AC`);
          prompts[safeIdx].status = "error";
        }
      }
      await chrome.storage.local.set({ prompts });
      if (allMediaUrls.size > 0) {
        for (let i = 0; i < batchSize; i++) {
          const idx = currentIndex + i;
          const urls = allMediaUrls.get(idx);
          if (!urls || urls.length === 0) continue;
          const promptNumber = idx + 1;
          for (let j = 0; j < urls.length; j++) {
            const subIndex = urls.length > 1 ? j + 1 : void 0;
            const filename = generateFilename(promptNumber, "mp4", subIndex);
            console.log(`[Veo3] \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC: ${filename}`);
            chrome.runtime.sendMessage({ type: "DOWNLOAD_VIDEO", url: urls[j], filename });
            await controller.delay(500);
          }
        }
      } else {
        await downloadCompletedVideosInOrder(currentIndex, batchSize, settings.videoOutputCount);
      }
      await chrome.storage.local.set({ currentIndex: currentIndex + batchSize });
    }
    currentPrompts = null;
  }
  async function processI2VQueue(settings, i2vMode) {
    await controller.applySettings(settings);
    while (!shouldStop) {
      const storage = await chrome.storage.local.get(["prompts", "currentIndex", "status"]);
      const prompts = storage.prompts;
      const currentIndex = storage.currentIndex || 0;
      const status = storage.status;
      if (status !== "running" || !prompts || !Array.isArray(prompts) || currentIndex >= prompts.length) {
        console.log("[Veo3] I2V \uB300\uAE30\uC5F4 \uCC98\uB9AC \uC644\uB8CC");
        await chrome.storage.local.set({ status: "idle" });
        break;
      }
      currentPrompts = prompts;
      const batchSize = Math.min(5, prompts.length - currentIndex);
      console.log(`[Veo3] I2V \uBC30\uCE58 \uCC98\uB9AC: ${currentIndex + 1}~${currentIndex + batchSize}/${prompts.length} (\uBAA8\uB4DC: ${i2vMode})`);
      resetApiBatch();
      let apiRequestCount = 0;
      for (let i = 0; i < batchSize && !shouldStop; i++) {
        const idx = currentIndex + i;
        const item = prompts[idx];
        prompts[idx].status = "running";
        await chrome.storage.local.set({ prompts, currentIndex: idx });
        let retries = 0;
        let success = false;
        while (!success && retries <= (settings.retryOnFail ? settings.maxRetries : 0)) {
          try {
            if (retries > 0) {
              console.log(`[Veo3] I2V \uC7AC\uC2DC\uB3C4 ${retries}/${settings.maxRetries}: ${item.text}`);
            }
            const thisSeq = ++expectedSeq;
            pendingBySeq.set(thisSeq, idx);
            if (i2vMode === "ingredients") {
              const ingredientDataUrls = await requestIngredientData(idx);
              if (ingredientDataUrls.length > 0) {
                console.log(`[Veo3] Ingredients \uBAA8\uB4DC: \uD504\uB86C\uD504\uD2B8 ${idx + 1}, \uC7AC\uB8CC ${ingredientDataUrls.length}\uAC1C`);
                const uploadSuccess = await controller.uploadIngredientImages(ingredientDataUrls);
                if (!uploadSuccess) throw new Error("\uC7AC\uB8CC \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC2E4\uD328");
                await controller.delay(1e3);
              }
            } else {
              const imageDataUrl = await requestImageData(idx);
              if (imageDataUrl) {
                const uploadSuccess = await controller.uploadStartFrameImage(imageDataUrl);
                if (!uploadSuccess) throw new Error("\uC2DC\uC791 \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC2E4\uD328");
                await controller.delay(1e3);
              }
              if (i2vMode === "start-end") {
                const endImageDataUrl = await requestImageData(idx, "endImageFile");
                if (endImageDataUrl) {
                  const endUploadSuccess = await controller.uploadEndFrameImage(endImageDataUrl);
                  if (!endUploadSuccess) throw new Error("\uB05D \uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC2E4\uD328");
                  await controller.delay(1e3);
                }
              }
            }
            if (item.text && item.text.trim().length > 0) {
              await controller.typePrompt(item.text);
              await controller.delay(500);
            }
            await controller.clickCreate();
            const waitTime = getRandomWaitTime(settings.waitTimeMin, settings.waitTimeMax);
            console.log(`[Veo3] I2V ${idx + 1}\uBC88 \uC644\uB8CC, \uB300\uAE30: ${waitTime / 1e3}\uCD08 [seq=${thisSeq}]`);
            await controller.delay(waitTime);
            success = true;
            apiRequestCount++;
          } catch (error) {
            console.error(`[Veo3] I2V \uC5D0\uB7EC:`, error);
            pendingBySeq.delete(expectedSeq);
            expectedSeq--;
            retries++;
            if (retries > (settings.retryOnFail ? settings.maxRetries : 0)) {
              prompts[idx].status = "error";
            }
          }
        }
        await chrome.storage.local.set({ prompts });
      }
      if (apiRequestCount > 0) {
        console.log(`[Veo3] I2V API \uC751\uB2F5 \uB300\uAE30 \uC911... (${apiRequestCount}\uAC1C)`);
        await waitForApiResponses(apiRequestCount);
        console.log(`[Veo3] I2V \uBC30\uCE58 API \uC751\uB2F5 \uC644\uB8CC (${apiResponseCount}\uAC1C \uC218\uC2E0)`);
      }
      if (apiRequestCount > 0 && apiResponseCount === 0) {
        console.log("[Veo3] API \uACB0\uACFC \uC5C6\uC74C, DOM \uAE30\uBC18 fallback");
        await detectAndUpdatePolicyViolations(prompts);
      }
      for (let i = 0; i < batchSize; i++) {
        const safeIdx = currentIndex + i;
        if (prompts[safeIdx] && prompts[safeIdx].status === "running") {
          console.log(`[Veo3] I2V \uD504\uB86C\uD504\uD2B8 ${safeIdx + 1}: API \uC751\uB2F5 \uC5C6\uC74C - error \uCC98\uB9AC`);
          prompts[safeIdx].status = "error";
        }
      }
      await chrome.storage.local.set({ prompts });
      if (allMediaUrls.size > 0) {
        for (let i = 0; i < batchSize; i++) {
          const idx = currentIndex + i;
          const urls = allMediaUrls.get(idx);
          if (!urls || urls.length === 0) continue;
          const promptNumber = idx + 1;
          for (let j = 0; j < urls.length; j++) {
            const subIndex = urls.length > 1 ? j + 1 : void 0;
            const filename = generateFilename(promptNumber, "mp4", subIndex);
            console.log(`[Veo3] I2V \uB2E4\uC6B4\uB85C\uB4DC: ${filename}`);
            chrome.runtime.sendMessage({ type: "DOWNLOAD_VIDEO", url: urls[j], filename });
            await controller.delay(500);
          }
        }
      } else {
        await downloadCompletedVideosInOrder(currentIndex, batchSize, settings.videoOutputCount);
      }
      await chrome.storage.local.set({ currentIndex: currentIndex + batchSize });
    }
    currentPrompts = null;
  }
  async function processI2IQueue(settings) {
    await controller.applyImageSettings({
      imageModel: settings.imageModel,
      imageAspectRatio: settings.imageAspectRatio,
      outputCount: settings.outputCount
    });
    while (!shouldStop) {
      const storage = await chrome.storage.local.get(["prompts", "currentIndex", "status"]);
      const prompts = storage.prompts;
      const currentIndex = storage.currentIndex || 0;
      const status = storage.status;
      if (status !== "running" || !prompts || !Array.isArray(prompts) || currentIndex >= prompts.length) {
        console.log("[Veo3] I2I \uB300\uAE30\uC5F4 \uCC98\uB9AC \uC644\uB8CC");
        await chrome.storage.local.set({ status: "idle" });
        break;
      }
      currentPrompts = prompts;
      const idx = currentIndex;
      const item = prompts[idx];
      console.log(`[Veo3] I2I \uCC98\uB9AC: ${idx + 1}/${prompts.length}`);
      prompts[idx].status = "running";
      await chrome.storage.local.set({ prompts, currentIndex: idx });
      resetApiBatch();
      let submitted = false;
      let retries = 0;
      let success = false;
      while (!success && retries <= (settings.retryOnFail ? settings.maxRetries : 0)) {
        try {
          if (retries > 0) {
            console.log(`[Veo3] I2I \uC7AC\uC2DC\uB3C4 ${retries}/${settings.maxRetries}: ${item.text}`);
          }
          const thisSeq = ++expectedSeq;
          pendingBySeq.set(thisSeq, idx);
          const imageDataUrl = await requestImageData(idx);
          if (imageDataUrl) {
            const uploadSuccess = await controller.uploadStartFrameImage(imageDataUrl);
            if (!uploadSuccess) throw new Error("\uC774\uBBF8\uC9C0 \uC5C5\uB85C\uB4DC \uC2E4\uD328");
            await controller.delay(1e3);
          }
          if (item.text && item.text.trim().length > 0) {
            await controller.typeImagePrompt(item.text);
            await controller.delay(500);
          }
          await controller.clickCreate();
          success = true;
          submitted = true;
        } catch (error) {
          console.error(`[Veo3] I2I \uC5D0\uB7EC:`, error);
          pendingBySeq.delete(expectedSeq);
          expectedSeq--;
          retries++;
          if (retries > (settings.retryOnFail ? settings.maxRetries : 0)) {
            prompts[idx].status = "error";
          }
        }
      }
      await chrome.storage.local.set({ prompts });
      if (submitted) {
        console.log(`[Veo3] I2I ${idx + 1}\uBC88 API \uC751\uB2F5 \uB300\uAE30 \uC911...`);
        await waitForApiResponses(1);
        if (apiResponseCount === 0) {
          console.log("[Veo3] API \uACB0\uACFC \uC5C6\uC74C, DOM \uAE30\uBC18 fallback");
          await detectAndUpdatePolicyViolations(prompts);
        }
        if (prompts[idx] && prompts[idx].status === "running") {
          console.log(`[Veo3] I2I \uD504\uB86C\uD504\uD2B8 ${idx + 1}: API \uC751\uB2F5 \uC5C6\uC74C - error \uCC98\uB9AC`);
          prompts[idx].status = "error";
          await chrome.storage.local.set({ prompts });
        }
        const urls = allMediaUrls.get(idx);
        if (urls && urls.length > 0) {
          const promptNumber = idx + 1;
          for (let j = 0; j < urls.length; j++) {
            const subIndex = urls.length > 1 ? j + 1 : void 0;
            const filename = generateFilename(promptNumber, "png", subIndex);
            console.log(`[Veo3] I2I \uB2E4\uC6B4\uB85C\uB4DC: ${filename}`);
            chrome.runtime.sendMessage({ type: "DOWNLOAD_IMAGE", url: urls[j], filename });
            await controller.delay(500);
          }
        } else {
          await downloadCompletedImagesInOrder(idx, 1, settings.outputCount);
        }
      }
      const waitTime = getRandomWaitTime(settings.waitTimeMin, settings.waitTimeMax);
      console.log(`[Veo3] I2I \uB2E4\uC74C \uB300\uAE30: ${waitTime / 1e3}\uCD08`);
      await controller.delay(waitTime);
      await chrome.storage.local.set({ currentIndex: idx + 1 });
    }
    currentPrompts = null;
  }
  async function processImageQueue(settings) {
    await controller.applyImageSettings({
      imageModel: settings.imageModel,
      imageAspectRatio: settings.imageAspectRatio,
      outputCount: settings.outputCount
    });
    const storage = await chrome.storage.local.get(["prompts", "status"]);
    const prompts = storage.prompts;
    const status = storage.status;
    if (status !== "running" || !prompts || !Array.isArray(prompts) || prompts.length === 0) {
      console.log("[Veo3] \uC774\uBBF8\uC9C0 \uB300\uAE30\uC5F4\uC774 \uBE44\uC5B4\uC788\uC74C");
      await chrome.storage.local.set({ status: "idle" });
      return;
    }
    currentPrompts = prompts;
    const totalPrompts = prompts.length;
    const BATCH_SIZE = 5;
    console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uC804\uCCB4 \uCC98\uB9AC \uC2DC\uC791: ${totalPrompts}\uAC1C \uD504\uB86C\uD504\uD2B8 (${BATCH_SIZE}\uAC1C\uC529 \uBC30\uCE58)`);
    allMediaUrls.clear();
    let currentBatchStart = 0;
    while (currentBatchStart < totalPrompts && !shouldStop) {
      const batchEnd = Math.min(currentBatchStart + BATCH_SIZE, totalPrompts);
      console.log(`[Veo3] \uBC30\uCE58 ${Math.floor(currentBatchStart / BATCH_SIZE) + 1}: \uD504\uB86C\uD504\uD2B8 ${currentBatchStart + 1}~${batchEnd}/${totalPrompts}`);
      resetApiBatch(false);
      let apiRequestCount = 0;
      for (let idx = currentBatchStart; idx < batchEnd && !shouldStop; idx++) {
        const item = prompts[idx];
        prompts[idx].status = "running";
        await chrome.storage.local.set({ prompts, currentIndex: idx });
        let retries = 0;
        let success = false;
        while (!success && retries <= (settings.retryOnFail ? settings.maxRetries : 0)) {
          try {
            if (retries > 0) {
              console.log(`[Veo3] \uC7AC\uC2DC\uB3C4 ${retries}/${settings.maxRetries}: ${item.text}`);
            }
            console.log(`[Veo3] \uD504\uB86C\uD504\uD2B8 ${idx + 1}/${totalPrompts} \uC0DD\uC131 \uC694\uCCAD: ${item.text.substring(0, 30)}...`);
            const thisSeq = ++expectedSeq;
            pendingBySeq.set(thisSeq, idx);
            await controller.typeImagePrompt(item.text);
            await controller.delay(500);
            await controller.clickCreate();
            const waitTime = getRandomWaitTime(settings.waitTimeMin, settings.waitTimeMax);
            console.log(`[Veo3] \uB300\uAE30: ${waitTime / 1e3}\uCD08 [seq=${thisSeq}]`);
            await controller.delay(waitTime);
            success = true;
            apiRequestCount++;
          } catch (error) {
            console.error(`[Veo3] \uC5D0\uB7EC:`, error);
            pendingBySeq.delete(expectedSeq);
            expectedSeq--;
            retries++;
            if (retries > (settings.retryOnFail ? settings.maxRetries : 0)) {
              prompts[idx].status = "error";
            }
          }
        }
        await chrome.storage.local.set({ prompts });
      }
      if (apiRequestCount > 0) {
        console.log(`[Veo3] API \uC751\uB2F5 \uC644\uB8CC \uB300\uAE30 \uC911... (${apiRequestCount}\uAC1C)`);
        await waitForApiResponses(apiRequestCount);
        console.log(`[Veo3] \uBC30\uCE58 API \uC751\uB2F5 \uC644\uB8CC (${apiResponseCount}\uAC1C \uC218\uC2E0)`);
      }
      if (apiRequestCount > 0 && apiResponseCount === 0) {
        console.log("[Veo3] API \uACB0\uACFC \uC5C6\uC74C, DOM \uAE30\uBC18 fallback");
        await detectAndUpdatePolicyViolations(prompts, currentBatchStart, batchEnd);
      }
      for (let safeIdx = currentBatchStart; safeIdx < batchEnd; safeIdx++) {
        if (prompts[safeIdx] && prompts[safeIdx].status === "running") {
          console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uD504\uB86C\uD504\uD2B8 ${safeIdx + 1}: API \uC751\uB2F5 \uC5C6\uC74C - error \uCC98\uB9AC`);
          prompts[safeIdx].status = "error";
        }
      }
      await chrome.storage.local.set({ prompts });
      currentBatchStart = batchEnd;
    }
    if (shouldStop) {
      console.log("[Veo3] \uC0AC\uC6A9\uC790\uC5D0 \uC758\uD574 \uC911\uB2E8\uB428");
      await chrome.storage.local.set({ status: "idle" });
      return;
    }
    const totalSuccessCount = prompts.filter((p) => p.status === "done").length;
    console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791 (${totalSuccessCount}\uAC1C \uC131\uACF5, API URL \uC0AC\uC6A9)`);
    if (allMediaUrls.size > 0) {
      for (let i = 0; i < totalPrompts; i++) {
        const urls = allMediaUrls.get(i);
        if (!urls || urls.length === 0) continue;
        const promptNumber = i + 1;
        for (let j = 0; j < urls.length; j++) {
          const subIndex = urls.length > 1 ? j + 1 : void 0;
          const filename = generateFilename(promptNumber, "png", subIndex);
          console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC: ${filename}`);
          chrome.runtime.sendMessage({
            type: "DOWNLOAD_IMAGE",
            url: urls[j],
            filename
          });
          await controller.delay(500);
        }
      }
    } else {
      console.log("[Veo3] API URL \uC5C6\uC74C, DOM \uAE30\uBC18 fallback \uB2E4\uC6B4\uB85C\uB4DC");
      await downloadAllImagesInOrder(prompts, settings.outputCount);
    }
    await chrome.storage.local.set({ status: "idle", currentIndex: totalPrompts });
    currentPrompts = null;
    console.log("[Veo3] \uC774\uBBF8\uC9C0 \uB300\uAE30\uC5F4 \uCC98\uB9AC \uC644\uB8CC");
  }
  async function downloadCompletedVideosInOrder(startIndex, count, videoOutputCount = 1) {
    console.log(`[Veo3] ${count}\uAC1C \uD504\uB86C\uD504\uD2B8 \xD7 ${videoOutputCount}\uAC1C \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791 (\uC2DC\uC791 \uC778\uB371\uC2A4: ${startIndex})`);
    const storage = await chrome.storage.local.get(["prompts"]);
    const prompts = storage.prompts;
    if (!prompts || !Array.isArray(prompts)) {
      console.error("[Veo3] prompts\uAC00 \uC5C6\uAC70\uB098 \uBC30\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4:", prompts);
      return;
    }
    const batchPrompts = prompts.slice(startIndex, startIndex + count);
    const successCount = batchPrompts.filter((p) => p.status === "done").length;
    const totalVideos = successCount * videoOutputCount;
    const downloadUrls = await controller.getVideoDownloadUrlsInOrder(totalVideos);
    console.log(`[Veo3] \uCD94\uCD9C\uB41C \uBE44\uB514\uC624 URL \uAC1C\uC218: ${downloadUrls.length}`);
    let urlIndex = 0;
    for (let i = count - 1; i >= 0; i--) {
      const prompt = batchPrompts[i];
      const promptNumber = startIndex + i + 1;
      if (prompt.status === "done") {
        for (let j = 0; j < videoOutputCount; j++) {
          if (urlIndex < downloadUrls.length) {
            const subIndex = videoOutputCount > 1 ? j + 1 : void 0;
            const filename = generateFilename(promptNumber, "mp4", subIndex);
            chrome.runtime.sendMessage({
              type: "DOWNLOAD_VIDEO",
              url: downloadUrls[urlIndex],
              filename
            });
            console.log(`[Veo3] \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD: ${filename}`);
            urlIndex++;
            await controller.delay(500);
          }
        }
      } else {
        console.log(`[Veo3] \uD504\uB86C\uD504\uD2B8 ${promptNumber} \uAC74\uB108\uB700 (status: ${prompt.status})`);
      }
    }
  }
  async function downloadAllImagesInOrder(prompts, outputCount) {
    const successCount = prompts.filter((p) => p.status === "done").length;
    const totalSuccessImages = successCount * outputCount;
    console.log(`[Veo3] \uC804\uCCB4 \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791: ${successCount}\uAC1C \uC131\uACF5 \uD504\uB86C\uD504\uD2B8, ${totalSuccessImages}\uAC1C \uC774\uBBF8\uC9C0`);
    const downloadUrls = await controller.getImageDownloadUrlsInOrder(totalSuccessImages);
    console.log(`[Veo3] \uCD94\uCD9C\uB41C URL \uAC1C\uC218: ${downloadUrls.length}`);
    if (downloadUrls.length === 0) {
      console.warn("[Veo3] URL\uC744 \uCD94\uCD9C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
      return;
    }
    let urlIndex = 0;
    for (let i = prompts.length - 1; i >= 0; i--) {
      const prompt = prompts[i];
      const promptNumber = i + 1;
      if (prompt.status === "done") {
        for (let j = 0; j < outputCount; j++) {
          if (urlIndex < downloadUrls.length) {
            const subIndex = outputCount > 1 ? j + 1 : void 0;
            const filename = generateFilename(promptNumber, "png", subIndex);
            console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD: ${filename} (URL ${urlIndex + 1}/${downloadUrls.length})`);
            chrome.runtime.sendMessage({
              type: "DOWNLOAD_IMAGE",
              url: downloadUrls[urlIndex],
              filename
            });
            urlIndex++;
            await controller.delay(500);
          }
        }
      } else {
        console.log(`[Veo3] \uD504\uB86C\uD504\uD2B8 ${promptNumber} \uAC74\uB108\uB700 (status: ${prompt.status})`);
      }
    }
    console.log(`[Veo3] \uC804\uCCB4 ${urlIndex}\uAC1C \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD \uC644\uB8CC`);
  }
  async function downloadAllExistingImages(outputCount = 1) {
    console.log(`[Veo3] \uAE30\uC874 \uC774\uBBF8\uC9C0 \uC804\uCCB4 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791 (\uCD9C\uB825 \uAC1C\uC218: ${outputCount})`);
    const downloadUrls = await controller.getImageDownloadUrlsInOrder(1e3);
    console.log(`[Veo3] \uCD94\uCD9C\uB41C URL \uAC1C\uC218: ${downloadUrls.length}`);
    if (downloadUrls.length === 0) {
      console.warn("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC\uD560 \uC774\uBBF8\uC9C0\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      return 0;
    }
    const storage = await chrome.storage.local.get(["prompts"]);
    const prompts = storage.prompts;
    if (prompts && Array.isArray(prompts) && prompts.length > 0) {
      console.log(`[Veo3] \uD050 \uC815\uBCF4 \uBC1C\uACAC - \uD050 \uAE30\uBC18 \uBC88\uD638 \uB9E4\uAE30\uAE30 \uC0AC\uC6A9 (\uD504\uB86C\uD504\uD2B8 ${prompts.length}\uAC1C)`);
      let urlIndex = 0;
      for (let i = prompts.length - 1; i >= 0; i--) {
        if (prompts[i].status === "done") {
          const promptNumber = i + 1;
          for (let j = 0; j < outputCount; j++) {
            if (urlIndex < downloadUrls.length) {
              const subIndex = outputCount > 1 ? j + 1 : void 0;
              const filename = generateFilename(promptNumber, "png", subIndex);
              console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD: ${filename} (URL ${urlIndex + 1}/${downloadUrls.length})`);
              chrome.runtime.sendMessage({
                type: "DOWNLOAD_IMAGE",
                url: downloadUrls[urlIndex],
                filename
              });
              urlIndex++;
              await controller.delay(500);
            }
          }
        } else {
          console.log(`[Veo3] \uD504\uB86C\uD504\uD2B8 ${i + 1} \uAC74\uB108\uB700 (status: ${prompts[i].status})`);
        }
      }
      console.log(`[Veo3] \uC804\uCCB4 ${urlIndex}\uAC1C \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD \uC644\uB8CC (\uD050 \uAE30\uBC18)`);
      return urlIndex;
    }
    console.log("[Veo3] \uD050 \uC815\uBCF4 \uC5C6\uC74C - \uC21C\uCC28 \uBC88\uD638 \uC0AC\uC6A9");
    const totalGroups = Math.ceil(downloadUrls.length / outputCount);
    for (let urlIndex = 0; urlIndex < downloadUrls.length; urlIndex++) {
      const groupIndex = Math.floor(urlIndex / outputCount);
      const promptIndex = totalGroups - groupIndex;
      const subIndex = outputCount > 1 ? urlIndex % outputCount + 1 : void 0;
      const filename = generateFilename(promptIndex, "png", subIndex);
      console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD: ${filename} (URL ${urlIndex + 1}/${downloadUrls.length})`);
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_IMAGE",
        url: downloadUrls[urlIndex],
        filename
      });
      await controller.delay(500);
    }
    console.log(`[Veo3] \uC804\uCCB4 ${downloadUrls.length}\uAC1C \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD \uC644\uB8CC`);
    return downloadUrls.length;
  }
  async function downloadAllExistingVideos() {
    console.log("[Veo3] \uAE30\uC874 \uBE44\uB514\uC624 \uC804\uCCB4 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791");
    const downloadUrls = await controller.getVideoDownloadUrlsInOrder(1e3);
    console.log(`[Veo3] \uCD94\uCD9C\uB41C \uBE44\uB514\uC624 URL \uAC1C\uC218: ${downloadUrls.length}`);
    if (downloadUrls.length === 0) {
      console.warn("[Veo3] \uB2E4\uC6B4\uB85C\uB4DC\uD560 \uBE44\uB514\uC624\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      return 0;
    }
    const storage = await chrome.storage.local.get(["prompts"]);
    const prompts = storage.prompts;
    if (prompts && Array.isArray(prompts) && prompts.length > 0) {
      console.log(`[Veo3] \uD050 \uC815\uBCF4 \uBC1C\uACAC - \uD050 \uAE30\uBC18 \uBC88\uD638 \uB9E4\uAE30\uAE30 \uC0AC\uC6A9 (\uD504\uB86C\uD504\uD2B8 ${prompts.length}\uAC1C)`);
      let urlIndex = 0;
      for (let i = prompts.length - 1; i >= 0; i--) {
        if (prompts[i].status === "done") {
          const promptNumber = i + 1;
          if (urlIndex < downloadUrls.length) {
            const filename = generateFilename(promptNumber, "mp4");
            console.log(`[Veo3] \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD: ${filename} (URL ${urlIndex + 1}/${downloadUrls.length})`);
            chrome.runtime.sendMessage({
              type: "DOWNLOAD_VIDEO",
              url: downloadUrls[urlIndex],
              filename
            });
            urlIndex++;
            await controller.delay(500);
          }
        } else {
          console.log(`[Veo3] \uD504\uB86C\uD504\uD2B8 ${i + 1} \uAC74\uB108\uB700 (status: ${prompts[i].status})`);
        }
      }
      console.log(`[Veo3] \uC804\uCCB4 ${urlIndex}\uAC1C \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD \uC644\uB8CC (\uD050 \uAE30\uBC18)`);
      return urlIndex;
    }
    console.log("[Veo3] \uD050 \uC815\uBCF4 \uC5C6\uC74C - \uC21C\uCC28 \uBC88\uD638 \uC0AC\uC6A9");
    const totalCount = downloadUrls.length;
    for (let urlIndex = 0; urlIndex < downloadUrls.length; urlIndex++) {
      const promptIndex = totalCount - urlIndex;
      const filename = generateFilename(promptIndex, "mp4");
      console.log(`[Veo3] \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD: ${filename} (URL ${urlIndex + 1}/${downloadUrls.length})`);
      chrome.runtime.sendMessage({
        type: "DOWNLOAD_VIDEO",
        url: downloadUrls[urlIndex],
        filename
      });
      await controller.delay(500);
    }
    console.log(`[Veo3] \uC804\uCCB4 ${downloadUrls.length}\uAC1C \uBE44\uB514\uC624 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD \uC644\uB8CC`);
    return downloadUrls.length;
  }
  async function downloadCompletedImagesInOrder(startIndex, promptCount, outputCount) {
    console.log(`[Veo3] \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC2DC\uC791 (\uD504\uB86C\uD504\uD2B8 ${promptCount}\uAC1C \xD7 \uCD9C\uB825 ${outputCount}\uAC1C, \uC2DC\uC791 \uC778\uB371\uC2A4: ${startIndex})`);
    const storage = await chrome.storage.local.get(["prompts"]);
    const prompts = storage.prompts;
    if (!prompts || !Array.isArray(prompts)) {
      console.error("[Veo3] prompts\uAC00 \uC5C6\uAC70\uB098 \uBC30\uC5F4\uC774 \uC544\uB2D9\uB2C8\uB2E4:", prompts);
      return;
    }
    const batchPrompts = prompts.slice(startIndex, startIndex + promptCount);
    const successCount = batchPrompts.filter((p) => p.status === "done").length;
    const totalSuccessImages = successCount * outputCount;
    console.log(`[Veo3] \uC131\uACF5 \uD504\uB86C\uD504\uD2B8: ${successCount}\uAC1C, \uCD1D \uC774\uBBF8\uC9C0: ${totalSuccessImages}\uAC1C`);
    const downloadUrls = await controller.getImageDownloadUrlsInOrder(totalSuccessImages);
    console.log(`[Veo3] \uCD94\uCD9C\uB41C URL \uAC1C\uC218: ${downloadUrls.length}`);
    if (downloadUrls.length > 0) {
      console.log(`[Veo3] \uCCAB \uBC88\uC9F8 URL: ${downloadUrls[0].substring(0, 80)}...`);
    } else {
      console.warn("[Veo3] URL\uC744 \uCD94\uCD9C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. DOM\uC5D0\uC11C \uC774\uBBF8\uC9C0\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
    }
    let urlIndex = 0;
    for (let i = 0; i < promptCount; i++) {
      const promptIndex = startIndex + i + 1;
      const prompt = batchPrompts[i];
      if (prompt.status === "done") {
        for (let j = 0; j < outputCount; j++) {
          if (urlIndex < downloadUrls.length) {
            const subIndex = outputCount > 1 ? j + 1 : void 0;
            const filename = generateFilename(promptIndex, "png", subIndex);
            console.log(`[Veo3] \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD: ${filename}, URL: ${downloadUrls[urlIndex].substring(0, 50)}...`);
            chrome.runtime.sendMessage({
              type: "DOWNLOAD_IMAGE",
              url: downloadUrls[urlIndex],
              filename
            });
            urlIndex++;
            await controller.delay(500);
          } else {
            console.warn(`[Veo3] URL \uBD80\uC871: urlIndex=${urlIndex}, downloadUrls.length=${downloadUrls.length}`);
          }
        }
      } else if (prompt.status === "error") {
        console.log(`[Veo3] \uD504\uB86C\uD504\uD2B8 ${promptIndex} \uC2E4\uD328 - \uB2E4\uC6B4\uB85C\uB4DC \uAC74\uB108\uB700`);
      }
    }
    console.log(`[Veo3] ${urlIndex}\uAC1C \uC774\uBBF8\uC9C0 \uB2E4\uC6B4\uB85C\uB4DC \uC694\uCCAD \uC644\uB8CC`);
  }
  console.log("[Veo3] Content script loaded on:", window.location.href);
  if (window.location.href.includes("labs.google") && window.location.href.includes("flow")) {
    console.log("[Veo3] Flow \uD398\uC774\uC9C0 \uAC10\uC9C0\uB428");
  }
})();
