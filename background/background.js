/**
 * MangoAuto - Service Worker (Central Orchestrator)
 * Supports concurrent prompt processing, download quality/folders, prompt delay
 */

importScripts('../lib/utils.js', '../lib/mangohub-api.js', '../lib/state-machine.js');

const sm = new AutomationStateMachine();
let activeTabIds = [];      // Multiple tabs for concurrent processing
let automationSettings = {};
let allResults = [];        // { index, success, dataUrl?, filename? }
let reviewModeEnabled = false;

// 썸네일 문구 → 최종 프롬프트 조합 (노란=큰글씨, 흰=작은글씨, swap=위치만)
function _buildThumbFinalPrompt(basePrompt, textData) {
  if (!basePrompt) return '';
  let prompt = basePrompt.trim();
  const yellowText = (textData?.top || '').trim();
  const whiteText = (textData?.bottom || '').trim();
  const isSwapped = !!textData?.swapped;

  if (!yellowText && !whiteText) return prompt;

  prompt = prompt.replace(/, no text, no letters, no watermark/gi, '');
  let ti = ', with large bold impactful YouTube thumbnail style Korean text overlay on the lower portion of the image';
  if (yellowText && whiteText) {
    const topText = isSwapped ? whiteText : yellowText;
    const botText = isSwapped ? yellowText : whiteText;
    const topColor = isSwapped ? 'bold white' : 'EXTRA LARGE bold golden-orange (#F5A623)';
    const botColor = isSwapped ? 'EXTRA LARGE bold golden-orange (#F5A623)' : 'bold white';
    const bigPos = isSwapped ? 'bottom' : 'top';
    ti += `. Top line reads "${topText}" in ${topColor} color with thick black outline stroke. Bottom line reads "${botText}" in ${botColor} color with thick black outline stroke. The ${bigPos} line (golden-orange one) should be about 1.5x larger font size. Both lines centered horizontally, extra bold weight, dramatic impact font style like popular YouTube thumbnails`;
  } else if (yellowText) {
    ti += `. Text reads "${yellowText}" in EXTRA LARGE bold golden-orange (#F5A623) color with thick black outline stroke, centered, extra bold weight, dramatic impact font style`;
  } else {
    ti += `. Text reads "${whiteText}" in bold white color with thick black outline stroke, centered, extra bold weight, dramatic impact font style`;
  }
  return prompt + ti;
}

// Restore review mode on startup
chrome.storage.local.get('mangoauto_review_mode').then(data => {
  reviewModeEnabled = data.mangoauto_review_mode || false;
});

// Clear any old corrupted storage data (prevents QuotaExceededError)
chrome.storage.local.remove('mangoauto_state').catch(() => {});

// Concurrent processing state
let concurrentCount = 1;
let promptDelay = 40;       // seconds between prompts in concurrent mode
let activeTasks = new Map(); // tabId → { item, index, status }
let pendingCompletions = 0;

// Pipeline mode state
let pipelineNextIdx = 0;

// ─── Side Panel: open on icon click ───
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Keepalive + Watchdog via chrome.alarms ───
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
let _lastStateChange = Date.now();
let _lastWatchdogState = null;

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    // Watchdog: GENERATING/DOWNLOADING/UPLOADING 상태가 너무 오래 지속되면 에러 처리
    const state = sm.state;
    const stuckStates = [AutoState.GENERATING, AutoState.DOWNLOADING, AutoState.UPLOADING];

    if (state !== _lastWatchdogState) {
      _lastStateChange = Date.now();
      _lastWatchdogState = state;
    }

    if (stuckStates.includes(state)) {
      // 타임아웃 계산: Grok 비디오는 길게 (10분), 나머지는 5분
      const isGrokVideo = sm.platform === 'grok' && sm.mediaType === 'video';
      const maxStuckMs = isGrokVideo ? 600000 : 300000; // 10분 / 5분
      const elapsed = Date.now() - _lastStateChange;

      if (elapsed > maxStuckMs) {
        broadcastLog(`Watchdog: ${state} 상태 ${Math.round(elapsed/1000)}초 경과 → 강제 에러 처리`, 'error');

        // 현재 아이템 실패 처리 후 다음으로 진행
        const item = sm.currentItem;
        sm.results.push({
          success: false,
          index: sm._resultIndex?.() ?? sm.currentIndex,
          segmentIndex: item?.segmentIndex,
          error: `Watchdog timeout (${Math.round(elapsed/1000)}s stuck in ${state})`
        });
        sm.transition(AutoState.COOLDOWN);
        _lastStateChange = Date.now();
        broadcastState(getExtendedSnapshot());
        await handleCooldownAndNext();
      }
    }
  }
});

// ─── State broadcast (safe, no onChange callback) ───
function broadcastState(snapshot) {
  try {
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', data: snapshot }).catch(() => {});
  } catch (e) { /* sidepanel not open */ }
}

function broadcastLog(text, level = 'info') {
  try {
    chrome.runtime.sendMessage({ type: 'LOG', text, level }).catch(() => {});
  } catch (e) { /* sidepanel not open */ }
}

// Extended snapshot: includes pipeline active indices
function getExtendedSnapshot() {
  const snapshot = sm.getSnapshot();
  if (concurrentCount > 1 && activeTasks.size > 0) {
    snapshot.activeIndices = [...activeTasks.values()].map(t => t.index);
  }
  return snapshot;
}

// ─── LLM 프롬프트 수정 (검열 회피) ───
const CENSORSHIP_PATTERNS = [
  'safety', 'blocked', 'policy', 'harmful', 'inappropriate', 'violat',
  'prohibited', 'not allowed', 'content filter', 'moderat',
  'responsible ai', 'generation failed', 'MEDIA_GENERATION_STATUS_FAILED',
  '생성 실패', '생성에 실패', '안전', '차단', '정책', '부적절'
];

function isCensorshipError(errorMsg, errorCode) {
  const combined = `${errorMsg || ''} ${errorCode || ''}`.toLowerCase();
  return CENSORSHIP_PATTERNS.some(p => combined.includes(p));
}

async function callKieApi(model, apiKey, prompt) {
  const url = `https://api.kie.ai/${model}/v1/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'system',
          content: '당신은 AI 이미지/영상 생성 프롬프트 전문가입니다. 사용자의 프롬프트가 Google의 콘텐츠 정책으로 거부되었습니다. 원래의 시각적 묘사와 의미를 최대한 유지하면서, 검열에 걸릴 수 있는 표현 1~2개만 부드럽게 수정해주세요. 수정된 프롬프트만 출력하세요. 설명이나 부연 없이 프롬프트 텍스트만 반환하세요.'
        },
        {
          role: 'user',
          content: `다음 프롬프트가 거부되었습니다. 수정해주세요:\n\n${prompt}`
        }
      ],
      stream: false
    })
  });
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    throw new Error(`KIE API ${model} error ${resp.status}: ${errData.error?.message || resp.statusText}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('LLM returned empty response');
  return content;
}

async function rewritePromptWithLLM(prompt, apiKey) {
  // 1차: Gemini 3 Pro
  try {
    broadcastLog('LLM 프롬프트 수정 중 (Gemini 3 Pro)...', 'info');
    const rewritten = await callKieApi('gemini-3-pro', apiKey, prompt);
    broadcastLog(`프롬프트 수정 완료: "${rewritten.substring(0, 60)}..."`, 'info');
    return rewritten;
  } catch (err) {
    broadcastLog(`Gemini 실패: ${err.message}, Claude로 폴백`, 'warn');
  }
  // 2차: Claude Opus 4.5
  try {
    broadcastLog('LLM 프롬프트 수정 중 (Claude Opus 4.5)...', 'info');
    const rewritten = await callKieApi('claude-opus-4-5', apiKey, prompt);
    broadcastLog(`프롬프트 수정 완료: "${rewritten.substring(0, 60)}..."`, 'info');
    return rewritten;
  } catch (err) {
    broadcastLog(`Claude도 실패: ${err.message}`, 'error');
    return null;
  }
}

// Generation timeout (content script timeout + 2분 안전 버퍼)
function getGenerationTimeoutMs() {
  let base;
  if (sm.platform === 'flow') {
    // 비디오 모드는 frameDuration 사용, 이미지 모드는 flowTimeout 사용
    const fv = automationSettings?.flowVideo || automationSettings?.veo;
    if (sm.mediaType === 'video') {
      base = (fv?.frameDuration || 10) * 60 * 1000;
    } else {
      base = (automationSettings?.flowTimeout || 3) * 60 * 1000;
    }
  } else {
    base = (automationSettings?.grok?.timeout || 5) * 60 * 1000;
  }
  return base + 2 * 60 * 1000;
}

