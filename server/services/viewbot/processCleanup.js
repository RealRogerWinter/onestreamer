// Process-kill consolidation for ViewBotInstance, extracted verbatim from
// cleanupGStreamerProcesses and killAllProcesses (plus the live-process FFmpeg
// kills from cleanupMediaGeneration, which were dead — see note below).
//
// These two routines use DIFFERENT kill semantics on purpose and are NOT
// unified:
//   - cleanupGStreamerProcesses delegates to processKill.killProcessGroup
//     (negative-PID group SIGKILL), clears timers, and resets the starting flag.
//   - killAllProcesses uses plain SIGKILL per process plus a pkill sweep keyed
//     on the allocated RTP ports.
//
// `owner` is the ViewBotInstance: these read/write owner.gstreamerVideoProcess,
// owner.gstreamerAudioProcess, owner.gstreamerProcess, owner.ffmpegProcess,
// owner.videoDurationTimer, owner.recoveryTimer, owner.gstreamerStarting,
// owner.videoRtpPort, owner.audioRtpPort and call owner.healthMonitor.stop() —
// preserving the original control flow.
//
// NOTE: cleanupMediaGeneration's combinedFFmpeg/videoFFmpeg/audioFFmpeg/
// ffmpegProcess branches are dead (those fields are only ever assigned null,
// never a live process), so they are intentionally NOT consolidated here.

const { killProcessGroup } = require('./processKill');

/**
 * Clean up GStreamer processes. Verbatim port of
 * ViewBotInstance.cleanupGStreamerProcesses.
 */
function cleanupGStreamerProcesses(owner, logger) {
  logger.debug(`🧹🧹🧹 CLEANUP CALLED - ViewBot ${owner.botId}: Cleaning up GStreamer processes...`);
  logger.debug(`   📊 Current process references:`, {
    video: owner.gstreamerVideoProcess ? `PID ${owner.gstreamerVideoProcess.pid}` : 'NULL',
    audio: owner.gstreamerAudioProcess ? `PID ${owner.gstreamerAudioProcess.pid}` : 'NULL',
    gstreamer: owner.gstreamerProcess ? `PID ${owner.gstreamerProcess.pid}` : 'NULL'
  });

  // Clear duration timer if set
  if (owner.videoDurationTimer) {
    clearTimeout(owner.videoDurationTimer);
    owner.videoDurationTimer = null;
  }

  // Clear health check timer if set
  owner.healthMonitor.stop();

  // Clear recovery timer if set
  if (owner.recoveryTimer) {
    clearTimeout(owner.recoveryTimer);
    owner.recoveryTimer = null;
  }

  // CRITICAL: Kill entire process group to prevent orphaned processes
  killProcessGroup(owner.gstreamerVideoProcess, 'video', logger);
  killProcessGroup(owner.gstreamerAudioProcess, 'audio', logger);
  killProcessGroup(owner.gstreamerProcess, 'gstreamer', logger);

  // No longer needed - process group killing handles all child processes

  // Clear references immediately - processes are being killed
  owner.gstreamerVideoProcess = null;
  owner.gstreamerAudioProcess = null;
  owner.gstreamerProcess = null;
  // CRITICAL: Clear the starting flag to allow future starts
  owner.gstreamerStarting = false;
  logger.debug(`   🧹 Process references and flags cleared`);

  logger.debug(`   ✅ Cleanup completed - all processes killed`);
}

/**
 * Kill all pipeline processes forcefully. Verbatim port of
 * ViewBotInstance.killAllProcesses.
 */
async function killAllProcesses(owner, logger) {
  const processes = [
    { proc: owner.gstreamerVideoProcess, name: 'video' },
    { proc: owner.gstreamerAudioProcess, name: 'audio' },
    { proc: owner.ffmpegProcess, name: 'ffmpeg' }
  ];

  for (const { proc, name } of processes) {
    if (proc && proc.pid) {
      try {
        logger.debug(`💀 Killing ${name} process (PID: ${proc.pid})`);
        proc.kill('SIGKILL');
      } catch (error) {
        // Process might already be dead
      }
    }
  }

  // Also kill any orphaned gst-launch processes
  try {
    const { execSync } = require('child_process');
    execSync(`pkill -f "gst-launch.*${owner.videoRtpPort}" || true`, { encoding: 'utf8' });
    execSync(`pkill -f "gst-launch.*${owner.audioRtpPort}" || true`, { encoding: 'utf8' });
  } catch (error) {
    // Ignore errors
  }

  // Clear references
  owner.gstreamerVideoProcess = null;
  owner.gstreamerAudioProcess = null;
  owner.ffmpegProcess = null;
}

module.exports = { cleanupGStreamerProcesses, killAllProcesses };
