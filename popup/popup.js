/**
 * MangoAuto - Popup Controller (Full Redesign)
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const MANGOHUB_BASE = 'https://mangois.love';

let currentSource = 'mangohub';
let currentPlatform = 'grok';
let currentMode = 'text-image';  // text-image | text-video | image-video | image-image
let currentContentType = 'segments';  // segments | thumbnail
let currentProject = null;
let uploadedImages = [];  // { file, dataUrl, name }
let lastState = null;
let reviewItems = [];

// ─── Supported URL patterns ───
const SUPPORTED_PATTERNS = [
  { pattern: /^https:\/\/grok\.com/,                   platform: 'grok' },
  { pattern: /^https:\/\/labs\.google\/fx\/.*tools\/video-fx/, platform: 'flow' },
  { pattern: /^https:\/\/labs\.google\/fx\/.*tools\/flow/,     platform: 'flow' },
  { pattern: /^https:\/\/labs\.google\/fx\/.*tools\/image-fx/, platform: 'whisk' }
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
  await loadReviewMode();
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
  try {
    const resp = await sendBg({ type: 'API_CHECK_AUTH' });
    const badge = $('#authBadge');
    if (resp.loggedIn) {
      badge.textContent = 'Connected';
      badge.className = 'badge badge-on';
      loadProjects();
    } else {
      badge.textContent = 'Not Connected';
      badge.className = 'badge badge-off';
    }
  } catch {
    $('#authBadge').textContent = 'Error';
    $('#authBadge').className = 'badge badge-off';
  }
}

// ─── Load Projects ───
async function loadProjects() {
  try {
    const projects = await sendBg({ type: 'API_LIST_PROJECTS' });
    const select = $('#projectSelect');
    select.innerHTML = '<option value="">프로젝트 선택...</option>';
    if (Array.isArray(projects)) {
      projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || `Project ${p.id}`;
        select.appendChild(opt);
      });
    }
  } catch (err) {
    addLog('프로젝트 로드 실패: ' + err.message, 'error');
  }
}

// ─── Bind All Events ───
function bindEvents() {
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

  // Main tabs (workspace / review / settings)
  $$('.mtab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.mtab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      $('#workspacePanel').classList.toggle('hidden', target !== 'workspace');
      $('#reviewPanel').classList.toggle('hidden', target !== 'review');
      $('#settingsPanel').classList.toggle('hidden', target !== 'settings');
      if (target === 'review') loadReviewQueue();
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

  // Save settings
  $('#saveSettingsBtn').addEventListener('click', saveSettings);

  // ── Review tab events ──
  $('#reviewModeToggle').addEventListener('change', async (e) => {
    await sendBg({ type: 'SET_REVIEW_MODE', enabled: e.target.checked });
    addLog(e.target.checked ? '검토 모드 활성화' : '검토 모드 비활성화', 'info');
  });

  $('#approveAllBtn').addEventListener('click', async () => {
    const result = await sendBg({ type: 'REVIEW_APPROVE_ALL' });
    if (result?.count > 0) addLog(`${result.count}개 전체 승인`, 'success');
    await loadReviewQueue();
  });

  $('#rejectAllBtn').addEventListener('click', async () => {
    if (!confirm('모든 대기 항목을 거부하시겠습니까?')) return;
    const result = await sendBg({ type: 'REVIEW_REJECT_ALL' });
    if (result?.count > 0) addLog(`${result.count}개 전체 거부`, 'info');
    await loadReviewQueue();
  });

  $('#uploadApprovedBtn').addEventListener('click', async () => {
    const result = await sendBg({ type: 'REVIEW_UPLOAD_APPROVED' });
    addLog(`승인 항목 업로드 시작 (${result?.count || 0}개)`, 'info');
    // Reload after a short delay to show uploading status
    setTimeout(() => loadReviewQueue(), 1000);
  });

  $('#clearCompletedBtn').addEventListener('click', async () => {
    await sendBg({ type: 'REVIEW_CLEAR_COMPLETED' });
    await loadReviewQueue();
    addLog('완료 항목 정리됨', 'info');
  });
}

// ─── Mode UI Update ───
function updateModeUI() {
  const needsImageUpload = currentMode === 'image-video' || currentMode === 'image-image';
  const imageSection = $('#imageUploadSection');
  if (currentSource === 'standalone') {
    imageSection.classList.toggle('hidden', !needsImageUpload);
  } else {
    imageSection.classList.add('hidden');
  }
}

function updateModeAvailability() {
  const videoOnly = false; // Flow는 모든 모드 지원
  const imageOnly = currentPlatform === 'whisk';
  const videoModes = ['text-video', 'image-video'];
  const imageModes = ['text-image', 'image-image'];

  $$('.mode-btn').forEach(btn => {
    const mode = btn.dataset.mode;
    const isVideo = videoModes.includes(mode);
    const isImage = imageModes.includes(mode);
    if (videoOnly && isImage) {
      btn.style.opacity = '0.3';
      btn.style.pointerEvents = 'none';
    } else if (imageOnly && isVideo) {
      btn.style.opacity = '0.3';
      btn.style.pointerEvents = 'none';
    } else {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }
  });

  // Auto-select appropriate mode
  if (videoOnly && imageModes.includes(currentMode)) {
    setMode('text-video');
  } else if (imageOnly && videoModes.includes(currentMode)) {
    setMode('text-image');
  }
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
    const project = await sendBg({ type: 'API_GET_PROJECT', projectId });
    currentProject = project;

    $('#projectName').textContent = project.name || 'Unnamed';
    $('#projectInfo').classList.remove('hidden');

    updateProjectInfo();
    updateQueuePreview();

    const thumbCount = (project.thumbnail_concepts?.concepts || []).filter(c => c.prompt).length;
    addLog(`불러옴: ${project.name} (세그먼트 ${(project.segments || []).length}개, 썸네일 ${thumbCount}개)`, 'info');
  } catch (err) {
    addLog('프로젝트 로드 실패: ' + err.message, 'error');
  }
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
    const segments = currentProject.segments || [];
    const withImagePrompt = segments.filter(s => s.prompt).length;
    const withVideoPrompt = segments.filter(s => s.video_prompt).length;
    const withImage = segments.filter(s => s.image_url).length;
    const withVideo = segments.filter(s => s.video_url).length;

    segmentCount.textContent =
      `${segments.length}개 세그먼트 | 이미지프롬프트 ${withImagePrompt} | 영상프롬프트 ${withVideoPrompt} | 이미지 ${withImage}장 | 영상 ${withVideo}개`;

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
      // 세그먼트 큐 (기존)
      const segments = currentProject.segments || [];
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
    div.innerHTML = `
      <span class="queue-idx">${String(item._isMangoHub ? item.idx : item.idx + 1).padStart(3, '0')}</span>
      ${thumbHtml}
      <span class="queue-text">${escapeHtml(item.text)}</span>
      <span class="queue-status qs-pending">대기</span>
    `;
    queueList.appendChild(div);
  }
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
    config.useExistingImages = $('#useExistingImages').checked;
    config.skipCompleted = $('#skipCompleted').checked;

    // 썸네일 모드: 기존 이미지가 있으면 확인
    if (currentContentType === 'thumbnail') {
      const thumbImages = currentProject?.thumbnail_images || {};
      const existingCount = Object.keys(thumbImages).filter(k => !!thumbImages[k]).length;
      if (existingCount > 0 && config.skipCompleted) {
        const doOverwrite = confirm(
          `이미 생성된 썸네일이 ${existingCount}개 있습니다.\n` +
          `[확인] 기존 이미지 건너뛰고 나머지만 생성\n` +
          `[취소] 전체 다시 생성`
        );
        if (!doOverwrite) {
          config.skipCompleted = false;
        }
      }
    }
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

  saveSettings();
}

// ─── Gather Settings ───
function gatherSettings() {
  return {
    grok: {
      videoDuration: $('#grokVideoDuration').value,
      videoResolution: $('#grokVideoResolution').value,
      aspectRatio: $('#grokAspectRatio').value,
      timeout: parseInt($('#grokTimeout').value) || 5
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
      concurrentCount: parseInt($('#concurrentCount').value) || 1,
      promptDelay: parseInt($('#promptDelay').value) || 40
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

  // 결과 맵 빌드 (index → success)
  const doneMap = new Map();
  for (const r of state.results) {
    doneMap.set(r.index, r.success);
  }

  // 파이프라인 모드: 현재 진행 중인 항목 인덱스
  const activeSet = new Set(state.activeIndices || []);

  items.forEach((item, i) => {
    const statusEl = item.querySelector('.queue-status');
    if (!statusEl) return;

    if (doneMap.has(i)) {
      // 완료 또는 실패
      const success = doneMap.get(i);
      statusEl.textContent = success ? '완료' : '실패';
      statusEl.className = `queue-status ${success ? 'qs-done' : 'qs-fail'}`;
    } else if (activeSet.size > 0 ? activeSet.has(i) : i === state.currentIndex) {
      // 진행중 (파이프라인: activeIndices, 순차: currentIndex)
      statusEl.textContent = '진행중';
      statusEl.className = 'queue-status qs-running';
    } else {
      // 대기
      statusEl.textContent = '대기';
      statusEl.className = 'queue-status qs-pending';
    }

    // 완료 상태에서 체크박스 표시
    if (isCompleted && !item.querySelector('.queue-check')) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'queue-check';
      cb.dataset.index = i;
      item.insertBefore(cb, item.firstChild);
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
async function saveSettings() {
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
    if (s.general.defaultMode) $('#defaultMode').value = s.general.defaultMode;
    if (s.general.concurrentCount) $('#concurrentCount').value = s.general.concurrentCount;
    if (s.general.promptDelay) $('#promptDelay').value = s.general.promptDelay;
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
  try {
    const result = await sendBg({ type: 'GET_REVIEW_MODE' });
    if (result?.enabled) {
      $('#reviewModeToggle').checked = true;
    }
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