// ─── Message Router ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    // ── MangoHub API Proxy ──
    case 'API_CHECK_AUTH':
      return { loggedIn: await MangoHubAPI.checkAuth() };

    case 'API_LIST_PROJECTS':
      return await MangoHubAPI.listProjects();

    case 'API_GET_PROJECT':
      return await MangoHubAPI.getProject(msg.projectId);

    case 'API_UPLOAD_IMAGE': {
      const blob = await fetch(msg.dataUrl).then(r => r.blob());
      return await MangoHubAPI.uploadImage(msg.projectId, msg.segmentIndex, blob, msg.filename);
    }

    case 'API_UPLOAD_VIDEO': {
      const blob = await fetch(msg.dataUrl).then(r => r.blob());
      return await MangoHubAPI.uploadVideo(msg.projectId, msg.segmentIndex, blob, msg.filename);
    }

    case 'API_UPLOAD_THUMBNAIL': {
      const blob = await fetch(msg.dataUrl).then(r => r.blob());
      return await MangoHubAPI.uploadThumbnailImage(msg.projectId, msg.conceptIndex, blob, msg.filename);
    }

    // ── Automation Control ──
    case 'START_AUTOMATION':
      return await startAutomation(msg.config);

    case 'PAUSE_AUTOMATION':
      sm.pause();
      return { ok: true };

    case 'RESUME_AUTOMATION':
      sm.resume();
      await runLoop();
      return { ok: true };

    case 'STOP_AUTOMATION':
      sm.reset();
      allResults = [];
      // 파이프라인 타임아웃 정리
      for (const [, task] of activeTasks) {
        if (task.timeoutId) clearTimeout(task.timeoutId);
      }
      activeTasks.clear();
      pendingCompletions = 0;
      pipelineNextIdx = 0;
      // Content script에 중지 신호 전송 (진행 중인 작업 취소)
      for (const tabId of activeTabIds) {
        try {
          chrome.tabs.sendMessage(tabId, { type: 'STOP_GENERATION' }).catch(() => {});
        } catch (e) { /* tab may not exist */ }
      }
      return { ok: true };

    case 'GET_STATE':
      return getExtendedSnapshot();

    case 'SKIP_CURRENT':
      sm.skipCurrent();
      return { ok: true };

    case 'DOWNLOAD_ALL_RESULTS':
      return await downloadAllResults();

    case 'RETRY_FAILED':
      return await retryFailed();

    case 'RETRY_SELECTED':
      return await retrySelected(msg.indices);

    // ── File Injection (MAIN world) ──
    case 'INJECT_GROK_FILE':
      return await injectFileToGrok(msg, sender);

    case 'INJECT_FILE_INPUT':
      return await injectFileToFlow(msg, sender);

    case 'DOWNLOAD_VIDEO':
      return await downloadMedia(msg);

    case 'DOWNLOAD_IMAGE':
      return await downloadMedia(msg);

    // ── Content Script → Background ──
    case 'GENERATION_COMPLETE':
      await handleGenerationComplete(msg, sender);
      return { ok: true };

    case 'GENERATION_ERROR':
      await handleGenerationError(msg, sender);
      return { ok: true };

    // ── Review Queue ──
    case 'SET_REVIEW_MODE':
      reviewModeEnabled = msg.enabled;
      await chrome.storage.local.set({ mangoauto_review_mode: msg.enabled });
      return { ok: true };

    case 'GET_REVIEW_MODE': {
      const stored = await chrome.storage.local.get('mangoauto_review_mode');
      reviewModeEnabled = stored.mangoauto_review_mode || false;
      return { enabled: reviewModeEnabled };
    }

    case 'GET_REVIEW_QUEUE':
      return await getReviewQueue();

    case 'REVIEW_APPROVE':
      return await updateReviewItemStatus(msg.id, 'approved');

    case 'REVIEW_REJECT':
      return await updateReviewItemStatus(msg.id, 'rejected');

    case 'REVIEW_APPROVE_ALL':
      return await bulkUpdateReviewStatus('pending', 'approved');

    case 'REVIEW_REJECT_ALL':
      return await bulkUpdateReviewStatus('pending', 'rejected');

    case 'REVIEW_UPLOAD_APPROVED':
      return await uploadApprovedItems();

    case 'REVIEW_CLEAR_COMPLETED':
      return await clearCompletedReviewItems();

    // ── API Key Export (cross-profile sharing) ──
    case 'EXPORT_API_KEY':
      return await exportApiKey(msg.apiKey);

    default:
      return { error: 'Unknown message type: ' + msg.type };
  }
}

// ─── Start Automation ───
async function startAutomation(config) {
  const { source, platform, mode, settings, projectId, prompts, images,
          useExistingImages, skipCompleted, contentType } = config;

  broadcastLog(`자동화 시작: source=${source}, platform=${platform}, mode=${mode}, contentType=${contentType || 'segments'}`, 'info');

  automationSettings = settings || {};
  allResults = [];
  activeTasks.clear();
  pendingCompletions = 0;
  pipelineNextIdx = 0;

  // Concurrent settings
  concurrentCount = parseInt(settings?.general?.concurrentCount) || 1;
  promptDelay = (parseInt(settings?.general?.promptDelay) || 40) * 1000;
  broadcastLog(`동시처리: ${concurrentCount}개, 전송간격: ${promptDelay/1000}초`, 'info');

  // Max retries
  sm.maxRetries = settings?.general?.maxRetries || 3;

  // Determine media type from mode
  const mediaType = ['text-image', 'image-image'].includes(mode) ? 'image' : 'video';

  let queue = [];

  if (source === 'mangohub' && projectId) {
    const project = await MangoHubAPI.getProject(projectId);

    if (contentType === 'thumbnail') {
      // 썸네일 프롬프트 큐 빌드 (문구 포함 최종 프롬프트)
      const concepts = project.thumbnail_concepts?.concepts || [];
      const thumbImages = project.thumbnail_images || {};
      const thumbTexts = project.thumbnail_texts || {};

      for (let i = 0; i < concepts.length; i++) {
        const c = concepts[i];
        if (!c.prompt) continue;
        broadcastLog(`썸네일[${i}] 서버 원본: "${c.prompt.substring(0, 80)}..."`, 'info');
        const hasExisting = !!thumbImages[String(i)];
        if (skipCompleted && hasExisting) continue;

        const finalPrompt = _buildThumbFinalPrompt(c.prompt, thumbTexts[String(i)]);
        broadcastLog(`썸네일[${i}] 최종 프롬프트: "${finalPrompt.substring(0, 80)}..."`, 'info');

        queue.push({
          segmentIndex: i,  // concept index (0-based)
          prompt: finalPrompt,
          text: MangoUtils.truncate(c.name || c.prompt, 50),
          _isThumbnail: true,
          _conceptGroup: c.group || 'A'
        });
      }
      broadcastLog(`썸네일 프롬프트 ${queue.length}개 로드 (전체 ${concepts.length}개, 문구 포함)`, 'info');
    } else {
      // 세그먼트 프롬프트 큐 빌드 (기존)
      const segments = project.segments || [];

      for (const seg of segments) {
        const promptField = mediaType === 'video' ? 'video_prompt' : 'prompt';
        const existingField = mediaType === 'video' ? 'video_url' : 'image_url';

        if (!seg[promptField]) continue;
        if (skipCompleted && seg[existingField]) continue;

        const item = {
          segmentIndex: seg.index,
          prompt: seg[promptField],
          text: MangoUtils.truncate(seg.text || seg[promptField], 50)
        };

        // Image-to-video: include source image
        if (mode === 'image-video' && useExistingImages && seg.image_url) {
          item.sourceImageUrl = seg.image_url;
        }

        queue.push(item);
      }
    }
  } else {
    // Standalone mode
    const promptList = prompts || [];
    const imageList = images || [];

    if (mode === 'image-video') {
      // Image-to-video: pair images with prompts
      const count = Math.max(imageList.length, promptList.length);
      for (let i = 0; i < count; i++) {
        const prompt = promptList[i] || promptList[promptList.length - 1] || '';
        const img = imageList[i] || null;
        queue.push({
          segmentIndex: i,
          prompt: prompt,
          text: MangoUtils.truncate(prompt || (img ? img.name : ''), 50),
          sourceImageDataUrl: img ? img.dataUrl : null
        });
      }
    } else if (mode === 'image-image') {
      // Image-to-image: pair images with prompts
      const count = Math.max(imageList.length, promptList.length);
      for (let i = 0; i < count; i++) {
        const prompt = promptList[i] || promptList[promptList.length - 1] || '';
        const img = imageList[i] || null;
        queue.push({
          segmentIndex: i,
          prompt: prompt,
          text: MangoUtils.truncate(prompt || (img ? img.name : ''), 50),
          sourceImageDataUrl: img ? img.dataUrl : null
        });
      }
    } else {
      // Text-to-image or text-to-video
      queue = promptList.map((p, i) => ({
        segmentIndex: i,
        prompt: p,
        text: MangoUtils.truncate(p, 50)
      }));
    }
  }

  if (queue.length === 0) {
    broadcastLog('큐가 비어있습니다', 'error');
    return { error: '처리할 프롬프트가 없습니다' };
  }

  broadcastLog(`큐 생성 완료: ${queue.length}개 항목, mediaType=${mediaType}`, 'info');

  // Log first item for debugging
  if (queue[0]) {
    broadcastLog(`첫 항목: prompt="${(queue[0].prompt || '').substring(0, 40)}", hasImage=${!!queue[0].sourceImageDataUrl}`, 'info');
  }

  // Calculate cooldown
  const cooldownMin = (settings?.general?.cooldownMin || 3) * 1000;
  const cooldownMax = (settings?.general?.cooldownMax || 6) * 1000;
  const avgCooldown = Math.round((cooldownMin + cooldownMax) / 2);

  sm.init({
    queue, mode: source, platform, mediaType,
    projectId, cooldownMs: avgCooldown
  });

  // Store full config for later use
  sm._config = config;
  sm._cooldownMin = cooldownMin;
  sm._cooldownMax = cooldownMax;

  sm.start();

  // Ensure target tabs
  broadcastLog(`대상 탭 확인 중... (platform=${platform}, count=${concurrentCount})`, 'info');
  await ensureTargetTabs(platform, concurrentCount);
  broadcastLog(`활성 탭: [${activeTabIds.join(', ')}]`, 'info');

  // Content script 설정 플래그 리셋 (새 자동화 시작 시 설정 재적용)
  for (const tabId of activeTabIds) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'RESET_SETTINGS' });
    } catch { /* content script not ready yet */ }
  }
  await MangoUtils.sleep(2000);

  broadcastLog('자동화 루프 시작!', 'info');
  runLoop().catch(err => {
    broadcastLog(`루프 에러: ${err.message}`, 'error');
    console.error('[Background] runLoop error:', err);
  });
  return { ok: true, count: queue.length };
}

