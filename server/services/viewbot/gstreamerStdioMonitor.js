// GStreamer stdout/stderr state-machine monitor for ViewBotInstance, extracted
// verbatim from the per-pipeline 'data'/'exit'/'error' listeners in
// startDirectRTPPipelines. The video and audio listeners were ~80% identical;
// they are collapsed into one attachPipelineStdioMonitor(proc, opts) driven by
// `kind` ('video' | 'audio'). Every log string, branch, and control-flow detail
// is preserved exactly as it was inline.
//
// The original code kept mutable locals (videoStarted/videoEOS/videoError and
// the audio equivalents) that the outer pipeline-start Promise read after the
// listeners mutated them. To preserve that, this returns a mutable `state`
// object ({ started, eos, error }) the caller reads in place of those locals.
//
// Deps come from the owning ViewBotInstance via callbacks:
//   onEos()      — kind:'video' only; runs the cleanup-then-rotation sequence.
//   shouldRotate() — kind:'video' only; gate read at exit (videoEOS || code===0
//                    && !stopping && !handlingVideoEnd), see attach call site.
// (logger is passed directly to keep the child-logger binding.)

/**
 * Attaches stdout/stderr/exit/error listeners to a GStreamer pipeline process,
 * reproducing the original inline state machine. Returns a mutable `state`
 * object the caller polls for start/EOS detection.
 *
 * @param {ChildProcess} proc
 * @param {object} opts
 * @param {'video'|'audio'} opts.kind
 * @param {object} opts.logger
 * @param {string} opts.botId
 * @param {() => boolean} opts.isStopping
 * @param {() => boolean} opts.isHandlingVideoEnd
 * @param {() => void} opts.cleanupGStreamerProcesses
 * @param {() => void} opts.handleVideoEnd
 * @param {() => void} opts.clearVideoRef   clears owner.gstreamerVideoProcess
 * @param {() => void} opts.clearAudioRef   clears owner.gstreamerAudioProcess
 */
function attachPipelineStdioMonitor(proc, opts) {
  const {
    kind,
    logger,
    botId,
    isStopping,
    isHandlingVideoEnd,
    cleanupGStreamerProcesses,
    handleVideoEnd,
    clearVideoRef,
    clearAudioRef,
  } = opts;

  const isVideo = kind === 'video';
  const emoji = isVideo ? '📹' : '🔊';
  const Label = isVideo ? 'Video' : 'Audio';

  // Mutable state the caller reads after listeners fire (replaces the
  // videoStarted/videoEOS/videoError / audioStarted/audioEOS/audioError locals).
  const state = { started: false, eos: false, error: '' };

  // Monitor pipeline stderr for state changes and errors
  proc.stderr.on('data', (data) => {
    const output = data.toString();

    // Log first few messages for debugging (video only)
    if (isVideo && !state.started) {
      logger.debug(`📹 ViewBot ${botId}: Video stderr: ${output.substring(0, 200)}`);
    }

    if (output.includes('ERROR')) {
      state.error = output.substring(0, 200);
      logger.error(`❌ ViewBot ${botId}: ${Label} pipeline error`);
      logger.error(output);
    } else if (output.includes('PLAYING') || output.includes('Setting pipeline to PLAYING')) {
      if (!state.started) {
        state.started = true;
        logger.debug(`▶️ ViewBot ${botId}: ${Label} pipeline playing`);
      }
    } else if (isVideo && (output.includes('EOS') || output.includes('end-of-stream') ||
               output.includes('Got EOS from element') || output.includes('Posting EOS') ||
               output.includes('EOS received') || output.includes('Execution ended'))) {
      if (!state.eos) {
        state.eos = true;
        logger.debug(`🏁 ViewBot ${botId}: Video EOS detected - cleaning up first!`);
        logger.debug(`   EOS Message: ${output.substring(0, 100)}`);

        // First cleanup the processes to ensure resources are freed
        logger.debug(`🧹 ViewBot ${botId}: Cleaning up GStreamer processes immediately`);
        cleanupGStreamerProcesses();

        // Then trigger video end handling after cleanup to avoid conflicts
        setTimeout(() => {
          if (!isStopping() && !isHandlingVideoEnd()) {
            logger.debug(`🔄 ViewBot ${botId}: Triggering rotation after cleanup`);
            handleVideoEnd();
          }
        }, 200); // Small delay to ensure cleanup completes
      }
    } else if (!isVideo && output.includes('EOS')) {
      state.eos = true;
      logger.debug(`🏁 ViewBot ${botId}: Audio EOS received - complete playback!`);
    } else if (isVideo && output.includes('Setting pipeline to NULL')) {
      logger.debug(`🔧 ViewBot ${botId}: Video pipeline shutting down`);
    } else if (isVideo && output.includes('Setting pipeline')) {
      logger.debug(`🔧 ViewBot ${botId}: Video pipeline state change`);
    } else if (output.includes(`caps = ${kind}/`)) {
      logger.debug(`${emoji} ViewBot ${botId}: ${Label} stream detected`);
    } else if (isVideo && output.includes('Freeing pipeline')) {
      logger.debug(`🧹 ViewBot ${botId}: Video pipeline freed`);
    }
  });

  // Also monitor stdout (GStreamer may output to stdout instead of stderr)
  proc.stdout.on('data', (data) => {
    const output = data.toString();

    // Log for debugging
    if (!state.started) {
      logger.debug(`${emoji} ViewBot ${botId}: ${Label} stdout: ${output.substring(0, 200)}`);
    }

    if (output.includes('Setting pipeline') || output.includes('PLAYING')) {
      logger.debug(`🔧 ViewBot ${botId}: ${Label} pipeline state: ${output.trim()}`);
      if (!state.started && (output.includes('PLAYING') || output.includes('Pipeline is PREROLLED'))) {
        state.started = true;
        logger.debug(`▶️ ViewBot ${botId}: ${Label} pipeline playing (from stdout)`);
      }
    }
  });

  proc.on('error', (error) => {
    if (isVideo) {
      logger.error(`❌ ViewBot ${botId}: Failed to start video pipeline:`, error);
      throw error;
    } else {
      logger.error(`❌ ViewBot ${botId}: Failed to start audio pipeline:`, error);
      // Audio failure is not critical, continue
    }
  });

  proc.on('exit', (code, signal) => {
    logger.debug(`🛑 ViewBot ${botId}: ${Label} pipeline exited (code: ${code})`);

    if (state.eos) {
      logger.debug(`   ✅ ${Label} played to completion`);
    } else if (code === 0) {
      logger.debug(`   ✅ ${Label} pipeline completed normally`);
    } else if (state.error) {
      logger.error(`   ❌ ${Label} error: ${state.error}`);
    }

    if (isVideo) {
      clearVideoRef();

      // Handle video end - trigger rotation after ensuring cleanup
      if (!isStopping() && !isHandlingVideoEnd() && (state.eos || code === 0)) {
        logger.debug(`🎬 ViewBot ${botId}: Video file reached end (GStreamer EOS: ${state.eos}, Exit code: ${code})`);
        // Ensure cleanup then trigger rotation
        setTimeout(() => {
          if (!isStopping() && !isHandlingVideoEnd()) {
            handleVideoEnd();
          }
        }, 500); // Small delay to ensure process cleanup
      }
    } else {
      clearAudioRef();
    }
  });

  return state;
}

module.exports = { attachPipelineStdioMonitor };
