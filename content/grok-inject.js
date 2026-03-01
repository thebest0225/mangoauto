/**
 * MangoAuto - Grok MAIN world injector
 * addEventListener Proxy: paste/drop 이벤트의 isTrusted를 항상 true로 보이게 함
 * → 프로그래밍(synthetic) 이벤트도 Grok 커스텀 핸들러가 정상 처리
 * → 수동 이벤트는 원래 isTrusted=true이므로 영향 없음
 *
 * ※ fetch interceptor 제거: 수동 드래그/붙여넣기까지 깨뜨리는 원인이었음
 * CSP 우회를 위해 manifest.json에서 world: "MAIN", run_at: "document_start"로 등록
 */
(function() {
  const _origAddEventListener = EventTarget.prototype.addEventListener;
  const PROXY_EVENTS = new Set(['paste', 'drop']);

  EventTarget.prototype.addEventListener = function(type, handler, options) {
    if (PROXY_EVENTS.has(type) && typeof handler === 'function') {
      const wrappedHandler = function(event) {
        // Proxy로 감싸서 isTrusted를 항상 true로 반환
        const proxy = new Proxy(event, {
          get(target, prop) {
            if (prop === 'isTrusted') return true;
            const val = Reflect.get(target, prop);
            return typeof val === 'function' ? val.bind(target) : val;
          }
        });
        return handler.call(this, proxy);
      };
      return _origAddEventListener.call(this, type, wrappedHandler, options);
    }
    return _origAddEventListener.call(this, type, handler, options);
  };

  console.log('[MangoAuto:Inject] addEventListener Proxy 설치 완료 (paste/drop isTrusted=true)');
})();