// ─── Ensure target site tabs are open (supports concurrent) ───
async function ensureTargetTabs(platform, count) {
  const urls = {
    grok: 'https://grok.com/imagine',
    whisk: 'https://labs.google/fx/tools/image-fx',
    flow: 'https://labs.google/fx/tools/flow'
  };

  const targetUrl = urls[platform];
  if (!targetUrl) throw new Error('Unknown platform: ' + platform);

  // Find existing tabs (including locale variants and project pages)
  let tabs = await chrome.tabs.query({ url: targetUrl + '*' });

  if (platform !== 'grok' && tabs.length === 0) {
    const toolName = targetUrl.split('/tools/')[1];
    tabs = await chrome.tabs.query({ url: `https://labs.google/fx/*/tools/${toolName}*` });
  }

  // Flow: video-fx 탭도 검색
  if (platform === 'flow' && tabs.length === 0) {
    const vfxTabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*/tools/video-fx*' });
    if (vfxTabs.length === 0) {
      const vfxTabs2 = await chrome.tabs.query({ url: 'https://labs.google/fx/tools/video-fx*' });
      tabs = vfxTabs2;
    } else {
      tabs = vfxTabs;
    }
  }

  activeTabIds = tabs.map(t => t.id).slice(0, count);

  // Create additional tabs if needed
  while (activeTabIds.length < count) {
    const tab = await chrome.tabs.create({ url: targetUrl, active: activeTabIds.length === 0 });
    await waitForTabLoad(tab.id);
    await MangoUtils.sleep(2000);
    activeTabIds.push(tab.id);
  }

  // Activate first tab
  if (activeTabIds.length > 0) {
    await chrome.tabs.update(activeTabIds[0], { active: true });
  }
}

async function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Timeout fallback
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

// ─── Main Automation Loop ───
async function runLoop() {
  if (sm.state !== AutoState.PREPARING) return;
  if (concurrentCount > 1) {
    await runPipelineMode();
  } else {
    await runSequentialLoop();
  }
}

// ─── Sequential loop (single tab) ───
async function runSequentialLoop() {
  while (sm.state === AutoState.PREPARING) {
    const item = sm.currentItem;
    if (!item) {
      sm.transition(AutoState.COMPLETED);
      break;
    }

    const idx = sm.currentIndex + 1;
    const total = sm.queue.length;
    MangoUtils.log('info', `Processing ${idx}/${total}: ${item.text}`);
    broadcastLog(`[${idx}/${total}] ${item.text}`, 'info');

    sm.markGenerating();
    broadcastState(getExtendedSnapshot());

    let resp;
    try {
      // Fetch source image if needed (MangoHub image-to-video mode)
      if (item.sourceImageUrl && !item.sourceImageDataUrl) {
        broadcastLog('소스 이미지 다운로드 중...', 'info');
        await fetchSourceImage(item);
      }
      const message = buildExecuteMessage(item);
      broadcastLog(`탭 ${activeTabIds[0]}에 EXECUTE_PROMPT 전송 중... (mode=${message.settings?._mode}, hasImage=${!!message.sourceImageDataUrl})`, 'info');
      resp = await sendToTab(activeTabIds[0] || null, message);
      broadcastLog(`Content script 응답: ${JSON.stringify(resp)}`, 'info');
    } catch (err) {
      broadcastLog(`sendToTab 실패: ${err.message}`, 'error');
      sm.markError(err);
      broadcastState(getExtendedSnapshot());
      if (sm.state === AutoState.ERROR) {
        broadcastLog(`에러 (재시도 ${sm.retryCount}/${sm.maxRetries}): ${err.message}`, 'error');
        await MangoUtils.sleep(3000);
        sm.transition(AutoState.PREPARING);
        continue;
      }
      broadcastLog(`실패: ${err.message}`, 'error');
      await handleCooldownAndNext();
      continue;
    }

    // Content script가 에러를 반환한 경우 → 인라인 처리 (GENERATION_ERROR 레이스 방지)
    if (resp?.error) {
      broadcastLog(`생성 에러: ${resp.error}`, 'error');
      sm.markError(resp.error);
      broadcastState(getExtendedSnapshot());
      if (sm.state === AutoState.ERROR) {
        broadcastLog(`에러 (재시도 ${sm.retryCount}/${sm.maxRetries}): ${resp.error}`, 'error');
        await MangoUtils.sleep(3000);
        sm.transition(AutoState.PREPARING);
        continue;
      }

      // maxRetries 초과 → 검열 에러이면 LLM 프롬프트 수정 재시도
      const llmCfg = automationSettings?.llm;
      const llmMaxAttempts = llmCfg?.retryCount || 2;
      const llmAttemptsSoFar = item._llmRewriteCount || 0;

      if (llmCfg?.enabled && llmCfg?.kieApiKey &&
          !item._isThumbnail &&
          isCensorshipError(resp.error, resp.errorCode) &&
          llmAttemptsSoFar < llmMaxAttempts) {
        broadcastLog(`검열 에러 감지 → LLM 프롬프트 수정 시도 (${llmAttemptsSoFar + 1}/${llmMaxAttempts})`, 'info');
        // 매번 원본 프롬프트 기준으로 LLM에 요청 (다른 수정본을 받기 위해)
        const originalPrompt = item._originalPrompt || item.prompt;
        const rewritten = await rewritePromptWithLLM(originalPrompt, llmCfg.kieApiKey);
        if (rewritten) {
          item._originalPrompt = item._originalPrompt || item.prompt;
          item.prompt = rewritten;
          item._llmRewriteCount = llmAttemptsSoFar + 1;

          // 실패 결과 제거 (LLM 재시도이므로 다시 시도)
          const lastResult = sm.results[sm.results.length - 1];
          if (lastResult && !lastResult.success) {
            sm.results.pop();
          }

          // 일반 재시도 1번만 (실패하면 다시 LLM 수정)
          sm.retryCount = 0;
          sm.maxRetries = 1;
          broadcastLog(`LLM 수정본 #${llmAttemptsSoFar + 1}: "${rewritten.substring(0, 60)}..."`, 'info');
          sm.transition(AutoState.PREPARING);
          continue;
        }
      }

      // LLM 수정 시도 완료 후 원본 maxRetries 복원
      if (item._llmRewriteCount) {
        sm.maxRetries = automationSettings?.general?.maxRetries || 3;
      }

      broadcastLog(`최종 실패: ${resp.error}`, 'error');
      await handleCooldownAndNext();
      continue;
    }

    // Content script will report back via GENERATION_COMPLETE with media data
    break;
  }
}

// ─── Pipeline mode (sliding window) ───
// 슬롯 N개를 항상 채우면서 진행. 하나 끝나면 즉시 다음 채움.
async function runPipelineMode() {
  sm.markGenerating();
  broadcastLog(`파이프라인 모드: 동시 ${concurrentCount}개, 전송간격 ${promptDelay/1000}초`, 'info');

  // Initial fill: 슬롯을 순차적으로 채움 (전송 간격 적용)
  for (let i = 0; i < concurrentCount && pipelineNextIdx < sm.queue.length; i++) {
    if (sm.state !== AutoState.GENERATING) break;

    const sent = await sendNextPipelineItem();
    if (!sent) continue; // 전송 실패 시 다음 시도

    // 다음 슬롯 채우기 전 전송 간격 대기
    if (i < concurrentCount - 1 && pipelineNextIdx < sm.queue.length) {
      const delay = Math.max(3000, promptDelay);
      broadcastLog(`다음 전송까지 ${Math.round(delay/1000)}초 대기...`, 'info');
      await MangoUtils.sleep(delay);
    }
  }

  checkPipelineCompletion();
}

