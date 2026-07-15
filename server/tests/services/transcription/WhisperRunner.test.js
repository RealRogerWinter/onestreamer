// Tests for WhisperRunner's subprocess close-handling — in particular that a
// whisper.cpp binary which crashes with a signal (SIGILL from an AVX-512 binary
// on an AVX2-only host, SIGSEGV, …) is surfaced LOUDLY rather than folded into
// the success path as an empty transcript. A silent 0-word transcript made an
// instruction-set mismatch look like permanent silence with no error in prod.

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

let mockProc;
jest.mock('child_process', () => ({
    spawn: jest.fn(() => mockProc),
}));
jest.mock('../../../bootstrap/logger', () => {
    const l = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return { child: () => l, __mockLogger: l };
});
const { spawn } = require('child_process');
const { __mockLogger: mockLogger } = require('../../../bootstrap/logger');
const WhisperRunner = require('../../../services/transcription/WhisperRunner');

function makeProc() {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.kill = jest.fn();
    p.killed = false;
    return p;
}

describe('WhisperRunner.transcribeWithWhisperCpp', () => {
    let runner;

    beforeEach(() => {
        runner = new WhisperRunner({ whisperPath: '/tmp/whisper-test', isWindows: false });
        mockProc = makeProc();
        spawn.mockClear();
    });

    test('rejects when the binary crashes with SIGILL (AVX-512 / instruction-set mismatch)', async () => {
        const p = runner.transcribeWithWhisperCpp('/tmp/audio-sigill.wav', { model: 'base', language: 'en' });
        // whisper prints its banner, then the first inference instruction faults.
        mockProc.stderr.emit('data', Buffer.from('whisper_init_state: kv self size ...'));
        mockProc.emit('close', null, 'SIGILL');
        await expect(p).rejects.toThrow(/SIGILL/);
    });

    test('rejects on any unexpected crash signal (e.g. SIGSEGV)', async () => {
        const p = runner.transcribeWithWhisperCpp('/tmp/audio-segv.wav', { model: 'base', language: 'en' });
        mockProc.emit('close', null, 'SIGSEGV');
        await expect(p).rejects.toThrow(/SIGSEGV/);
    });

    test('resolves the transcript on clean exit (code 0) and removes the .txt file', async () => {
        const audioPath = path.join(os.tmpdir(), `wr-${process.pid}-${Date.now()}.wav`);
        const txtPath = `${audioPath}.txt`;
        fs.writeFileSync(txtPath, '  hello world  \n');

        const p = runner.transcribeWithWhisperCpp(audioPath, { model: 'base', language: 'en' });
        mockProc.emit('close', 0, null);

        await expect(p).resolves.toBe('hello world');
        expect(fs.existsSync(txtPath)).toBe(false); // cleaned up
    });

    test('resolves empty string on a genuine clean-but-silent run (code 0, no output)', async () => {
        const p = runner.transcribeWithWhisperCpp('/tmp/audio-silent.wav', { model: 'base', language: 'en' });
        mockProc.emit('close', 0, null); // no .txt, no stdout
        await expect(p).resolves.toBe('');
    });

    test('resolves empty string when OUR watchdog times the process out (not a crash)', async () => {
        jest.useFakeTimers();
        try {
            const p = runner.transcribeWithWhisperCpp('/tmp/audio-timeout.wav', { model: 'base', language: 'en' });
            jest.advanceTimersByTime(20000); // fire the watchdog: sets killedByTimeout, sends SIGTERM
            expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
            mockProc.emit('close', null, 'SIGTERM'); // close arrives from our own kill
            await expect(p).resolves.toBe('');
        } finally {
            jest.useRealTimers();
        }
    });

    // A3 (audit Plan 07): duration-scaled watchdog, partial-output salvage,
    // and the in-module concurrency semaphore.
    describe('A3: duration-scaled timeout / partial output / concurrency', () => {
        test('watchdog timeout scales with audioDurationSec (45s audio > 20s floor)', async () => {
            jest.useFakeTimers();
            try {
                const p = runner.transcribeWithWhisperCpp(
                    '/tmp/audio-45s.wav',
                    { model: 'base', language: 'en' },
                    { audioDurationSec: 45 }
                );
                // Old fixed watchdog fired at 20s — with the default
                // 1500 ms/s scaling a 45s window gets 67.5s.
                jest.advanceTimersByTime(20000);
                expect(mockProc.kill).not.toHaveBeenCalled();
                jest.advanceTimersByTime(47500); // total 67500 = 45 * 1500
                expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
                mockProc.emit('close', null, 'SIGTERM');
                await expect(p).resolves.toBe('');
            } finally {
                jest.useRealTimers();
            }
        });

        test('short audio keeps the 20s floor', async () => {
            jest.useFakeTimers();
            try {
                const p = runner.transcribeWithWhisperCpp(
                    '/tmp/audio-5s.wav',
                    { model: 'base', language: 'en' },
                    { audioDurationSec: 5 } // 5 * 1500 = 7.5s, below the floor
                );
                jest.advanceTimersByTime(19999);
                expect(mockProc.kill).not.toHaveBeenCalled();
                jest.advanceTimersByTime(1);
                expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
                mockProc.emit('close', null, 'SIGTERM');
                await expect(p).resolves.toBe('');
            } finally {
                jest.useRealTimers();
            }
        });

        test('WHISPER_TIMEOUT_FLOOR_MS / WHISPER_TIMEOUT_PER_SEC_MS env overrides are honored', async () => {
            jest.useFakeTimers();
            process.env.WHISPER_TIMEOUT_FLOOR_MS = '1000';
            process.env.WHISPER_TIMEOUT_PER_SEC_MS = '100';
            try {
                const p = runner.transcribeWithWhisperCpp(
                    '/tmp/audio-env.wav',
                    { model: 'base', language: 'en' },
                    { audioDurationSec: 30 } // 30 * 100 = 3000ms > 1000ms floor
                );
                jest.advanceTimersByTime(2999);
                expect(mockProc.kill).not.toHaveBeenCalled();
                jest.advanceTimersByTime(1);
                expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
                mockProc.emit('close', null, 'SIGTERM');
                await expect(p).resolves.toBe('');
            } finally {
                delete process.env.WHISPER_TIMEOUT_FLOOR_MS;
                delete process.env.WHISPER_TIMEOUT_PER_SEC_MS;
                jest.useRealTimers();
            }
        });

        test('surfaces partial stdout as a truncated transcript on timeout, with a WARN', async () => {
            jest.useFakeTimers();
            mockLogger.warn.mockClear();
            try {
                const p = runner.transcribeWithWhisperCpp(
                    '/tmp/audio-partial.wav',
                    { model: 'base', language: 'en' },
                    { audioDurationSec: 10 }
                );
                // whisper emits banner noise + real transcript lines before hanging
                mockProc.stdout.emit('data', Buffer.from('whisper_init_state: compute buffer\n'));
                mockProc.stdout.emit('data', Buffer.from(' Hello this is the first part\n of the stream audio\n'));
                jest.advanceTimersByTime(20000); // floor applies (10 * 1500 < 20000)
                expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
                mockProc.emit('close', null, 'SIGTERM');
                await expect(p).resolves.toBe('Hello this is the first part  of the stream audio');
                expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/timed out after 20000ms.*truncated/));
            } finally {
                jest.useRealTimers();
            }
        });

        test('semaphore holds the 3rd concurrent run until one finishes (default max 2)', async () => {
            const procs = [];
            spawn.mockImplementation(() => {
                const p = makeProc();
                procs.push(p);
                return p;
            });
            try {
                const cfg = { model: 'base', language: 'en' };
                const p1 = runner.transcribeWithWhisperCpp('/tmp/audio-c1.wav', cfg);
                const p2 = runner.transcribeWithWhisperCpp('/tmp/audio-c2.wav', cfg);
                const p3 = runner.transcribeWithWhisperCpp('/tmp/audio-c3.wav', cfg);

                // Two slots (default WHISPER_MAX_CONCURRENT=2): the 3rd run queues.
                expect(spawn).toHaveBeenCalledTimes(2);

                procs[0].emit('close', 0, null); // run 1 finishes (silent, no .txt)
                await expect(p1).resolves.toBe('');
                await new Promise((resolve) => setImmediate(resolve)); // let the queued run spawn
                expect(spawn).toHaveBeenCalledTimes(3);

                procs[1].emit('close', 0, null);
                procs[2].emit('close', 0, null);
                await expect(p2).resolves.toBe('');
                await expect(p3).resolves.toBe('');
            } finally {
                spawn.mockImplementation(() => mockProc);
            }
        });
    });
});
