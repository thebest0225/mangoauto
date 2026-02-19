/**
 * MangoAuto - Automation State Machine
 */

const AutoState = {
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  GENERATING: 'GENERATING',
  WAITING: 'WAITING',
  DOWNLOADING: 'DOWNLOADING',
  UPLOADING: 'UPLOADING',
  COOLDOWN: 'COOLDOWN',
  NEXT: 'NEXT',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
  PAUSED: 'PAUSED'
};

class AutomationStateMachine {
  constructor() {
    this.state = AutoState.IDLE;
    this.queue = [];
    this.currentIndex = 0;
    this.currentItem = null;
    this.retryCount = 0;
    this.maxRetries = 3;
    this.results = [];
    this.error = null;
    this.mode = null;          // 'mangohub' | 'standalone'
    this.platform = null;      // 'grok' | 'whisk' | 'veo'
    this.mediaType = null;     // 'image' | 'video'
    this.projectId = null;
    this.cooldownMs = 5000;
    this.listeners = [];
  }

  onChange(callback) {
    this.listeners.push(callback);
  }

  emit() {
    const snapshot = this.getSnapshot();
    for (const cb of this.listeners) {
      try { cb(snapshot); } catch (e) { /* silent */ }
    }
  }

  getSnapshot() {
    // Only include serializable, small data
    let safeCurrentItem = null;
    if (this.currentItem) {
      safeCurrentItem = {
        segmentIndex: this.currentItem.segmentIndex,
        prompt: this.currentItem.prompt,
        text: this.currentItem.text
      };
    }

    // Only include summary of results, not full array
    const completedCount = this.results.filter(r => r.success).length;
    const failedCount = this.results.filter(r => !r.success).length;

    return {
      state: this.state,
      currentIndex: this.currentIndex,
      totalCount: this._originalTotalCount || this.queue.length,
      currentItem: safeCurrentItem,
      retryCount: this.retryCount,
      error: this.error ? String(this.error) : null,
      mode: this.mode,
      platform: this.platform,
      mediaType: this.mediaType,
      projectId: this.projectId,
      completedCount,
      failedCount,
      results: this.results.map(r => ({
        success: r.success,
        index: r.index,
        error: r.error ? String(r.error) : undefined
      }))
    };
  }

  transition(newState) {
    const oldState = this.state;
    this.state = newState;
    console.log(`[StateMachine] ${oldState} → ${newState}`);
    this.emit();
  }

  init({ queue, mode, platform, mediaType, projectId, cooldownMs }) {
    this.queue = queue;
    this.currentIndex = 0;
    this.currentItem = null;
    this.retryCount = 0;
    this.results = [];
    this.error = null;
    this.mode = mode;
    this.platform = platform;
    this.mediaType = mediaType;
    this.projectId = projectId;
    if (cooldownMs !== undefined) this.cooldownMs = cooldownMs;
    this.transition(AutoState.IDLE);
  }

  start() {
    if (this.queue.length === 0) {
      this.transition(AutoState.COMPLETED);
      return;
    }
    this.currentIndex = 0;
    this.currentItem = this.queue[0];
    this.retryCount = 0;
    this.transition(AutoState.PREPARING);
  }

  markGenerating() {
    this.transition(AutoState.GENERATING);
  }

  markWaiting() {
    this.transition(AutoState.WAITING);
  }

  markDownloading() {
    this.transition(AutoState.DOWNLOADING);
  }

  markUploading() {
    this.transition(AutoState.UPLOADING);
  }

  // 현재 아이템의 결과 저장용 인덱스 (재시도/재생성 시 원본 인덱스 사용)
  _resultIndex() {
    const item = this.queue[this.currentIndex];
    if (this._useOriginalIndex && item?._originalIndex !== undefined) {
      return item._originalIndex;
    }
    return this.currentIndex;
  }

  markSuccess(result) {
    this.results.push({ success: true, index: this._resultIndex(), ...result });
    this.retryCount = 0;
    this.transition(AutoState.COOLDOWN);
  }

  markError(error) {
    // Always store error as string to ensure serializability
    this.error = error instanceof Error ? error.message : String(error);
    this.retryCount++;
    if (this.retryCount >= this.maxRetries) {
      this.results.push({ success: false, index: this._resultIndex(), error: this.error });
      this.retryCount = 0;
      this.transition(AutoState.COOLDOWN);
    } else {
      this.transition(AutoState.ERROR);
    }
  }

  skipCurrent() {
    this.results.push({ success: false, index: this._resultIndex(), error: 'Skipped' });
    this.retryCount = 0;
    this.transition(AutoState.COOLDOWN);
  }

  next() {
    this.currentIndex++;
    if (this.currentIndex >= this.queue.length) {
      this.transition(AutoState.COMPLETED);
    } else {
      this.currentItem = this.queue[this.currentIndex];
      this.retryCount = 0;
      this.transition(AutoState.PREPARING);
    }
  }

  pause() {
    this.transition(AutoState.PAUSED);
  }

  resume() {
    if (this.state === AutoState.PAUSED) {
      this.transition(AutoState.PREPARING);
    }
  }

  reset() {
    this.state = AutoState.IDLE;
    this.queue = [];
    this.currentIndex = 0;
    this.currentItem = null;
    this.retryCount = 0;
    this.results = [];
    this.error = null;
    this.emit();
  }

  async saveState() {
    return;
  }

  async restoreState() {
    return false;
  }
}
