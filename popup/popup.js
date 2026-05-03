/**
 * MangoAuto - Popup Controller (Full Redesign)
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const MANGOHUB_BASE = 'https://mangois.love';

let currentSource = 'mangohub';
let currentPlatform = 'grok';
let currentMode = 'text-image';  // text-image | image-video (프레임→영상). text-video / image-image / Whisk 제거됨.
let currentContentType = 'segments';  // segments | thumbnail
let currentProject = null;
let currentApiType = 'longform-v2';  // 'longform-v2' (기본: 롱폼 = V2) | 'shortform' | 'mangomaker'
let uploadedImages = [];  // { file, dataUrl, name }
let lastState = null;
let reviewItems = [];

// ─── Supported URL patterns (Whisk 제거됨) ───
const SUPPORTED_PATTERNS = [
  { pattern: /^https:\/\/grok\.com/,                   platform: 'grok' },
  { pattern: /^https:\/\/labs\.google\/fx\/.*tools\/video-fx/, platform: 'flow' },
  { pattern: /^https:\/\/labs\.google\/fx\/.*tools\/flow/,     platform: 'flow' },
];

function detectPlatform(url) {
  if (!url) return null;
  for (const s of SUPPORTED_PATTERNS) {
    if (s.pattern.test(url)) return s.platform;
  }
  return null;
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  await checkCurrentTab();
  await loadSettings();
  await checkAuth();
  await refreshState();
  // loadReviewMode() 제거 — 검토 탭 삭제됨
  bindEvents();
});

// ─── Check current tab and show unsupported notice if needed ───
async function checkCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || '';
    const detected = detectPlatform(url);

    if (detected) {
      // Supported page - auto-select platform tab
      $('#unsupportedNotice').classList.add('hidden');
      $('#mainContent').classList.remove('hidden');
      currentPlatform = detected;
      $$('.ptab').forEach(t => t.classList.toggle('active', t.dataset.platform === detected));
      updateModeAvailability();
    } else {
      // Unsupported page - show notice
      $('#unsupportedNotice').classList.remove('hidden');
      $('#mainContent').classList.add('hidden');
    }
  } catch {
    // Can't detect tab (e.g. chrome:// pages) - show notice
    $('#unsupportedNotice').classList.remove('hidden');
    $('#mainContent').classList.add('hidden');
  }
}

// ─── Tab change listener (update when user switches tabs or navigates) ───
chrome.tabs.onActivated.addListener(async () => {
  await checkCurrentTab();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.id === tabId) {
      await checkCurrentTab();
    }
  }
});

// ─── Auth Check ───
async function checkAuth() {
  const badge = $('#authBadge');
  const badgeText = $('#authBadgeText');
  const loginCard = $('#authLoginCard');
  try {
    const resp = await sendBg({ type: 'API_CHECK_AUTH' });
    if (resp.loggedIn) {
      badge.className = 'badge badge-on';
      badgeText.textContent = 'Connected';
      badge.title = 'MangoHub 에 연결됨';
      if (loginCard) loginCard.classList.add('hidden');
      loadProjects();
    } else {
      badge.className = 'badge badge-off';
      badgeText.textContent = 'Not Connected';
      badge.title = '클릭해서 MangoHub 로그인';
      if (loginCard) loginCard.classList.remove('hidden');
    }
  } catch {
    badge.className = 'badge badge-off';
    badgeText.textContent = 'Error';
    if (loginCard) loginCard.classList.remove('hidden');
  }
}

// MangoHub 로그인 페이지를 새 탭으로 열고, 그 탭 URL 이 / 또는 /pages/my.html 등 로그인 후 페이지로
// 바뀌면 자동으로 checkAuth() 재실행.
function openMangoHubLogin() {
  const loginUrl = 'https://mangois.love/login';
  chrome.tabs.create({ url: loginUrl, active: true }, (tab) => {
    if (!tab || !tab.id) return;
    showToast('MangoHub 로그인 창이 열렸습니다. 로그인 후 자동 감지됩니다.', 'info');
    const listener = (tabId, changeInfo) => {
      if (tabId !== tab.id) return;
      // /login 이 아닌 페이지로 이동 = 로그인 성공 가능성 높음
      if (changeInfo.url && !changeInfo.url.includes('/login')) {
        chrome.tabs.onUpdated.removeListener(listener);
        // 쿠키 반영까지 약간 대기
        setTimeout(() => { checkAuth(); }, 800);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // 30초 후 리스너 제거 (메모리 누수 방지)
    setTimeout(() => {
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
    }, 30000);
  });
}

// ─── Toast ───
function showToast(message, type = 'info', duration = 2400) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = {
    success: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  }[type] || '';
  toast.innerHTML = `${icon}<span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fading');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── Load Projects ───
async function loadProjects() {
  try {
    const projects = await sendBg({ type: 'API_LIST_PROJECTS', apiType: currentApiType });
    const select = $('#projectSelect');
    select.innerHTML = '<option value="">프로젝트 선택...</option>';
    if (Array.isArray(projects)) {
      // 최신순 정렬 (created_at > id 역순)
      projects.sort((a, b) => {
        if (a.created_at && b.created_at) return new Date(b.created_at) - new Date(a.created_at);
        return (b.id || 0) - (a.id || 0);
      });
      projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `⚪ ${p.name || `Project ${p.id}`}`;
        select.appendChild(opt);
      });
      // 백그라운드에서 각 프로젝트 상태 가져와서 동그라미 업데이트
      fetchProjectStatuses(projects);
    }
  } catch (err) {
    addLog('프로젝트 로드 실패: ' + err.message, 'error');
  }
}

// 프로젝트별 상태를 가져와서 select option에 동그라미 색 업데이트
async function fetchProjectStatuses(projects) {
  const select = $('#projectSelect');
  const promises = projects.map(async (p) => {
    try {
      const detail = await sendBg({ type: 'API_GET_PROJECT', projectId: p.id, apiType: currentApiType });
      return { id: p.id, status: getProjectStatus(detail) };
    } catch {
      return { id: p.id, status: 'unknown' };
    }
  });
  const results = await Promise.all(promises);
  results.forEach(({ id, status }) => {
    const opt = select.querySelector(`option[value="${id}"]`);
    if (!opt) return;
    const name = opt.textContent.replace(/^[⚪🟢🟡🔵⚫]\s*/, '');
    const icon = status === 'complete' ? '🟢'
               : status === 'video_done' ? '🔵'
               : status === 'image_done' ? '🟡'
               : status === 'partial' ? '🟡'
               : '⚪';
    opt.textContent = `${icon} ${name}`;
  });
}