// 다음 대기 항목을 빈 슬롯(탭)에 전송
async function sendNextPipelineItem() {
  if (pipelineNextIdx >= sm.queue.length) return false;
  if (sm.state === AutoState.IDLE || sm.state === AutoState.COMPLETED || sm.state === AutoState.PAUSED) return false;

  const freeTabId = activeTabIds.find(id => !activeTasks.has(id));
  if (!freeTabId) return false;

  const itemIndex = pipelineNextIdx;
  const item = sm.queue[itemIndex];
  pipelineNextIdx++;

  // 재시도/재생성 시 원본 인덱스 사용
  const resultIndex = (sm._useOriginalIndex && item?._originalIndex !== undefined)
    ? item._originalIndex : itemIndex;

  activeTasks.set(freeTabId, { item, index: resultIndex, queueIndex: itemIndex, status: 'processing' });

  const idx = itemIndex + 1;
  const total = sm.queue.length;
  broadcastLog(`[${idx}/${total}] ${item.text}`, 'info');

  try {
    if (item.sourceImageUrl && !item.sourceImageDataUrl) {
      broadcastLog('소스 이미지 다운로드 중...', 'info');
      await fetchSourceImage(item);
    }
    const message = buildExecuteMessage(item);
    await sendToTab(freeTabId, message);

    // 안전 타임아웃: 컨텐츠 스크립트가 응답 없을 때 슬롯 해제
    const timeoutMs = getGenerationTimeoutMs();
    const timeoutId = setTimeout(async () => {
      const task = activeTasks.get(freeTabId);
      if (task && task.queueIndex === itemIndex) {
        broadcastLog(`타임아웃 [${itemIndex + 1}]: 응답 없음 (${Math.round(timeoutMs/60000)}분), 다음 진행`, 'error');
        sm.results.push({ success: false, index: resultIndex, segmentIndex: item.segmentIndex, error: 'Timeout' });
        activeTasks.delete(freeTabId);
        sm.currentIndex = sm.results.length;
        broadcastState(getExtendedSnapshot());
        await sendNextPipelineItem();
        checkPipelineCompletion();
      }
    }, timeoutMs);
    activeTasks.get(freeTabId).timeoutId = timeoutId;

    return true;
  } catch (err) {
    broadcastLog(`전송 실패: ${err.message}`, 'error');
    activeTasks.delete(freeTabId);
    sm.results.push({ success: false, index: resultIndex, segmentIndex: item.segmentIndex, error: err.message });
    return false;
  }
}

// 모든 작업 완료 여부 확인
function checkPipelineCompletion() {
  if (activeTasks.size === 0 && pipelineNextIdx >= sm.queue.length) {
    sm.transition(AutoState.COMPLETED);
    broadcastState(getExtendedSnapshot());
    broadcastLog('모든 작업 완료!', 'success');
  }
}

// ─── Build execute message for content script ───
function buildExecuteMessage(item) {
  // Inject current mode into settings so content scripts know the workflow
  const settingsWithMode = {
    ...automationSettings,
    _mode: sm._config?.mode || 'text-image'
  };

  const message = {
    type: 'EXECUTE_PROMPT',
    prompt: item.prompt,
    platform: sm.platform,
    mediaType: sm.mediaType,
    settings: settingsWithMode
  };

  // Attach source image if available
  if (item.sourceImageDataUrl) {
    message.sourceImageDataUrl = item.sourceImageDataUrl;
  }

  return message;
}

// ─── Fetch source image URL to dataUrl (for MangoHub images) ───
async function fetchSourceImage(item) {
  if (item.sourceImageDataUrl) return;
  if (!item.sourceImageUrl) return;

  try {
    // MangoHub returns relative paths like "/uploads/longform/images/xxx.png"
    // Service worker needs absolute URL to fetch
    let imageUrl = item.sourceImageUrl;
    if (imageUrl.startsWith('/')) {
      imageUrl = MangoHubAPI.BASE_URL + imageUrl;
      MangoUtils.log('info', 'Resolved relative image URL:', imageUrl.substring(0, 80));
    }

    const token = await MangoHubAPI.getSessionToken().catch(() => null);
    const fetchOpts = {};
    if (token) {
      fetchOpts.headers = { 'Cookie': `session_token=${token}` };
      fetchOpts.credentials = 'include';
    }

    const imgResp = await fetch(imageUrl, fetchOpts);
    if (!imgResp.ok) {
      throw new Error(`HTTP ${imgResp.status} for ${imageUrl.substring(0, 80)}`);
    }
    const imgBlob = await imgResp.blob();
    item.sourceImageDataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(imgBlob);
    });
    MangoUtils.log('info', 'Source image loaded:', Math.round(imgBlob.size / 1024) + 'KB');
    broadcastLog('소스 이미지 로드 완료', 'info');
  } catch (e) {
    MangoUtils.log('warn', 'Source image fetch failed:', e.message);
    broadcastLog(`소스 이미지 로드 실패: ${e.message}`, 'error');
  }
}

// ─── Content script files per platform ───
const CONTENT_SCRIPTS = {
  grok: ['lib/utils.js', 'content/shared-dom.js', 'content/grok.js'],
  whisk: ['lib/utils.js', 'content/shared-dom.js', 'content/whisk.js'],
  flow: ['lib/utils.js', 'content/shared-dom.js', 'content/flow.js']
};

// ─── Inject content scripts if not loaded ───
async function ensureContentScript(tabId, platform) {
  const files = CONTENT_SCRIPTS[platform];
  if (!files) {
    broadcastLog(`알 수 없는 플랫폼: ${platform}`, 'error');
    return;
  }

  try {
    // Try pinging the content script first
    broadcastLog(`Content script PING 전송 (tab ${tabId})...`, 'info');
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (resp?.ok) {
      broadcastLog(`Content script 이미 로드됨 (site: ${resp.site})`, 'info');
      return;
    }
  } catch (e) {
    // Content script not loaded - inject it
    broadcastLog(`PING 실패 (${e.message}), content script 주입 중...`, 'warn');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files
      });
      broadcastLog('Content script 주입 완료!', 'info');
      await MangoUtils.sleep(1000); // Wait for scripts to initialize
    } catch (injectErr) {
      broadcastLog(`Content script 주입 실패: ${injectErr.message}`, 'error');
    }
  }
}

// ─── Send message to specific tab ───
async function sendToTab(tabId, msg) {
  if (!tabId) throw new Error('No active tab');

  try {
    const tab = await chrome.tabs.get(tabId);
    broadcastLog(`대상 탭: ${tab.url?.substring(0, 60)} (id=${tabId})`, 'info');
  } catch {
    // Tab doesn't exist, recreate
    broadcastLog('탭이 존재하지 않음, 재생성 중...', 'warn');
    await ensureTargetTabs(sm.platform, concurrentCount);
    await MangoUtils.sleep(3000);
    tabId = activeTabIds[0];
  }

  // Ensure content script is loaded before sending message
  await ensureContentScript(tabId, sm.platform);

  // Fetch source image if needed (for MangoHub mode)
  if (msg.type === 'EXECUTE_PROMPT' && !msg.sourceImageDataUrl) {
    const task = activeTasks.get(tabId);
    if (task?.item?.sourceImageUrl) {
      await fetchSourceImage(task.item);
      if (task.item.sourceImageDataUrl) {
        msg.sourceImageDataUrl = task.item.sourceImageDataUrl;
      }
    }
  }

  broadcastLog(`chrome.tabs.sendMessage 호출 (type=${msg.type})...`, 'info');
  return chrome.tabs.sendMessage(tabId, msg);
}

// ─── Handle generation complete ───
async function handleGenerationComplete(msg, sender) {
  // 중지/완료 후 도착한 완료 메시지 무시
  if (sm.state === AutoState.IDLE || sm.state === AutoState.COMPLETED) {
    MangoUtils.log('info', `Ignoring GENERATION_COMPLETE (state=${sm.state})`);
    return;
  }

  const { mediaDataUrl, mediaUrl } = msg;
  const senderTabId = sender?.tab?.id;

  // mediaUrl = raw HTTP URL (비디오 다운로드 시 사용)
  // mediaDataUrl = data:// URL (이미지 등 기존 방식)
  if (concurrentCount > 1 && activeTasks.size > 0) {
    await handleConcurrentComplete(senderTabId, mediaDataUrl, true, null, mediaUrl);
  } else {
    await handleSequentialComplete(mediaDataUrl, mediaUrl);
  }
}

