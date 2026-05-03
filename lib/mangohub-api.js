/**
 * MangoAuto - MangoHub API Client
 * Runs in Service Worker (background.js) to bypass CORS
 */

const MangoHubAPI = {
  BASE_URL: 'https://mangois.love',
  _apiType: 'longform', // 'longform' | 'longform-v2' | 'shortform' | 'mangomaker'

  get apiPrefix() {
    return `/api/${this._apiType}`;
  },

  setApiType(type) {
    if (type === 'shortform') this._apiType = 'shortform';
    else if (type === 'mangomaker') this._apiType = 'mangomaker';
    else if (type === 'longform-v2') this._apiType = 'longform-v2';
    else this._apiType = 'longform';
  },

  async getSessionToken() {
    const cookie = await chrome.cookies.get({
      url: this.BASE_URL,
      name: 'session_token'
    });
    if (!cookie) throw new Error('Not logged in to MangoHub');
    return cookie.value;
  },

  async request(path, options = {}) {
    const token = await this.getSessionToken();
    const url = `${this.BASE_URL}${path}`;
    const headers = {
      'Cookie': `session_token=${token}`,
      ...(options.headers || {})
    };

    if (!(options.body instanceof FormData) && options.body && typeof options.body === 'object') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const resp = await fetch(url, {
      ...options,
      headers,
      credentials: 'include'
    });

    if (resp.status === 401) {
      throw new Error('AUTH_EXPIRED');
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API ${resp.status}: ${text}`);
    }
    return resp.json();
  },

  async listProjects(apiType) {
    if (apiType) this.setApiType(apiType);
    return this.request(`${this.apiPrefix}/projects`);
  },

  async getProject(id, apiType) {
    if (apiType) this.setApiType(apiType);
    return this.request(`${this.apiPrefix}/projects/${id}`);
  },

  // 업로드 재시도 래퍼 (최대 maxRetries회, 간격 delayMs)
  async _uploadWithRetry(fn, maxRetries = 2, delayMs = 2000) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (err.message === 'AUTH_EXPIRED') throw err; // 인증 만료는 즉시 throw
        if (attempt < maxRetries) {
          console.log(`[MangoHubAPI] 업로드 재시도 ${attempt + 1}/${maxRetries} (${delayMs}ms 후)...`);
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
    }
    throw lastErr;
  },

  async uploadImage(projectId, segmentIndex, imageBlob, filename, apiType) {
    if (apiType) this.setApiType(apiType);
    return this._uploadWithRetry(async () => {
      const token = await this.getSessionToken();
      const formData = new FormData();
      formData.append('image', imageBlob, filename || 'image.png');

      const resp = await fetch(
        `${this.BASE_URL}${this.apiPrefix}/projects/${projectId}/segments/${segmentIndex}/upload-image`,
        {
          method: 'POST',
          headers: { 'Cookie': `session_token=${token}` },
          credentials: 'include',
          body: formData
        }
      );

      if (!resp.ok) throw new Error(`Upload image failed: ${resp.status}`);
      return resp.json();
    });
  },

  async uploadVideo(projectId, segmentIndex, videoBlob, filename, apiType) {
    if (apiType) this.setApiType(apiType);
    return this._uploadWithRetry(async () => {
      const token = await this.getSessionToken();
      const formData = new FormData();
      formData.append('video', videoBlob, filename || 'video.mp4');

      const resp = await fetch(
        `${this.BASE_URL}${this.apiPrefix}/projects/${projectId}/segments/${segmentIndex}/upload-video`,
        {
          method: 'POST',
          headers: { 'Cookie': `session_token=${token}` },
          credentials: 'include',
          body: formData,
          signal: AbortSignal.timeout(300000) // 5분 타임아웃
        }
      );

      if (!resp.ok) throw new Error(`Upload video failed: ${resp.status}`);
      return resp.json();
    });
  },

  async uploadThumbnailImage(projectId, conceptIndex, imageBlob, filename, apiType) {
    if (apiType) this.setApiType(apiType);
    return this._uploadWithRetry(async () => {
      const token = await this.getSessionToken();
      const formData = new FormData();
      formData.append('image', imageBlob, filename || 'thumbnail.png');
      formData.append('concept_index', String(conceptIndex));

      const resp = await fetch(
        `${this.BASE_URL}${this.apiPrefix}/projects/${projectId}/upload-thumbnail-image`,
        {
          method: 'POST',
          headers: { 'Cookie': `session_token=${token}` },
          credentials: 'include',
          body: formData
        }
      );

      if (!resp.ok) throw new Error(`Upload thumbnail failed: ${resp.status}`);
      return resp.json();
    });
  },

  async checkAuth() {
    try {
      const token = await this.getSessionToken();
      return !!token;
    } catch {
      return false;
    }
  },

  /**
   * 인라인 로그인 — 팝업에서 username+password 받아 직접 호출.
   * 성공 시 서버가 Set-Cookie (session_token) 응답 → host_permissions 가 있으므로 chrome 쿠키 store 에 자동 저장.
   * 같은 .mangois.love 쿠키는 이후 모든 API 호출에서 자동 인식.
   */
  async login(username, password, autoLogin = true) {
    const url = `${this.BASE_URL}/api/auth/login`;
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: String(username || '').trim(),
        password: String(password || ''),
        auto_login: !!autoLogin,
      }),
    });
    if (!resp.ok) {
      let detail = '';
      try { detail = (await resp.json()).detail || ''; } catch (_) {}
      const msg = resp.status === 401 ? '아이디 또는 비밀번호가 올바르지 않습니다'
                : resp.status === 403 ? (detail || '계정 승인 대기 또는 정지 상태입니다')
                : `로그인 실패 (${resp.status}) ${detail}`;
      throw new Error(msg);
    }
    const data = await resp.json();
    return data;
  },
};
