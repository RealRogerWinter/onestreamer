// Rotation-check scheduler for ViewBotInstance, extracted from
// startRotationCheckTimer / scheduleNextRotationCheck / performRotationCheck /
// stopRotationCheckTimer. Owns the rotation timer; reads rotation config from
// the parent service (via injected accessor) and, when a probability roll
// passes, invokes onRotate() (the bot's requestRotation). rng is injectable for
// deterministic tests (defaults to Math.random — production behavior).
//
// Deps: { botId, logger, getParentService(), isStreaming(), onRotate(), rng }.

class RotationScheduler {
  constructor({ botId, logger = null, getParentService, isStreaming, onRotate, rng = Math.random }) {
    this.botId = botId;
    this.logger = logger;
    this.getParentService = getParentService;
    this.isStreaming = isStreaming;
    this.onRotate = onRotate;
    this.rng = rng;
    this.timer = null;
  }

  // Random check interval (ms) in [min, max].
  static computeInterval(minInterval, maxInterval, rng = Math.random) {
    return Math.floor(rng() * (maxInterval - minInterval + 1)) + minInterval;
  }

  start() {
    this.stop();
    const parentService = this.getParentService();
    if (!parentService || !parentService.rotationEnabled) {
      this.logger?.debug(`⏸️ ViewBot ${this.botId}: Rotation disabled - no checks will be performed`);
      return;
    }
    this.scheduleNext();
  }

  scheduleNext() {
    const parentService = this.getParentService();
    if (!parentService) return;

    const minInterval = parentService.rotationCheckIntervalMin || 65000;
    const maxInterval = parentService.rotationCheckIntervalMax || 65000;
    const interval = RotationScheduler.computeInterval(minInterval, maxInterval, this.rng);

    this.logger?.debug(`⏱️ ViewBot ${this.botId}: Next rotation check in ${interval / 1000} seconds (using ${minInterval / 1000}-${maxInterval / 1000}s range)`);

    this.timer = setTimeout(() => {
      this.performCheck();
    }, interval);
  }

  performCheck() {
    const parentService = this.getParentService();
    if (!parentService || !parentService.rotationEnabled || !this.isStreaming()) {
      this.logger?.debug(`🚫 ViewBot ${this.botId}: Rotation check skipped - conditions not met`);
      return;
    }

    const rotationProbability = parentService.rotationProbability || 0.31;
    const roll = this.rng();
    this.logger?.debug(`🎲 ViewBot ${this.botId}: Rotation check - rolled ${(roll * 100).toFixed(2)}% vs ${(rotationProbability * 100).toFixed(2)}% threshold`);

    if (roll < rotationProbability) {
      this.logger?.debug(`✅ ViewBot ${this.botId}: Rotation triggered! Requesting rotation...`);
      this.onRotate();
    } else {
      this.logger?.debug(`⏭️ ViewBot ${this.botId}: No rotation this time, scheduling next check`);
      this.scheduleNext();
    }
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.logger?.debug(`⏹️ ViewBot ${this.botId}: Stopped rotation check timer`);
    }
  }
}

module.exports = RotationScheduler;
