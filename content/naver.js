// content/naver.js — 네이버 블로그 글쓰기(SmartEditor ONE) 채우기
//
// 역할: 블로그라이터에서 고른 초안의 제목/본문/이미지를 네이버 글쓰기 화면에 넣는다.
//
// ⚠️ 자동 "발행"은 하지 않는다. 채우기까지만 하고 검토·발행은 사람이 한다.
//    (네이버는 자동 발행 패턴을 계정 제재 사유로 본다. 채우기만 하면 수동 작성과 구분되지 않는다.)
//
// ★실제로 겪어서 알게 된 것 (2026-08-12, 3차 시도까지)
//  · 제목과 본문이 서로 다른 iframe 에 있다. 프레임을 하나만 골라 둘 다 찾으면 실패한다.
//    → 모든 프레임에 주입하고, 영역별로 프레임을 따로 확정한다(가장 큰 것이 진짜).
//  · 합성 마우스 이벤트로는 실제 커서가 안 옮겨진다. 제목에 넣은 글자가 에디터가 기억하는
//    본문 위치로 들어갔다. → CDP 로 진짜 클릭을 쏜다.
//  · 합성 paste 와 execCommand('insertHTML') 은 에디터가 막거나 자기 모델로 정규화하면서
//    <strong>·<hr> 을 버린다. → 평문으로 넣고, 굵게는 '그 줄 선택 → 편집 명령' 으로 따로.
//  · 결국 사람이 클릭하고 타이핑하는 것과 같은 경로(CDP)가 가장 확실하다.
//
// 좌표는 반드시 최상위 뷰포트 기준이어야 한다 — viewportRect() 가 frameElement 를 타고
// 올라가며 iframe 오프셋을 더한다 (blog.naver.com 안은 모두 같은 출처).

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

  // ⚠️ 제목이 안 채워졌던 이유: SmartEditor ONE 은 제목과 본문이 하나의 contenteditable
  //    문서 안의 서로 다른 '섹션'이다. 제목 문단 자체에는 contenteditable 이 없어서
  //    contenteditable 목록만 훑으면 제목을 영원히 못 찾는다.
  //    → contenteditable 여부를 따지지 않고 제목 문단을 직접 찾고, 그 안에 커서를 놓는다.
  const TITLE_SEL = [
    '.se-documentTitle .se-text-paragraph',
    '.se-section-documentTitle .se-text-paragraph',
    '[class*="documentTitle"] [class*="text-paragraph"]',
    '[class*="documentTitle"] [class*="textarea"]',
    '.se-title-text',
    '.se-documentTitle',
  ];

  function editables() {
    return Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);
  }

  function findTitle() {
    for (const s of TITLE_SEL) {
      const el = document.querySelector(s);
      if (el && (el.offsetParent !== null || el.getClientRects().length > 0)) return el;
    }
    // 폴백: 제목만 별도 input 인 구버전 에디터
    return document.querySelector('input#subject, input[name="subject"]') || null;
  }

  // 마우스로 실제 클릭한 것처럼 눌러 포커스를 준다. 제목 섹션은 클릭 없이는
  // 커서를 안 받는 경우가 있다.
  function clickInto(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true,
                clientX: Math.round(r.left + Math.min(20, r.width / 2)),
                clientY: Math.round(r.top + r.height / 2) };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }

  function findBody() {
    // 본문 섹션 안의 문단을 먼저 노린다 (제목/본문이 한 문서인 구조에서 본문 자리를 정확히 잡으려고)
    const inBody = document.querySelector(
      '.se-component.se-text:not([class*="documentTitle"]) .se-text-paragraph, ' +
      '.se-section-text .se-text-paragraph'
    );
    if (inBody && (inBody.offsetParent !== null || inBody.getClientRects().length > 0)) return inBody;

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

  // ─── 최상위 뷰포트 기준 좌표 ───
  // 제목과 본문이 서로 다른 iframe 에 있어서, 프레임마다 자기 오프셋을 스스로 더해야
  // CDP 클릭 좌표가 맞는다. blog.naver.com 안은 모두 같은 출처라 frameElement 를 탈 수 있다.
  function viewportRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top, w = window, guard = 0;
    try {
      while (w !== w.parent && w.frameElement && guard++ < 8) {
        const fr = w.frameElement.getBoundingClientRect();
        x += fr.left; y += fr.top;
        w = w.parent;
      }
    } catch (_) { /* 다른 출처면 거기서 멈춘다 */ }
    return { x, y, w: r.width, h: r.height };
  }

  // ─── 편집 문서 전체 컨테이너 ───
  // ⚠️ 굵게가 0개였던 이유. findBody() 는 '첫 문단' 하나를 가리키는데(입력 후 15자),
  //    타이핑한 189줄은 그 문단의 형제로 쌓인다. 첫 문단 안에서만 소제목을 찾으니
  //    당연히 하나도 못 찾았다. → 모든 .se-text-paragraph 를 담는 공통 조상을 쓴다.
  function editorRoot() {
    const ps = document.querySelectorAll('.se-text-paragraph');
    if (ps.length > 1) {
      let root = ps[0].parentElement;
      let guard = 0;
      while (root && guard++ < 12 && root.querySelectorAll('.se-text-paragraph').length < ps.length) {
        root = root.parentElement;
      }
      if (root) return root;
    }
    const b = findBody();
    return (b && b.closest('[contenteditable="true"]')) || document.body;
  }

  // 제목 문단을 제외한 본문 문단들
  function bodyParagraphs() {
    return Array.from(document.querySelectorAll('.se-text-paragraph')).filter((p) => !p.closest(TITLE_HINT));
  }

  // 문단 전체에서 그 한 줄에 해당하는 텍스트 노드를 찾는다
  function findLineNode(text) {
    const target = String(text || '').trim();
    if (!target) return null;
    const walker = document.createTreeWalker(editorRoot(), NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if ((n.nodeValue || '').trim() === target) return n;
    }
    return null;
  }

  const describe = (el) => !el ? '' :
    (el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/)[0] : '')).slice(0, 60);

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

  // ─── 합성 paste ───
  // Chrome 은 ClipboardEvent 생성자에 clipboardData 를 넘길 수 있다.
  // 에디터가 e.clipboardData 를 읽는 구조면 이게 진짜 붙여넣기와 같게 동작한다.
  //
  // ⚠️ text/plain 을 같이 넣으면 에디터가 그쪽을 골라 서식이 다 날아간다(1차 시도에서 겪음).
  //    서식을 살릴 때는 text/html 만 넣는다.
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

    // ⚠️ 성공 판정은 '편집 문서 전체' 길이로 한다.
    //    insertHTML 은 <p> 블록을 넣을 때 대상 문단을 쪼개서 내용이 el 밖으로 나간다.
    //    el 만 재면 '실패'로 보고 다음 방법을 또 실행해 같은 글이 두 번 들어간다.
    const scope = (el.closest && el.closest('[contenteditable="true"]')) || el;
    const before = textLen(scope);

    if (trySetValue(el, payload.text)) {
      return { ok: true, how: 'value', label };
    }

    clickInto(el);
    await sleep(120);
    focusEnd(el);

    // 서식이 있는 경우 순서를 뒤집는다.
    // 1차 시도에서 paste 가 평문으로 먼저 '성공'해버려 서식 경로에 도달하지 못했다.
    // insertHTML 이 contenteditable 에서 서식을 가장 확실히 남긴다.
    const attempts = payload.html
      ? [
          ['insertHTML', () => tryExec(el, { html: payload.html, text: null })],
          ['paste(html)', () => tryPaste(el, { html: payload.html, text: null })],
          ['paste', () => tryPaste(el, payload)],
          ['insertText', () => tryExec(el, { html: null, text: payload.text })],
        ]
      : [
          ['paste', () => tryPaste(el, payload)],
          ['insertText', () => tryExec(el, payload)],
        ];

    for (const [how, run] of attempts) {
      run();
      await sleep(240);
      if (textLen(scope) > before) return { ok: true, how, label };
    }

    // 여기까지 실패면 CDP 차례. 포커스는 남겨둔다 — background 가 focused element 로 쏜다.
    focusEnd(el);
    return { ok: false, how: 'needCdp', label, reason: `${label}: paste/execCommand 둘 다 막힘` };
  }

  // ─── 이미지 넣기 ───
  //
  // ⚠️ 사진 툴바 버튼은 절대 누르지 않는다. 그 버튼은 OS 파일 선택창을 띄우고,
  //    그러면 브라우저가 멈춰서 사람이 직접 닫아야 한다(1차 시도에서 그렇게 됐다).
  //
  // 1순위: 클립보드 붙여넣기. 에디터가 이미지 붙여넣기를 직접 처리해 커서 위치에 넣는다.
  // 2순위: 이미 열려 있는 숨은 file input 에 DataTransfer 로 밀어넣기 (없으면 포기).
  async function attachImages(files) {
    const el = document.activeElement && document.activeElement !== document.body
      ? document.activeElement : (findBody() || document.body);

    // 1순위 — 이미지 붙여넣기
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(1800);
      if (document.querySelectorAll('.se-component.se-image').length > (window.__mangoImgBefore ?? 0)) {
        return { ok: true, how: 'paste', count: files.length };
      }
    } catch (_) {}

    // 2순위 — 이미 있는 file input
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const target = inputs.find((i) => (i.accept || '').includes('image')) || inputs[0];
    if (!target) {
      return { ok: false, reason: '붙여넣기가 막히고 file input 도 없음 (사진은 직접 넣어주세요)' };
    }
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      target.files = dt.files;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, how: 'file-input', count: files.length };
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

    // 에디터 없는 프레임은 조용히 빠진다. 단 PING·DIAGNOSE 는 모든 프레임이 답해야
    // 어느 프레임에 무엇이 있는지 알 수 있다.
    if (msg.type !== 'NAVER_PING' && msg.type !== 'NAVER_DIAGNOSE' && !hasEditor()) return;

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
            const before = document.querySelectorAll('.se-component.se-image').length;
            window.__mangoImgBefore = before;
            const r = await attachImages(files);
            await sleep(2500);   // 업로드·삽입까지 시간이 걸린다
            const after = document.querySelectorAll('.se-component.se-image').length;
            sendResponse({ ...r, before, after, inserted: after - before });
            return;
          }

          case 'NAVER_FILE_INPUT': {
            // 사진 업로더의 숨은 file input 이 있는지, 사진 버튼 좌표는 어디인지.
            const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
            const btn = document.querySelector(
              '.se-toolbar button[class*="image"], .se-image-toolbar-button, ' +
              'button[data-name="image"], button[title*="사진"], [class*="toolbar"] [class*="image"]'
            );
            const v = btn ? viewportRect(btn) : null;
            sendResponse({
              ok: true,
              inputs: inputs.map((i) => ({ accept: i.accept || '', id: i.id || '', cls: String(i.className || '').slice(0, 60) })),
              button: v ? { x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2), hint: describe(btn) } : null,
            });
            return;
          }

          case 'NAVER_DELETE_LINE': {
            // 사진을 넣은 뒤 자리표시 줄을 지운다. 선택해두고 CDP Delete 를 쏘는 방식이라
            // 여기서는 선택만 하고 좌표를 돌려준다.
            const hit = findLineNode(msg.text);
            if (!hit) { sendResponse({ ok: false, error: '그 줄 없음' }); return; }
            try {
              const para = hit.parentElement && hit.parentElement.closest('.se-text-paragraph');
              const r = document.createRange();
              r.selectNodeContents(para || hit);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(r);
              sendResponse({ ok: true });
            } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
            return;
          }

          case 'NAVER_RECT': {
            // 제목/본문 영역의 '최상위 뷰포트' 좌표. CDP 로 진짜 클릭을 쏠 위치다.
            const el = msg.area === '제목' ? findTitle() : findBody();
            if (!el) { sendResponse({ ok: false, error: `${msg.area} 영역 없음` }); return; }
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(150);
            const v = viewportRect(el);
            if (!v.w || !v.h) { sendResponse({ ok: false, error: `${msg.area} 영역 크기 0` }); return; }
            sendResponse({
              ok: true,
              // 왼쪽 끝에 붙여 클릭한다 (가운데를 찍으면 글자 사이에 커서가 낀다)
              x: Math.round(v.x + 12), y: Math.round(v.y + v.h / 2),
              w: Math.round(v.w), h: Math.round(v.h),
              area: Math.round(v.w * v.h),
              chars: textLen(el),
              frame: window === window.top ? 'top' : 'iframe',
              hint: describe(el),
            });
            return;
          }

          case 'NAVER_FORMAT': {
            // ─── 서식 후처리 ───
            // SmartEditor 는 붙여넣은 <strong>·<hr> 을 자기 모델로 정규화하면서 버린다.
            // 그래서 평문으로 먼저 넣고, 여기서 '해당 줄을 선택 → 굵게' 를 실제 편집
            // 명령으로 적용한다. execCommand('bold') 는 브라우저 기본 편집 명령이라
            // 에디터의 붙여넣기 필터를 거치지 않는다.
            const want = new Set((msg.bolds || []).map((s) => s.trim()).filter(Boolean));
            if (!want.size) { sendResponse({ ok: true, applied: 0, missed: [] }); return; }

            const hits = [];
            const walker = document.createTreeWalker(editorRoot(), NodeFilter.SHOW_TEXT, null);
            let n;
            while ((n = walker.nextNode())) {
              const t = (n.nodeValue || '').trim();
              if (t && want.has(t)) hits.push(n);
            }

            let applied = 0;
            const found = new Set();
            for (const node of hits) {
              const t = (node.nodeValue || '').trim();
              try {
                const r = document.createRange();
                r.selectNodeContents(node);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
                document.execCommand('bold');
                if (msg.fontSize) document.execCommand('fontSize', false, String(msg.fontSize));
                // 실제로 굵어졌는지 확인
                const p = node.parentElement;
                if (p && (p.closest('b,strong') || /(^|\s)(700|bold)/i.test(getComputedStyle(p).fontWeight))) {
                  applied++; found.add(t);
                }
              } catch (_) {}
              await sleep(40);
            }
            try { window.getSelection().removeAllRanges(); } catch (_) {}
            sendResponse({
              ok: applied > 0,
              applied,
              total: want.size,
              missed: [...want].filter((t) => !found.has(t)),
            });
            return;
          }

          case 'NAVER_SELECT_LINE': {
            // execCommand('bold') 가 에디터에 막힐 때를 위한 경로.
            // 여기서 그 줄을 '선택' 만 해두면 CDP 가 진짜 Ctrl+B 를 쏜다.
            const target = String(msg.text || '').trim();
            if (!target) { sendResponse({ ok: false, error: '빈 문자열' }); return; }
            const hit = findLineNode(target);
            if (!hit) { sendResponse({ ok: false, error: '그 줄을 못 찾음' }); return; }
            try {
              const pe = hit.parentElement;
              // ⚠️ 반드시 화면으로 끌어와야 한다. 이걸 안 해서 좌표가 화면 밖(음수/과대)이 되고
              //    클릭이 엉뚱한 자리에 떨어져 사진이 글 맨 끝에 붙었다.
              (pe || hit.parentNode).scrollIntoView({ block: 'center', behavior: 'instant' });
              await sleep(180);

              const r = document.createRange();
              r.selectNodeContents(hit);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(r);

              // 드래그 선택용 시작/끝 좌표 — 사람처럼 긋기 위해 글자 범위의 양 끝을 준다
              const rects = Array.from(r.getClientRects()).filter((b) => b.width > 0 && b.height > 0);
              const off = viewportRect(pe || hit.parentNode);
              const base = (pe || hit.parentNode).getBoundingClientRect();
              const dx = off.x - base.left, dy = off.y - base.top;   // 프레임 오프셋
              const first = rects[0], last = rects[rects.length - 1];

              sendResponse({
                ok: true,
                alreadyBold: !!(pe && pe.closest('b,strong')),
                x: Math.round(off.x + 12), y: Math.round(off.y + off.h / 2),
                drag: (first && last) ? {
                  x1: Math.round(first.left + dx + 1), y1: Math.round(first.top + dy + first.height / 2),
                  x2: Math.round(last.right + dx - 1), y2: Math.round(last.top + dy + last.height / 2),
                } : null,
              });
            } catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
            return;
          }

          case 'NAVER_BOLD_CHECK': {
            // CDP Ctrl+B 후 실제로 굵어졌는지 확인
            const hit = findLineNode(msg.text);
            const pe = hit && hit.parentElement;
            const bold = !!(pe && (pe.closest('b,strong') || /^(bold|[6-9]00)$/i.test(getComputedStyle(pe).fontWeight)));
            sendResponse({ ok: true, bold, found: !!hit });
            return;
          }

          case 'NAVER_TOOLBAR': {
            // 툴바 컨트롤 구조를 뽑는다. 폰트 크기·구분선은 툴바를 눌러야 하는데
            // 구조를 모르면 좌표를 찍을 수 없다. 이 출력을 보고 구현한다.
            const grab = (sel) => Array.from(document.querySelectorAll(sel)).slice(0, 14).map((el) => {
              const v = viewportRect(el);
              return {
                tag: el.tagName.toLowerCase(),
                cls: String(el.className || '').slice(0, 70),
                txt: (el.textContent || '').trim().slice(0, 18),
                aria: el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-name') || '',
                x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2),
                w: Math.round(v.w), h: Math.round(v.h),
              };
            });
            sendResponse({
              ok: true,
              toolbars: grab('[class*="toolbar"]').slice(0, 4),
              buttons: grab('[class*="toolbar"] button'),
              // 폰트 크기 후보 — select / 드롭다운 버튼 / 목록
              fontSize: grab('[class*="font-size"], [class*="fontSize"], select[class*="size"]'),
              options: grab('[class*="font-size"] li, [class*="fontSize"] li, [class*="size"] [role="option"]'),
            });
            return;
          }

          case 'NAVER_TOOLBAR_BTN': {
            // 툴바 버튼을 aria-label 또는 클래스 조각으로 찾아 좌표를 준다.
            // 진단으로 확인된 이름 — image / horizontal-line / quotation / table,
            // 폰트 크기는 클래스에 'font-size' 가 들어간다(aria 는 title-font-size 처럼 문맥에 따라 바뀐다).
            const name = String(msg.name || '');
            const vis = (el) => el.getClientRects().length > 0;
            const pool = Array.from(document.querySelectorAll('[class*="toolbar"] button')).filter(vis);
            const hit = pool.find((el) => (el.getAttribute('aria-label') || '') === name)
                     || pool.find((el) => String(el.className).includes(name))
                     || pool.find((el) => (el.getAttribute('aria-label') || '').includes(name));
            if (!hit) { sendResponse({ ok: false, error: `툴바 버튼 '${name}' 없음` }); return; }
            const v = viewportRect(hit);
            sendResponse({
              ok: true,
              x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2),
              hint: describe(hit), label: (hit.getAttribute('aria-label') || ''),
              txt: (hit.textContent || '').trim().slice(0, 20),
            });
            return;
          }

          case 'NAVER_MENU_OPTIONS': {
            // 방금 열린 드롭다운의 항목들. 폰트 크기 목록을 읽어 원하는 값의 좌표를 찾는다.
            const vis = (el) => el.getClientRects().length > 0 && el.offsetWidth > 0;
            const items = Array.from(document.querySelectorAll(
              '[class*="font-size"] li, [class*="font-size"] button, [class*="option-list"] li, ' +
              '[class*="toolbar"] [role="option"], [class*="select-list"] li, [class*="dropdown"] li'
            )).filter(vis);
            sendResponse({
              ok: true,
              items: items.slice(0, 30).map((el) => {
                const v = viewportRect(el);
                return {
                  txt: (el.textContent || '').trim().slice(0, 14),
                  cls: String(el.className || '').slice(0, 50),
                  x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2),
                };
              }),
            });
            return;
          }

          case 'NAVER_DIVIDERS': {
            // 진짜 구분선 컴포넌트 개수 (삽입 성공 검증용)
            sendResponse({
              ok: true,
              count: document.querySelectorAll('[class*="horizontalLine"], .se-component[class*="horizontal"]').length,
            });
            return;
          }

          case 'NAVER_IMAGE_RECT': {
            // 마지막에 삽입된 이미지 컴포넌트 좌표. 클릭해서 선택하면 캡션 칸이 나타난다.
            const comps = document.querySelectorAll('.se-component.se-image');
            const comp = comps[comps.length - 1];
            if (!comp) { sendResponse({ ok: false, error: '이미지 컴포넌트 없음' }); return; }
            comp.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(200);
            const v = viewportRect(comp);
            sendResponse({
              ok: true, count: comps.length,
              x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2),
            });
            return;
          }

          case 'NAVER_CAPTION_RECT': {
            // 사진 설명(캡션) 입력 칸. 이미지를 선택하면 '사진 설명을 입력하세요' 가 뜬다.
            // ★캡션을 본문 텍스트로 넣으면 안 된다 — 그 줄에 커서를 놓고 사진을 넣어서
            //   '잔' / '디밭 뛰고…' 로 줄이 쪼개졌다(사용자 화면에서 확인).
            const comps = document.querySelectorAll('.se-component.se-image');
            const comp = comps[comps.length - 1];
            let cap = comp && comp.querySelector(
              '[class*="caption"] .se-text-paragraph, [class*="caption"] [contenteditable], [class*="caption"]'
            );
            if (!cap) {
              cap = Array.from(document.querySelectorAll('[class*="caption"], .se-text-paragraph'))
                .find((el) => /사진\s*설명을?\s*입력/.test(el.textContent || '') && el.getClientRects().length);
            }
            if (!cap || !cap.getClientRects().length) {
              sendResponse({ ok: false, error: '캡션 칸을 못 찾음 (이미지를 먼저 선택해야 나타난다)' });
              return;
            }
            cap.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(180);
            const v = viewportRect(cap);
            sendResponse({
              ok: true,
              x: Math.round(v.x + Math.min(30, v.w / 2)), y: Math.round(v.y + v.h / 2),
              hint: describe(cap), txt: (cap.textContent || '').trim().slice(0, 24),
            });
            return;
          }

          case 'NAVER_TABLE_PICKER': {
            // 표 크기 피커. 격자에서 원하는 행×열 칸을 찍어야 한다.
            // ⚠️ 전에는 '한 행에 몇 칸인지'를 첫 행 top 으로만 세서 5×3 을 요청했는데
            //    3×3 이 만들어졌다(닛폰·토요타·롯데가 2행에 뭉쳤다).
            //    → 셀들의 left/top 을 각각 모아 실제 격자 크기를 기하학적으로 계산한다.
            const want = { r: Math.max(1, msg.rows | 0), c: Math.max(1, msg.cols | 0) };
            const vis = (el) => el.getClientRects().length > 0;
            const pools = [
              '[class*="table"] [class*="cell"]',
              '[class*="table"] td',
              '[class*="grid"] [class*="cell"]',
              '[class*="table-select"] *[data-row]',
              '[class*="table"] li',
            ];
            let cells = [];
            for (const sel of pools) {
              const got = Array.from(document.querySelectorAll(sel)).filter(vis);
              if (got.length > cells.length) cells = got;
              if (cells.length >= want.r * want.c) break;
            }
            if (!cells.length) { sendResponse({ ok: false, error: '표 크기 피커를 못 찾음' }); return; }

            const rnd = (n) => Math.round(n / 4) * 4;   // 1~2px 흔들림 흡수
            const info = cells.map((el) => {
              const b = el.getBoundingClientRect();
              return { el, l: rnd(b.left), t: rnd(b.top),
                       r: +(el.getAttribute('data-row') || el.dataset?.row || 0),
                       c: +(el.getAttribute('data-col') || el.dataset?.col || 0) };
            });
            const lefts = [...new Set(info.map((x) => x.l))].sort((a, b) => a - b);
            const tops  = [...new Set(info.map((x) => x.t))].sort((a, b) => a - b);

            // 1순위: data-row/col 속성
            let hit = info.find((x) => x.r === want.r && x.c === want.c);
            // 2순위: 격자 좌표로 정확히 찾기 (행=top 순서, 열=left 순서)
            if (!hit && want.r <= tops.length && want.c <= lefts.length) {
              const T = tops[want.r - 1], L = lefts[want.c - 1];
              hit = info.find((x) => x.t === T && x.l === L);
            }
            if (!hit) {
              sendResponse({ ok: false, error: `${want.r}x${want.c} 칸 없음 (피커 격자 ${tops.length}행 × ${lefts.length}열)`,
                             gridRows: tops.length, gridCols: lefts.length });
              return;
            }
            const v = viewportRect(hit.el);
            sendResponse({
              ok: true, count: cells.length, gridRows: tops.length, gridCols: lefts.length,
              x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2),
            });
            return;
          }

          case 'NAVER_TABLE_ADDROW': {
            // 표 행이 부족할 때. 마지막 셀에 커서를 놓고 Tab 을 치면 네이버가 행을 추가한다.
            const tabs = document.querySelectorAll('[class*="se-table"], table');
            const t = tabs[tabs.length - 1];
            if (!t) { sendResponse({ ok: false, error: '표 없음' }); return; }
            const cells = t.querySelectorAll('td,th');
            const last = cells[cells.length - 1];
            if (!last) { sendResponse({ ok: false, error: '셀 없음' }); return; }
            last.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(180);
            const target = last.querySelector('[class*="paragraph"], [contenteditable]') || last;
            const v = viewportRect(target);
            sendResponse({ ok: true, rows: t.querySelectorAll('tr').length,
                           x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2) });
            return;
          }

          case 'NAVER_TABLE_PICKER_DUMP': {
            // 표 버튼을 누른 뒤 열린 크기 피커의 실제 구조를 뽑는다.
            // 세 번 추측해서 세 번 틀렸다(5×3 요청 → 3×3 생성). 이제 눈으로 본다.
            const vis = (el) => el.getClientRects().length > 0;
            const cand = [
              '[class*="table"] [class*="cell"]', '[class*="table"] td', '[class*="grid"] [class*="cell"]',
              '[class*="table-select"] *', '[class*="table"] li', '[class*="table"] div',
              '[class*="layer"] [class*="cell"]', '[class*="popup"] td',
            ];
            const report = [];
            for (const sel of cand) {
              const got = Array.from(document.querySelectorAll(sel)).filter(vis);
              if (!got.length) continue;
              const rects = got.map((e) => e.getBoundingClientRect());
              const lefts = [...new Set(rects.map((b) => Math.round(b.left / 4) * 4))].length;
              const tops  = [...new Set(rects.map((b) => Math.round(b.top / 4) * 4))].length;
              report.push({
                sel, n: got.length, grid: `${tops}행 × ${lefts}열`,
                sample: got.slice(0, 4).map((e) => ({
                  tag: e.tagName, cls: String(e.className || '').slice(0, 50),
                  row: e.getAttribute('data-row') || e.dataset?.row || '',
                  col: e.getAttribute('data-col') || e.dataset?.col || '',
                  w: Math.round(e.getBoundingClientRect().width),
                  h: Math.round(e.getBoundingClientRect().height),
                  txt: (e.textContent || '').trim().slice(0, 10),
                })),
              });
            }
            // 피커 컨테이너 자체도
            const layers = Array.from(document.querySelectorAll('[class*="table"]')).filter(vis)
              .slice(0, 6).map((e) => ({ tag: e.tagName, cls: String(e.className || '').slice(0, 60),
                w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }));
            sendResponse({ ok: true, pools: report, layers });
            return;
          }

          case 'NAVER_AFTER_TABLE': {
            // 표 '바로 다음' 문단 좌표. 폴백 글자가 셀 안으로 들어가는 걸 막는다.
            const tabs = document.querySelectorAll('[class*="se-table"], table');
            const t = tabs[tabs.length - 1];
            if (!t) { sendResponse({ ok: false, error: '표 없음' }); return; }
            // 표를 담은 컴포넌트의 다음 형제에서 문단을 찾는다
            let node = t.closest('[class*="se-component"]') || t;
            let para = null, guard = 0;
            while (node && guard++ < 6) {
              node = node.nextElementSibling;
              if (!node) break;
              para = node.querySelector('.se-text-paragraph, [class*="paragraph"]')
                  || (node.matches('.se-text-paragraph, [class*="paragraph"]') ? node : null);
              if (para && para.getClientRects().length) break;
              para = null;
            }
            if (!para) { sendResponse({ ok: false, error: '표 다음 문단 없음' }); return; }
            para.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(180);
            const v = viewportRect(para);
            sendResponse({ ok: true, x: Math.round(v.x + 12), y: Math.round(v.y + v.h / 2) });
            return;
          }

          case 'NAVER_TABLE_COUNT': {
            sendResponse({ ok: true, count: document.querySelectorAll('[class*="se-table"], table').length });
            return;
          }

          case 'NAVER_TABLE_FIRST_CELL': {
            // 방금 삽입된 표의 첫 셀 좌표. 여기 클릭하고 Tab 으로 칸을 옮겨가며 채운다.
            const tabs = document.querySelectorAll('[class*="se-table"], table');
            const t = tabs[tabs.length - 1];
            if (!t) { sendResponse({ ok: false, error: '삽입된 표를 못 찾음' }); return; }
            t.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(200);
            const cell = t.querySelector('td, th, [class*="cell"] [class*="paragraph"], [class*="cell"]');
            if (!cell) { sendResponse({ ok: false, error: '표 셀을 못 찾음' }); return; }
            const v = viewportRect(cell);
            const rows = t.querySelectorAll('tr').length;
            sendResponse({
              ok: true, rows,
              x: Math.round(v.x + Math.min(12, v.w / 2)), y: Math.round(v.y + v.h / 2),
            });
            return;
          }

          case 'NAVER_LINK_INPUT': {
            // 링크(oglink) 버튼을 누르면 주소 입력칸이 열린다. 그 칸과 확인 버튼 좌표.
            const vis = (el) => el.getClientRects().length > 0;
            const input = Array.from(document.querySelectorAll(
              'input[type="text"], input[type="url"], input:not([type]), textarea'
            )).filter(vis).find((el) => /link|url|oglink|주소/i.test(
              (el.className || '') + ' ' + (el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')
            )) || Array.from(document.querySelectorAll('[class*="oglink"] input, [class*="link"] input')).filter(vis)[0];
            if (!input) {
              sendResponse({
                ok: false, error: '링크 입력칸을 못 찾음',
                dump: Array.from(document.querySelectorAll('input,textarea')).filter(vis).slice(0, 6).map((el) => ({
                  tag: el.tagName, type: el.type || '', cls: String(el.className || '').slice(0, 45),
                  ph: el.placeholder || '',
                })),
              });
              return;
            }
            const v = viewportRect(input);
            const btn = Array.from(document.querySelectorAll('[class*="oglink"] button, [class*="link"] button')).filter(vis)
              .find((b) => /확인|검색|적용|추가/.test(b.textContent || ''));
            const bv = btn ? viewportRect(btn) : null;
            sendResponse({
              ok: true,
              x: Math.round(v.x + Math.min(30, v.w / 2)), y: Math.round(v.y + v.h / 2),
              hint: describe(input),
              ok_btn: bv ? { x: Math.round(bv.x + bv.w / 2), y: Math.round(bv.y + bv.h / 2) } : null,
            });
            return;
          }

          case 'NAVER_OGLINK_COUNT': {
            sendResponse({ ok: true, count: document.querySelectorAll('[class*="oglink"], [class*="se-oglink"]').length });
            return;
          }

          case 'NAVER_TABLE_CELLS': {
            // 표의 모든 셀 좌표. Tab 으로 칸을 옮기는 게 안 먹혀서(첫 셀에 전부 들어갔다)
            // 셀마다 직접 클릭해 넣는다.
            const tabs = document.querySelectorAll('[class*="se-table"], table');
            const t = tabs[tabs.length - 1];
            if (!t) { sendResponse({ ok: false, error: '표를 못 찾음' }); return; }
            t.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(250);
            const rows = Array.from(t.querySelectorAll('tr'));
            const grid = rows.map((tr) => Array.from(tr.querySelectorAll('td,th')).map((td) => {
              // 셀 안의 문단이 실제 입력 지점이다
              const target = td.querySelector('[class*="paragraph"], [contenteditable]') || td;
              const v = viewportRect(target);
              return { x: Math.round(v.x + Math.min(14, v.w / 2)), y: Math.round(v.y + v.h / 2), w: Math.round(v.w), h: Math.round(v.h) };
            }));
            sendResponse({ ok: true, rows: grid.length, cols: grid[0] ? grid[0].length : 0, grid });
            return;
          }

          case 'NAVER_TABLE_TEXT': {
            // 표에 들어간 내용 검증용 — 셀별 글자수
            const tabs = document.querySelectorAll('[class*="se-table"], table');
            const t = tabs[tabs.length - 1];
            if (!t) { sendResponse({ ok: false, error: '표 없음' }); return; }
            const cells = Array.from(t.querySelectorAll('td,th')).map((td) => (td.innerText || '').trim());
            sendResponse({ ok: true, cells, filled: cells.filter(Boolean).length, total: cells.length });
            return;
          }

          case 'NAVER_LINK_DIALOG': {
            // 링크(oglink) 입력창 구조.
            // ★핵심: 주소를 넣고 '돋보기(검색)' 를 눌러야 확인이 활성화된다.
            //   그걸 안 눌러서 확인 클릭이 먹지 않았다(링크 카드 1/5).
            const vis = (el) => el.getClientRects().length > 0;
            const scope = document.querySelector('[class*="oglink"], [class*="link-layer"], [class*="se-popup"]') || document;
            const input = Array.from(scope.querySelectorAll('input[type="text"], input[type="url"], input:not([type]), textarea')).filter(vis)[0]
              || Array.from(document.querySelectorAll('input[type="text"], input[type="url"]')).filter(vis)
                   .find((el) => /link|url|oglink|주소/i.test((el.className || '') + ' ' + (el.placeholder || '')));
            if (!input) { sendResponse({ ok: false, error: '주소 입력칸 없음' }); return; }
            const iv = viewportRect(input);

            const btns = Array.from(scope.querySelectorAll('button')).filter(vis);
            const pick = (re) => btns.find((b) =>
              re.test((b.getAttribute('aria-label') || '') + ' ' + (b.className || '') + ' ' + (b.textContent || '').trim()));
            const search  = pick(/검색|search|magnif|돋보기/i);
            const confirm = pick(/확인|적용|추가|등록|완료/);
            const rc = (el) => { if (!el) return null; const v = viewportRect(el); return { x: Math.round(v.x + v.w / 2), y: Math.round(v.y + v.h / 2), disabled: !!el.disabled }; };

            sendResponse({
              ok: true,
              input: { x: Math.round(iv.x + Math.min(30, iv.w / 2)), y: Math.round(iv.y + iv.h / 2) },
              search: rc(search), confirm: rc(confirm),
              buttons: btns.slice(0, 8).map((b) => ({
                cls: String(b.className || '').slice(0, 42),
                aria: b.getAttribute('aria-label') || '',
                txt: (b.textContent || '').trim().slice(0, 12),
                disabled: !!b.disabled,
              })),
            });
            return;
          }

          case 'NAVER_STYLE_BTN': {
            // 툴바의 문단 스타일 선택기('본문 ▾'). 여기서 제목1/제목2 를 고르면
            // 발행된 HTML 에 진짜 heading 이 들어간다(굵게+19pt 는 heading 이 아니다).
            const vis = (el) => el.getClientRects().length > 0;
            const pool = Array.from(document.querySelectorAll('[class*="toolbar"] button')).filter(vis);
            const hit = pool.find((b) => /본문|제목|스타일|헤딩|heading|paragraph-style|text-style/.test(
              (b.textContent || '') + ' ' + (b.className || '') + ' ' + (b.getAttribute('aria-label') || '')));
            if (!hit) {
              sendResponse({ ok: false, error: '문단 스타일 버튼 없음',
                dump: pool.slice(0, 12).map((b) => ({ cls: String(b.className||'').slice(0,44),
                  aria: b.getAttribute('aria-label')||'', txt: (b.textContent||'').trim().slice(0,14) })) });
              return;
            }
            const v = viewportRect(hit);
            sendResponse({ ok: true, x: Math.round(v.x + v.w/2), y: Math.round(v.y + v.h/2),
                           hint: describe(hit), txt: (hit.textContent||'').trim().slice(0,16) });
            return;
          }

          case 'NAVER_STYLE_OPTIONS': {
            // 스타일 드롭다운을 연 뒤 항목들. '제목1' 같은 걸 찾아 클릭한다.
            const vis = (el) => el.getClientRects().length > 0 && el.offsetWidth > 0;
            const items = Array.from(document.querySelectorAll(
              '[class*="text-style"] li, [class*="paragraph-style"] li, [class*="style"] li, ' +
              '[class*="toolbar"] [role="option"], [class*="option-list"] li, [class*="dropdown"] li'
            )).filter(vis);
            sendResponse({
              ok: true,
              items: items.slice(0, 20).map((el) => {
                const v = viewportRect(el);
                return { txt: (el.textContent || '').trim().slice(0, 16),
                         cls: String(el.className || '').slice(0, 44),
                         x: Math.round(v.x + v.w/2), y: Math.round(v.y + v.h/2) };
              }),
            });
            return;
          }

          case 'NAVER_HEADING_COUNT': {
            // 발행 전에도 확인 가능한 heading 개수 (진짜 제목 구조가 들어갔는지)
            sendResponse({ ok: true,
              h: document.querySelectorAll('h1,h2,h3,h4').length,
              se: document.querySelectorAll('[class*="se-section-quotation"], [class*="heading"]').length });
            return;
          }

          case 'NAVER_STATUS':
            sendResponse({
              ok: true,
              titleChars: textLen(findTitle()),
              // findBody() 는 첫 문단만 가리킨다(입력 후 15자로 나왔던 이유).
              // 제목 문단을 뺀 모든 문단을 합쳐서 잰다.
              bodyChars: bodyParagraphs().reduce((n, p) => n + textLen(p), 0),
              paragraphs: bodyParagraphs().length,
              images: document.querySelectorAll('.se-component.se-image').length,
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
