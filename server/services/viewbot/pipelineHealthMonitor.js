// Detection half of the ViewBot pipeline health system, extracted from
// ViewBotInstance (startPipelineHealthCheck / checkPipelineHealth /
// isProcessAlive / checkPipelineActivity). Owns the polling timer + activity
// state; on a detected crash/stall it invokes the injected `onCrash(type)` —
// the RECOVERY (restart/backoff) deliberately stays on ViewBotInstance
// (handlePipelineCrash), which is too coupled to the bot to move.
//
// Deps: { botId, logger, getVideoProcess(), getAudioProcess(), shouldRun(), onCrash(type) }.

class PipelineHealthMonitor {
  constructor({ botId, logger = null, getVideoProcess, getAudioProcess, shouldRun, onCrash }) {
    this.botId = botId;
    this.logger = logger;
    this.getVideoProcess = getVideoProcess;
    this.getAudioProcess = getAudioProcess;
    this.shouldRun = shouldRun;
    this.onCrash = onCrash;
    this.timer = null;
    this.lastHealthCheck = null;
  }

  // Signal 0 tests process existence without killing it.
  static isProcessAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  start() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.logger?.debug(`🏥 ViewBot ${this.botId}: Starting pipeline health monitoring`);
    // Initial health check after 10s, then every 5s.
    setTimeout(() => this.checkHealth(), 10000);
    this.timer = setInterval(() => {
      this.checkHealth();
    }, 5000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkHealth() {
    // Skip while stopping / handling video-end / not streaming.
    if (!this.shouldRun()) {
      return;
    }

    const videoPid = this.getVideoProcess()?.pid;
    const audioPid = this.getAudioProcess()?.pid;
    const videoAlive = PipelineHealthMonitor.isProcessAlive(videoPid);
    const audioAlive = PipelineHealthMonitor.isProcessAlive(audioPid);

    if (!videoAlive && !audioAlive) {
      this.logger?.error(`💀 ViewBot ${this.botId}: Both pipelines are dead!`);
      this.onCrash('both');
    } else if (!videoAlive) {
      this.logger?.error(`💀 ViewBot ${this.botId}: Video pipeline is dead (PID ${videoPid})`);
      this.onCrash('video');
    } else if (!audioAlive) {
      this.logger?.error(`💀 ViewBot ${this.botId}: Audio pipeline is dead (PID ${audioPid})`);
      this.onCrash('audio');
    } else {
      this.checkActivity();
    }
  }

  checkActivity() {
    const currentTime = Date.now();

    if (!this.lastHealthCheck) {
      this.lastHealthCheck = { time: currentTime, videoFrames: 0, audioFrames: 0 };
      return;
    }

    const timeDiff = currentTime - this.lastHealthCheck.time;
    if (timeDiff > 10000) {
      this.logger?.warn(`⚠️ ViewBot ${this.botId}: No pipeline activity for ${timeDiff / 1000}s`);
      if (timeDiff > 15000) {
        this.logger?.error(`🔄 ViewBot ${this.botId}: Pipelines appear stuck, recovering...`);
        this.onCrash('stuck');
      }
    }
  }
}

module.exports = PipelineHealthMonitor;