// 프로젝트 상세 데이터로 완성도 판별
function getProjectStatus(project) {
  // mangomaker: scenes 배열 사용
  let segments;
  if (currentApiType === 'mangomaker') {
    const scenes = project.scenes || [];
    segments = scenes.map(sc => ({
      image_url: sc.bg?.type === 'image' ? sc.bg.value : '',
      video_url: sc.bg?.type === 'video' ? sc.bg.value : '',
    }));
  } else {
    segments = project.segments || [];
  }
  if (segments.length === 0) return 'empty';
  const withImage = segments.filter(s => s.image_url).length;
  const withVideo = segments.filter(s => s.video_url).length;
  const total = segments.length;
  if (withVideo === total && withImage === total) return 'complete';
  if (withVideo === total) return 'video_done';
  if (withImage === total) return 'image_done';
  if (withImage > 0 || withVideo > 0) return 'partial';
  return 'empty';
}

// ─── Bind All Events ───
function bindEvents() {
  // Auth badge — connected 면 로그아웃 옵션, 안 connected 면 폼에 포커스
  const badgeEl = $('#authBadge');
  if (badgeEl) badgeEl.addEventListener('click', async () => {
    if (badgeEl.classList.contains('badge-on')) {
      if (!confirm('MangoHub 에서 로그아웃할까요?')) return;
      try { await sendBg({ type: 'API_LOGOUT' }); } catch (_) {}
      showToast('로그아웃됨', 'info');
      await checkAuth();
    } else {
      const userInput = $('#authLoginUser');
      if (userInput) userInput.focus();
    }
  });

  // Inline 로그인 폼 — POST /api/auth/login (background 가 fetch + Set-Cookie 처리)
  const loginForm = $('#authLoginForm');
  const loginBtn = $('#authLoginBtn');
  const loginErr = $('#authLoginError');
  if (loginForm) loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = ($('#authLoginUser').value || '').trim();
    const password = $('#authLoginPass').value || '';
    const autoLogin = !!($('#authAutoLogin') && $('#authAutoLogin').checked);
    if (!username || !password) { showToast('아이디와 비밀번호를 입력해주세요', 'error'); return; }
    if (loginErr) loginErr.classList.add('hidden');
    if (loginBtn) { loginBtn.disabled = true; loginBtn.style.opacity = 0.6; }
    try {
      const r = await sendBg({ type: 'API_LOGIN', username, password, autoLogin });
      if (!r || !r.ok) throw new Error((r && r.error) || '로그인 실패');
      showToast(`환영합니다, ${(r.user && (r.user.username || r.user.email)) || ''}`, 'success');
      const passEl = $('#authLoginPass'); if (passEl) passEl.value = '';
      // 쿠키 반영 약간 대기 후 재확인
      setTimeout(() => checkAuth(), 250);
    } catch (er) {
      const msg = er.message || String(er);
      if (loginErr) { loginErr.textContent = msg; loginErr.classList.remove('hidden'); }
      showToast(msg, 'error');
    } finally {
      if (loginBtn) { loginBtn.disabled = false; loginBtn.style.opacity = 1; }
    }
  });

  // 웹에서 로그인 — 기존 동작 fallback (인라인 로그인 막힐 때, 또는 Cloudflare Access 같은 외부 인증 우회)
  const openWebBtn = $('#authOpenWebBtn');
  if (openWebBtn) openWebBtn.addEventListener('click', openMangoHubLogin);

  // Unsupported page links - navigate current tab
  $$('.unsupported-link').forEach(link => {
    link.addEventListener('click', async (e) => {
      e.preventDefault();
      const url = link.dataset.url;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
      }
    });
  });

  // Platform tabs
  $$('.ptab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.ptab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPlatform = tab.dataset.platform;
      updateModeAvailability();
    });
  });

  // Main tabs (workspace / settings) — 검토 탭 제거됨
  $$('.mtab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.mtab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      $('#workspacePanel').classList.toggle('hidden', target !== 'workspace');
      $('#settingsPanel').classList.toggle('hidden', target !== 'settings');
    });
  });

  // Source tabs (mangohub / standalone)
  $$('.stab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.stab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSource = tab.dataset.source;
      $('#mangohubSection').classList.toggle('hidden', currentSource !== 'mangohub');
      $('#standaloneSection').classList.toggle('hidden', currentSource !== 'standalone');
    });
  });

  // Mode buttons
  $$('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMode = btn.dataset.mode;
      updateModeUI();
    });
  });

  // Content type tabs (segments / thumbnail)
  $$('.ctab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.ctab').forEach(t => {
        t.classList.remove('active');
        t.style.background = '#fff';
        t.style.color = '#666';
      });
      tab.classList.add('active');
      tab.style.background = '#4f46e5';
      tab.style.color = '#fff';
      currentContentType = tab.dataset.ctype;
      updateProjectInfo();
      updateQueuePreview();
    });
  });

  // Load project
  $('#loadProjectBtn').addEventListener('click', loadProject);
  $('#refreshProjectsBtn').addEventListener('click', loadProjects);

  // 롱폼/숏폼 탭 전환
  $$('.api-type-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      currentApiType = tab.dataset.api;
      $$('.api-type-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.api === currentApiType);
        t.style.background = t.dataset.api === currentApiType ? '#4f46e5' : 'transparent';
        t.style.color = t.dataset.api === currentApiType ? '#fff' : '#aaa';
      });
      currentProject = null;
      $('#projectInfo').classList.add('hidden');
      loadProjects();
    });
  });

  // Image upload
  const imagesInput = $('#imagesInput');
  imagesInput.addEventListener('change', handleImageUpload);

  // Drag and drop
  const uploadArea = $('#uploadArea');
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      // Create a synthetic event-like object for handleImageUpload
      handleImageUpload({ target: { files: e.dataTransfer.files, value: '' } });
    }
  });

  // Prompt file import
  $('#promptFileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const current = $('#promptsInput').value;
    $('#promptsInput').value = current ? current + '\n\n' + text : text;
    updateQueuePreview();
    addLog(`프롬프트 파일 가져옴: ${file.name}`, 'info');
  });

  // Reset button
  $('#resetBtn').addEventListener('click', () => {
    if (confirm('프롬프트와 이미지를 모두 초기화하시겠습니까?')) {
      $('#promptsInput').value = '';
      uploadedImages = [];
      $('#imagePreviewList').innerHTML = '';
      $('#imagesInput').value = '';
      updateQueuePreview();
      addLog('초기화 완료', 'info');
    }
  });

  // Controls
  $('#startBtn').addEventListener('click', startAutomation);
  $('#pauseBtn').addEventListener('click', async () => {
    await sendBg({ type: 'PAUSE_AUTOMATION' });
    addLog('일시정지', 'info');
  });
  $('#resumeBtn').addEventListener('click', async () => {
    await sendBg({ type: 'RESUME_AUTOMATION' });
    addLog('재개', 'info');
  });
  $('#stopBtn').addEventListener('click', async () => {
    if (confirm('자동화를 중지하시겠습니까?')) {
      await sendBg({ type: 'STOP_AUTOMATION' });
      addLog('중지됨', 'info');
      // Immediately update UI
      $('#startBtn').classList.remove('hidden');
      $('#stopBtn').classList.add('hidden');
      $('#pauseBtn').classList.add('hidden');
      $('#resumeBtn').classList.add('hidden');
    }
  });
  $('#downloadAllBtn').addEventListener('click', () => sendBg({ type: 'DOWNLOAD_ALL_RESULTS' }));
  $('#retryFailedBtn').addEventListener('click', async () => {
    const result = await sendBg({ type: 'RETRY_FAILED' });
    if (result?.error) {
      addLog(result.error, 'error');
    } else if (result?.count > 0) {
      addLog(`실패 ${result.count}개 항목 재시도 시작`, 'info');
    } else {
      addLog('재시도할 실패 항목이 없습니다', 'info');
    }
  });
  $('#retrySelectedBtn').addEventListener('click', async () => {
    const checks = $$('.queue-check:checked');
    const indices = [...checks].map(cb => parseInt(cb.dataset.index));
    if (indices.length === 0) {
      addLog('재생성할 항목을 선택해주세요', 'error');
      return;
    }
    // 체크박스 제거
    $$('.queue-check').forEach(cb => cb.remove());
    _completionLogged = false;
    _authExpiredLogged = false;
    startStatePolling();
    const result = await sendBg({ type: 'RETRY_SELECTED', indices });
    if (result?.error) {
      addLog(result.error, 'error');
    } else if (result?.count > 0) {
      addLog(`선택 ${result.count}개 항목 재생성 시작`, 'success');
    }
  });

  // 대기열 전체선택 토글
  $('#queueSelectAll').addEventListener('change', (e) => {
    $$('.queue-select').forEach(cb => { cb.checked = e.target.checked; });
    updateQueueSelectedCount();
    // 전체선택 시 퍼센트 버튼 active 해제
    $$('.qs-pct-btn').forEach(b => b.classList.toggle('active', e.target.checked ? false : false));
  });

  // 대기열 개별 체크 → 전체선택 동기화 (이벤트 위임)
  $('#queueList').addEventListener('change', (e) => {
    if (e.target.classList.contains('queue-select')) {
      updateQueueSelectedCount();
      // 수동 체크 시 퍼센트 버튼 active 해제
      $$('.qs-pct-btn').forEach(b => b.classList.remove('active'));
    }
  });

  // 대기열 퀵 선택 (25%, 50%, 75%, hybrid)
  $$('.qs-pct-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      const allCbs = $$('.queue-select');
      const total = allCbs.length;
      if (total === 0) return;
      const wasActive = btn.classList.contains('active');
      $$('.qs-pct-btn').forEach(b => b.classList.remove('active'));
      if (wasActive) {
        // 같은 버튼 다시 누르면 전체 선택
        allCbs.forEach(cb => { cb.checked = true; });
        const selectAll = $('#queueSelectAll');
        if (selectAll) selectAll.checked = true;
        updateQueueSelectedCount();
        return;
      }
      if (mode === 'hybrid25') {
        // 1~25번 전체 + 26번부터 홀수번만 (27, 29, 31, ...)
        allCbs.forEach((cb, i) => {
          const oneBased = i + 1;
          if (oneBased <= 25) cb.checked = true;
          else cb.checked = (oneBased % 2 === 1);
        });
      } else if (mode === 'hybrid40') {
        // 1~40번 전체 + 41번부터 짝수번만 (42, 44, 46, ...)
        allCbs.forEach((cb, i) => {
          const oneBased = i + 1;
          if (oneBased <= 40) cb.checked = true;
          else cb.checked = (oneBased % 2 === 0);
        });
      } else {
        const pct = parseInt(btn.dataset.pct);
        const selectCount = Math.max(1, Math.round(total * pct / 100));
        allCbs.forEach((cb, i) => { cb.checked = i < selectCount; });
      }
      btn.classList.add('active');
      const selectAll = $('#queueSelectAll');
      if (selectAll) selectAll.checked = false;
      updateQueueSelectedCount();
    });
  });

  // Save settings
  $('#saveSettingsBtn').addEventListener('click', saveSettings);

  // API Key export/import
  $('#exportApiKeyBtn').addEventListener('click', async () => {
    const key = $('#kieApiKey').value.trim();
    if (!key) {
      addLog('내보낼 API 키가 없습니다', 'error');
      return;
    }
    const result = await sendBg({ type: 'EXPORT_API_KEY', apiKey: key });
    if (result?.ok) {
      addLog('API 키 파일 내보내기 완료 (MangoAuto 폴더)', 'success');
    } else {
      addLog('API 키 내보내기 실패: ' + (result?.error || ''), 'error');
    }
  });

  $('#importApiKeyFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const key = text.trim();
      if (key && key.length > 5) {
        $('#kieApiKey').value = key;
        addLog('API 키 가져오기 완료', 'success');
        // 자동 저장 (silent — toast 는 API 키 가져오기 토스트가 있으면 중복)
        await saveSettings({ silent: true });
      } else {
        addLog('유효하지 않은 키 파일입니다', 'error');
      }
    } catch (err) {
      addLog('키 파일 읽기 실패: ' + err.message, 'error');
    }
    e.target.value = '';
  });

  // ── Review tab events 제거됨 (검토 탭 삭제) ──
}

