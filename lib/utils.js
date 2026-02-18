/**
 * MangoAuto - Shared Utilities
 */

const MangoUtils = {
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

if (typeof window !== 'undefined') {
  window.MangoUtils = MangoUtils;
}
