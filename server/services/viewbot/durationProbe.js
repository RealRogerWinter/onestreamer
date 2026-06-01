// ffprobe duration probes for ViewBotInstance, extracted verbatim from
// getVideoDuration and setupDurationBasedRotation. Both shell out to ffprobe to
// learn a video's length and arm a failsafe timer that forces rotation if the
// pipeline never emits EOS. They differ in mechanics (spawn+close vs execSync)
// and in which timer field they own, so they are kept as two functions sharing
// one entry point rather than collapsed into one.
//
// `owner` is the ViewBotInstance: these read/write owner.botId, owner.streaming,
// owner.handlingVideoEnd, owner.videoDuration, owner.videoEndTimer,
// owner.videoDurationTimer and call owner.handleVideoEnd() /
// owner.cleanupMediaGeneration() — preserving the original control flow.

const { spawn } = require('child_process');

/**
 * Gets video duration using ffprobe (async, spawn-based). Mirrors the original
 * ViewBotInstance.getVideoDuration: resolves once ffprobe closes, arming
 * owner.videoEndTimer as a fallback for video end.
 */
function getVideoDuration(owner, videoPath, logger) {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);

    let duration = '';
    ffprobe.stdout.on('data', (data) => {
      duration += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code === 0 && duration) {
        const durationSeconds = parseFloat(duration.trim());
        logger.debug(`⏱️ ViewBot ${owner.botId}: Video duration: ${durationSeconds} seconds`);
        owner.videoDuration = durationSeconds;

        // Set up a fallback timer for video end
        if (durationSeconds > 0 && !isNaN(durationSeconds)) {
          owner.videoEndTimer = setTimeout(() => {
            logger.debug(`⏰ ViewBot ${owner.botId}: Video duration timer expired, triggering rotation`);
            owner.handleVideoEnd();
          }, (durationSeconds * 1000) + 2000); // Add 2 second buffer
        }
      } else {
        logger.warn(`⚠️ ViewBot ${owner.botId}: Could not determine video duration`);
      }
      resolve();
    });

    ffprobe.on('error', (error) => {
      logger.error(`❌ ViewBot ${owner.botId}: ffprobe error:`, error);
      resolve();
    });
  });
}

/**
 * Set up duration-based rotation as a failsafe (sync, execSync-based). Mirrors
 * the original ViewBotInstance.setupDurationBasedRotation: arms
 * owner.videoDurationTimer to force cleanup + rotation if EOS is never seen.
 */
async function setupDurationBasedRotation(owner, videoFile, logger) {
  try {
    const { execSync } = require('child_process');
    const duration = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoFile}"`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    const durationSeconds = parseFloat(duration);
    if (durationSeconds > 0 && !isNaN(durationSeconds)) {
      // Add 5 second buffer for processing delays
      const rotationDelay = (durationSeconds + 5) * 1000;

      logger.debug(`⏰ ViewBot ${owner.botId}: Video duration is ${durationSeconds}s, setting failsafe rotation timer for ${rotationDelay}ms`);

      owner.videoDurationTimer = setTimeout(() => {
        logger.debug(`⚠️ ViewBot ${owner.botId}: Duration-based failsafe triggered - video should have ended by now`);
        if (!owner.handlingVideoEnd && owner.streaming) {
          logger.debug(`🆘 ViewBot ${owner.botId}: EOS not detected, forcing cleanup then rotation`);

          // First force cleanup to free resources
          owner.cleanupMediaGeneration();

          // Then trigger rotation after cleanup
          setTimeout(() => {
            if (!owner.handlingVideoEnd) {
              owner.handleVideoEnd();
            }
          }, 200);
        }
      }, rotationDelay);
    } else {
      logger.warn(`⚠️ ViewBot ${owner.botId}: Could not determine video duration for failsafe`);
    }
  } catch (error) {
    logger.warn(`⚠️ ViewBot ${owner.botId}: Failed to set up duration-based rotation:`, error.message);
  }
}

module.exports = { getVideoDuration, setupDurationBasedRotation };