// ─── Mode UI Update ───
function updateModeUI() {
  const needsImageUpload = currentMode === 'image-video';  // 프레임→영상만 이미지 업로드 필요
  const imageSection = $('#imageUploadSection');
  if (currentSource === 'standalone') {
    imageSection.classList.toggle('hidden', !needsImageUpload);
  } else {
    imageSection.classList.add('hidden');
  }
}

function updateModeAvailability() {
  // Whisk/text-video/image-image 제거로 플랫폼별 모드 제한 불필요. 모든 모드 항상 활성.
  $$('.mode-btn').forEach(btn => {
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
  });
  // (이전에 있던 자동 setMode 스위칭 — 사용하는 모드 2개뿐이라 불필요)
}

function setMode(mode) {
  currentMode = mode;
  $$('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  updateModeUI();
}

// ─── Load Project ───
async function loadProject() {
  const projectId = $('#projectSelect').value;
  if (!projectId) return;
  try {
    const project = await sendBg({ type: 'API_GET_PROJECT', projectId, apiType: currentApiType });
    currentProject = project;

    $('#projectName').textContent = project.name || 'Unnamed';
    $('#projectInfo').classList.remove('hidden');

    updateProjectInfo();
    updateQueuePreview();

    const thumbCount = (project.thumbnail_concepts?.concepts || []).filter(c => c.prompt).length;
    const sceneCount = currentApiType === 'mangomaker'
      ? (project.scenes || []).length
      : (project.segments || []).length;
    addLog(`불러옴: ${project.name} (${currentApiType === 'mangomaker' ? '씬' : '세그먼트'} ${sceneCount}개, 썸네일 ${thumbCount}개)`, 'info');
  } catch (err) {
    addLog('프로젝트 로드 실패: ' + err.message, 'error');
  }
}

// mangomaker scenes → segment 형식으로 변환 (popup용)
// _analysis.scenes 기준으로 순회 (scenes[]는 이미지 생성 전 비어있을 수 있음)
function getMakerSegments(project) {
  const analysisScenes = project._analysis?.scenes || [];
  const scenes = project.scenes || [];
  return analysisScenes.map((asc, i) => {
    const sc = scenes[i] || {};
    return {
      index: i,
      text: asc.text || sc.script_text || '',
      prompt: asc.image_prompt || asc.keyword_en || '',
      video_prompt: asc.video_prompt || '',
      image_url: sc.bg?.type === 'image' ? sc.bg.value : '',
      video_url: sc.bg?.type === 'video' ? sc.bg.value : '',
    };
  });
}

// ─── Update Project Info based on content type ───
function updateProjectInfo() {
  if (!currentProject) return;

  const segmentCount = $('#segmentCount');
  const thumbInfo = $('#thumbnailInfo');
  const thumbCount = $('#thumbnailCount');

  if (currentContentType === 'thumbnail') {
    // 썸네일 정보 표시
    const concepts = currentProject.thumbnail_concepts?.concepts || [];
    const thumbImages = currentProject.thumbnail_images || {};
    const withPrompt = concepts.filter(c => c.prompt).length;
    const withImage = Object.keys(thumbImages).length;

    segmentCount.textContent =
      `썸네일 ${concepts.length}개 | 프롬프트 ${withPrompt}개 | 생성완료 ${withImage}개`;
    thumbInfo.classList.add('hidden');
  } else {
    // 세그먼트 정보 표시
    const segments = currentApiType === 'mangomaker'
      ? getMakerSegments(currentProject)
      : (currentProject.segments || []);
    const withImagePrompt = segments.filter(s => s.prompt).length;
    const withVideoPrompt = segments.filter(s => s.video_prompt).length;
    const withImage = segments.filter(s => s.image_url).length;
    const withVideo = segments.filter(s => s.video_url).length;
    const unitName = currentApiType === 'mangomaker' ? '씬' : '세그먼트';

    segmentCount.textContent =
      `${segments.length}개 ${unitName} | 이미지프롬프트 ${withImagePrompt} | 영상프롬프트 ${withVideoPrompt} | 이미지 ${withImage}장 | 영상 ${withVideo}개`;

    // 썸네일 요약도 하단에 표시
    const concepts = currentProject.thumbnail_concepts?.concepts || [];
    const thumbImages = currentProject.thumbnail_images || {};
    const thumbWithPrompt = concepts.filter(c => c.prompt).length;
    const thumbWithImage = Object.keys(thumbImages).length;
    if (thumbWithPrompt > 0) {
      thumbCount.textContent = `썸네일 프롬프트 ${thumbWithPrompt}개 | 생성완료 ${thumbWithImage}개`;
      thumbInfo.classList.remove('hidden');
    } else {
      thumbInfo.classList.add('hidden');
    }
  }
}

// ─── Update Queue Preview ───
function updateQueuePreview() {
  const queueList = $('#queueList');
  const queueCount = $('#queueCount');
  queueList.innerHTML = '';

  let items = [];

  if (currentSource === 'mangohub' && currentProject) {
    const skipCompleted = $('#skipCompleted').checked;

    if (currentContentType === 'thumbnail') {
      // 썸네일 큐
      const concepts = currentProject.thumbnail_concepts?.concepts || [];
      const thumbImages = currentProject.thumbnail_images || {};
      for (let i = 0; i < concepts.length; i++) {
        const c = concepts[i];
        if (!c.prompt) continue;
        const hasExisting = !!thumbImages[String(i)];
        if (skipCompleted && hasExisting) continue;
        items.push({
          idx: i,
          _isMangoHub: true,
          _isThumbnail: true,
          text: `[${c.group || '?'}] ${(c.name || c.prompt).substring(0, 50)}`,
          hasImage: hasExisting,
          imageUrl: thumbImages[String(i)] ? resolveMangoUrl(thumbImages[String(i)]) : null,
          imageName: `thumb_${String(i).padStart(2, '0')}`
        });
      }
    } else {
      // 세그먼트 큐
      const segments = currentApiType === 'mangomaker'
        ? getMakerSegments(currentProject)
        : (currentProject.segments || []);
      for (const seg of segments) {
        let prompt, hasExisting;
        if (currentMode === 'text-image') {
          prompt = seg.prompt;
          hasExisting = !!seg.image_url;
        } else {
          prompt = seg.video_prompt;
          hasExisting = !!seg.video_url;
        }
        if (!prompt) continue;
        if (skipCompleted && hasExisting) continue;
        items.push({
          idx: seg.index,  // MangoHub seg.index는 1-based
          _isMangoHub: true,
          text: prompt.substring(0, 60),
          hasImage: !!seg.image_url,
          imageUrl: seg.image_url ? resolveMangoUrl(seg.image_url) : null,
          imageName: seg.image_url ? `seg_${String(seg.index).padStart(3, '0')}` : null
        });
      }
    }
  } else if (currentSource === 'standalone') {
    const prompts = parsePrompts($('#promptsInput').value || '');
    items = prompts.map((p, i) => ({ idx: i, _isMangoHub: false, text: p.substring(0, 60) }));
  }

  queueCount.textContent = `${items.length}개`;

  for (const item of items) {
    const div = document.createElement('div');
    div.className = 'queue-item';
    let thumbHtml = '';
    if (item.imageUrl) {
      thumbHtml = `<img class="queue-thumb" src="${escapeHtml(item.imageUrl)}" title="${escapeHtml(item.imageName || '')}">`;
    }
    // longform/shortform은 seg.index가 1-based, longform-v2/mangomaker/standalone은 0-based → +1
    const displayIdx = item._isThumbnail ? item.idx + 1
      : (item._isMangoHub && currentApiType !== 'mangomaker' && currentApiType !== 'longform-v2') ? item.idx
      : item.idx + 1;
    div.innerHTML = `
      <input type="checkbox" class="queue-check queue-select" data-idx="${item.idx}" checked>
      <span class="queue-idx">${String(displayIdx).padStart(3, '0')}</span>
      ${thumbHtml}
      <span class="queue-text">${escapeHtml(item.text)}</span>
      <span class="queue-status qs-pending">대기</span>
    `;
    queueList.appendChild(div);
  }

  // 전체선택 체크박스 초기 상태
  const selectAll = $('#queueSelectAll');
  if (selectAll) selectAll.checked = true;
  updateQueueSelectedCount();
}

// ─── Queue Selection Helpers ───
function updateQueueSelectedCount() {
  const all = $$('.queue-select');
  const checked = $$('.queue-select:checked');
  const queueCount = $('#queueCount');
  if (all.length === 0) {
    queueCount.textContent = '0개';
  } else if (checked.length === all.length) {
    queueCount.textContent = `${all.length}개`;
  } else {
    queueCount.textContent = `${checked.length}/${all.length}개`;
  }
  // 전체선택 동기화
  const selectAll = $('#queueSelectAll');
  if (selectAll) selectAll.checked = all.length > 0 && checked.length === all.length;
}

// ─── Image Upload Handler (append, sort, delete) ───
async function handleImageUpload(e) {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  for (const file of files) {
    // Skip duplicates by name
    if (uploadedImages.some(img => img.name === file.name)) continue;
    const dataUrl = await fileToDataUrl(file);
    uploadedImages.push({ file, dataUrl, name: file.name });
  }

  // Sort by name (natural sort)
  uploadedImages.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  // Clear file input so re-selecting same file triggers change event
  e.target.value = '';

  renderImagePreviews();
  updateQueuePreview();
}

function renderImagePreviews() {
  const previewList = $('#imagePreviewList');
  previewList.innerHTML = '';

  for (let i = 0; i < uploadedImages.length; i++) {
    const imgData = uploadedImages[i];

    const wrapper = document.createElement('div');
    wrapper.className = 'image-preview-wrapper';
    wrapper.draggable = true;
    wrapper.dataset.idx = i;

    // Order badge (top-left number)
    const orderBadge = document.createElement('div');
    orderBadge.className = 'image-order-badge';
    orderBadge.textContent = i + 1;

    const img = document.createElement('img');
    img.src = imgData.dataUrl;
    img.className = 'image-preview-item';
    img.title = imgData.name;
    img.draggable = false; // prevent img native drag

    const nameLabel = document.createElement('div');
    nameLabel.className = 'image-preview-name';
    nameLabel.textContent = imgData.name;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'image-delete-btn';
    deleteBtn.textContent = '\u00d7';
    deleteBtn.title = '삭제';
    deleteBtn.dataset.idx = i;
    deleteBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const idx = parseInt(ev.currentTarget.dataset.idx);
      uploadedImages.splice(idx, 1);
      renderImagePreviews();
      updateQueuePreview();
    });

    // ── Drag-and-drop reorder ──
    wrapper.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', String(i));
      ev.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => wrapper.classList.add('dragging'));
    });
    wrapper.addEventListener('dragend', () => {
      wrapper.classList.remove('dragging');
      // Clean up all drag-over states
      previewList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    wrapper.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      wrapper.classList.add('drag-over');
    });
    wrapper.addEventListener('dragleave', () => {
      wrapper.classList.remove('drag-over');
    });
    wrapper.addEventListener('drop', (ev) => {
      ev.preventDefault();
      wrapper.classList.remove('drag-over');
      const fromIdx = parseInt(ev.dataTransfer.getData('text/plain'));
      const toIdx = parseInt(wrapper.dataset.idx);
      if (fromIdx !== toIdx && !isNaN(fromIdx) && !isNaN(toIdx)) {
        const [moved] = uploadedImages.splice(fromIdx, 1);
        uploadedImages.splice(toIdx, 0, moved);
        renderImagePreviews();
        updateQueuePreview();
      }
    });

    wrapper.appendChild(orderBadge);
    wrapper.appendChild(img);
    wrapper.appendChild(nameLabel);
    wrapper.appendChild(deleteBtn);
    previewList.appendChild(wrapper);
  }

  if (uploadedImages.length > 0) {
    const badge = document.createElement('div');
    badge.className = 'image-count-badge';
    badge.textContent = `${uploadedImages.length}장 선택됨`;
    previewList.appendChild(badge);
  }
}

