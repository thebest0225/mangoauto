/**
 * MangoAuto - Shared Utilities
 * 중복 주입 가드 — Chrome 이 같은 페이지에 두번 주입할 때 SyntaxError 방지.
 * globalThis 사용 — service worker (importScripts 경유) 에는 window 가 없음.
 */

if (!globalThis.__MANGOAUTO_UTILS_LOADED__) {
globalThis.__MANGOAUTO_UTILS_LOADED__ = true;

var MangoUtils = {
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  async retry(fn, maxRetries = 3, delay = 2000) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === maxRetries - 1) throw err;
        console.warn(`[MangoAuto] Retry ${i + 1}/${maxRetries}:`, err.message);
        await this.sleep(delay * (i + 1));
      }
    }
  },

  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  },

  formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
  },

  truncate(str, maxLen) {
    if (!str || str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  },

  log(level, ...args) {
    const prefix = `[MangoAuto ${new Date().toLocaleTimeString()}]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  }
};

// window (content script/popup) 또는 self (service worker) 양쪽 모두 expose
if (typeof window !== 'undefined') window.MangoUtils = MangoUtils;
if (typeof self !== 'undefined') self.MangoUtils = MangoUtils;
globalThis.MangoUtils = MangoUtils;

} else {
  console.warn('[MangoAuto:Utils] 중복 주입 감지 — 두번째 로드 무시');
}
