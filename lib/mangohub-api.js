/**
 * MangoAuto - MangoHub API Client
 * Runs in Service Worker (background.js) to bypass CORS
 */

const MangoHubAPI = {
  BASE_URL: 'https://mangois.love',
  _apiType: 'longform', // 'longform' | 'shortform' | 'mangomaker'

  get apiPrefix() {
    return `/api/${this._apiType}`;
  },

  setApiType(type) {
    if (type === 'shortform') this._apiType = 'shortform';
    else if (type === 'mangomaker') this._apiType = 'mangomaker';
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

  async uploadImage(projectId, segmentIndex, imageBlob, filename, apiType) {
    if (apiType) this.setApiType(apiType);
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
  },

  async uploadVideo(projectId, segmentIndex, videoBlob, filename, apiType) {
    if (apiType) this.setApiType(apiType);
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
        signal: AbortSignal.timeout(120000) // 2분 타임아웃
      }
    );

    if (!resp.ok) throw new Error(`Upload video failed: ${resp.status}`);
    return resp.json();
  },

  async uploadThumbnailImage(projectId, conceptIndex, imageBlob, filename, apiType) {
    if (apiType) this.setApiType(apiType);
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
  },

  async checkAuth() {
    try {
      const token = await this.getSessionToken();
      return !!token;
    } catch {
      return false;
    }
  }
};