// ─── Start Automation ───
async function startAutomation() {
  const settings = gatherSettings();

  const config = {
    source: currentSource,
    platform: currentPlatform,
    mode: currentMode,
    settings
  };

  if (currentSource === 'mangohub') {
    config.projectId = $('#projectSelect').value;
    if (!config.projectId) {
      addLog('프로젝트를 선택해주세요', 'error');
      return;
    }
    config.projectName = currentProject?.name || '';
    config.contentType = currentContentType;
    config.apiType = currentApiType;
    config.useExistingImages = $('#useExistingImages').checked;
    config.skipCompleted = $('#skipCompleted').checked;

    // 선택된 항목만 전송 (체크된 인덱스 수집)
    const checkedBoxes = $$('.queue-select:checked');
    const allBoxes = $$('.queue-select');
    if (checkedBoxes.length === 0) {
      addLog('변환할 항목을 선택해주세요', 'error');
      return;
    }
    // 항상 체크된 인덱스를 전달 (대기열이 skipCompleted 등으로 이미 필터된 상태이므로)
    config.selectedIndices = [...checkedBoxes].map(cb => parseInt(cb.dataset.idx));
  } else {
    // Standalone - 빈 줄로 구분된 프롬프트 파싱
    const prompts = parsePrompts($('#promptsInput').value || '');
    if (prompts.length === 0 && uploadedImages.length === 0) {
      addLog('프롬프트 또는 이미지를 입력해주세요', 'error');
      return;
    }
    config.prompts = prompts;

    // For image-to-video, include uploaded images as dataUrls
    if (currentMode === 'image-video' && uploadedImages.length > 0) {
      config.images = uploadedImages.map(img => ({
        dataUrl: img.dataUrl,
        name: img.name
      }));
    }
  }

  try {
    const result = await sendBg({ type: 'START_AUTOMATION', config });
    if (result.error) {
      addLog(result.error, 'error');
    } else {
      addLog(`시작: ${result.count}개 항목`, 'success');
      $('#logSection').classList.remove('hidden');
      $('#progressSection').classList.remove('hidden');
      // Immediately update UI to show controls
      $('#startBtn').classList.add('hidden');
      $('#stopBtn').classList.remove('hidden');
      $('#pauseBtn').classList.remove('hidden');
      // Reset completion flags and restart polling
      _completionLogged = false;
      _authExpiredLogged = false;
      startStatePolling();
    }
  } catch (err) {
    addLog('시작 실패: ' + err.message, 'error');
  }

  // 자동 상태 저장 (UI 상태 — 토스트는 설정 화면에서만 띄움)
  saveSettings({ silent: true });
}