// ─── Handle generation error from content script ───
async function handleGenerationError(msg, sender) {
  // 중지/완료 후 도착한 에러 메시지 무시
  if (sm.state === AutoState.IDLE || sm.state === AutoState.COMPLETED) {
    MangoUtils.log('info', `Ignoring GENERATION_ERROR (state=${sm.state})`);
    return;
  }

  const senderTabId = sender?.tab?.id;

  if (concurrentCount > 1 && activeTasks.size > 0) {
    // 동시(파이프라인) 모드: 파이프라인 핸들러로 처리
    await handleConcurrentComplete(senderTabId, null, false, msg.error);
  } else {
    // 순차 모드: runSequentialLoop에서 sendToTab 응답으로 이미 처리됨
    // 중복 처리 방지 (레이스 컨디션)
    MangoUtils.log('info', `Sequential GENERATION_ERROR ignored (handled inline): ${msg.error}`);
  }
}

// ─── Sequential complete handler ───
async function handleSequentialComplete(mediaDataUrl, mediaUrl) {
  const item = sm.currentItem;
  sm.markDownloading();

  const filename = generateFilename(sm.currentIndex, sm.platform, sm.mediaType);
  broadcastLog(`handleSequentialComplete: mode=${sm.mode}, mediaType=${sm.mediaType}, hasUrl=${!!mediaUrl}, hasDataUrl=${!!mediaDataUrl}`, 'info');

  // Flow 비디오 품질 업스케일 적용
  if (mediaUrl && sm.platform === 'flow' && sm.mediaType === 'video') {
    const videoQuality = automationSettings?.download?.videoQuality || '720p';
    const originalUrl = mediaUrl;
    mediaUrl = applyFlowVideoQuality(mediaUrl, videoQuality);
    if (mediaUrl !== originalUrl) {
      broadcastLog(`Flow 비디오 품질 적용: ${videoQuality}`, 'info');
    }
  }

  if (sm.mode === 'mangohub' && sm.projectId) {
    if (reviewModeEnabled) {
      // 검토 모드: 즉시 업로드하지 않고 검토 큐에 추가
      const reviewItem = {
        id: MangoUtils.generateId(),
        segmentIndex: item.segmentIndex,
        projectId: sm.projectId,
        projectName: sm._config?.projectName || sm._config?.projectId || sm.projectId,
        platform: sm.platform,
        mediaType: sm.mediaType,
        prompt: item.prompt,
        text: item.text,
        mediaUrl: mediaUrl || null,
        mediaDataUrl: (sm.mediaType === 'image' && mediaDataUrl) ? mediaDataUrl : null,
        originalImageUrl: item.sourceImageUrl || null,
        _isThumbnail: !!item._isThumbnail,
        status: 'pending',
        error: null,
        createdAt: Date.now(),
        reviewedAt: null,
        uploadedAt: null
      };
      await addReviewItem(reviewItem);
      sm.markSuccess({ segmentIndex: item.segmentIndex, review: true });
      broadcastLog(`검토 대기열 추가: ${filename}`, 'info');
    } else {
      // 기존 동작: 즉시 업로드
      sm.markUploading();
      try {
        let blob;
        if (mediaDataUrl) {
          blob = await fetch(mediaDataUrl).then(r => r.blob());
        } else if (mediaUrl) {
          blob = await fetchMediaWithCookies(mediaUrl);
        } else {
          throw new Error('No media data available');
        }
        if (item._isThumbnail) {
          // 썸네일 이미지 업로드
          await MangoHubAPI.uploadThumbnailImage(sm.projectId, item.segmentIndex, blob, filename);
          broadcastLog(`썸네일 업로드 완료: concept ${item.segmentIndex}`, 'success');
        } else if (sm.mediaType === 'video') {
          await MangoHubAPI.uploadVideo(sm.projectId, item.segmentIndex, blob, filename);
        } else {
          await MangoHubAPI.uploadImage(sm.projectId, item.segmentIndex, blob, filename);
        }
        sm.markSuccess({ segmentIndex: item.segmentIndex });
        broadcastLog(`업로드 완료: ${filename}`, 'success');
      } catch (err) {
        if (err.message === 'AUTH_EXPIRED') {
          sm.pause();
          broadcastState({ ...getExtendedSnapshot(), authExpired: true });
          return;
        }
        // 업로드 실패: 생성은 성공했으므로 실패 기록 후 다음으로 진행
        // markError 대신 직접 결과에 실패 기록 + COOLDOWN으로 전환
        broadcastLog(`업로드 실패: ${err.message} (다음 항목 진행)`, 'error');
        sm.results.push({ success: false, index: sm._resultIndex(), segmentIndex: item.segmentIndex, error: err.message });
        sm.transition(AutoState.COOLDOWN);
      }
    }

    // MangoHub 모드에서도 로컬 다운로드 (PC에 작업 내역 보관)
    try {
      const dlFilename = getDownloadPath(filename, !!item._isThumbnail);
      const downloadUrl = mediaUrl || mediaDataUrl;
      if (downloadUrl) {
        await chrome.downloads.download({
          url: downloadUrl,
          filename: dlFilename,
          saveAs: false
        });
        broadcastLog(`로컬 다운로드: ${filename}`, 'info');
      }
    } catch (dlErr) {
      broadcastLog(`로컬 다운로드 실패 (업로드는 완료): ${dlErr.message}`, 'warn');
    }
  } else {
    // Standalone - download locally via chrome.downloads (브라우저 쿠키 자동 포함)
    try {
      const dlFilename = getDownloadPath(filename, false);
      const downloadUrl = mediaUrl || mediaDataUrl;
      await chrome.downloads.download({
        url: downloadUrl,
        filename: dlFilename,
        saveAs: false
      });
      sm.markSuccess({ downloaded: filename });
      broadcastLog(`다운로드: ${filename}`, 'success');
    } catch (err) {
      // 다운로드 실패: 기록 후 다음 진행
      broadcastLog(`다운로드 실패: ${err.message} (다음 항목 진행)`, 'error');
      sm.results.push({ success: false, index: sm._resultIndex(), error: err.message });
      sm.transition(AutoState.COOLDOWN);
    }
  }

  // Store result
  allResults.push({
    index: sm._resultIndex(),
    segmentIndex: item.segmentIndex,
    success: true,
    dataUrl: mediaDataUrl || mediaUrl,
    filename
  });

  // Download delay: 순차 모드에서는 스킵, 동시 모드일 때만 적용
  // Flow 이미지는 항상 스킵 (빠른 처리)
  if (concurrentCount > 1) {
    const downloadDelay = (automationSettings?.download?.delay || 2) * 1000;
    if (downloadDelay > 0) {
      broadcastLog(`다운로드 대기 ${Math.round(downloadDelay / 1000)}초...`, 'info');
      await MangoUtils.sleep(downloadDelay);
    }
  }

  await handleCooldownAndNext();
}

