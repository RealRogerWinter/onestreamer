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
const { spawn } = require('child_process');
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
});
