/**
 * Tests for the descendant-scoped kill helper (server/bootstrap/process-tree.js,
 * ADR-0032). The pure core (`signalDescendantsFromPs`) is driven with fake
 * `ps -eo pid=,ppid=,comm=` output and an injected kill spy; the async/sync
 * wrappers get injected child_process fakes.
 */

const {
    parsePs,
    commMatches,
    signalDescendantsFromPs,
    killDescendantsByComm,
    killDescendantsByCommSync,
} = require('../../bootstrap/process-tree');

// Tree: node(100, root) ── ffmpeg(200)
//                       └─ streamlink(300) ── ffmpeg(400)   [grandchild]
// Unrelated: ffmpeg(500) under init — must NEVER be signalled.
const PS_FIXTURE = [
    '  100     1 node',
    '  200   100 ffmpeg',
    '  300   100 streamlink',
    '  400   300 ffmpeg',
    '  500     1 ffmpeg',
    '  600   100 whisper',
].join('\n');

describe('bootstrap/process-tree (ADR-0032)', () => {
    it('signals direct-child AND grandchild ffmpeg, leaving unrelated ffmpeg untouched', () => {
        const kill = jest.fn();
        const signalled = signalDescendantsFromPs(PS_FIXTURE, 100, 'ffmpeg', 'SIGTERM', kill);

        expect(signalled.sort()).toEqual([200, 400]);
        expect(kill).toHaveBeenCalledTimes(2);
        expect(kill).toHaveBeenCalledWith(200, 'SIGTERM');
        expect(kill).toHaveBeenCalledWith(400, 'SIGTERM');
        // The foreign ffmpeg (pid 500, not our descendant) is never touched.
        expect(kill).not.toHaveBeenCalledWith(500, expect.anything());
        // Non-matching comm under our tree (whisper) is never touched.
        expect(kill).not.toHaveBeenCalledWith(600, expect.anything());
    });

    it('tolerates malformed / empty ps output: no signals, no throw', () => {
        const kill = jest.fn();
        for (const junk of ['', '   \n\n', 'garbage line\nUSER PID %CPU\nnot numbers here', null, undefined]) {
            expect(() => signalDescendantsFromPs(junk, 100, 'ffmpeg', 'SIGTERM', kill)).not.toThrow();
        }
        expect(kill).not.toHaveBeenCalled();
    });

    it('skips a PID that dies between enumeration and kill (kill throws) without aborting the sweep', () => {
        const kill = jest.fn((pid) => {
            if (pid === 200) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
        });
        const signalled = signalDescendantsFromPs(PS_FIXTURE, 100, 'ffmpeg', 'SIGKILL', kill);
        expect(signalled).toEqual([400]); // 200 threw, 400 still swept
    });

    it('matches kernel-truncated comm values (15-char /proc TASK_COMM_LEN)', () => {
        expect(commMatches('ffmpeg', 'ffmpeg')).toBe(true);
        expect(commMatches('ffprobe', 'ffmpeg')).toBe(false);
        // 15-char truncation of a longer name is a prefix match…
        expect(commMatches('some-very-long-', 'some-very-long-process')).toBe(true);
        // …but a short comm is never treated as a prefix.
        expect(commMatches('ff', 'ffmpeg')).toBe(false);
    });

    it('parsePs skips malformed rows and keeps valid ones', () => {
        const rows = parsePs('  12   1 node\nbroken\n  34  12 ffmpeg extra tokens\n');
        expect(rows).toEqual([
            { pid: 12, ppid: 1, comm: 'node' },
            { pid: 34, ppid: 12, comm: 'ffmpeg extra tokens' },
        ]);
    });

    it('async wrapper: resolves with signalled pids, and resolves [] when ps fails', async () => {
        const kill = jest.fn();
        const okExec = (cmd, cb) => cb(null, PS_FIXTURE);
        const pids = await killDescendantsByComm(100, 'ffmpeg', 'SIGTERM', { childProcess: { exec: okExec }, kill });
        expect(pids.sort()).toEqual([200, 400]);

        const failExec = (cmd, cb) => cb(new Error('ps not found'));
        const none = await killDescendantsByComm(100, 'ffmpeg', 'SIGTERM', { childProcess: { exec: failExec }, kill });
        expect(none).toEqual([]);
    });

    it('sync wrapper: signals from execSync output, and returns [] (no throw) when execSync throws', () => {
        const kill = jest.fn();
        const pids = killDescendantsByCommSync(100, 'ffmpeg', 'SIGKILL', {
            childProcess: { execSync: () => PS_FIXTURE },
            kill,
        });
        expect(pids.sort()).toEqual([200, 400]);

        const none = killDescendantsByCommSync(100, 'ffmpeg', 'SIGKILL', {
            childProcess: { execSync: () => { throw new Error('boom'); } },
            kill,
        });
        expect(none).toEqual([]);
    });
});