// ─── Concurrent complete handler ───
async function handleConcurrentComplete(tabId, mediaDataUrl, success, errorMsg, mediaUrl) {
  const task = activeTasks.get(tabId);
  if (!task) {
    MangoUtils.log('warn', 'Received completion from unknown tab:', tabId);
    return;
  }

  // 타임아웃 해제
  if (task.timeoutId) clearTimeout(task.timeoutId);

  task.status = success ? 'completed' : 'failed';
  const item = task.item;
  const itemIndex = task.index;
  // 파일명은 큐 인덱스 기준 (resultIndex가 아닌 실제 큐 위치)
  const filename = generateFilename(task.queueIndex ?? itemIndex, sm.platform, sm.mediaType);

  // Flow 비디오 품질 업스케일 적용 (concurrent)
  if (mediaUrl && sm.platform === 'flow' && sm.mediaType === 'video') {
    const videoQuality = automationSettings?.download?.videoQuality || '720p';
    const originalUrl = mediaUrl;
    mediaUrl = applyFlowVideoQuality(mediaUrl, videoQuality);
    if (mediaUrl !== originalUrl) {
      broadcastLog(`Flow 비디오 품질 적용: ${videoQuality}`, 'info');
    }
  }

  if (success && (mediaDataUrl || mediaUrl)) {
    if (sm.mode === 'mangohub' && sm.projectId) {
      if (reviewModeEnabled) {
        // 검토 모드: 즉시 업로드하지 않고 검토 큐에 추가
        const reviewItem = {
          id: MangoUtils.generateId(),
          segmentIndex: item.segmentIndex,
          projectId: sm.projectId,
          projectName: sm._config?.projectName || sm._config?.projectId || sm.projectId,
          platform: sm.platform,
          mediaType: sm.mediaType,
          prompt: item.prompt,
          text: item.text,
          mediaUrl: mediaUrl || null,
          mediaDataUrl: (sm.mediaType === 'image' && mediaDataUrl) ? mediaDataUrl : null,
          originalImageUrl: item.sourceImageUrl || null,
          _isThumbnail: !!item._isThumbnail,
          status: 'pending',
          error: null,
          createdAt: Date.now(),
          reviewedAt: null,
          uploadedAt: null
        };
        await addReviewItem(reviewItem);
        broadcastLog(`검토 대기열 추가: ${filename}`, 'info');
        sm.results.push({ success: true, index: itemIndex, segmentIndex: item.segmentIndex, review: true });
      } else {
        // 기존 동작: 즉시 업로드
        try {
          let blob;
          if (mediaDataUrl) {
            blob = await fetch(mediaDataUrl).then(r => r.blob());
          } else if (mediaUrl) {
            blob = await fetchMediaWithCookies(mediaUrl);
          }
          if (item._isThumbnail) {
            await MangoHubAPI.uploadThumbnailImage(sm.projectId, item.segmentIndex, blob, filename);
            broadcastLog(`썸네일 업로드 완료: concept ${item.segmentIndex}`, 'success');
          } else if (sm.mediaType === 'video') {
            await MangoHubAPI.uploadVideo(sm.projectId, item.segmentIndex, blob, filename);
          } else {
            await MangoHubAPI.uploadImage(sm.projectId, item.segmentIndex, blob, filename);
          }
          broadcastLog(`업로드 완료: ${filename}`, 'success');
          sm.results.push({ success: true, index: itemIndex, segmentIndex: item.segmentIndex });
        } catch (err) {
          if (err.message === 'AUTH_EXPIRED') {
            sm.pause();
            broadcastState({ ...getExtendedSnapshot(), authExpired: true });
            return;
          }
          broadcastLog(`업로드 실패: ${err.message}`, 'error');
          sm.results.push({ success: false, index: itemIndex, error: err.message });
        }
      }

      // MangoHub 모드에서도 로컬 다운로드 (PC에 작업 내역 보관)
      try {
        const dlFilename = getDownloadPath(filename, !!item._isThumbnail);
        const downloadUrl = mediaUrl || mediaDataUrl;
        if (downloadUrl) {
          await chrome.downloads.download({
            url: downloadUrl,
            filename: dlFilename,
            saveAs: false
          });
          broadcastLog(`로컬 다운로드: ${filename}`, 'info');
        }
      } catch (dlErr) {
        broadcastLog(`로컬 다운로드 실패 (업로드는 완료): ${dlErr.message}`, 'warn');
      }
    } else {
      try {
        const dlFilename = getDownloadPath(filename, false);
        const downloadUrl = mediaUrl || mediaDataUrl;
        await chrome.downloads.download({
          url: downloadUrl,
          filename: dlFilename,
          saveAs: false
        });
        broadcastLog(`다운로드: ${filename}`, 'success');
        sm.results.push({ success: true, index: itemIndex, downloaded: filename });
      } catch (err) {
        broadcastLog(`다운로드 실패: ${err.message}`, 'error');
        sm.results.push({ success: false, index: itemIndex, error: err.message });
      }
    }

    allResults.push({
      index: itemIndex,
      segmentIndex: item.segmentIndex,
      success: true,
      dataUrl: mediaDataUrl || mediaUrl,
      filename
    });

  } else {
    // 실패 → 검열 에러이면 LLM 수정 후 큐에 재삽입
    const llmCfg = automationSettings?.llm;
    const llmMaxAttempts = llmCfg?.retryCount || 2;
    const llmAttemptsSoFar = item._llmRewriteCount || 0;

    if (llmCfg?.enabled && llmCfg?.kieApiKey &&
        !item._isThumbnail &&
        isCensorshipError(errorMsg, '') &&
        llmAttemptsSoFar < llmMaxAttempts) {
      broadcastLog(`검열 에러 [${itemIndex + 1}] → LLM 프롬프트 수정 (${llmAttemptsSoFar + 1}/${llmMaxAttempts})`, 'info');
      const originalPrompt = item._originalPrompt || item.prompt;
      const rewritten = await rewritePromptWithLLM(originalPrompt, llmCfg.kieApiKey);
      if (rewritten) {
        item._originalPrompt = item._originalPrompt || item.prompt;
        item.prompt = rewritten;
        item._llmRewriteCount = llmAttemptsSoFar + 1;
        // 큐 끝에 다시 추가하여 재시도
        sm.queue.push(item);
        broadcastLog(`LLM 수정본 #${llmAttemptsSoFar + 1} 재시도 예약: [${itemIndex + 1}]`, 'info');
      } else {
        sm.results.push({ success: false, index: itemIndex, error: errorMsg || 'Failed' });
      }
    } else {
      broadcastLog(`실패 [${itemIndex + 1}]: ${errorMsg || 'Unknown error'}`, 'error');
      sm.results.push({ success: false, index: itemIndex, error: errorMsg || 'Failed' });
    }
  }

  // 슬롯 해제 및 진행 상황 업데이트
  activeTasks.delete(tabId);
  sm.currentIndex = sm.results.length;
  broadcastState(getExtendedSnapshot());

  // 빈 슬롯에 다음 항목 즉시 전송
  await sendNextPipelineItem();
  checkPipelineCompletion();
}

// ─── Generate filename ───
function generateFilename(index, platform, mediaType) {
  // MangoHub: segmentIndex (서버 기준 번호로 중단/재시작 시에도 일관됨)
  // Retry: _originalIndex (원래 대기열 위치)
  // Standalone: 배열 인덱스
  const item = sm.queue[index];
  let displayIndex;
  if (sm.mode === 'mangohub' && item?.segmentIndex !== undefined) {
    displayIndex = item.segmentIndex;
  } else if (sm._useOriginalIndex && item?._originalIndex !== undefined) {
    displayIndex = item._originalIndex + 1;
  } else {
    displayIndex = index + 1;
  }
  const idx = String(displayIndex).padStart(3, '0');
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ext = mediaType === 'video' ? 'mp4' : 'png';

  // 썸네일: 날짜_프로젝트명_썸네일_번호.png
  if (item?._isThumbnail) {
    const projectName = sm._config?.projectName || 'project';
    const safeName = String(projectName).replace(/[^a-zA-Z0-9가-힣_-]/g, '_').substring(0, 20);
    return `${date}_${safeName}_썸네일_${idx}.${ext}`;
  }

  const model = getModelName(platform) || platform || 'auto';
  const pattern = automationSettings?.download?.naming || 'idx_model_date';
  switch (pattern) {
    case 'idx_date_model':
      return `${idx}_${date}_${model}.${ext}`;
    case 'idx_prompt_date': {
      const prompt = item?.text?.replace(/[^a-zA-Z0-9가-힣]/g, '_').substring(0, 20) || 'prompt';
      return `${idx}_${prompt}_${date}.${ext}`;
    }
    default:
      return `${idx}_${model}_${date}.${ext}`;
  }
}

// ─── Get specific model name for filename ───
function getModelName(platform) {
  switch (platform) {
    case 'grok': return 'grok';
    case 'flow': return automationSettings?.flowVideo?.model || automationSettings?.veo?.model || 'flow';
    case 'whisk': return automationSettings?.image?.model || 'whisk';
    default: return platform;
  }
}

// ─── Get download path with per-project folder support ───
function getDownloadPath(filename, isThumbnail) {
  if (isThumbnail) {
    return `MangoAuto/썸네일/${filename}`;
  }
  const perProject = automationSettings?.download?.perProject;
  if (perProject && sm._config?.projectId && sm.mode === 'mangohub') {
    const projectName = sm._config?.projectName ||
      sm._config?.projectId ||
      'project';
    const safeName = String(projectName).replace(/[^a-zA-Z0-9가-힣_-]/g, '_').substring(0, 30);
    return `MangoAuto/${safeName}/${filename}`;
  }
  return `MangoAuto/${filename}`;
}

// ─── Cooldown with random range ───
async function handleCooldownAndNext() {
  if (sm.state === AutoState.COOLDOWN) {
    broadcastState(getExtendedSnapshot());
    let min, max;
    if (false) {
      // (구: Flow 짧은 쿨다운 하드코딩 제거 — 사용자 설정값 사용)
    } else {
      min = sm._cooldownMin || 10000;
      max = sm._cooldownMax || 15000;
    }
    const delay = min + Math.random() * (max - min);
    broadcastLog(`쿨다운 ${Math.round(delay / 1000)}초...`, 'info');
    await MangoUtils.sleep(delay);
    sm.next();
    broadcastState(getExtendedSnapshot());
    if (sm.state === AutoState.PREPARING) {
      await runLoop();
    }
  }
}