// ─── Gather Settings ───
function gatherSettings() {
  return {
    grok: {
      videoDuration: $('#grokVideoDuration').value,
      videoResolution: $('#grokVideoResolution').value,
      aspectRatio: $('#grokAspectRatio').value,
      timeout: parseInt($('#grokTimeout').value) || 5,
      autoUpscale: $('#grokAutoUpscale').checked
    },
    flowVideo: {
      model: $('#flowVideoModel').value,
      aspectRatio: $('#flowVideoAspectRatio').value,
      frameDuration: $('#flowVideoFrameDuration').value,
      outputCount: parseInt($('#flowVideoOutputCount').value) || 1
    },
    flowImage: {
      model: $('#flowImageModel').value,
      aspectRatio: $('#flowImageAspectRatio').value,
      outputCount: parseInt($('#flowImageOutputCount').value) || 1
    },
    flowTimeout: parseInt($('#flowTimeout').value) || 3,
    image: {
      model: $('#imageModel').value,
      aspectRatio: $('#imageAspectRatio').value,
      outputCount: parseInt($('#imageOutputCount').value) || 1
    },
    download: {
      videoQuality: $('#downloadVideoQuality').value,
      imageQuality: $('#downloadImageQuality').value,
      naming: $('#downloadNaming').value,
      delay: parseInt($('#downloadDelay').value) || 30,
      perProject: $('#downloadPerProject').checked
    },
    general: {
      cooldownMin: parseInt($('#cooldownMin').value) || 10,
      cooldownMax: parseInt($('#cooldownMax').value) || 15,
      retryOnFailure: $('#retryOnFailure').checked,
      maxRetries: parseInt($('#maxRetries').value) || 3,
      defaultMode: $('#defaultMode').value,
      concurrentCount: 1,  // 항상 1 (순차 처리). UI 에서 제거됨.
      promptDelay: parseInt($('#promptDelay').value) || 40
    },
    llm: {
      enabled: $('#llmRewriteEnabled').checked,
      kieApiKey: $('#kieApiKey').value.trim(),
      retryCount: parseInt($('#llmRetryCount').value) || 2
    }
  };
}

