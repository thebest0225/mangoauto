/**
 * MangoAuto - Grok MAIN world injector
 * fetch interceptor: /rest/app-chat/upload-file 400 → mock success
 * CSP 우회를 위해 manifest.json에서 world: "MAIN"으로 등록
 */
(function() {
  const _origFetch = window.fetch;

  window.fetch = async function(url, opts) {
    const u = (typeof url === 'string' ? url : url?.url) || '';

    if (u.includes('/rest/app-chat/upload-file')) {
      console.log('[MangoAuto:Inject] upload-file 요청 인터셉트');

      try {
        const resp = await _origFetch.apply(this, arguments);
        if (resp.ok) {
          console.log('[MangoAuto:Inject] upload-file 성공 (원본)');
          return resp;
        }
        console.log('[MangoAuto:Inject] upload-file 실패:', resp.status, '→ mock success 반환');
      } catch(e) {
        console.log('[MangoAuto:Inject] upload-file 에러:', e.message, '→ mock success 반환');
      }

      // 400 에러 시 mock success 반환 → 페이지 롤백 방지
      return new Response(JSON.stringify({
        fileMetadata: {
          id: crypto.randomUUID(),
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

  console.log('[MangoAuto:Inject] Grok upload interceptor 설치 완료');
})();
