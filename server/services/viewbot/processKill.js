// Cross-platform forced process-group kill, extracted verbatim from the inner
// helper in ViewBotInstance.cleanupGStreamerProcesses. On Linux it kills the
// whole process group (kill -9 -PID) so GStreamer's children die too, falling
// back to a single SIGKILL; on Windows it SIGKILLs the process. Tolerates an
// already-dead process (ESRCH). Pure aside from the kill side effect + logger.
//
// NOTE: ViewBotInstance.killAllProcesses and cleanupMediaGeneration intentionally
// use DIFFERENT kill semantics (plain SIGKILL / SIGTERM-then-timeout) and are not
// unified here.

function killProcessGroup(proc, name, logger = null) {
  if (proc && proc.pid) {
    const pid = proc.pid;
    logger?.debug(`   💀💀💀 KILLING ${name} process group (PID: ${pid})`);

    try {
      // Use negative PID to kill the entire process group on Linux so all
      // children spawned by GStreamer are killed.
      if (process.platform !== 'win32') {
        const { execSync } = require('child_process');
        try {
          logger?.debug(`   🔫 Executing: kill -9 -${pid} (kill process group)`);
          execSync(`kill -9 -${pid}`, { stdio: 'ignore' });
          logger?.debug(`   ✅✅✅ ${name} process group KILLED (PID: -${pid})`);
        } catch (killError) {
          // If group kill fails, try to kill the single process.
          logger?.debug(`   ⚠️ Group kill failed, trying single process kill`);
          try {
            proc.kill('SIGKILL');
            logger?.debug(`   ✅ ${name} single process killed (PID: ${pid})`);
          } catch (e) {
            logger?.debug(`   ❌ Failed to kill ${name}: ${e.message}`);
          }
        }
      } else {
        proc.kill('SIGKILL');
        logger?.debug(`   ✅ ${name} process killed (PID: ${pid})`);
      }
    } catch (error) {
      // Process might already be dead.
      if (error.code !== 'ESRCH') {
        logger?.debug(`   ❌❌❌ ERROR killing ${name}: ${error.message}`);
      } else {
        logger?.debug(`   ⚠️ ${name} process already dead (ESRCH)`);
      }
    }
  } else {
    logger?.debug(`   ⚠️⚠️⚠️ No ${name} process reference to kill!`);
  }
}

module.exports = { killProcessGroup };
