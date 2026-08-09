/**
 * MangoAuto - Grok Network Dedupe (MAIN world)
 *
 * 근본 문제: 그록 React submit 핸들러가 시간이 지날수록 (3번째, 4번째 task)
 *   같은 클릭에 대해 onPointerUp + onClick 양쪽을 트리거하거나, 부모/자식
 *   handler 중복 등록 등으로 1회 클릭에 2번 POST 가 발사됨 → 영상 2개 생성.
 *
 * 근본 차단: 동일 endpoint + body 의 POST 가 짧은 시간 (3초) 안에 2번 이상
 *   발생하면 2번째부터 무시 (가짜 200 OK 응답).
 *
 * ⚠️ 2026-08-09 리뉴얼 대응 — 과차단 사고 수정 (v1.7.35)
 *   리뉴얼된 grok.com 은 설정/구성 조회도 POST 로 한다:
 *     POST /rest/modes, POST /rest/models/imagine/overrides ...
 *   이걸 React 가 마운트 때 두 번 쏘는데, 예전 버전은 "모든 grok.com POST" 를
 *   무차별 dedupe 해서 2번째 호출에 {"deduped":true} 가짜 응답을 돌려줬다.
 *   → 앱이 modes/model override 를 못 받아 composer 가 깨지고 리렌더 루프 →
 *     탭이 거의 정지 상태가 됨 (2~3개 작업 후 멈춤 증상의 직접 원인).
 *
 *   fix 3종:
 *     1) DENY 리스트 — 조회/구성 endpoint 는 절대 dedupe 안 함
 *     2) body 를 실제로 읽는다 (Request 객체는 clone().text() 로 비동기 확인).
 *        예전엔 init.body 만 봐서 대부분 body='' 로 뭉개져 서로 다른 요청이
 *        같은 fingerprint 가 됐다.
 *     3) 생성 요청 판별 — ALLOW 패턴이거나 body 가 충분히 큰 (>=20자) POST 만
 *        dedupe 대상. 작은 구성 핑은 절대 안 막음.
 *
 * - window.fetch + XMLHttpRequest.send 양쪽 patch
 * - 매칭: URL (query 포함) + body 앞 500자
 * - 윈도우: 3000ms
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
  const MIN_BODY_LEN = 20;          // 이보다 짧은 body = 구성/핑 → dedupe 안 함
  const recentPosts = new Map();    // fingerprint → timestamp

  // 🔍 진단용: grok.com 으로 나가는 모든 POST 를 기록한다.
  //    (영상이 2개 생성되는 문제의 실제 submit endpoint 를 특정하기 위함.
  //     콘솔에서 `__mangoPostLog` 로 확인 가능.)
  const postLog = [];
  window.__mangoPostLog = postLog;
  function tracePost(url, bodyStr, verdict) {
    const entry = { t: Date.now(), url: String(url).substring(0, 160), len: bodyStr.length, body: bodyStr.substring(0, 200), verdict };
    postLog.push(entry);
    if (postLog.length > 200) postLog.shift();
    console.log(LOG_PREFIX, `POST[${verdict}] ${entry.url} (body ${entry.len}자)`);
  }

  // ─── 절대 dedupe 하면 안 되는 endpoint (조회/구성/인증) ───
  //     여기 걸리면 무조건 원본 그대로 통과시킨다.
  const DENY_PATTERNS = [
    '/rest/modes',
    '/rest/models',
    'override',
    '/rest/auth',
    '/rest/user',
    '/rest/subscription',
    '/rest/rate-limit',
    '/rest/setting',
    '/rest/preference',
    '/rest/feature',
    '/rest/flag',
    '/rest/config',
    '/rest/quota',
    '/rest/credit',
    '/rest/upload',
    'upload-file',
    'presigned',
    'statsig',
    '/rest/v2/',
    'analytic', 'tracking', 'telemetry', 'segment.io', 'sentry',
    'facebook.com', 'doubleclick',
  ];

  // ─── 확실한 "생성 요청" 패턴 — body 길이와 무관하게 dedupe 대상 ───
  const ALLOW_PATTERNS = [
    'imagine/generate',
    'imagine/create',
    'imagine/video',
    'imagine/image',
    'imagine/post',
    'app-chat/conversations',
    '/generate',
    '/create-video',
  ];

  function pathOf(url) {
    const s = String(url || '');
    if (!s) return '';
    if (s.startsWith('http')) {
      try { return new URL(s).pathname + new URL(s).search; } catch (_) { return s; }
    }
    return s;
  }

  function isGrokUrl(url) {
    const s = String(url || '');
    if (!s) return false;
    if (!s.startsWith('http')) return true;  // 상대경로 = 현재 오리진(grok.com)
    try { return new URL(s).hostname.endsWith('grok.com'); } catch (_) { return false; }
  }

  /** POST 이고 grok.com 이고 DENY 에 안 걸리면 "검사 후보" */
  function isCandidate(url, method) {
    if (!method || method.toUpperCase() !== 'POST') return false;
    if (!isGrokUrl(url)) return false;
    const lower = pathOf(url).toLowerCase();
    if (DENY_PATTERNS.some(p => lower.includes(p))) return false;
    return true;
  }

  /** 후보 중에서도 실제로 dedupe 를 적용할지 — body 근거 필요 */
  function shouldDedupeBody(url, bodyStr) {
    const lower = pathOf(url).toLowerCase();
    if (ALLOW_PATTERNS.some(p => lower.includes(p))) return true;
    // 그 외에는 "의미있는 payload 가 실린 POST" 만. 구성 핑 (빈 body / {} ) 은 통과.
    return bodyStr.length >= MIN_BODY_LEN;
  }

  function bodyToString(body) {
    if (!body) return '';
    if (typeof body === 'string') return body.slice(0, 500);
    if (body instanceof URLSearchParams) return body.toString().slice(0, 500);
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
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
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return '[blob:' + body.size + '/' + (body.type || '') + ']';
    }
    try { return JSON.stringify(body).slice(0, 500); } catch (_) {}
    return String(body).slice(0, 100);
  }

  /**
   * 요청마다 달라지는 값(요청 UUID, 타임스탬프, nonce)을 제거한다.
   * 이걸 안 하면 "같은 클릭이 만든 2개의 POST" 가 서로 다른 fingerprint 를 갖게 되어
   * dedupe 가 통째로 무력화된다 (→ 영상 2개 생성 / 크레딧 2배 소모).
   */
  function normalize(s) {
    return String(s || '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/\b[0-9a-f]{24,}\b/gi, '<hex>')
      .replace(/\b\d{10,}\b/g, '<ts>');
  }

  function fingerprint(url, bodyStr) {
    return normalize(url) + '|' + normalize(bodyStr);
  }

  function isDuplicate(url, bodyStr) {
    const now = Date.now();
    for (const [k, ts] of recentPosts.entries()) {
      if (now - ts > DEDUPE_WINDOW_MS) recentPosts.delete(k);
    }
    const fp = fingerprint(url, bodyStr);
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

  const origFetch = window.fetch;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  // ─── fetch patch ───
  window.fetch = function (input, init) {
    const self = this;
    const args = arguments;
    try {
      const isReq = (typeof Request !== 'undefined') && (input instanceof Request);
      const url = isReq ? input.url : String(input || '');
      const method = (init?.method || (isReq ? input.method : 'GET') || 'GET').toUpperCase();

      if (!isCandidate(url, method)) return origFetch.apply(self, args);

      // body 확보 — init.body 우선, 없으면 Request 를 clone 해서 실제로 읽는다.
      if (init && init.body != null) {
        const bodyStr = bodyToString(init.body);
        if (!shouldDedupeBody(url, bodyStr)) {
          tracePost(url, bodyStr, 'pass(small)');
          return origFetch.apply(self, args);
        }
        if (isDuplicate(url, bodyStr)) {
          tracePost(url, bodyStr, 'BLOCK');
          return Promise.resolve(fakeOkResponse());
        }
        tracePost(url, bodyStr, 'pass');
        return origFetch.apply(self, args);
      }

      if (isReq) {
        // 대용량/멀티파트(이미지 업로드) 는 clone().text() 로 읽으면 메모리 낭비 — 그냥 통과.
        const ctype = (input.headers?.get?.('content-type') || '').toLowerCase();
        const clen = parseInt(input.headers?.get?.('content-length') || '0', 10) || 0;
        if (ctype.includes('multipart/form-data') || ctype.startsWith('image/') ||
            ctype.includes('octet-stream') || clen > 200000) {
          tracePost(url, '', 'pass(binary)');
          return origFetch.apply(self, args);
        }
        // Request 에 body 가 실려있는 케이스 — 비동기로 읽고 판단 (fetch 는 Promise 반환이므로 가능)
        let cloned = null;
        try { cloned = input.clone(); } catch (_) { cloned = null; }
        if (!cloned) return origFetch.apply(self, args);
        return cloned.text().then(
          (text) => {
            const bodyStr = String(text || '').slice(0, 500);
            if (!shouldDedupeBody(url, bodyStr)) {
              tracePost(url, bodyStr, 'pass(small)');
              return origFetch.apply(self, args);
            }
            if (isDuplicate(url, bodyStr)) {
              tracePost(url, bodyStr, 'BLOCK');
              return fakeOkResponse();
            }
            tracePost(url, bodyStr, 'pass');
            return origFetch.apply(self, args);
          },
          () => origFetch.apply(self, args)
        );
      }

      // body 없는 POST — 구성 핑일 가능성이 높다. 절대 막지 않음.
      tracePost(url, '', 'pass(nobody)');
      return origFetch.apply(self, args);
    } catch (e) {
      console.warn(LOG_PREFIX, 'fetch wrapper 에러 (원본 호출):', e.message);
      return origFetch.apply(self, args);
    }
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
      if (isCandidate(url, method)) {
        const bodyStr = bodyToString(body);
        if (shouldDedupeBody(url, bodyStr) && isDuplicate(url, bodyStr)) {
          tracePost(url, bodyStr, 'BLOCK(xhr)');
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
        tracePost(url, bodyStr, 'pass(xhr)');
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'xhr wrapper 에러 (원본 호출):', e.message);
    }
    return origXhrSend.apply(this, arguments);
  };

  console.log(LOG_PREFIX, '✅ Network dedupe installed (window=' + DEDUPE_WINDOW_MS + 'ms, 생성요청 한정 / 구성 endpoint 제외)');
})();
