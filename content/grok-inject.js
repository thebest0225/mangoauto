/**
 * MangoAuto - Grok MAIN world 디버그 로거
 * fetch 요청을 가로채지 않고 로그만 남김
 * 수동 드래그 vs 자동 paste 비교용
 */
(function() {
  const _origFetch = window.fetch;

  window.fetch = async function(url, opts) {
    const u = (typeof url === 'string' ? url : url?.url) || '';

    // upload-file 요청 로깅 (가로채지 않음!)
    if (u.includes('/rest/app-chat/upload-file')) {
      console.log('%c[MangoAuto:Inject] ===== upload-file 요청 감지 =====', 'color: red; font-weight: bold');
      console.log('[MangoAuto:Inject] URL:', u);
      console.log('[MangoAuto:Inject] Method:', opts?.method || 'GET');

      // FormData 내용 로깅
      if (opts?.body instanceof FormData) {
        console.log('[MangoAuto:Inject] FormData 내용:');
        for (const [key, value] of opts.body.entries()) {
          if (value instanceof File) {
            console.log(`  ${key}: File(name=${value.name}, size=${value.size}, type=${value.type})`);
          } else if (value instanceof Blob) {
            console.log(`  ${key}: Blob(size=${value.size}, type=${value.type})`);
          } else {
            console.log(`  ${key}: ${String(value).substring(0, 200)}`);
          }
        }
      }

      // Headers 로깅
      if (opts?.headers) {
        console.log('[MangoAuto:Inject] Headers:', JSON.stringify(opts.headers));
      }

      // 원본 요청 실행 후 응답 로깅
      try {
        const response = await _origFetch.apply(this, arguments);
        const cloned = response.clone();
        const status = response.status;
        console.log(`%c[MangoAuto:Inject] upload-file 응답: ${status}`, status >= 400 ? 'color: red' : 'color: green');

        try {
          const body = await cloned.text();
          console.log('[MangoAuto:Inject] 응답 본문:', body.substring(0, 500));
        } catch (e) {
          console.log('[MangoAuto:Inject] 응답 읽기 실패:', e.message);
        }

        return response;
      } catch (fetchErr) {
        console.error('[MangoAuto:Inject] fetch 에러:', fetchErr);
        throw fetchErr;
      }
    }

    // 다른 모든 요청은 그대로 통과
    return _origFetch.apply(this, arguments);
  };

  console.log('[MangoAuto:Inject] fetch 디버그 로거 설치 완료 (가로채기 없음, 로그만)');
})();