// ─── Update UI from State ───
function updateUI(state) {
  if (!state) return;
  lastState = state;

  const isRunning = !['IDLE', 'COMPLETED'].includes(state.state);
  const isPaused = state.state === 'PAUSED';
  const isCompleted = state.state === 'COMPLETED';

  // Controls
  $('#startBtn').classList.toggle('hidden', isRunning);
  $('#pauseBtn').classList.toggle('hidden', !isRunning || isPaused);
  $('#resumeBtn').classList.toggle('hidden', !isPaused);
  $('#stopBtn').classList.toggle('hidden', !isRunning);
  const hasFailed = isCompleted && state.failedCount > 0;
  $('#retryFailedBtn').classList.toggle('hidden', !hasFailed);
  $('#retrySelectedBtn').classList.toggle('hidden', !isCompleted || state.totalCount === 0);
  $('#downloadAllBtn').classList.toggle('hidden', !isCompleted);

  // Progress
  const showProgress = isRunning || isCompleted;
  $('#progressSection').classList.toggle('hidden', !showProgress);
  $('#logSection').classList.toggle('hidden', !showProgress && !isCompleted);

  if (showProgress) {
    const total = state.totalCount || 1;
    const done = state.completedCount + state.failedCount;
    const pct = Math.round((done / total) * 100);

    $('#progressLabel').textContent = `완료 ${done}/${total}`;
    $('#progressPercent').textContent = `${pct}%`;
    $('#progressFill').style.width = `${pct}%`;

    if (state.currentItem) {
      const stateLabels = {
        PREPARING: '준비 중',
        GENERATING: '생성 중',
        WAITING: '대기 중',
        DOWNLOADING: '다운로드 중',
        UPLOADING: '업로드 중',
        COOLDOWN: '쿨다운',
        ERROR: '에러 (재시도)',
        PAUSED: '일시정지'
      };
      const label = stateLabels[state.state] || state.state;
      $('#currentStatus').textContent = `[${label}] ${state.currentItem.text || ''}`;
    }

    // Update queue list items
    updateQueueListFromState(state);
  }

  if (isCompleted && state.totalCount > 0 && !_completionLogged) {
    _completionLogged = true;
    addLog(`완료! 성공 ${state.completedCount}개, 실패 ${state.failedCount}개`, 'success');
    stopStatePolling();
  }

  if (state.authExpired && !_authExpiredLogged) {
    _authExpiredLogged = true;
    addLog('MangoHub 세션 만료. 다시 로그인 후 재개해주세요.', 'error');
  }

  // 작업 시작되면 플래그 리셋
  if (isRunning && !isPaused) {
    _completionLogged = false;
    _authExpiredLogged = false;
  }
}

function updateQueueListFromState(state) {
  const items = $('#queueList').querySelectorAll('.queue-item');
  if (!state.results) return;

  const isCompleted = state.state === 'COMPLETED';

  // 결과 맵 빌드 (segmentIndex → result object)
  // MangoHub: segmentIndex(1-based)로 매칭, Standalone: index(0-based)로 매칭
  const doneMap = new Map();
  for (const r of state.results) {
    const key = r.segmentIndex !== undefined ? r.segmentIndex : r.index;
    doneMap.set(key, r);
  }

  // 파이프라인 모드: 현재 진행 중인 항목 인덱스 (segmentIndex 기준)
  const activeSet = new Set(state.activeIndices || []);
  // 현재 진행중 항목의 segmentIndex (선택 필터링 시 currentIndex와 DOM 위치 불일치 방지)
  const currentSegIdx = state.currentItem?.segmentIndex;

  items.forEach((item, i) => {
    const statusEl = item.querySelector('.queue-status');
    if (!statusEl) return;

    // data-idx(segmentIndex) 기준으로 매칭 (DOM 위치가 아닌 실제 세그먼트 인덱스)
    const selectBox = item.querySelector('.queue-select');
    const segIdx = selectBox ? parseInt(selectBox.dataset.idx) : i;

    if (doneMap.has(segIdx)) {
      // 완료 또는 실패
      const result = doneMap.get(segIdx);
      const success = result.success;
      statusEl.textContent = success ? '완료' : '실패';
      statusEl.className = `queue-status ${success ? 'qs-done' : 'qs-fail'}`;
      // 재업로드 버튼: 실패 항목 + 성공 항목 모두 (서버에 실제 안 올라갔을 수 있으므로)
      if (!item.querySelector('.reupload-btn')) {
        const btn = document.createElement('button');
        btn.className = 'reupload-btn';
        btn.textContent = '재업';
        btn.title = 'MangoHub에 재업로드';
        const btnColor = success ? '#6b7280' : '#f59e0b'; // 성공=회색, 실패=노랑
        btn.style.cssText = `margin-left:4px;padding:1px 6px;font-size:10px;background:${btnColor};color:#fff;border:none;border-radius:3px;cursor:pointer;font-weight:600;`;
        btn.onclick = async (e) => {
          e.stopPropagation();
          btn.disabled = true; btn.textContent = '...';
          const res = await sendBg({ type: 'REUPLOAD_ITEM', segmentIndex: segIdx });
          if (res?.success) {
            btn.textContent = '✓';
            btn.style.background = '#22c55e';
            statusEl.textContent = '완료';
            statusEl.className = 'queue-status qs-done';
          } else {
            btn.textContent = '재업';
            btn.disabled = false;
            addLog(`재업로드 실패: ${res?.error || '알 수 없는 오류'}`, 'error');
          }
        };
        statusEl.parentElement.appendChild(btn);
      }
    } else if (activeSet.size > 0 ? activeSet.has(segIdx) : segIdx === currentSegIdx) {
      // 진행중 (파이프라인: activeIndices, 순차: currentItem.segmentIndex)
      statusEl.textContent = '진행중';
      statusEl.className = 'queue-status qs-running';
    } else {
      // 대기
      statusEl.textContent = '대기';
      statusEl.className = 'queue-status qs-pending';
    }

    // 완료 상태에서 체크박스 표시 (queue-select 이미 있으면 재사용)
    if (isCompleted && !item.querySelector('.queue-check:not(.queue-select)')) {
      const existing = item.querySelector('.queue-select');
      if (existing) {
        // 프리뷰 체크박스를 재시도용으로 전환
        existing.dataset.index = segIdx;
      } else {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'queue-check';
        cb.dataset.index = segIdx;
        item.insertBefore(cb, item.firstChild);
      }
    }
  });
}

