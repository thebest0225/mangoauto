/**
 * MangoAuto - MangoHub API Client
 * Runs in Service Worker (background.js) to bypass CORS
 */

const MangoHubAPI = {
  BASE_URL: 'https://mangois.love',

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

  async listProjects() {
    return this.request('/api/longform/projects');
  },

  async getProject(id) {
    return this.request(`/api/longform/projects/${id}`);
  },

  async uploadImage(projectId, segmentIndex, imageBlob, filename) {
    const token = await this.getSessionToken();
    const formData = new FormData();
    formData.append('image', imageBlob, filename || 'image.png');

    const resp = await fetch(
      `${this.BASE_URL}/api/longform/projects/${projectId}/segments/${segmentIndex}/upload-image`,
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

  async uploadVideo(projectId, segmentIndex, videoBlob, filename) {
    const token = await this.getSessionToken();
    const formData = new FormData();
    formData.append('video', videoBlob, filename || 'video.mp4');

    const resp = await fetch(
      `${this.BASE_URL}/api/longform/projects/${projectId}/segments/${segmentIndex}/upload-video`,
      {
        method: 'POST',
        headers: { 'Cookie': `session_token=${token}` },
        credentials: 'include',
        body: formData
      }
    );

    if (!resp.ok) throw new Error(`Upload video failed: ${resp.status}`);
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
