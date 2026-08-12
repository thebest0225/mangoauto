// content/naver.js — 네이버 블로그 글쓰기(SmartEditor ONE) 채우기
//
// 역할: 블로그라이터에서 고른 초안의 제목/본문/이미지를 네이버 글쓰기 화면에 넣는다.
//
// ⚠️ 자동 "발행"은 하지 않는다. 채우기까지만 하고 검토·발행은 사람이 한다.
//    (네이버는 자동 발행 패턴을 계정 제재 사유로 본다. 채우기만 하면 수동 작성과 구분되지 않는다.)
//
// SmartEditor ONE 은 iframe(#mainFrame) 안에서 돈다. 그래서 이 스크립트는
// all_frames:true 로 주입되고, 에디터를 실제로 가진 프레임만 응답한다.
//
// 입력 경로는 3단계로 내려간다 —
//   1) 합성 paste (ClipboardEvent + DataTransfer) — 배너 없음, 서식 유지. 대개 여기서 끝난다.
//   2) execCommand insertHTML / insertText — paste 를 막는 에디터 대응
//   3) CDP Input.insertText (background 가 처리) — 위 둘이 다 막힐 때. 노란 배너가 뜬다.
// 각 단계 후 실제로 글자가 들어갔는지 검증하고, 안 들어갔으면 다음 단계로 내려간다.