// ─── State polling (1초마다 background에서 상태 가져오기) ───
let _pollTimer = null;
let _completionLogged = false;
let _authExpiredLogged = false;

function startStatePolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(async () => {
    try {
      const state = await sendBg({ type: 'GET_STATE' });
      if (state && !state.error) updateUI(state);
    } catch { /* background not ready */ }
  }, 1000);
}

function stopStatePolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

// LOG 메시지는 여전히 실시간으로 받기
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') {
    addLog(msg.text, msg.level);
  }
  if (msg.type === 'STATE_UPDATE') {
    updateUI(msg.data);
  }
  // 검토 실시간 업데이트
  if (msg.type === 'REVIEW_ITEM_ADDED') {
    reviewItems.push(msg.item);
    renderReviewList();
  }
  if (msg.type === 'REVIEW_ITEM_UPDATED') {
    const item = reviewItems.find(i => i.id === msg.id);
    if (item) {
      item.status = msg.status;
      if (msg.error) item.error = msg.error;
      renderReviewList();
    }
  }
});

async function refreshState() {
  try {
    const state = await sendBg({ type: 'GET_STATE' });
    if (state && !state.error) updateUI(state);
  } catch {}
  startStatePolling();
}

// ─── Log ───
function addLog(text, type = 'info') {
  const container = $('#logContainer');
  if (!container) return;
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  const time = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.textContent = `${time} ${text}`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
  while (container.children.length > 100) {
    container.removeChild(container.firstChild);
  }
  // Auto-show log section
  $('#logSection').classList.remove('hidden');
}

// ─── Settings Persistence ───
async function saveSettings(opts) {
  const silent = !!(opts && opts.silent);
  const settings = gatherSettings();
  await chrome.storage.local.set({
    'mangoauto_settings': {
      ...settings,
      _ui: {
        source: currentSource,
        platform: currentPlatform,
        mode: currentMode,
        contentType: currentContentType,
        projectId: $('#projectSelect').value
      }
    }
  });

  addLog('설정 저장됨', 'info');
  if (!silent && typeof showToast === 'function') {
    showToast('설정이 저장되었습니다', 'success');
  }
}

async function loadSettings() {
  const data = await chrome.storage.local.get('mangoauto_settings');
  const s = data.mangoauto_settings;
  if (!s) return;

  // Grok
  if (s.grok) {
    if (s.grok.videoDuration) $('#grokVideoDuration').value = s.grok.videoDuration;
    if (s.grok.videoResolution) $('#grokVideoResolution').value = s.grok.videoResolution;
    if (s.grok.aspectRatio) $('#grokAspectRatio').value = s.grok.aspectRatio;
    if (s.grok.timeout) $('#grokTimeout').value = s.grok.timeout;
    if (s.grok.autoUpscale !== undefined) $('#grokAutoUpscale').checked = s.grok.autoUpscale;
  }

  // Flow Video (마이그레이션: 기존 veo 키도 지원)
  const fv = s.flowVideo || s.veo;
  if (fv) {
    if (fv.model) $('#flowVideoModel').value = fv.model;
    if (fv.aspectRatio) $('#flowVideoAspectRatio').value = fv.aspectRatio;
    if (fv.frameDuration) $('#flowVideoFrameDuration').value = fv.frameDuration;
    if (fv.outputCount) $('#flowVideoOutputCount').value = fv.outputCount;
  }

  // Image (Grok / Whisk)
  if (s.image) {
    if (s.image.model) $('#imageModel').value = s.image.model;
    if (s.image.aspectRatio) $('#imageAspectRatio').value = s.image.aspectRatio;
    if (s.image.outputCount) $('#imageOutputCount').value = s.image.outputCount;
  }

  // Flow Image
  if (s.flowImage) {
    if (s.flowImage.model) $('#flowImageModel').value = s.flowImage.model;
    if (s.flowImage.aspectRatio) $('#flowImageAspectRatio').value = s.flowImage.aspectRatio;
    if (s.flowImage.outputCount) $('#flowImageOutputCount').value = s.flowImage.outputCount;
  }
  if (s.flowTimeout) $('#flowTimeout').value = s.flowTimeout;

  // Download
  if (s.download) {
    if (s.download.videoQuality) $('#downloadVideoQuality').value = s.download.videoQuality;
    if (s.download.imageQuality) $('#downloadImageQuality').value = s.download.imageQuality;
    if (s.download.naming) $('#downloadNaming').value = s.download.naming;
    if (s.download.delay) $('#downloadDelay').value = s.download.delay;
    if (s.download.perProject !== undefined) $('#downloadPerProject').checked = s.download.perProject;
  }

  // General
  if (s.general) {
    if (s.general.cooldownMin) $('#cooldownMin').value = s.general.cooldownMin;
    if (s.general.cooldownMax) $('#cooldownMax').value = s.general.cooldownMax;
    if (s.general.retryOnFailure !== undefined) $('#retryOnFailure').checked = s.general.retryOnFailure;
    if (s.general.maxRetries) $('#maxRetries').value = s.general.maxRetries;
    if (s.general.defaultMode) {
      // 제거된 모드(text-video / image-image)가 저장돼 있으면 text-image 로 fallback
      const validModes = ['text-image', 'image-video'];
      const saved = s.general.defaultMode;
      $('#defaultMode').value = validModes.includes(saved) ? saved : 'text-image';
    }
    // concurrentCount UI 제거됨 — 항상 1
    if (s.general.promptDelay) $('#promptDelay').value = s.general.promptDelay;
  }

  // LLM
  if (s.llm) {
    if (s.llm.enabled !== undefined) $('#llmRewriteEnabled').checked = s.llm.enabled;
    if (s.llm.kieApiKey) $('#kieApiKey').value = s.llm.kieApiKey;
    if (s.llm.retryCount) $('#llmRetryCount').value = s.llm.retryCount;
  }

  // UI state
  if (s._ui) {
    if (s._ui.source) {
      currentSource = s._ui.source;
      $$('.stab').forEach(t => t.classList.toggle('active', t.dataset.source === currentSource));
      $('#mangohubSection').classList.toggle('hidden', currentSource !== 'mangohub');
      $('#standaloneSection').classList.toggle('hidden', currentSource !== 'standalone');
    }
    if (s._ui.platform) {
      currentPlatform = s._ui.platform;
      $$('.ptab').forEach(t => t.classList.toggle('active', t.dataset.platform === currentPlatform));
    }
    if (s._ui.mode) {
      setMode(s._ui.mode);
    }
    if (s._ui.contentType) {
      currentContentType = s._ui.contentType;
      $$('.ctab').forEach(t => {
        const isActive = t.dataset.ctype === currentContentType;
        t.classList.toggle('active', isActive);
        t.style.background = isActive ? '#4f46e5' : '#fff';
        t.style.color = isActive ? '#fff' : '#666';
      });
    }
    if (s._ui.projectId) {
      setTimeout(() => {
        const opt = $(`#projectSelect option[value="${s._ui.projectId}"]`);
        if (opt) $('#projectSelect').value = s._ui.projectId;
      }, 1000);
    }
  }

  updateModeAvailability();
}

