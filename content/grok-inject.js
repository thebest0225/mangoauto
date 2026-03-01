/**
 * MangoAuto - Grok MAIN world injector
 * 1) fetch interceptor: /rest/app-chat/upload-file → mock success (원본 요청 안 보냄)
 * 2) history.back/go 차단: upload 실패 후 페이지 롤백 방지
 * CSP 우회를 위해 manifest.json에서 world: "MAIN"으로 등록
 */
(function() {
  const _origFetch = window.fetch;
  const _origBack = History.prototype.back;
  const _origGo = History.prototype.go;
  const _origPushState = History.prototype.pushState;
  const _origReplaceState = History.prototype.replaceState;

  let _blockNavBack = false;
  let _blockNavToImagine = false;

  // history.back() 차단
  History.prototype.back = function() {
    if (_blockNavBack) {
      console.log('[MangoAuto:Inject] history.back() 차단됨');
      _blockNavBack = false;
      return;
    }
    return _origBack.apply(this, arguments);
  };

  // history.go(-n) 차단
  History.prototype.go = function(delta) {
    if (_blockNavBack && delta < 0) {
      console.log('[MangoAuto:Inject] history.go(' + delta + ') 차단됨');
      _blockNavBack = false;
      return;
    }
    return _origGo.apply(this, arguments);
  };

  // pushState to /imagine 차단 (upload 실패 후 React Router 리다이렉트 방지)
  History.prototype.pushState = function(state, title, url) {
    if (_blockNavToImagine && typeof url === 'string') {
      // /imagine (정확히) 또는 /imagine? 로 돌아가는 것만 차단
      const path = new URL(url, location.origin).pathname;
      if (path === '/imagine' || path === '/imagine/') {
        console.log('[MangoAuto:Inject] pushState to /imagine 차단됨');
        _blockNavToImagine = false;
        return;
      }
    }
    return _origPushState.apply(this, arguments);
  };

  History.prototype.replaceState = function(state, title, url) {
    if (_blockNavToImagine && typeof url === 'string') {
      const path = new URL(url, location.origin).pathname;
      if (path === '/imagine' || path === '/imagine/') {
        console.log('[MangoAuto:Inject] replaceState to /imagine 차단됨');
        _blockNavToImagine = false;
        return;
      }
    }
    return _origReplaceState.apply(this, arguments);
  };

  // fetch interceptor: upload-file 요청을 원본으로 보내지 않고 mock success 즉시 반환
  window.fetch = async function(url, opts) {
    const u = (typeof url === 'string' ? url : url?.url) || '';

    if (u.includes('/rest/app-chat/upload-file')) {
      console.log('[MangoAuto:Inject] upload-file 인터셉트 → mock success 즉시 반환 (원본 요청 안 보냄)');

      // 네비게이션 롤백 차단 활성화 (5초간)
      _blockNavBack = true;
      _blockNavToImagine = true;
      setTimeout(() => { _blockNavBack = false; _blockNavToImagine = false; }, 5000);

      // 원본 요청을 보내지 않고 mock success 즉시 반환
      const mockId = crypto.randomUUID();
      return new Response(JSON.stringify({
        fileMetadata: {
          id: mockId,
          mimeType: 'image/png',
          fileName: 'image.png',
          size: 0
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return _origFetch.apply(this, arguments);
  };

  console.log('[MangoAuto:Inject] Grok upload interceptor + nav blocker 설치 완료');
})();
