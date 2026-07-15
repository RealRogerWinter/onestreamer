/**
 * Descendant-scoped process signalling (ADR-0032).
 *
 * Replaces the host/namespace-wide `pkill ffmpeg` safety nets in
 * `bootstrap/shutdown.js` with a kill that only ever touches processes
 * descended from this node process: parse `ps -eo pid=,ppid=,comm=`,
 * BFS the child tree from a root PID, and signal entries whose comm
 * matches. Catches direct children (all ffmpeg spawn sites) AND
 * grandchildren (e.g. an ffmpeg forked by streamlink), while never
 * reaching an unrelated ffmpeg — such as the LiveKit egress recorder
 * on a bare-host run.
 *
 * Robustness contract (tested): malformed/empty `ps` output, a failing
 * `ps`, or a PID that exits between enumeration and kill must produce
 * NO signals and NO throw. `comm` is truncated to 15 chars by the
 * kernel (/proc TASK_COMM_LEN), so a 15-char comm is treated as a
 * prefix match against the requested name.
 */

const COMM_TRUNCATION = 15;

/** Parse `ps -eo pid=,ppid=,comm=` text into {pid, ppid, comm} rows, skipping malformed lines. */
function parsePs(text) {
    const rows = [];
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3].trim() });
    }
    return rows;
}

/** True when a (possibly kernel-truncated) comm refers to `name`. */
function commMatches(comm, name) {
    return comm === name || (comm.length === COMM_TRUNCATION && name.startsWith(comm));
}

/** BFS the parsed rows from rootPid; returns every descendant row (cycle-safe). */
function descendantsOf(rows, rootPid) {
    const byPpid = new Map();
    for (const r of rows) {
        if (!byPpid.has(r.ppid)) byPpid.set(r.ppid, []);
        byPpid.get(r.ppid).push(r);
    }
    const out = [];
    const seen = new Set([Number(rootPid)]);
    const queue = [Number(rootPid)];
    while (queue.length) {
        for (const child of byPpid.get(queue.shift()) || []) {
            if (seen.has(child.pid)) continue;
            seen.add(child.pid);
            out.push(child);
            queue.push(child.pid);
        }
    }
    return out;
}

/**
 * Pure core: given raw `ps` text, signal every descendant of rootPid whose
 * comm matches `comm`. Returns the PIDs actually signalled. Never throws —
 * a kill() failure (PID already gone / not signallable) is skipped.
 */
function signalDescendantsFromPs(psText, rootPid, comm, signal, kill = process.kill.bind(process)) {
    const signalled = [];
    for (const p of descendantsOf(parsePs(psText), rootPid)) {
        if (!commMatches(p.comm, comm)) continue;
        try {
            kill(p.pid, signal);
            signalled.push(p.pid);
        } catch (_err) {
            // PID exited between enumeration and kill, or not ours — skip.
        }
    }
    return signalled;
}

const PS_CMD = 'ps -eo pid=,ppid=,comm=';

/** Async variant for the graceful-shutdown path. Resolves to the signalled PIDs; never rejects. */
function killDescendantsByComm(rootPid, comm, signal, deps = {}) {
    const { exec } = deps.childProcess || require('child_process');
    return new Promise((resolve) => {
        exec(PS_CMD, (err, stdout) => {
            if (err) return resolve([]);
            resolve(signalDescendantsFromPs(stdout, rootPid, comm, signal, deps.kill));
        });
    });
}

/** Sync variant for the crash path (uncaughtException) where async work can't be awaited. Never throws. */
function killDescendantsByCommSync(rootPid, comm, signal, deps = {}) {
    const { execSync } = deps.childProcess || require('child_process');
    try {
        const out = execSync(PS_CMD, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return signalDescendantsFromPs(out, rootPid, comm, signal, deps.kill);
    } catch (_err) {
        return [];
    }
}

module.exports = {
    parsePs,
    commMatches,
    descendantsOf,
    signalDescendantsFromPs,
    killDescendantsByComm,
    killDescendantsByCommSync,
};