// ─── Helpers ───
function sendBg(msg) {
  return chrome.runtime.sendMessage(msg);
}

function fileToDataUrl(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function resolveMangoUrl(url) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  return MANGOHUB_BASE + url;
}

// Parse prompts separated by blank lines (double newline)
// Each "block" between blank lines is one prompt (can be multi-line)
function parsePrompts(text) {
  if (!text.trim()) return [];
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
}

// Listen for prompt input changes to update queue preview
$('#promptsInput')?.addEventListener('input', () => {
  clearTimeout(window._queuePreviewTimer);
  window._queuePreviewTimer = setTimeout(updateQueuePreview, 500);
});

$('#skipCompleted')?.addEventListener('change', updateQueuePreview);

// ─── Review Functions ───
async function loadReviewMode() {
  // 검토 탭 제거됨 — DOM 엘리먼트 없으면 no-op
  const toggle = $('#reviewModeToggle');
  if (!toggle) return;
  try {
    const result = await sendBg({ type: 'GET_REVIEW_MODE' });
    if (result?.enabled) toggle.checked = true;
  } catch {}
}

async function loadReviewQueue() {
  try {
    reviewItems = await sendBg({ type: 'GET_REVIEW_QUEUE' }) || [];
  } catch {
    reviewItems = [];
  }
  renderReviewList();
}

function renderReviewList() {
  const list = $('#reviewList');
  if (!list) return;  // 검토 탭 제거됨 — DOM 없으면 skip
  list.innerHTML = '';

  // Update badge
  const pendingCount = reviewItems.filter(i => i.status === 'pending').length;
  const badge = $('#reviewBadge');
  if (pendingCount > 0) {
    badge.textContent = pendingCount;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  // Update summary
  const counts = { pending: 0, approved: 0, rejected: 0, uploaded: 0, uploading: 0, error: 0 };
  reviewItems.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
  $('#reviewSummary').textContent =
    `대기 ${counts.pending} | 승인 ${counts.approved} | 거부 ${counts.rejected} | 업로드 ${counts.uploaded}` +
    (counts.error > 0 ? ` | 오류 ${counts.error}` : '');

  if (reviewItems.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#555;padding:20px;font-size:11px;">검토 항목이 없습니다</div>';
    return;
  }

  // Render items (newest first)
  const sorted = [...reviewItems].reverse();
  for (const item of sorted) {
    const div = document.createElement('div');
    div.className = 'review-item';
    div.dataset.id = item.id;
    div.dataset.status = item.status;

    const statusLabels = {
      pending: '대기', approved: '승인', rejected: '거부',
      uploading: '업로드중', uploaded: '완료', error: '오류'
    };

    // Original image column
    let originalHtml = '';
    if (item.originalImageUrl) {
      const resolvedUrl = item.originalImageUrl.startsWith('http')
        ? item.originalImageUrl
        : MANGOHUB_BASE + item.originalImageUrl;
      originalHtml = `<div class="review-col">
        <div class="review-col-label">원본</div>
        <img class="review-media" src="${escapeHtml(resolvedUrl)}" onerror="this.style.display='none'">
      </div>`;
    }

    // Generated media column
    const mediaSrc = item.mediaUrl || item.mediaDataUrl || '';
    let mediaHtml;
    if (item.mediaType === 'video') {
      mediaHtml = `<video class="review-media" src="${escapeHtml(mediaSrc)}" controls muted preload="metadata"
        onerror="this.outerHTML='<div class=\\'review-expired\\'>미디어 만료됨</div>'"></video>`;
    } else {
      mediaHtml = `<img class="review-media" src="${escapeHtml(mediaSrc)}"
        onerror="this.outerHTML='<div class=\\'review-expired\\'>미디어 만료됨</div>'">`;
    }

    // Actions
    let actionsHtml = '';
    if (item.status === 'pending') {
      actionsHtml = `<button class="btn btn-sm btn-primary review-approve-btn" data-id="${item.id}">승인</button>
         <button class="btn btn-sm btn-danger review-reject-btn" data-id="${item.id}">거부</button>`;
    } else if (item.status === 'error') {
      actionsHtml = `<button class="btn btn-sm btn-primary review-approve-btn" data-id="${item.id}">재시도</button>
         <span class="review-error">${escapeHtml(item.error || '')}</span>`;
    }

    div.innerHTML = `
      <div class="review-item-header">
        <span class="review-idx">#${String(item.segmentIndex || 1).padStart(3, '0')}</span>
        <span class="review-prompt">${escapeHtml(item.text || item.prompt || '')}</span>
        <span class="review-status-badge rs-${item.status}">${statusLabels[item.status] || item.status}</span>
      </div>
      <div class="review-comparison" ${!originalHtml ? 'style="grid-template-columns:1fr"' : ''}>
        ${originalHtml}
        <div class="review-col">
          <div class="review-col-label">생성결과</div>
          ${mediaHtml}
        </div>
      </div>
      ${actionsHtml ? `<div class="review-actions">${actionsHtml}</div>` : ''}
    `;

    list.appendChild(div);
  }

  // Bind per-item buttons
  list.querySelectorAll('.review-approve-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await sendBg({ type: 'REVIEW_APPROVE', id: btn.dataset.id });
      await loadReviewQueue();
    });
  });
  list.querySelectorAll('.review-reject-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await sendBg({ type: 'REVIEW_REJECT', id: btn.dataset.id });
      await loadReviewQueue();
    });
  });
}