// ─── Retry failed items only ───
async function retryFailed() {
  // Collect failed items from results
  const failedResults = sm.results.filter(r => !r.success);
  if (failedResults.length === 0) return { count: 0 };

  // Map failed indices back to original queue items
  const failedItems = [];
  for (const fr of failedResults) {
    const originalItem = sm.queue[fr.index];
    if (originalItem) {
      // Preserve original index for consistent filename numbering
      // LLM 관련 상태 리셋: 재시도 시 LLM이 새로 시도할 수 있도록
      const retryItem = { ...originalItem, _originalIndex: fr.index };
      if (retryItem._llmRewriteCount) {
        retryItem._llmRewriteCount = 0;
        if (retryItem._originalPrompt) {
          retryItem.prompt = retryItem._originalPrompt;  // 원본 프롬프트 복원
          delete retryItem._originalPrompt;
        }
      }
      failedItems.push(retryItem);
    }
  }

  if (failedItems.length === 0) return { count: 0 };

  // Store previous config
  const prevConfig = sm._config;
  const prevCooldownMin = sm._cooldownMin;
  const prevCooldownMax = sm._cooldownMax;
  const prevPlatform = sm.platform;
  const prevMediaType = sm.mediaType;
  const prevMode = sm.mode;
  const prevProjectId = sm.projectId;
  const originalTotalCount = sm._originalTotalCount || sm.queue.length;

  // Remove failed results (keep successful ones)
  const successResults = sm.results.filter(r => r.success);

  // Re-init state machine with only failed items
  const avgCooldown = Math.round((prevCooldownMin + prevCooldownMax) / 2);
  sm.init({
    queue: failedItems,
    mode: prevMode,
    platform: prevPlatform,
    mediaType: prevMediaType,
    projectId: prevProjectId,
    cooldownMs: avgCooldown
  });

  // Restore config and previous successful results
  sm._config = prevConfig;
  sm._cooldownMin = prevCooldownMin;
  sm._cooldownMax = prevCooldownMax;
  sm.results = successResults;
  sm._originalTotalCount = originalTotalCount;

  // Override filename generation and result index to use original indices
  sm._useOriginalIndex = true;

  activeTasks.clear();
  pendingCompletions = 0;
  concurrentCount = automationSettings?.general?.concurrentCount || 1;
  promptDelay = (automationSettings?.general?.promptDelay || 40) * 1000;
  sm.maxRetries = automationSettings?.general?.maxRetries || 3;

  sm.start();

  await ensureTargetTabs(prevPlatform, concurrentCount);
  await MangoUtils.sleep(2000);

  broadcastLog(`실패 ${failedItems.length}개 항목 재시도 시작`, 'info');
  runLoop();

  return { ok: true, count: failedItems.length };
}

// ─── Retry selected items (user-picked indices) ───
async function retrySelected(indices) {
  if (!Array.isArray(indices) || indices.length === 0) return { error: '선택된 항목이 없습니다' };

  // Map indices back to original queue items
  const selectedItems = [];
  for (const idx of indices) {
    const originalItem = sm.queue[idx];
    if (originalItem) {
      // LLM 관련 상태 리셋: 재생성 시 LLM이 새로 시도할 수 있도록
      const retryItem = { ...originalItem, _originalIndex: idx };
      if (retryItem._llmRewriteCount) {
        retryItem._llmRewriteCount = 0;
        if (retryItem._originalPrompt) {
          retryItem.prompt = retryItem._originalPrompt;  // 원본 프롬프트 복원
          delete retryItem._originalPrompt;
        }
      }
      selectedItems.push(retryItem);
    }
  }

  if (selectedItems.length === 0) return { error: '유효한 항목이 없습니다' };

  // Store previous config
  const prevConfig = sm._config;
  const prevCooldownMin = sm._cooldownMin;
  const prevCooldownMax = sm._cooldownMax;
  const prevPlatform = sm.platform;
  const prevMediaType = sm.mediaType;
  const prevMode = sm.mode;
  const prevProjectId = sm.projectId;
  const originalTotalCount = sm._originalTotalCount || sm.queue.length;

  // Keep results for non-selected items, remove selected ones (they'll be regenerated)
  const selectedSet = new Set(indices);
  const keptResults = sm.results.filter(r => !selectedSet.has(r.index));

  // Re-init state machine with selected items
  const avgCooldown = Math.round((prevCooldownMin + prevCooldownMax) / 2);
  sm.init({
    queue: selectedItems,
    mode: prevMode,
    platform: prevPlatform,
    mediaType: prevMediaType,
    projectId: prevProjectId,
    cooldownMs: avgCooldown
  });

  // Restore config and kept results
  sm._config = prevConfig;
  sm._cooldownMin = prevCooldownMin;
  sm._cooldownMax = prevCooldownMax;
  sm.results = keptResults;
  sm._originalTotalCount = originalTotalCount;

  // Use original indices for filename generation and result tracking
  sm._useOriginalIndex = true;

  activeTasks.clear();
  pendingCompletions = 0;
  concurrentCount = automationSettings?.general?.concurrentCount || 1;
  promptDelay = (automationSettings?.general?.promptDelay || 40) * 1000;
  sm.maxRetries = automationSettings?.general?.maxRetries || 3;

  sm.start();

  await ensureTargetTabs(prevPlatform, concurrentCount);
  await MangoUtils.sleep(2000);

  broadcastLog(`선택 ${selectedItems.length}개 항목 재생성 시작`, 'info');
  runLoop();

  return { ok: true, count: selectedItems.length };
}

// ─── Download all results ───
async function downloadAllResults() {
  if (allResults.length === 0) return { error: 'No results to download' };

  const delayMs = (automationSettings?.download?.delay || 2) * 1000;

  for (let i = 0; i < allResults.length; i++) {
    const result = allResults[i];
    if (result.dataUrl) {
      try {
        const dlFilename = getDownloadPath(result.filename);
        await chrome.downloads.download({
          url: result.dataUrl,
          filename: dlFilename,
          saveAs: false
        });
        broadcastLog(`다운로드 ${i + 1}/${allResults.length}: ${result.filename}`, 'info');
      } catch (e) {
        MangoUtils.log('warn', 'Download failed:', result.filename, e.message);
      }
      // Wait between downloads to preserve ordering
      if (i < allResults.length - 1) {
        await MangoUtils.sleep(delayMs);
      }
    }
  }
  return { ok: true, count: allResults.length };
}

// ─── Tab close detection ───
chrome.tabs.onRemoved.addListener((tabId) => {
  const idx = activeTabIds.indexOf(tabId);
  if (idx !== -1) {
    activeTabIds.splice(idx, 1);
    activeTasks.delete(tabId);
    MangoUtils.log('warn', 'Active tab was closed');

    if (sm.state !== AutoState.IDLE && sm.state !== AutoState.COMPLETED) {
      if (activeTabIds.length === 0) {
        sm.pause();
        broadcastLog('모든 탭이 닫혔습니다. 재개하면 탭을 다시 엽니다.', 'error');
      } else {
        broadcastLog('탭 하나가 닫혔습니다.', 'error');
      }
    }
  }
});

// ─── File Injection: Grok (intercept file input click in MAIN world) ───
async function injectFileToGrok(msg, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (imageDataUrl) => {
        // Convert dataURL to File
        const arr = imageDataUrl.split(',');
        const mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        const u8arr = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
        const file = new File([u8arr], `image-${Date.now()}.png`, { type: mime });

        // Intercept the next file input click to inject our file
        const origClick = HTMLInputElement.prototype.click;
        let intercepted = false;

        HTMLInputElement.prototype.click = function () {
          if (this.type === 'file' && !intercepted) {
            intercepted = true;
            const dt = new DataTransfer();
            dt.items.add(file);
            this.files = dt.files;
            this.dispatchEvent(new Event('change', { bubbles: true }));
            HTMLInputElement.prototype.click = origClick;
            return;
          }
          return origClick.call(this);
        };

        // Auto-cleanup after 10 seconds
        setTimeout(() => {
          if (!intercepted) HTMLInputElement.prototype.click = origClick;
        }, 10000);
      },
      args: [msg.imageDataUrl]
    });
    return { success: true };
  } catch (err) {
    MangoUtils.log('error', 'Grok file inject failed:', err.message);
    return { error: err.message };
  }
}

// ─── File Injection: Flow (frame upload file input interception) ───
async function injectFileToFlow(msg, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return { error: 'No tab ID' };

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (imageDataUrl) => {
        const arr = imageDataUrl.split(',');
        const mime = arr[0].match(/:(.*?);/)[1];
        const bstr = atob(arr[1]);
        const u8arr = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
        const file = new File([u8arr], `frame-${Date.now()}.png`, { type: mime });

        const origClick = HTMLInputElement.prototype.click;
        let intercepted = false;

        HTMLInputElement.prototype.click = function () {
          if (this.type === 'file' && !intercepted) {
            intercepted = true;
            const dt = new DataTransfer();
            dt.items.add(file);
            this.files = dt.files;
            this.dispatchEvent(new Event('change', { bubbles: true }));
            HTMLInputElement.prototype.click = origClick;
            return;
          }
          return origClick.call(this);
        };

        setTimeout(() => {
          if (!intercepted) HTMLInputElement.prototype.click = origClick;
        }, 10000);
      },
      args: [msg.imageDataUrl]
    });
    return { success: true };
  } catch (err) {
    MangoUtils.log('error', 'Flow file inject failed:', err.message);
    return { error: err.message };
  }
}