(function () {
  'use strict';

  if (window.__mangoNaverLoaded) return;
  window.__mangoNaverLoaded = true;

  const log = (...a) => console.log('[MangoAuto/Naver]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ─── 에디터 요소 찾기 ───
  // 네이버가 클래스명을 바꾸는 일이 있어서 한 셀렉터에 의존하지 않는다.
  // contenteditable 을 전부 긁어서 "제목 영역 안에 있는지"로 분류한다.

  const TITLE_HINT = [
    '.se-documentTitle',
    '.se-section-documentTitle',
    '.se-title-text',
    '[class*="documentTitle"]',
  ].join(',');

  function editables() {
    return Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
  }

  function findTitle() {
    for (const el of editables()) {
      if (el.closest(TITLE_HINT)) return el;
    }
    // 폴백: 제목만 별도 input 인 구버전 에디터
    return document.querySelector('input#subject, input[name="subject"]') || null;
  }

  function findBody() {
    const title = findTitle();
    for (const el of editables()) {
      if (el === title) continue;
      if (el.closest(TITLE_HINT)) continue;
      return el;
    }
    return null;
  }

  function hasEditor() {
    return !!(findTitle() || findBody());
  }

  // ─── 텍스트 양 측정 — 입력 성공 여부 판정에 쓴다 ───
  const textLen = (el) => (el ? (el.innerText || el.textContent || el.value || '').trim().length : 0);

  // ─── 포커스 + 커서를 끝으로 ───
  function focusEnd(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      return true;
    }
    el.focus();
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (_) {}
    return document.activeElement === el || el.contains(document.activeElement);
  }

  function selectAllIn(el) {
    if (!focusEnd(el)) return false;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') { el.select(); return true; }
    try {
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return true;
    } catch (_) { return false; }
  }

  // ─── 1단계: 합성 paste ───
  // Chrome 은 ClipboardEvent 생성자에 clipboardData 를 넘길 수 있다.
  // 에디터가 e.clipboardData 를 읽는 구조면 이게 진짜 붙여넣기와 같게 동작한다.
  function tryPaste(el, { html, text }) {
    try {
      const dt = new DataTransfer();
      if (text) dt.setData('text/plain', text);
      if (html) dt.setData('text/html', html);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      // beforeinput 을 먼저 흘려주는 에디터가 있다
      el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromPaste', bubbles: true, cancelable: true }));
      const notCancelled = el.dispatchEvent(ev);
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
      return notCancelled !== null;
    } catch (e) {
      log('paste 합성 실패', e);
      return false;
    }
  }

  // ─── 2단계: execCommand ───
  function tryExec(el, { html, text }) {
    if (!focusEnd(el)) return false;
    let ok = false;
    try {
      if (html) ok = document.execCommand('insertHTML', false, html);
      if (!ok && text) ok = document.execCommand('insertText', false, text);
    } catch (_) {}
    if (ok) el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
    return ok;
  }

  // ─── input/textarea 직접 대입 (구버전 제목 필드) ───
  function trySetValue(el, text) {
    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
    const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value === text;
  }

  // ─── 한 영역 채우기 — 3단계 중 되는 것까지 ───
  async function fillOne(el, payload, label) {
    if (!el) return { ok: false, how: 'none', reason: `${label} 영역을 못 찾음` };

    const before = textLen(el);

    if (trySetValue(el, payload.text)) {
      return { ok: true, how: 'value', label };
    }

    tryPaste(el, payload);
    await sleep(220);
    if (textLen(el) > before) return { ok: true, how: 'paste', label };

    tryExec(el, payload);
    await sleep(220);
    if (textLen(el) > before) return { ok: true, how: 'exec', label };

    // 여기까지 실패면 CDP 차례. 포커스는 남겨둔다 — background 가 focused element 로 쏜다.
    focusEnd(el);
    return { ok: false, how: 'needCdp', label, reason: `${label}: paste/execCommand 둘 다 막힘` };
  }

  // ─── 이미지: 숨은 file input 에 DataTransfer 로 밀어넣기 ───
  async function attachImages(files) {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) return { ok: false, reason: 'file input 을 못 찾음 (사진 버튼을 한 번 눌러 업로더를 띄운 뒤 다시 시도)' };
    // 이미지 받는 input 우선
    const target = inputs.find((i) => (i.accept || '').includes('image')) || inputs[0];
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      target.files = dt.files;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, count: files.length };
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
  }

  // ─── 진단: 실제 DOM 구조를 뽑아준다 ───
  // 네이버가 에디터를 바꾸면 셀렉터가 어긋난다. 그때 이 출력을 받아서 고친다.
  function diagnose() {
    const eds = editables();
    return {
      url: location.href,
      frame: window === window.top ? 'top' : 'iframe',
      frameCount: document.querySelectorAll('iframe').length,
      editableCount: eds.length,
      editables: eds.slice(0, 8).map((el) => ({
        tag: el.tagName,
        cls: (el.className || '').toString().slice(0, 140),
        id: el.id || '',
        isTitle: !!el.closest(TITLE_HINT),
        chars: textLen(el),
        path: (() => {
          const p = [];
          let n = el;
          for (let i = 0; i < 5 && n && n.tagName; i++) {
            p.unshift(n.tagName.toLowerCase() + (n.className ? '.' + String(n.className).trim().split(/\s+/)[0] : ''));
            n = n.parentElement;
          }
          return p.join(' > ');
        })(),
      })),
      fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map((i) => ({
        accept: i.accept || '', id: i.id || '', cls: String(i.className || '').slice(0, 80),
      })),
      titleFound: !!findTitle(),
      bodyFound: !!findBody(),
    };
  }

  // ─── 메시지 처리 ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !String(msg.type || '').startsWith('NAVER_')) return;

    // 에디터 없는 프레임은 조용히 빠진다 — all_frames 라서 여러 프레임이 응답하면 꼬인다.
    if (msg.type !== 'NAVER_PING' && !hasEditor()) return;

    (async () => {
      try {
        switch (msg.type) {
          case 'NAVER_PING':
            sendResponse({ ok: true, hasEditor: hasEditor(), frame: window === window.top ? 'top' : 'iframe' });
            return;

          case 'NAVER_DIAGNOSE':
            sendResponse({ ok: true, info: diagnose() });
            return;

          case 'NAVER_FILL': {
            const results = [];
            const titleEl = findTitle();
            const bodyEl = findBody();

            if (msg.title) {
              // 제목은 덮어쓴다 (초안 제목이 정답이므로)
              if (titleEl && textLen(titleEl) > 0) selectAllIn(titleEl);
              results.push(await fillOne(titleEl, { text: msg.title, html: null }, '제목'));
              await sleep(300);
            }
            if (msg.bodyText || msg.bodyHtml) {
              results.push(await fillOne(bodyEl, { text: msg.bodyText, html: msg.bodyHtml }, '본문'));
            }

            const need = results.filter((r) => !r.ok);
            sendResponse({
              ok: need.length === 0,
              results,
              needCdp: need.some((r) => r.how === 'needCdp'),
              // CDP 로 넘길 때 background 가 어느 영역을 채워야 하는지 알아야 한다
              cdpPending: need.filter((r) => r.how === 'needCdp').map((r) => r.label),
            });
            return;
          }

          case 'NAVER_FOCUS': {
            // CDP 입력 직전에 포커스를 잡아준다
            const el = msg.area === '제목' ? findTitle() : findBody();
            if (el && textLen(el) > 0 && msg.replace) selectAllIn(el);
            else focusEnd(el);
            sendResponse({ ok: !!el, focused: !!el });
            return;
          }

          case 'NAVER_ATTACH_IMAGES': {
            const files = [];
            for (const im of msg.images || []) {
              const bin = Uint8Array.from(atob(im.b64), (c) => c.charCodeAt(0));
              files.push(new File([bin], im.name, { type: im.mime || 'image/jpeg' }));
            }
            sendResponse(await attachImages(files));
            return;
          }

          case 'NAVER_STATUS':
            sendResponse({
              ok: true,
              titleChars: textLen(findTitle()),
              bodyChars: textLen(findBody()),
            });
            return;

          default:
            sendResponse({ ok: false, error: 'unknown ' + msg.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e.message || e) });
      }
    })();

    return true; // async
  });

  log('준비됨', window === window.top ? '(top)' : '(iframe)', 'editor=', hasEditor());
})();
