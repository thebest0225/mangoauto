/**
 * MangoAuto - Grok Network Dedupe (MAIN world)
 *
 * 근본 문제: 그록 React submit 핸들러가 시간이 지날수록 (3번째, 4번째 task)
 *   같은 클릭에 대해 onPointerUp + onClick 양쪽을 트리거하거나, 부모/자식
 *   handler 중복 등록 등으로 1회 클릭에 2번 POST 가 발사됨 → 영상 2개 생성.
 *
 * 근본 차단: 네트워크 레이어에서 동일 endpoint + body 의 POST 가 짧은 시간 (3초)
 *   안에 2번 이상 발생하면 2번째부터 무시 (가짜 200 OK 응답). 어떤 이유로
 *   중복이 발생해도 절대 서버까지 닿지 않음.
 *
 * - window.fetch + XMLHttpRequest.send 양쪽 patch (Grok 은 둘 다 사용 가능)
 * - 매칭: URL (query 포함) + body 의 앞 500자 hash
 * - 윈도우: 3000ms (작업 한 번에 1번만 submit, 다음 작업은 60s+ 뒤이므로 충돌 X)
 * - 중복 주입 가드 (PING version 재주입 시에도 1회만 patch)
 */
(() => {
  if (window.__MANGOAUTO_GROK_DEDUPE_LOADED__) {
    console.log('[MangoAuto:GrokDedupe] 이미 로드됨 — skip');
    return;
  }
  window.__MANGOAUTO_GROK_DEDUPE_LOADED__ = true;

  const LOG_PREFIX = '[MangoAuto:GrokDedupe]';
  const DEDUPE_WINDOW_MS = 3000;
  const recentPosts = new Map();  // fingerprint → timestamp

  const origFetch = window.fetch;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  function shouldDedupe(url, method) {
    if (!method || method.toUpperCase() !== 'POST') return false;
    const s = String(url || '');
    if (!s) return false;
    // 절대 URL or 상대 path (둘 다 grok 도메인 또는 path /api 등 매치)
    if (s.startsWith('http')) {
      try {
        const u = new URL(s);
        if (!u.hostname.endsWith('grok.com')) return false;
      } catch (_) { return false; }
    }
    // analytics / telemetry / segment 제외
    const lower = s.toLowerCase();
    if (lower.includes('analytic') || lower.includes('tracking') ||
        lower.includes('telemetry') || lower.includes('segment.io') ||
        lower.includes('sentry') || lower.includes('rest/v2/log') ||
        lower.includes('facebook.com') || lower.includes('doubleclick')) return false;
    return true;
  }

  function bodyToString(body) {
    if (!body) return '';
    if (typeof body === 'string') return body.slice(0, 500);
    if (body instanceof URLSearchParams) return body.toString().slice(0, 500);
    if (body instanceof FormData) {
      const parts = [];
      try {
        for (const [k, v] of body.entries()) {
          parts.push(`${k}=${typeof v === 'string' ? v.slice(0, 60) : '[file]'}`);
        }
      } catch (_) {}
      return parts.join('&').slice(0, 500);
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return '[binary:' + (body.byteLength || 0) + ']';
    }
    if (body instanceof Blob) return '[blob:' + body.size + '/' + (body.type || '') + ']';
    try { return JSON.stringify(body).slice(0, 500); } catch (_) {}
    return String(body).slice(0, 100);
  }

  function fingerprint(url, body) {
    // URL 의 query string 도 포함 (timestamp/nonce 있으면 fingerprint 가 매번 달라져
    // dedupe 무력화될 수 있지만, 그록은 보통 안정적 URL 사용. 만약 nonce 있으면
    // body 가 같아도 통과됨 — 그건 어쩔 수 없는 trade-off.)
    return String(url) + '|' + bodyToString(body);
  }

  function isDuplicate(url, body) {
    const now = Date.now();
    // GC: 오래된 entry 청소
    for (const [k, ts] of recentPosts.entries()) {
      if (now - ts > DEDUPE_WINDOW_MS) recentPosts.delete(k);
    }
    const fp = fingerprint(url, body);
    if (recentPosts.has(fp)) {
      const elapsed = now - recentPosts.get(fp);
      console.warn(LOG_PREFIX, `🛑 중복 POST 차단 (${elapsed}ms 전 동일 요청): ${String(url).substring(0, 100)}`);
      return true;
    }
    recentPosts.set(fp, now);
    return false;
  }

  function fakeOkResponse() {
    return new Response(JSON.stringify({ deduped: true, source: 'mangoauto' }), {
      status: 200,
      statusText: 'OK',
      headers: {
        'Content-Type': 'application/json',
        'X-MangoAuto-Deduped': '1',
      },
    });
  }

  // ─── fetch patch ───
  window.fetch = function (input, init) {
    try {
      let url, method, body;
      if (input instanceof Request) {
        url = input.url;
        method = (init?.method || input.method || 'GET').toUpperCase();
        body = init?.body;  // Request body 는 stream 이라 init.body 가 우선
      } else {
        url = String(input || '');
        method = (init?.method || 'GET').toUpperCase();
        body = init?.body;
      }
      if (shouldDedupe(url, method) && isDuplicate(url, body)) {
        return Promise.resolve(fakeOkResponse());
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'fetch wrapper 에러 (원본 호출):', e.message);
    }
    return origFetch.apply(this, arguments);
  };

  // ─── XMLHttpRequest patch ───
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__mango_method = String(method || 'GET').toUpperCase();
    this.__mango_url = String(url || '');
    return origXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const method = this.__mango_method || 'GET';
      const url = this.__mango_url || '';
      if (shouldDedupe(url, method) && isDuplicate(url, body)) {
        // 가짜 onload — 호출자가 spinner 해제 등 후속 처리 진행하도록.
        const self = this;
        setTimeout(() => {
          try {
            Object.defineProperty(self, 'readyState', { configurable: true, get: () => 4 });
            Object.defineProperty(self, 'status', { configurable: true, get: () => 200 });
            Object.defineProperty(self, 'statusText', { configurable: true, get: () => 'OK' });
            Object.defineProperty(self, 'response', { configurable: true, get: () => '{"deduped":true}' });
            Object.defineProperty(self, 'responseText', { configurable: true, get: () => '{"deduped":true}' });
            self.dispatchEvent(new Event('readystatechange'));
            self.dispatchEvent(new Event('load'));
            self.dispatchEvent(new Event('loadend'));
          } catch (e) { console.warn(LOG_PREFIX, 'XHR fake response 에러:', e.message); }
        }, 0);
        return;
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'xhr wrapper 에러 (원본 호출):', e.message);
    }
    return origXhrSend.apply(this, arguments);
  };

  console.log(LOG_PREFIX, '✅ Network dedupe installed (window=' + DEDUPE_WINDOW_MS + 'ms, all grok.com POSTs)');
})();
