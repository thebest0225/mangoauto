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
let currentApiType = 'longform-v2';  // 롱폼 V2 전용 (숏폼·메이커·무비 폐기 2026-08-04).
// ⚠️ 아래에 남아 있는 currentApiType === 'mangomaker' 분기들은 도달하지 않는 죽은 코드다.
//    세그먼트 인덱스 0/1-based 처리와 얽혀 있어 섣불리 걷어내면 회귀 위험이 있어 남겨둔다.
let uploadedImages = [];  // { file, dataUrl, name }
let lastState = null;
let reviewItems = [];

// ─── Supported URL patterns (Whisk 제거됨) ───
const SUPPORTED_PATTERNS = [
  { pattern: /^https:\/\/grok\.com/,                   platform: 'grok' },
  { pattern: /^https:\/\/labs\.google\/fx\/.*tools\/video-fx/, platform: 'flow' },
  { pattern: /^https:\/\/labs\.google\/fx\/.*tools\/flow/,     platform: 'flow' },
  { pattern: /^https:\/\/blog\.naver\.com/,            platform: 'naver' },
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

// ─── 탭 패널 동기화 ───
// 블로그 탭은 현재 페이지가 뭐든 열려야 한다 (초안을 먼저 고르고 그 다음 네이버를 여는 순서니까).
// 그래서 '지원 안 하는 페이지' 안내는 mainContent 전체를 숨기지 않고 영상제작 탭에서만 띄운다.
let currentMainTab = 'workspace';
let videoPlatformDetected = false;
let pageIsNaver = false;

function syncMainTab() {
  const noticeOn = currentMainTab === 'workspace' && !videoPlatformDetected;
  $('#unsupportedNotice').classList.toggle('hidden', !noticeOn);
  $('#mainContent').classList.remove('hidden');
  $('#platformTabs').classList.toggle('hidden', currentMainTab !== 'workspace' || noticeOn);
  $('#workspacePanel').classList.toggle('hidden', currentMainTab !== 'workspace' || noticeOn);
  $('#blogPanel').classList.toggle('hidden', currentMainTab !== 'blog');
  $('#settingsPanel').classList.toggle('hidden', currentMainTab !== 'settings');
  $$('.mtab').forEach(t => t.classList.toggle('active', t.dataset.tab === currentMainTab));
}

function selectMainTab(name) {
  currentMainTab = name;
  syncMainTab();
  if (name === 'blog' && !blogItems.length) loadBlogDrafts();
}

// ─── Check current tab and show unsupported notice if needed ───
async function checkCurrentTab() {
  let detected = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    detected = detectPlatform(tab?.url || '');
  } catch {
    detected = null;  // chrome:// 등
  }

  pageIsNaver = detected === 'naver';
  videoPlatformDetected = !!detected && !pageIsNaver;

  if (videoPlatformDetected) {
    currentPlatform = detected;
    $$('.ptab').forEach(t => t.classList.toggle('active', t.dataset.platform === detected));
    updateModeAvailability();
  }

  // 네이버에 있으면 블로그 탭으로 자동 이동 (설정 탭 보는 중이면 방해하지 않는다)
  if (pageIsNaver && currentMainTab === 'workspace') selectMainTab('blog');
  else syncMainTab();
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
// 카테고리 표시명 캐시 ({ 'senior-psychology': '심리학 돋보기', ... }).
// 팝업이 열려 있는 동안만 유지 — 카테고리는 자주 바뀌지 않으므로 1회 조회로 충분하다.
let _categoryNames = null;

async function loadCategoryNames() {
  if (_categoryNames) return _categoryNames;
  try {
    const cats = await sendBg({ type: 'API_LIST_CATEGORIES' });
    _categoryNames = {};
    // 응답이 배열([{id,name}]) 또는 {categories:[...]} 양쪽 모두를 허용
    const list = Array.isArray(cats) ? cats : (cats && cats.categories) || [];
    list.forEach(c => { if (c && c.id) _categoryNames[c.id] = c.name || c.id; });
  } catch (_) {
    _categoryNames = {};   // 실패해도 그룹화만 못 할 뿐, 목록은 정상 표시
  }
  return _categoryNames;
}

async function loadProjects() {
  try {
    const [projects, catNames] = await Promise.all([
      sendBg({ type: 'API_LIST_PROJECTS', apiType: currentApiType }),
      loadCategoryNames(),
    ]);
    const select = $('#projectSelect');
    select.innerHTML = '<option value="">프로젝트 선택...</option>';
    if (Array.isArray(projects)) {
      // 최신순 정렬 (created_at > id 역순)
      projects.sort((a, b) => {
        if (a.created_at && b.created_at) return new Date(b.created_at) - new Date(a.created_at);
        return (b.id || 0) - (a.id || 0);
      });

      // 망고허브 롱폼 사이드바와 같은 방식으로 카테고리별 묶음.
      // 정렬 순서는 위에서 정한 최신순을 그대로 따르므로, 가장 최근에 손댄
      // 프로젝트가 속한 카테고리가 위로 온다.
      const groups = [];               // [{ key, label, items: [] }]
      const byKey = new Map();
      projects.forEach(p => {
        const key = p.category || '_none';
        if (!byKey.has(key)) {
          const g = { key, label: catNames[key] || (key === '_none' ? '카테고리 없음' : key), items: [] };
          byKey.set(key, g); groups.push(g);
        }
        byKey.get(key).items.push(p);
      });

      groups.forEach(g => {
        // 카테고리가 하나뿐이면 optgroup 이 공간만 잡아먹으니 평면으로 둔다
        const host = groups.length > 1
          ? select.appendChild(Object.assign(document.createElement('optgroup'),
              { label: `${g.label} (${g.items.length})` }))
          : select;
        g.items.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `⚪ ${p.name || `Project ${p.id}`}`;
          host.appendChild(opt);
        });
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

  // Main tabs (영상제작 / 블로그 / 설정)
  $$('.mtab').forEach(tab => {
    tab.addEventListener('click', () => selectMainTab(tab.dataset.tab));
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

  // 대기열 범위 선택 (대기열번호 기준: 1~20 / 21~40 / 41~60 / 61~80 / 81~끝)
  // ⚠️ 큐 위치가 아니라 화면에 표시되는 "대기열번호"(data-num) 기준으로 필터.
  //    이미 생성된 항목은 큐에서 빠져있으므로, 범위 안에서 "생성 필요한 것"만 선택됨.
  //    (여러 컴퓨터에서 같은 프로젝트를 1~20 / 21~40 식으로 나눠 작업 가능.)
  // 범위 버튼: 다중 토글(합집합). 1~22 + 45~ → 두 구간 union.
  // v1 / 홀수 / 짝수: **단독 선택** — 누르면 다른 버튼 모두 해제 후 자기만 활성.
  //   범위 버튼을 누르면 단독 모드(v1/odd/even) 는 자동 해제.
  $$('.qs-pct-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // 수기입력: 범위를 직접 입력받아 range 버튼처럼 동작
      if (btn.dataset.mode === 'manual') {
        const raw = prompt('대기열번호 범위 입력 — 예) 26-50, 또는 30 (=1~30)\n※ 영1/영2/이1/이2 와 달리 수기는 "대기열번호" 기준입니다.', btn.dataset.range || '');
        if (raw == null) return;
        const m = raw.trim().match(/^(\d+)\s*(?:[-~]\s*(\d+))?$/);
        if (!m) { alert('형식이 올바르지 않습니다. 예) 26-50 또는 30'); return; }
        let lo = m[2] ? parseInt(m[1]) : 1;
        let hi = m[2] ? parseInt(m[2]) : parseInt(m[1]);
        if (lo > hi) { const t = lo; lo = hi; hi = t; }
        btn.dataset.rangeLo = String(lo); btn.dataset.rangeHi = String(hi); btn.dataset.range = `${lo}-${hi}`;
        btn.textContent = `${lo}-${hi}`;   // 칸이 좁아 범위만 표기 (툴팁에 설명)
        btn.title = `수기 입력 — 대기열번호 ${lo}~${hi}번 중 생성 필요한 것만 선택`;
        $$('.qs-pct-btn').forEach(b => { if (STANDALONE_MODES.has(b.dataset.mode)) b.classList.remove('active'); });
        btn.classList.add('active');
        applyQuickSelect();
        return;
      }
      const isStandalone = STANDALONE_MODES.has(btn.dataset.mode);
      if (isStandalone) {
        const willActivate = !btn.classList.contains('active');
        $$('.qs-pct-btn').forEach(b => b.classList.remove('active'));
        if (willActivate) btn.classList.add('active');
      } else {
        // 범위 버튼 — 단독 모드 버튼들 해제 후 이 범위 토글
        $$('.qs-pct-btn').forEach(b => {
          if (STANDALONE_MODES.has(b.dataset.mode)) b.classList.remove('active');
        });
        btn.classList.toggle('active');
      }
      applyQuickSelect();
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
    // longform/shortform은 seg.index가 1-based, longform-v2/v3/mangomaker/standalone은 0-based → +1
    const displayIdx = item._isThumbnail ? item.idx + 1
      : (item._isMangoHub && currentApiType !== 'mangomaker' && currentApiType !== 'longform-v2') ? item.idx
      : item.idx + 1;
    div.innerHTML = `
      <input type="checkbox" class="queue-check queue-select" data-idx="${item.idx}" data-num="${displayIdx}" checked>
      <span class="queue-idx">${String(displayIdx).padStart(3, '0')}</span>
      ${thumbHtml}
      <span class="queue-text">${escapeHtml(item.text)}</span>
      <span class="queue-status qs-pending">대기</span>
    `;
    queueList.appendChild(div);
  }

  // 전체선택 체크박스 초기 상태 + 범위 버튼 활성 상태 초기화 (재렌더 시 stale 방지)
  const selectAll = $('#queueSelectAll');
  if (selectAll) selectAll.checked = true;
  $$('.qs-pct-btn').forEach(b => b.classList.remove('active'));
  updateQueueSelectedCount();
}

// ─── Queue Selection Helpers ───
// 범위 버튼 1개의 "포함 여부" 술어. 술어는 (num, pos) 를 받는다.
//   num = 화면에 표시되는 대기열번호, pos = 목록에서 위에서부터 몇 번째인지 (1-based)
//
// (2026-08-09 재편) 고정 버튼 4개는 **대기열번호가 아니라 위에서부터 개수** 기준이다.
//   이미 생성된 항목은 큐에서 빠져 번호에 구멍이 생기므로, 번호 기준이면
//   "영1" 을 눌러도 13개가 아니라 7개만 잡히는 식이 된다. 화면에 보이는 대로
//   위에서부터 세는 게 실제로 원하는 동작.
//     영1  = 위에서부터 1~14번째
//     영2  = 위에서부터 15~30번째
//     이1  = 앞 절반 (목록 개수의 절반, 홀수면 앞쪽이 하나 더)
//     이2  = 뒤 절반
//   수기 = 예외적으로 **대기열번호** 기준 (여러 컴퓨터로 1~20 / 21~40 나눠 작업하는 용도).
//   all/odd/even 은 과거 버튼용 (현재 UI 에는 없지만 호환 유지).
const STANDALONE_MODES = new Set(['all', 'odd', 'even']);
function btnPredicate(btn, total) {
  const mode = btn.dataset.mode;
  if (mode === 'all') return () => true;
  if (mode === 'odd') return (num) => num % 2 === 1;
  if (mode === 'even') return (num) => num % 2 === 0;
  if (mode === 'pct1' || mode === 'pct2') {
    const half = Math.ceil((total || 0) / 2);
    return mode === 'pct1' ? (num, pos) => pos <= half : (num, pos) => pos > half;
  }
  if (mode === 'pos') {
    const lo = parseInt(btn.dataset.posLo);
    const hiRaw = (btn.dataset.posHi || '').trim();
    const hi = hiRaw === '' ? Infinity : parseInt(hiRaw);
    return (num, pos) => pos >= lo && pos <= hi;
  }
  // 수기입력 등 — 대기열번호 기준 범위
  const lo = parseInt(btn.dataset.rangeLo);
  const hiRaw = (btn.dataset.rangeHi || '').trim();
  const hi = hiRaw === '' ? Infinity : parseInt(hiRaw);
  return (num) => num >= lo && num <= hi;
}

// 활성화된 범위 버튼들의 합집합(union)으로 큐 체크박스 선택. 활성 없으면 전체 선택.
function applyQuickSelect() {
  const allCbs = $$('.queue-select');
  if (allCbs.length === 0) return;
  const activeBtns = $$('.qs-pct-btn.active');
  const selectAll = $('#queueSelectAll');
  if (activeBtns.length === 0) {
    // 활성 범위 없음 → 전체 선택 (기본 상태)
    allCbs.forEach(cb => { cb.checked = true; });
    if (selectAll) selectAll.checked = true;
    updateQueueSelectedCount();
    return;
  }
  // 개수 기준(영1/영2/이1/이2) 계산 기준 — 화면에 표시된 항목 총 개수
  const total = allCbs.length;
  const preds = [...activeBtns].map(b => btnPredicate(b, total));
  let matched = 0;
  allCbs.forEach((cb, i) => {
    const num = parseInt(cb.dataset.num);
    const pos = i + 1;   // 위에서부터 1-based 순번
    const sel = preds.some(p => p(num, pos));
    cb.checked = sel;
    if (sel) matched++;
  });
  if (selectAll) selectAll.checked = false;
  updateQueueSelectedCount();
  const labels = [...activeBtns].map(b => b.textContent.trim()).join(', ');
  addLog(`대기열 범위 [${labels}]: ${matched}개 선택됨 (생성 필요분만)`, 'info');
}

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
      autoUpscale: $('#grokAutoUpscale').checked,
      skipVideoSettings: $('#grokSkipVideoSettings').checked
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
    if (s.grok.skipVideoSettings !== undefined) $('#grokSkipVideoSettings').checked = s.grok.skipVideoSettings;
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

// ═══════════════════════════════════════════════════════════════
//  블로그 탭 — 블로그라이터 네이버 초안 → 네이버 글쓰기 채우기
// ═══════════════════════════════════════════════════════════════
//
// 흐름: 초안 목록(write.mangois.love) → 하나 고름 → 네이버 글쓰기 열기 →
//       제목·본문 채우기 → (선택) 이미지 첨부 → 사람이 검토하고 발행.
//
// ⚠️ 발행은 절대 자동으로 하지 않는다. 네이버는 자동 발행 패턴을 계정 제재 사유로 본다.
// ⚠️ 초안 이미지가 KIE 임시 CDN(tempfile.aiquickdraw.com)이면 며칠 뒤 사라진다.
//    그래서 채울 때 그 자리에서 바이트로 내려받아 네이버에 올린다 (핫링크 금지 원칙과 같은 이유).

const BLOGWRITE_BASE = 'https://write.mangois.love';
const NAVER_WRITE_URL = 'https://blog.naver.com/mangoabba?Redirect=Write';

let blogItems = [];
let blogPicked = null;      // { id, title, html, article }
let blogScope = 'naver';

function blogLog(msg, level = 'info') {
  const box = $('#blogLog');
  if (!box) return;
  const line = document.createElement('div');
  line.className = 'log-line log-' + level;
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  line.textContent = `[${t}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function blogStatus(msg, level = 'info') {
  const el = $('#blogStatus');
  if (el) { el.textContent = msg || ''; el.className = 'blog-status ' + (msg ? 'st-' + level : ''); }
}

async function bwFetch(path) {
  const r = await fetch(BLOGWRITE_BASE + path, { credentials: 'include' });
  if (r.status === 401 || r.status === 403) {
    throw new Error('블로그라이터 로그인이 필요합니다 — write.mangois.love 에 먼저 로그인하세요');
  }
  if (!r.ok) throw new Error(`블로그라이터 응답 ${r.status}`);
  return r.json();
}

// ─── 목록 ───
async function loadBlogDrafts() {
  const list = $('#blogList');
  list.innerHTML = '<div class="blog-empty">불러오는 중…</div>';
  try {
    const j = await bwFetch('/api/work?status=generated');
    blogItems = (j.items || []).filter(it => {
      if (blogScope !== 'naver') return true;
      return it.target === 'naver' || it.destination_id === 'naver_mango';
    });
    renderBlogList();
    $('#blogCount').textContent = `${blogItems.length}건`;
    blogLog(`초안 ${blogItems.length}건 불러옴 (${blogScope === 'naver' ? '네이버용' : '전체'})`);
  } catch (e) {
    list.innerHTML = `<div class="blog-empty err">${e.message}</div>`;
    $('#blogCount').textContent = '—';
    blogLog(e.message, 'error');
  }
}

function renderBlogList() {
  const list = $('#blogList');
  if (!blogItems.length) {
    list.innerHTML = `<div class="blog-empty">${blogScope === 'naver'
      ? '네이버용 초안이 없습니다. 루틴이 매일 하나씩 만듭니다.'
      : '대기 중인 초안이 없습니다.'}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const it of blogItems) {
    const card = document.createElement('button');
    card.className = 'blog-card' + (blogPicked?.id === it.id ? ' picked' : '');
    const when = it.created_at ? new Date(it.created_at).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '';
    const isNaver = it.target === 'naver' || it.destination_id === 'naver_mango';
    card.innerHTML = `
      <div class="blog-card-title"></div>
      <div class="blog-card-meta">
        <span class="tag ${isNaver ? 'tag-naver' : ''}">${isNaver ? '네이버' : (it.target || '기타')}</span>
        <span>${when}</span>
      </div>`;
    card.querySelector('.blog-card-title').textContent = it.title || '(제목 없음)';
    card.addEventListener('click', () => pickBlogDraft(it.id));
    list.appendChild(card);
  }
}

// ─── 선택 ───
async function pickBlogDraft(id) {
  blogStatus('');
  try {
    const w = await bwFetch('/api/work/' + encodeURIComponent(id));
    let article = {};
    try { article = JSON.parse(w.article_json || '{}'); } catch (_) {}
    blogPicked = { id: w.id, title: w.title || article.title || '', html: w.html || '', article };

    // ★네이버는 초안 원본을 쓴다. work_items.html 은 블로그라이터가 워드프레스용으로
    //   재생성한 것이라 볼드 소제목·구분선·사진 슬롯·해시태그가 다 뭉개져 있다.
    let parsed = null;
    const isNaver = w.target === 'naver' || w.destination_id === 'naver_mango';
    if (isNaver && w.draft_id) {
      try {
        const d = await bwFetch('/api/drafts/' + encodeURIComponent(w.draft_id));
        if (d && d.content) {
          parsed = naverizeDraft(d.content);
          if (d.title) blogPicked.title = d.title;   // 초안 제목이 네이버 규격(30~45자)이다
          blogLog('초안 원본에서 변환했습니다 (네이버 서식 유지)');
        }
      } catch (e) {
        blogLog('초안 원본을 못 읽어 재생성 html 로 대체합니다 — ' + e.message, 'warn');
      }
    }
    if (!parsed) {
      parsed = naverize(blogPicked.html, article);
      if (isNaver) blogLog('워드프레스용 html 로 변환했습니다. 볼드 소제목·사진 슬롯은 빠집니다', 'warn');
    }
    blogPicked.parsed = parsed;

    $('#blogDetail').style.display = '';
    $('#blogPickedTitle').textContent = blogPicked.title;
    const p = parsed;
    const bits = [`본문 ${p.charCount.toLocaleString()}자`];
    if (p.photos?.length) bits.push(`사진 슬롯 ${p.photos.length}칸`);
    else bits.push(`이미지 ${p.images.length}장`);
    bits.push(`해시태그 ${p.tags.length}개`);
    if (p.meta?.category) bits.push(p.meta.category);
    $('#blogPickedMeta').textContent = bits.join(' · ');
    renderPhotoSlots(p.photos || []);
    renderBlogList();
    blogLog(`선택: ${blogPicked.title}`);
    if (p.charCount > 2600) blogLog(`본문이 ${p.charCount}자입니다. 네이버 권장은 1,500~2,500자 — 길면 줄이세요.`, 'warn');
    if (!p.photos?.length && !p.images.length) blogLog('사진 자리가 없습니다. 망고 사진함에서 2~4장 골라 직접 넣으세요.', 'warn');
  } catch (e) {
    blogLog(e.message, 'error');
    blogStatus(e.message, 'error');
  }
}

// ─── 초안 원본(마크다운) → 네이버 서식 ───
//
// ★이게 제대로 된 경로다. 블로그라이터가 재생성한 html 은 워드프레스용이라
//   볼드 소제목·구분선·사진 슬롯·해시태그가 전부 평문으로 뭉개진다.
//   초안 원본은 루틴이 이미 네이버 규칙대로 써놓은 것이므로 그걸 그대로 살린다.
//
// 살리는 것: **볼드 소제목** / ——— 구분선 / 마크다운 표 / [사진N · 태그] 슬롯 + 캡션
//            · 불릿 / 맨 URL(네이버가 링크 카드로 바꿔줌) / 해시태그 / 짧은 줄바꿈 리듬
const ESC = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 인라인 서식: **굵게** 만 쓴다 (초안 규칙이 그렇다)
function inlineMd(line) {
  return ESC(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function naverizeDraft(md) {
  let src = String(md || '').replace(/\r\n/g, '\n');

  // 1) 썸네일 프롬프트 블록은 본문이 아니다 — 잘라서 따로 보관
  let thumb = '';
  // 앞 공백을 허용한다 — 루틴이 들여쓰면 못 잘라내고 썸네일 프롬프트가 본문에 섞인다
  const ti = src.search(/^[ \t]*##\s*썸네일 프롬프트/m);
  if (ti >= 0) { thumb = src.slice(ti).replace(/^[ \t]*##\s*썸네일 프롬프트\s*/m, '').trim(); src = src.slice(0, ti); }

  // 2) 맨 위 메타 두 줄
  const meta = {};
  src = src.replace(/^\s*카테고리\s*[:：]\s*(.+)$/m, (_, v) => { meta.category = v.trim(); return ''; });
  src = src.replace(/^\s*원본참고\s*[:：]\s*(.+)$/m, (_, v) => { meta.source = v.trim(); return ''; });

  // 3) 해시태그 줄 (# 이 3개 이상 있는 줄)
  let tagLine = '';
  src = src.replace(/^\s*(#[^\s#]+(?:\s+#[^\s#]+){2,})\s*$/m, (_, v) => { tagLine = v.trim(); return ''; });

  const groups = src.split(/\n{2,}/).map(g => g.trim()).filter(Boolean);
  const html = [];
  const text = [];
  const photos = [];
  const bolds = [];   // 소제목 — 붙여넣기 후에 '굵게'를 따로 적용할 대상

  const pushText = (t) => text.push(t);

  for (const g of groups) {
    const lines = g.split('\n').map(l => l.trim()).filter(l => l !== '');
    if (!lines.length) continue;

    // 구분선
    if (lines.every(l => /^[—–\-─]{3,}$/.test(l))) {
      html.push('<hr>');
      pushText('———');
      continue;
    }

    // 사진 슬롯 — [사진1 · walk+summer] (+ 다음 줄에 캡션: ...)
    const pm = lines[0].match(/^\[\s*사진\s*(\d+)\s*[·:]?\s*([^\]]*)\]$/);
    if (pm) {
      const capLine = (lines[1] || '').replace(/^캡션\s*[:：]\s*/, '').trim();
      photos.push({ n: Number(pm[1]), tags: pm[2].trim(), caption: capLine });
      // 자리표시는 '캡션만' 남긴다. 사진이 그 자리에 들어가면
      // 이미지 + 캡션 줄이 되어 그대로 캡션처럼 읽힌다.
      const marker = capLine || `[사진${pm[1]}]`;
      photos[photos.length - 1].marker = marker;
      html.push(`<p>${ESC(marker)}</p>`);
      pushText(marker);
      continue;
    }

    // 마크다운 표
    if (lines.length >= 2 && lines.every(l => l.startsWith('|'))) {
      const rows = lines
        .filter(l => !/^\|[\s:|-]+\|$/.test(l))
        .map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      if (rows.length) {
        const head = rows.shift();
        html.push(
          '<table><thead><tr>' + head.map(c => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map(r => '<tr>' + r.map(c => `<td>${inlineMd(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table>'
        );
        pushText([head, ...rows].map(r => r.join(' | ')).join('\n'));
        continue;
      }
    }

    // 불릿 (· 로 시작)
    if (lines.every(l => /^[·•]\s/.test(l))) {
      html.push('<ul>' + lines.map(l => `<li>${inlineMd(l.replace(/^[·•]\s*/, ''))}</li>`).join('') + '</ul>');
      pushText(lines.join('\n'));
      continue;
    }

    // 볼드만 있는 줄 = 소제목
    if (lines.length === 1 && /^\*\*.+\*\*$/.test(lines[0])) {
      const h = lines[0].replace(/^\*\*|\*\*$/g, '').trim();
      html.push(`<p><strong>${ESC(h)}</strong></p>`);
      bolds.push(h);
      pushText(h);
      continue;
    }

    // 맨 URL 만 있는 줄들 → 각각 독립 문단 (네이버가 링크 카드로 만든다)
    if (lines.every(l => /^https?:\/\/\S+$/.test(l))) {
      for (const u of lines) { html.push(`<p>${ESC(u)}</p>`); pushText(u); }
      continue;
    }

    // 일반 문단 — 초안의 짧은 줄바꿈 리듬을 <br> 로 그대로 살린다
    html.push('<p>' + lines.map(inlineMd).join('<br>') + '</p>');
    pushText(lines.join('\n'));
  }

  // ★해시태그는 본문 맨 아래에 실제로 들어가야 한다. 클립보드에만 넣어두면
  //   사람이 또 붙여넣어야 하고, 네이버는 본문 끝 해시태그를 검색 자산으로 본다.
  if (tagLine) { text.push(tagLine); html.push(`<p>${ESC(tagLine)}</p>`); }

  const body = text.join('\n\n');
  return {
    html: html.join(''),
    text: body,
    images: [],           // 사진은 슬롯으로 관리한다 (초안에는 이미지 URL 이 없다)
    photos,
    bolds,
    meta,
    thumbPrompt: thumb,
    tags: tagLine ? tagLine.split(/\s+/).map(t => t.replace(/^#/, '')) : [],
    tagLine,
    charCount: body.replace(/\s/g, '').length,
    from: 'draft',
  };
}

// ─── 워드프레스 HTML → 네이버용 텍스트/간이 HTML (초안 원본이 없을 때만 쓰는 폴백) ───
// 원본 html 은 인라인 스타일이 잔뜩 붙어 있어서 네이버에 그대로 붙이면 깨진다.
// 그래서 블록 단위로 뜯어 텍스트를 뽑고, 서식은 볼드·구분선만 남긴 최소 HTML 로 다시 만든다.
function naverize(html, article) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');

  const images = Array.from(doc.querySelectorAll('img'))
    .map(im => ({
      src: im.getAttribute('src') || '',
      alt: im.getAttribute('alt') || '',
      caption: (im.closest('figure')?.querySelector('figcaption')?.textContent || '').trim(),
    }))
    .filter(x => /^https?:\/\//.test(x.src));

  doc.querySelectorAll('script,style,noscript,iframe,img,figure').forEach(n => n.remove());

  // 링크 처리. 네이버는 붙여넣은 맨 URL 을 자동으로 링크 카드로 바꿔주므로 URL 을 살려야 한다.
  //
  // 워드프레스 관련글 카드는 <a><div><div>제목</div></div></a> 구조라서 <a> 안이 전부
  // div 다. div 는 블록 목록에 없으니 그냥 걷으면 URL 과 제목이 통째로 사라진다.
  // → 카드형 링크는 <p>URL</p> 로 갈아끼워 네이버가 카드로 만들게 한다.
  //   (카드 안 텍스트는 아이콘 이모지·"글 보기" 같은 껍데기라 버린다. 유도문은 바로 위 h4 가 이미 담당한다.)
  const BLOCK = 'h1,h2,h3,h4,h5,p,li,blockquote,hr,pre,tr,dt,dd';

  doc.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//.test(href)) return;
    const style = a.getAttribute('style') || '';
    const isCard = !!a.querySelector('div,p,h1,h2,h3,h4,h5,table') || /display\s*:\s*block/i.test(style);
    const label = a.textContent.replace(/\s+/g, ' ').trim();
    if (isCard) {
      const p = doc.createElement('p');
      p.textContent = href;
      a.replaceWith(p);
      return;
    }
    // 블록 밖에 떠 있는 링크(하단 CTA 버튼 등)는 그냥 걷으면 유실된다 → 문단으로 승격
    if (!a.closest(BLOCK)) {
      const p = doc.createElement('p');
      p.textContent = (label ? label + '\n' : '') + href;
      a.replaceWith(p);
      return;
    }
    if (!label.includes(href)) a.textContent = `${label}\n${href}`;
  });

  const lines = [];
  // 초안 html 은 <body> 없는 조각이다. 브라우저 DOMParser 는 body 로 감싸주지만
  // 감싸주지 않는 구현도 있어서 비어 있으면 document 를 그대로 순회한다.
  const root = (doc.body && doc.body.children.length) ? doc.body : doc;
  root.querySelectorAll(BLOCK).forEach(el => {
    if (el.tagName !== 'TR' && el.querySelector(BLOCK)) return;   // 컨테이너는 건너뛴다
    if (el.tagName === 'HR') { lines.push('', '———', ''); return; }
    if (el.tagName === 'TR') {
      const cells = Array.from(el.querySelectorAll('td,th')).map(c => c.textContent.replace(/\s+/g, ' ').trim());
      if (cells.some(Boolean)) lines.push(cells.join(' | '));
      return;
    }
    const t = el.textContent.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!t) return;
    // 워드프레스 전용 줄은 네이버에 필요 없다 (연관 검색어는 해시태그가 대신한다)
    if (/^최종 업데이트[:：]/.test(t)) return;
    if (/^연관 검색어[:：]/.test(t)) return;
    if (/^(출처|참고자료)[:：]?$/.test(t)) return;
    if (/^H[1-5]$/.test(el.tagName)) { lines.push('', t, ''); return; }
    if (el.tagName === 'LI') { lines.push('· ' + t); return; }
    if (el.tagName === 'BLOCKQUOTE') { lines.push('', '“' + t + '”', ''); return; }
    lines.push(t);
  });

  // 빈 줄 3개 이상은 2개로
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const tags = Array.isArray(article?.tags) ? article.tags.filter(Boolean) : [];
  const tagLine = tags.map(t => '#' + String(t).replace(/^#/, '').replace(/\s+/g, '')).join(' ');

  // 서식 유지용 최소 HTML — 소제목은 볼드 단락으로 (네이버 에디터에 h2 개념이 약하다)
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlOut = lines.map(l => {
    if (l === '———') return '<p>———</p>';
    if (!l.trim()) return '<p><br></p>';
    return '<p>' + esc(l).replace(/\n/g, '<br>') + '</p>';
  }).join('');

  return { text, html: htmlOut, images, tags, tagLine, charCount: text.replace(/\s/g, '').length };
}

// ─── 네이버 글쓰기 탭 확보 ───
async function ensureNaverTab() {
  // 지금 보고 있는 탭이 이미 네이버면 그걸 쓴다 — 열려 있는 글쓰기 화면을 다른 주소로
  // 덮어써서 작업 중인 내용을 날리는 일이 없게.
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && /^https:\/\/blog\.naver\.com/.test(active.url || '')) return active.id;
  } catch (_) {}

  const tabs = await chrome.tabs.query({ url: 'https://blog.naver.com/*' });
  const writing = tabs.find(t => /PostWriteForm|Redirect=Write/i.test(t.url || ''));
  if (writing) { await chrome.tabs.update(writing.id, { active: true }); return writing.id; }
  if (tabs.length) { await chrome.tabs.update(tabs[0].id, { active: true, url: NAVER_WRITE_URL }); return tabs[0].id; }
  const t = await chrome.tabs.create({ url: NAVER_WRITE_URL, active: true });
  return t.id;
}

// ─── 에디터가 있는 프레임 찾기 ───
//
// ⚠️ 여기가 처음에 안 됐던 이유다. 네이버 글쓰기는 최상위 페이지 안의 #mainFrame iframe 에
//    SmartEditor 가 들어 있다. chrome.tabs.sendMessage 는 탭의 모든 프레임에 뿌리고
//    '가장 먼저 온 응답' 하나만 쓰는데, 최상위 프레임이 먼저 대답해서 hasEditor=false 로
//    판정돼 버렸다. 그래서 프레임을 먼저 특정하고 그 프레임에만 말을 건다.
//
// 겸사겸사 매니페스트 content_scripts 에 의존하지 않고 그 자리에서 주입한다 —
// 확장을 새로고침한 뒤 열려 있던 탭에는 content script 가 안 들어가서, 페이지를 다시
// 불러야 하는 함정이 있었다. 주입하면 그럴 필요가 없다.
// ⚠️ 2차 시도에서 알아낸 것: 제목과 본문이 서로 다른 iframe 에 있다.
//    (콘솔에 '준비됨' 이 top / iframe / iframe 세 번 찍혔고 그중 하나만 editor=true)
//    프레임을 하나만 골라 그 안에서 둘 다 찾으려 하면 한쪽은 반드시 못 찾는다.
//    → 스크립트를 모든 프레임에 넣고, 제목·본문 프레임을 각각 따로 확정한다.
let naverFrames = [];      // 스크립트가 들어간 frameId 목록
let naverFrameId = null;   // 본문 프레임 (STATUS·FORMAT 기본 대상)
let naverTitleFrameId = null;

async function injectNaver(tabId) {
  const r = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/naver.js'],
  });
  naverFrames = r.map(x => x.frameId);
  blogLog(`프레임 ${naverFrames.length}개에 주입 (${naverFrames.join(', ')})`);
  return naverFrames;
}

// 한 프레임에만 보낸다.
function sendFrame(tabId, frameId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: '응답 없음' });
    });
  });
}

// 모든 프레임에 물어보고 응답을 모은다.
async function askAll(tabId, msg) {
  const out = [];
  for (const fid of naverFrames) {
    const res = await sendFrame(tabId, fid, msg);
    out.push({ frameId: fid, res });
  }
  return out;
}

// 그 영역을 가진 프레임을 고른다 — 화면에서 가장 큰 것이 진짜다
// (제목 iframe 에는 화면 밖으로 회전시켜 둔 보조 요소도 있다).
async function pickFrameFor(tabId, area) {
  const all = await askAll(tabId, { type: 'NAVER_RECT', area });
  const cands = all.filter(x => x.res?.ok);
  for (const c of cands) {
    blogLog(`${area} 후보 · 프레임 ${c.frameId} · ${c.res.hint} · ${c.res.w}x${c.res.h} @(${c.res.x},${c.res.y})`);
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.res.area - a.res.area);
  return { frameId: cands[0].frameId, rect: cands[0].res };
}

// 본문 프레임 기준 전송 (하위 호환)
function sendToNaver(tabId, msg) {
  const fid = naverFrameId != null ? naverFrameId : 0;
  return sendFrame(tabId, fid, msg);
}

// ─── 한 영역에 사람처럼 입력하기 ───
//
// 제목이든 본문이든 같은 방식이다 —
//   ① 그 영역을 가진 프레임과 화면 좌표를 구한다
//   ② CDP 로 '진짜 클릭' 을 쏴서 커서를 그 자리에 놓는다
//   ③ CDP Input.insertText + 신뢰 Enter 로 줄 단위로 넣는다
//
// 합성 이벤트로는 커서가 안 옮겨지고(제목이 본문으로 들어갔던 이유),
// 붙여넣기는 SmartEditor 가 자기 모델로 정규화하며 서식을 버린다.
// 결국 '사람이 클릭하고 타이핑하는 것' 과 같은 경로가 가장 확실하다.
async function typeIntoArea(tabId, area, text) {
  const pick = await pickFrameFor(tabId, area);
  if (!pick) { blogLog(`${area} 영역을 못 찾았습니다`, 'error'); return { ok: false, frameId: null }; }
  const { frameId, rect } = pick;

  blogLog(`${area} 프레임 ${frameId} 확정 · 클릭 (${rect.x}, ${rect.y})`);
  const click = await sendBg({ type: 'DEBUGGER_TRUSTED_CLICK', tabId, x: rect.x, y: rect.y });
  if (!click?.ok) { blogLog(`${area} 클릭 실패 — ${click?.error || ''}`, 'error'); return { ok: false, frameId }; }
  await new Promise(r => setTimeout(r, 450));

  const lines = String(text).split('\n').length;
  if (lines > 40) blogLog(`${area} ${lines}줄 입력 중… 한 줄씩 실제 타이핑하므로 ${Math.round(lines * 0.25)}초쯤 걸립니다`);

  const ins = await sendBg({ type: 'NAVER_CDP_TEXT', tabId, text });
  if (!ins?.ok) { blogLog(`${area} 입력 실패 — ${ins?.error || ''}`, 'error'); return { ok: false, frameId }; }

  await new Promise(r => setTimeout(r, 500));
  const chk = await sendFrame(tabId, frameId, { type: 'NAVER_STATUS' });
  const got = area === '제목' ? chk.titleChars : chk.bodyChars;
  blogLog(`${area} 입력 완료 — 에디터 글자수 ${got ?? '?'}`);
  return { ok: true, frameId, chars: got };
}

// ─── 선택된 글자의 폰트 크기 바꾸기 ───
//
// 진단으로 확인한 구조: 툴바에 se-font-size-code-toolbar-button 이 있고,
// 텍스트가 "32글자 크기 변경" 처럼 현재 크기를 담고 있다. 누르면 크기 목록이 열린다.
// 그래서 ① 버튼 좌표를 받아 클릭 → ② 열린 목록에서 원하는 숫자를 찾아 클릭 한다.
// (목록 항목은 열기 전에는 화면에 없어서 진단에서 options 가 비어 있었다)
async function setFontSize(tabId, frameId, size) {
  const btn = await sendFrame(tabId, frameId, { type: 'NAVER_TOOLBAR_BTN', name: 'font-size' });
  if (!btn.ok) return { ok: false, error: btn.error };

  await sendBg({ type: 'DEBUGGER_TRUSTED_CLICK', tabId, x: btn.x, y: btn.y });
  await new Promise(r => setTimeout(r, 450));

  const menu = await sendFrame(tabId, frameId, { type: 'NAVER_MENU_OPTIONS' });

  // ⚠️ 네이버는 접근성용 숨은 텍스트를 겹쳐 넣어서 항목 글자가 두 번 나온다.
  //    실제로 읽힌 값: '1111', '1313', '1515선택됨', '1919', '2424' …
  //    그래서 '1919' === '19' 비교가 전부 실패했다(크기 0/7).
  //    → 앞쪽 숫자만 떼서 비교한다. 그리고 '15글자 크기 변경' 은 드롭다운 버튼
  //      자기 자신이므로 후보에서 제외한다(안 그러면 현재 크기를 다시 고른다).
  const want = String(size);
  const nums = (menu.items || [])
    .filter(i => !/글자\s*크기/.test(i.txt))
    .map(i => ({ ...i, n: (i.txt.match(/^(\d{1,2})/) || [])[1] }))
    .filter(i => i.n);
  const hit = nums.find(i => i.n === want);
  if (!hit) {
    // 목록을 못 읽었으면 다시 눌러 닫는다 (열린 채로 두면 다음 클릭이 엉킨다)
    await sendBg({ type: 'DEBUGGER_TRUSTED_CLICK', tabId, x: btn.x, y: btn.y });
    return { ok: false, error: `크기 ${size} 항목을 못 찾음 (읽은 숫자: ${nums.map(n => n.n).join(',') || '없음'})` };
  }
  await sendBg({ type: 'DEBUGGER_TRUSTED_CLICK', tabId, x: hit.x, y: hit.y });
  await new Promise(r => setTimeout(r, 350));
  return { ok: true, picked: hit.txt };
}

// ─── 망고 사진함에서 슬롯 태그에 맞는 사진 고르기 ───
//
// 초안이 '[사진1 · walk+summer]' 로 태그를 지정해뒀다. walk 는 주제 태그, summer 는 계절이다.
// 덜 쓴 사진부터 고른다 — 같은 사진이 여러 글에 반복되면 티가 난다.
const PHOTO_TAGS = ['walk','water','travel','treat','home','health','gear','face','sleep','car','cafe','friend'];
const SEASONS = ['spring','summer','fall','winter'];

async function pickMangoPhoto(slotTags, usedIds) {
  const parts = String(slotTags || '').split(/[+,\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const tags = parts.filter(t => PHOTO_TAGS.includes(t));
  const season = parts.find(t => SEASONS.includes(t)) || '';

  // 태그+계절 → 태그만 → 아무거나. 조건을 풀어가며 찾는다.
  const tries = [
    { tag: tags.join(','), season },
    { tag: tags.join(','), season: '' },
    { tag: '', season: '' },
  ];
  for (const t of tries) {
    const qs = new URLSearchParams({ order: 'least_used', limit: '40' });
    if (t.tag) qs.set('tag', t.tag);
    if (t.season) qs.set('season', t.season);
    const r = await fetch(`${MANGOHUB_BASE}/api/mango-photos?${qs}`, { credentials: 'include' });
    if (r.status === 401) throw new Error('망고허브 로그인이 필요합니다');
    if (!r.ok) continue;
    const j = await r.json();
    const fresh = (j.photos || []).filter(p => !usedIds.has(p.id));
    if (fresh.length) {
      return { photo: fresh[0], matched: t.tag ? (t.season ? '태그+계절' : '태그') : '조건없음' };
    }
  }
  return null;
}

// ─── 사진 내려받아 올릴 크기로 다듬기 ───
//
// 사진함 원본은 장당 1MB 를 넘는다(1,127KB 를 그대로 올리고 있었다). 네이버 본문에
// 그 해상도가 필요하지도 않고, 업로드가 느려지고 실패 확률만 올라간다.
//   fit    — 긴 변을 maxPx 로 줄인다 (가로세로 비율 유지)
//   square — 가운데를 정사각형으로 잘라 maxPx 로 (목록에서 줄이 맞아 깔끔하다)
//   none   — 원본 그대로
async function photoToBase64(url, mode = 'fit', maxPx = 1280, quality = 0.86) {
  const r = await fetch(url.startsWith('http') ? url : MANGOHUB_BASE + url, { credentials: 'include' });
  if (!r.ok) throw new Error(`사진 내려받기 실패 ${r.status}`);
  const blob = await r.blob();

  const toB64 = (b) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = rej;
    fr.readAsDataURL(b);
  });

  if (mode === 'none') {
    return { b64: await toB64(blob), mime: blob.type || 'image/jpeg', size: blob.size, note: '원본' };
  }

  try {
    const bmp = await createImageBitmap(blob);
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height, dw, dh;
    if (mode === 'square') {
      const side = Math.min(bmp.width, bmp.height);
      sx = Math.round((bmp.width - side) / 2);
      sy = Math.round((bmp.height - side) / 2);
      sw = sh = side;
      dw = dh = Math.min(side, maxPx);
    } else {
      const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
      dw = Math.round(bmp.width * scale);
      dh = Math.round(bmp.height * scale);
    }
    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    // ⚠️ close() 뒤에는 width/height 가 0 이 된다 — 로그가 '0x0 → 960x1280' 으로 나온 이유
    const ow = bmp.width, oh = bmp.height;
    bmp.close();
    return {
      b64: await toB64(out), mime: 'image/jpeg', size: out.size,
      note: `${ow}x${oh} → ${dw}x${dh}`,
    };
  } catch (e) {
    // 리사이즈가 안 되면 원본으로라도 올린다
    return { b64: await toB64(blob), mime: blob.type || 'image/jpeg', size: blob.size, note: '리사이즈 실패, 원본' };
  }
}

// ─── 슬롯 자리에 사진 넣고, 캡션은 네이버 사진설명 칸에 ───
//
// 사용자 화면에서 확인된 두 가지를 반영했다 —
//  · 사진2 실패: 첫 업로드 뒤 네이버가 file input 을 치워버린다.
//    → 사진마다 업로더를 다시 확보한다(가로채기가 켜져 있으니 파일창은 안 뜬다).
//  · 캡션이 '잔' / '디밭 뛰고…' 로 쪼개짐: 자리표시 줄 가운데에 커서를 놓고 사진을
//    넣어 그 줄이 갈라졌다. → 자리표시 줄을 '지우고' 사진을 넣은 뒤, 이미지를 선택하면
//    나타나는 '사진 설명을 입력하세요' 칸에 캡션을 넣는다. 그게 네이버가 캡션으로
//    인식하는 자리이고, 캡션도 검색 대상 텍스트가 된다.
async function ensureUploader(tabId, frameId, button) {
  let probe = await sendFrame(tabId, frameId, { type: 'NAVER_FILE_INPUT' });
  if (probe.inputs?.length) return probe;
  if (!button) return probe;
  await sendBg({ type: 'DEBUGGER_TRUSTED_CLICK', tabId, x: button.x, y: button.y });
  await new Promise(r => setTimeout(r, 1400));
  return await sendFrame(tabId, frameId, { type: 'NAVER_FILE_INPUT' });
}

async function attachSlotPhotos(tabId, frameId, photos) {
  const first = await sendFrame(tabId, frameId, { type: 'NAVER_FILE_INPUT' });
  const button = first.button;

  const ic = await sendBg({ type: 'NAVER_FILECHOOSER', tabId, enabled: true });
  if (!ic?.ok) {
    blogLog(`파일창 가로채기 실패 — ${ic?.error || ''}. 사진은 직접 넣어주세요`, 'warn');
    return 0;
  }

  const usedIds = new Set();
  const mode = $('#blogPhotoFit')?.value || 'fit';
  const wantCaption = $('#blogPhotoCaption')?.checked !== false;
  let ok = 0;

  try {
    for (const slot of photos) {
      const marker = slot.marker || slot.caption || `[사진${slot.n}]`;
      try {
        const pick = await pickMangoPhoto(slot.tags, usedIds);
        if (!pick) { blogLog(`사진${slot.n}: 사진함에서 맞는 사진을 못 찾음`, 'warn'); continue; }
        usedIds.add(pick.photo.id);

        // ① 업로더 확보 — 사진마다 다시 (첫 업로드 뒤 input 이 사라진다)
        const up = await ensureUploader(tabId, frameId, button);
        if (!up.inputs?.length) { blogLog(`사진${slot.n}: 업로더를 못 만들었습니다`, 'warn'); continue; }

        // ② 자리표시 줄을 선택해 지운다 (줄 쪼개짐 방지)
        const sel = await sendFrame(tabId, frameId, { type: 'NAVER_SELECT_LINE', text: marker });
        if (!sel.ok) { blogLog(`사진${slot.n}: 자리표시 줄을 못 찾음 — ${sel.error}`, 'warn'); continue; }
        if (sel.drag) {
          await sendBg({ type: 'NAVER_CDP_SELECT', tabId, ...sel.drag });
          await new Promise(r => setTimeout(r, 140));
          await sendBg({ type: 'NAVER_CDP_KEY', tabId, key: 'Backspace' });
          await new Promise(r => setTimeout(r, 220));
        } else {
          await sendBg({ type: 'DEBUGGER_TRUSTED_CLICK', tabId, x: sel.x, y: sel.y });
          await new Promise(r => setTimeout(r, 250));
        }

        // ③ 사진 넣기
        const img = await photoToBase64(pick.photo.url, mode, mode === 'square' ? 1080 : 1280);
        blogLog(`사진${slot.n}: ${pick.matched} 매칭 · ${img.note} · ${Math.round(img.size / 1024)}KB 첨부 시도`);
        const att = await sendFrame(tabId, frameId, {
          type: 'NAVER_ATTACH_IMAGES',
          images: [{ b64: img.b64, mime: img.mime, name: `mango_${pick.photo.id}.jpg` }],
        });
        if (!(att.ok && att.inserted > 0)) {
          blogLog(`사진${slot.n} 삽입 실패 — ${att.reason || att.error || '이미지 수 변화 없음'}`, 'warn');
          continue;
        }
        ok++;
        blogLog(`사진${slot.n} 삽입됨 (에디터 이미지 ${att.before}→${att.after})`);
        fetch(`${MANGOHUB_BASE}/api/mango-photos/${pick.photo.id}/used`, { method: 'POST', credentials: 'include' }).catch(() => {});

        // ④ 캡션 — 이미지를 클릭해 선택하면 '사진 설명을 입력하세요' 칸이 나타난다
        if (wantCaption && slot.caption) {
          const ir = await sendFrame(tabId, frameId, { type: 'NAVER_IMAGE_RECT' });
          if (ir.ok) {
            await sendBg({ type: 'DEBUGGER_TRUSTED_CLICK', tabId, x: ir.x, y: ir.y });
            await new Promise(r => setTimeout(r, 500));
          }
          const cr = await sendFrame(tabId, frameId, { type: 'NAVER_CAPTION_RECT' });
          if (!cr.ok) {
            blogLog(`  사진${slot.n} 캡션 칸을 못 찾음 — ${cr.error}`, 'warn');
          } else {
            await sendBg({ type: 'DEBUGGER_TRUSTED_CLICK', tabId, x: cr.x, y: cr.y });
            await new Promise(r => setTimeout(r, 350));
            const ins = await sendBg({ type: 'NAVER_CDP_TEXT', tabId, text: slot.caption });
            blogLog(ins?.ok ? `  사진${slot.n} 캡션 입력: ${slot.caption}` : `  사진${slot.n} 캡션 실패 — ${ins?.error || ''}`,
                    ins?.ok ? 'info' : 'warn');
            // 캡션 편집에서 빠져나온다 (다음 작업이 캡션 안으로 들어가지 않게)
            await sendBg({ type: 'NAVER_CDP_KEY', tabId, key: 'Escape' });
            await new Promise(r => setTimeout(r, 250));
          }
        }
      } catch (e) {
        blogLog(`사진${slot.n} 오류 — ${e.message}`, 'error');
      }
    }
  } finally {
    // 켜둔 채로 두면 사람이 사진을 넣을 때 파일창이 안 뜬다
    await sendBg({ type: 'NAVER_FILECHOOSER', tabId, enabled: false });
  }
  return ok;
}

// ─── 채우기 ───
async function fillNaver() {
  if (!blogPicked) return;
  const btn = $('#blogFill');
  btn.disabled = true;
  blogStatus('채우는 중…');
  const tabIdHolder = {};
  try {
    const tabId = await ensureNaverTab();
    tabIdHolder.id = tabId;
    await injectNaver(tabId);

    const p = blogPicked.parsed;
    const keep = $('#blogKeepFormat').checked;

    // ① 본문 — 분량이 많아 시간이 걸린다
    const body = await typeIntoArea(tabId, '본문', p.text);
    naverFrameId = body.frameId != null ? body.frameId : naverFrameId;

    // ② 소제목 굵게 — 넣은 뒤 그 줄을 선택해 실제 편집 명령으로 적용한다
    if (body.ok && keep && p.bolds?.length) {
      const f = await sendFrame(tabId, body.frameId, { type: 'NAVER_FORMAT', bolds: p.bolds, fontSize: 5 });
      if (f.ok) {
        blogLog(`소제목 굵게 ${f.applied}/${f.total}개 적용`);
        if (f.missed?.length) blogLog(`못 찾은 소제목: ${f.missed.join(' / ')}`, 'warn');
      } else {
        blogLog('소제목 굵게 실패 — 에디터에서 직접 지정해주세요', 'warn');
      }

      // execCommand 가 막혔거나 일부만 먹었으면 CDP 로 진짜 Ctrl+B 를 쏜다.
      // (선택은 content script 가 잡아두고, CDP 키는 현재 선택에 작용한다)
      const remain = f.ok ? (f.missed || []) : p.bolds;
      if (remain.length) {
        blogLog(`남은 소제목 ${remain.length}개 — 드래그 선택 후 Ctrl+B 로 재시도`);
        let done = 0;
        const wantSize = $('#blogHeadSize')?.value || '';
        let sized = 0;
        for (const line of remain) {
          const sel = await sendFrame(tabId, body.frameId, { type: 'NAVER_SELECT_LINE', text: line });
          if (!sel.ok) { blogLog(`  건너뜀 (${line.slice(0, 20)}) — ${sel.error}`, 'warn'); continue; }
          if (!sel.drag) { blogLog(`  좌표 없음 (${line.slice(0, 20)})`, 'warn'); continue; }

          // ⚠️ Range 로 만든 선택은 에디터가 무시한다. 진짜 마우스로 그어야 한다.
          await sendBg({ type: 'NAVER_CDP_SELECT', tabId, ...sel.drag });
          await new Promise(r => setTimeout(r, 120));

          if (!sel.alreadyBold) {
            await sendBg({ type: 'NAVER_CDP_BOLD', tabId });
            await new Promise(r => setTimeout(r, 200));
          }
          const chk = await sendFrame(tabId, body.frameId, { type: 'NAVER_BOLD_CHECK', text: line });
          if (chk.bold) done++;
          else blogLog(`  굵게 안 먹음 (${line.slice(0, 20)})`, 'warn');

          // 폰트 크기 — 선택이 살아 있는 동안 툴바 드롭다운으로 바꾼다
          if (wantSize) {
            const fs = await setFontSize(tabId, body.frameId, wantSize);
            if (fs.ok) sized++;
            else if (sized === 0) blogLog(`  크기 실패 — ${fs.error}`, 'warn');
          }
        }
        blogLog(`드래그+Ctrl+B 굵게 ${done}/${remain.length}개 성공`, done ? 'info' : 'warn');
        if (wantSize) blogLog(`소제목 크기 ${wantSize} 적용 ${sized}/${remain.length}개`, sized ? 'info' : 'warn');
      }
    }

    // ③ 사진 — 초안이 지정한 자리에 망고 사진함에서 골라 넣는다
    if (body.ok && $('#blogAutoPhoto')?.checked && p.photos?.length) {
      const n = await attachSlotPhotos(tabId, body.frameId, p.photos);
      blogLog(`사진 ${n}/${p.photos.length}장 삽입`, n ? 'info' : 'warn');
      if (!n) blogLog('사진은 직접 넣어주세요. 자리표시 줄과 캡션은 그대로 남겨뒀습니다', 'warn');
    }

    // ④ 제목 — 마지막에 넣는다 (제목 클릭이 본문 커서를 밀지 않게)
    let title = { ok: false };
    if (blogPicked.title) {
      title = await typeIntoArea(tabId, '제목', blogPicked.title);
      naverTitleFrameId = title.frameId;
      if (!title.ok) {
        await navigator.clipboard.writeText(blogPicked.title).catch(() => {});
        blogLog('제목은 직접 입력해주세요 — 클립보드에 복사해뒀습니다', 'warn');
      }
    }

    if (body.ok) {
      blogStatus('채웠습니다. 사진 넣고 검토한 뒤 직접 발행하세요', 'ok');
      await navigator.clipboard.writeText(p.tagLine).catch(() => {});
      blogLog('해시태그를 클립보드에 넣어뒀습니다 — 본문 맨 아래에 붙여넣으세요');
    } else {
      blogStatus('본문이 안 들어갔습니다. 진단을 눌러 구조를 뽑아주세요', 'error');
    }
  } catch (e) {
    blogLog(e.message, 'error');
    blogStatus(e.message, 'error');
  } finally {
    // 디버거를 떼서 노란 배너를 없앤다 (붙어 있는 상태를 네이버가 볼 이유가 없다)
    if (tabIdHolder.id) await sendBg({ type: 'NAVER_CDP_DONE', tabId: tabIdHolder.id });
    btn.disabled = false;
  }
}

// ─── 이미지 내려받기 (임시 CDN 이 죽기 전에 확보) ───
async function saveBlogImages() {
  if (!blogPicked) return;
  const imgs = blogPicked.parsed.images;
  if (!imgs.length) { blogLog('내려받을 이미지가 없습니다', 'warn'); return; }
  let ok = 0, dead = 0;
  for (let i = 0; i < imgs.length; i++) {
    const url = imgs[i].src;
    try {
      const r = await fetch(url);
      if (!r.ok) { dead++; blogLog(`이미지 ${i + 1} 죽은 링크 (${r.status}) — ${url.slice(0, 60)}`, 'error'); continue; }
      const blob = await r.blob();
      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const name = `naver/${blogPicked.id}_${i + 1}.${ext}`;
      const dataUrl = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      await chrome.downloads.download({ url: dataUrl, filename: name, saveAs: false });
      ok++;
    } catch (e) {
      dead++;
      blogLog(`이미지 ${i + 1} 실패 — ${e.message}`, 'error');
    }
  }
  blogLog(`이미지 ${ok}장 내려받음${dead ? `, ${dead}장 실패` : ''} (다운로드 폴더 naver/)`);
  if (dead) blogLog('임시 CDN 링크가 만료된 것입니다. 초안을 오래 두면 이렇게 됩니다.', 'warn');
}

// ─── 진단 ───
// 프레임마다 구조를 뽑는다. 에디터가 바뀌어 셀렉터가 어긋날 때 이걸 보고 고친다.
async function diagnoseNaver() {
  try {
    const tabId = await ensureNaverTab();
    await injectNaver(tabId);
    const all = await askAll(tabId, { type: 'NAVER_DIAGNOSE' });
    const dump = all.map(x => ({ frameId: x.frameId, ...(x.res?.info || { error: x.res?.error }) }));
    console.log('[MangoAuto] 네이버 프레임 진단', dump);
    for (const d of dump) {
      if (d.error) { blogLog(`프레임 ${d.frameId}: ${d.error}`, 'warn'); continue; }
      blogLog(`프레임 ${d.frameId} (${d.frame}) · 입력영역 ${d.editableCount}개 · 제목 ${d.titleFound ? 'O' : 'X'} · 본문 ${d.bodyFound ? 'O' : 'X'} · file input ${d.fileInputs?.length ?? 0}`);
    }
    // 어느 프레임이 어느 영역을 갖는지도 같이 확인
    for (const area of ['제목', '본문']) {
      const pick = await pickFrameFor(tabId, area);
      blogLog(pick ? `→ ${area} 은 프레임 ${pick.frameId}` : `→ ${area} 을 가진 프레임이 없음`, pick ? 'info' : 'error');
    }
    // 사진 업로더·툴바 구조도 같이 뽑는다 (사진 자동첨부·폰트크기 구현에 필요)
    const bodyPick = await pickFrameFor(tabId, '본문');
    if (bodyPick) {
      const fi = await sendFrame(tabId, bodyPick.frameId, { type: 'NAVER_FILE_INPUT' });
      blogLog(`file input ${fi.inputs?.length ?? 0}개 · 사진버튼 ${fi.button ? fi.button.hint + ` @(${fi.button.x},${fi.button.y})` : '못 찾음'}`);
      const tb = await sendFrame(tabId, bodyPick.frameId, { type: 'NAVER_TOOLBAR' });
      console.log('[MangoAuto] 툴바 구조', tb);
      blogLog(`툴바 버튼 ${tb.buttons?.length ?? 0}개 · 폰트크기 컨트롤 ${tb.fontSize?.length ?? 0}개 (콘솔 참고)`);
      dump.push({ fileInput: fi, toolbar: tb });
    }
    await navigator.clipboard.writeText(JSON.stringify(dump, null, 2)).catch(() => {});
    blogLog('상세 구조를 클립보드에 복사했습니다 (콘솔에도 출력)');
  } catch (e) {
    blogLog(e.message, 'error');
  }
}

// ─── 사진 슬롯 목록 ───
// 초안이 '[사진1 · walk+summer]' 로 자리와 태그를 지정해뒀다. 본문에도 눈에 보이는
// 표시가 들어가고, 여기서 캡션을 복사해 네이버 사진 아래에 붙이면 된다.
function renderPhotoSlots(photos) {
  const box = $('#blogSlots');
  if (!box) return;
  if (!photos.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = '';
  box.innerHTML = `<div class="blog-slots-head">사진 자리 ${photos.length}칸 — 망고 사진함에서 태그로 골라 넣으세요</div>`;
  for (const p of photos) {
    const row = document.createElement('div');
    row.className = 'blog-slot';
    row.innerHTML = `
      <div class="blog-slot-n">사진${p.n}</div>
      <div class="blog-slot-body">
        <div class="blog-slot-tags"></div>
        <div class="blog-slot-cap"></div>
      </div>
      <button class="btn-ghost btn-xs blog-slot-copy">캡션</button>`;
    row.querySelector('.blog-slot-tags').textContent = p.tags || '(태그 없음)';
    row.querySelector('.blog-slot-cap').textContent = p.caption || '(캡션 없음)';
    row.querySelector('.blog-slot-copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(p.caption || '');
      blogLog(`사진${p.n} 캡션 복사: ${p.caption}`);
    });
    box.appendChild(row);
  }
}

function bindBlogEvents() {
  $('#blogRefresh')?.addEventListener('click', loadBlogDrafts);
  $$('.btab').forEach(t => t.addEventListener('click', () => {
    $$('.btab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    blogScope = t.dataset.scope;
    loadBlogDrafts();
  }));
  $('#blogClear')?.addEventListener('click', () => {
    blogPicked = null;
    $('#blogDetail').style.display = 'none';
    blogStatus('');
    renderBlogList();
  });
  $('#blogOpenWrite')?.addEventListener('click', async () => {
    await ensureNaverTab();
    blogLog('네이버 글쓰기를 열었습니다. 화면이 다 뜨면 채우기를 누르세요');
  });
  $('#blogFill')?.addEventListener('click', fillNaver);
  $('#blogCopyBody')?.addEventListener('click', async () => {
    if (!blogPicked) return;
    await navigator.clipboard.writeText(blogPicked.parsed.text);
    blogLog('본문을 클립보드에 복사했습니다 (에디터에서 Ctrl+V)');
  });
  $('#blogCopyTags')?.addEventListener('click', async () => {
    if (!blogPicked) return;
    await navigator.clipboard.writeText(blogPicked.parsed.tagLine);
    blogLog('해시태그를 복사했습니다');
  });
  $('#blogCopyThumb')?.addEventListener('click', async () => {
    if (!blogPicked) return;
    const t = blogPicked.parsed.thumbPrompt;
    if (!t) { blogLog('이 초안에는 썸네일 프롬프트가 없습니다', 'warn'); return; }
    await navigator.clipboard.writeText(t);
    blogLog('썸네일 프롬프트를 복사했습니다 (베이크 문구 포함)');
  });
  $('#blogSaveImages')?.addEventListener('click', saveBlogImages);
  $('#blogDiagnose')?.addEventListener('click', diagnoseNaver);
}

document.addEventListener('DOMContentLoaded', bindBlogEvents);