// ─── Fetch media with cookies (for MangoHub upload) ───
async function fetchMediaWithCookies(url) {
  try {
    // 1차: 직접 fetch (host_permissions에 의해 접근 가능할 수 있음)
    const resp = await fetch(url);
    if (resp.ok) {
      broadcastLog('미디어 직접 fetch 성공', 'info');
      return await resp.blob();
    }
    broadcastLog(`직접 fetch 실패 (${resp.status}), 쿠키 포함 재시도...`, 'warn');
  } catch (e) {
    broadcastLog(`직접 fetch 에러: ${e.message}`, 'warn');
  }

  // 2차: 쿠키 포함 fetch
  try {
    const urlObj = new URL(url);
    const cookies = await chrome.cookies.getAll({ domain: urlObj.hostname });
    if (cookies.length === 0) {
      // .grok.com 도메인으로도 시도
      const domainParts = urlObj.hostname.split('.');
      if (domainParts.length >= 2) {
        const baseDomain = '.' + domainParts.slice(-2).join('.');
        const moreCookies = await chrome.cookies.getAll({ domain: baseDomain });
        cookies.push(...moreCookies);
      }
    }
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    broadcastLog(`쿠키 ${cookies.length}개 포함 fetch 시도`, 'info');

    const resp = await fetch(url, {
      headers: cookieStr ? { 'Cookie': cookieStr } : {}
    });
    if (resp.ok) {
      broadcastLog('쿠키 포함 fetch 성공', 'info');
      return await resp.blob();
    }
    throw new Error(`HTTP ${resp.status}`);
  } catch (e) {
    broadcastLog(`쿠키 포함 fetch 실패: ${e.message}`, 'error');
  }

  // 3차: imagine-public fallback URL 시도
  if (url.includes('assets.grok.com') || url.includes('grok.com')) {
    // UUID 추출 시도
    const uuidMatch = url.match(/([a-f0-9-]{36})/);
    if (uuidMatch) {
      const fallbackUrl = `https://imagine-public.x.ai/imagine-public/share-videos/${uuidMatch[1]}.mp4`;
      broadcastLog(`Fallback URL 시도: ${fallbackUrl.substring(0, 60)}`, 'info');
      const resp = await fetch(fallbackUrl);
      if (resp.ok) {
        broadcastLog('Fallback URL fetch 성공', 'success');
        return await resp.blob();
      }
    }
  }

  throw new Error(`미디어 다운로드 실패: ${url.substring(0, 60)}`);
}

// ─── Apply video quality to Flow fifeUrl ───
function applyFlowVideoQuality(url, quality) {
  if (!url || !quality || quality === '720p') return url;

  // Flow/Google Labs fifeUrl만 대상 (storage.googleapis.com 또는 lh3.google)
  const isGoogleUrl = url.includes('storage.googleapis.com') ||
                      url.includes('lh3.google') ||
                      url.includes('labs.google');
  if (!isGoogleUrl) return url;

  // 1080p: =w1920 파라미터 추가 (Google fife URL 스타일)
  if (quality === '1080p') {
    // 기존 =xxx 파라미터가 있으면 교체, 없으면 추가
    if (url.includes('=w')) {
      return url.replace(/=w\d+/, '=w1920');
    }
    return url + (url.includes('?') ? '&' : '=') + 'w1920';
  }

  return url;
}

// ─── Download media ───
async function downloadMedia(msg) {
  try {
    const downloadId = await chrome.downloads.download({
      url: msg.url,
      filename: msg.filename || undefined,
      conflictAction: 'uniquify'
    });
    return { success: true, downloadId };
  } catch (err) {
    return { error: err.message };
  }
}

// ─── API Key Export (cross-profile file sharing) ───
async function exportApiKey(apiKey) {
  try {
    const blob = new Blob([apiKey], { type: 'text/plain' });
    const dataUrl = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
    await chrome.downloads.download({
      url: dataUrl,
      filename: 'MangoAuto/kie_api.key',
      conflictAction: 'overwrite',
      saveAs: false
    });
    return { ok: true };
  } catch (err) {
    MangoUtils.log('error', 'API key export failed:', err.message);
    return { error: err.message };
  }
}

// ─── Inject fetch interceptor into Google Labs pages ───
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('labs.google/fx/')) {
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['content/inject.js']
    }).catch(() => {
      // May fail if page isn't ready or permission denied
    });
  }
});

// ─── Review Queue Management ───

async function getReviewQueue() {
  const data = await chrome.storage.local.get('mangoauto_review_queue');
  return data.mangoauto_review_queue || [];
}

async function addReviewItem(item) {
  const queue = await getReviewQueue();
  queue.push(item);
  await chrome.storage.local.set({ mangoauto_review_queue: queue });
  try {
    chrome.runtime.sendMessage({ type: 'REVIEW_ITEM_ADDED', item }).catch(() => {});
  } catch (e) { /* popup not open */ }
}

async function updateReviewItemStatus(id, status, error = null) {
  const queue = await getReviewQueue();
  const item = queue.find(i => i.id === id);
  if (!item) return { error: 'Item not found' };
  item.status = status;
  item.reviewedAt = Date.now();
  if (error) item.error = error;
  await chrome.storage.local.set({ mangoauto_review_queue: queue });
  try {
    chrome.runtime.sendMessage({ type: 'REVIEW_ITEM_UPDATED', id, status, error }).catch(() => {});
  } catch (e) {}
  return { ok: true };
}

async function bulkUpdateReviewStatus(fromStatus, toStatus) {
  const queue = await getReviewQueue();
  let count = 0;
  for (const item of queue) {
    if (item.status === fromStatus) {
      item.status = toStatus;
      item.reviewedAt = Date.now();
      count++;
    }
  }
  await chrome.storage.local.set({ mangoauto_review_queue: queue });
  return { ok: true, count };
}

async function uploadApprovedItems() {
  const queue = await getReviewQueue();
  const approved = queue.filter(i => i.status === 'approved');
  if (approved.length === 0) return { ok: true, count: 0 };

  let uploaded = 0;
  for (const item of approved) {
    item.status = 'uploading';
    await chrome.storage.local.set({ mangoauto_review_queue: queue });
    try {
      chrome.runtime.sendMessage({ type: 'REVIEW_ITEM_UPDATED', id: item.id, status: 'uploading' }).catch(() => {});
    } catch (e) {}

    try {
      let blob;
      if (item.mediaDataUrl) {
        blob = await fetch(item.mediaDataUrl).then(r => r.blob());
      } else if (item.mediaUrl) {
        blob = await fetchMediaWithCookies(item.mediaUrl);
      } else {
        throw new Error('미디어 데이터 없음');
      }

      const filename = `${String(item.segmentIndex + 1).padStart(3, '0')}_review_${Date.now()}.${item.mediaType === 'video' ? 'mp4' : 'png'}`;
      if (item._isThumbnail) {
        await MangoHubAPI.uploadThumbnailImage(item.projectId, item.segmentIndex, blob, filename);
      } else if (item.mediaType === 'video') {
        await MangoHubAPI.uploadVideo(item.projectId, item.segmentIndex, blob, filename);
      } else {
        await MangoHubAPI.uploadImage(item.projectId, item.segmentIndex, blob, filename);
      }

      item.status = 'uploaded';
      item.uploadedAt = Date.now();
      uploaded++;
      broadcastLog(`검토 업로드 완료: ${item._isThumbnail ? '썸네일' : '세그먼트'} ${item.segmentIndex + 1}`, 'success');
    } catch (err) {
      if (err.message === 'AUTH_EXPIRED') {
        item.status = 'error';
        item.error = '세션 만료. 다시 로그인 후 재시도하세요.';
        await chrome.storage.local.set({ mangoauto_review_queue: queue });
        broadcastLog('MangoHub 세션 만료', 'error');
        break;
      }
      item.status = 'error';
      item.error = err.message;
      broadcastLog(`검토 업로드 실패 [${item.segmentIndex + 1}]: ${err.message}`, 'error');
    }

    await chrome.storage.local.set({ mangoauto_review_queue: queue });
    try {
      chrome.runtime.sendMessage({ type: 'REVIEW_ITEM_UPDATED', id: item.id, status: item.status, error: item.error }).catch(() => {});
    } catch (e) {}
  }

  return { ok: true, count: uploaded };
}

async function clearCompletedReviewItems() {
  const queue = await getReviewQueue();
  const remaining = queue.filter(i => !['uploaded', 'rejected'].includes(i.status));
  await chrome.storage.local.set({ mangoauto_review_queue: remaining });
  return { ok: true };
}

// ─── Service worker initialized ───
console.log('[MangoAuto] Background service worker started');
