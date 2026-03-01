/**
 * MangoAuto - Grok MAIN world injector
 * 1) fetch interceptor: /rest/app-chat/upload-file → mock success
 * 2) history/navigation 차단: upload 후 /imagine 롤백 방지
 * 3) popstate 차단: 뒤로가기 이벤트 방지
 * CSP 우회를 위해 manifest.json에서 world: "MAIN"으로 등록
 */
(function() {
  // ═══════════════════════════════════════════════════
  // ─── 1. fetch interceptor ───
  // ═══════════════════════════════════════════════════
  const _origFetch = window.fetch;

  window.fetch = async function(url, opts) {
    const u = (typeof url === 'string' ? url : url?.url) || '';

    if (u.includes('/rest/app-chat/upload-file')) {
      console.log('[MangoAuto:Inject] upload-file 인터셉트 → mock 즉시 반환');

      // 네비게이션 롤백 차단 (10초간)
      _blockNav = true;
      setTimeout(() => { _blockNav = false; }, 10000);

      // FormData에서 파일 추출 → blob URL 생성
      let fileUrl = '';
      let fileSize = 0;
      let fileMime = 'image/png';
      if (opts?.body instanceof FormData) {
        for (const [key, value] of opts.body.entries()) {
          if (value instanceof File || value instanceof Blob) {
            fileUrl = URL.createObjectURL(value);
            fileSize = value.size;
            fileMime = value.type || 'image/png';
            console.log('[MangoAuto:Inject] 파일 blob URL 생성:', fileUrl, '크기:', fileSize);
            break;
          }
        }
      }

      const mockId = crypto.randomUUID();
      return new Response(JSON.stringify({
        fileMetadata: {
          id: mockId,
          url: fileUrl,
          downloadUrl: fileUrl,
          thumbnailUrl: fileUrl,
          mimeType: fileMime,
          contentType: fileMime,
          fileName: 'image.png',
          size: fileSize
        },
        url: fileUrl,
        id: mockId,
        fileId: mockId
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return _origFetch.apply(this, arguments);
  };

  // ═══════════════════════════════════════════════════
  // ─── 2. History/Navigation 차단 ───
  // ═══════════════════════════════════════════════════
  const _origPushState = History.prototype.pushState;
  const _origReplaceState = History.prototype.replaceState;
  const _origBack = History.prototype.back;
  const _origGo = History.prototype.go;

  let _blockNav = false;

  History.prototype.back = function() {
    if (_blockNav) {
      console.log('[MangoAuto:Inject] history.back() 차단됨');
      return;
    }
    return _origBack.apply(this, arguments);
  };

  History.prototype.go = function(delta) {
    if (_blockNav && delta < 0) {
      console.log('[MangoAuto:Inject] history.go(' + delta + ') 차단됨');
      return;
    }
    return _origGo.apply(this, arguments);
  };

  History.prototype.pushState = function(state, title, url) {
    if (_blockNav && typeof url === 'string') {
      try {
        const path = new URL(url, location.origin).pathname;
        if (path === '/imagine' || path === '/imagine/') {
          console.log('[MangoAuto:Inject] pushState to /imagine 차단됨');
          return;
        }
      } catch(e) {}
    }
    return _origPushState.apply(this, arguments);
  };

  History.prototype.replaceState = function(state, title, url) {
    if (_blockNav && typeof url === 'string') {
      try {
        const path = new URL(url, location.origin).pathname;
        if (path === '/imagine' || path === '/imagine/') {
          console.log('[MangoAuto:Inject] replaceState to /imagine 차단됨');
          return;
        }
      } catch(e) {}
    }
    return _origReplaceState.apply(this, arguments);
  };

  window.addEventListener('popstate', function(e) {
    if (_blockNav) {
      console.log('[MangoAuto:Inject] popstate 이벤트 차단됨');
      e.stopImmediatePropagation();
      if (location.pathname === '/imagine' || location.pathname === '/imagine/') {
        _origGo.call(history, 1);
      }
    }
  }, true);

  console.log('[MangoAuto:Inject] Grok upload interceptor + nav blocker 설치 완료');
})();
