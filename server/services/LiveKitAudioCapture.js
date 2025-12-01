/**
 * LiveKit Audio Capture - Direct audio subscription without GStreamer
 * Uses LiveKit Node SDK to subscribe to audio tracks and write to WAV
 */

const { Room, RoomEvent, Track } = require('livekit-client');
const { AccessToken } = require('livekit-server-sdk');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class LiveKitAudioCapture {
    constructor(config) {
        this.config = config;
        this.room = null;
        this.audioTrack = null;
        this.outputFile = null;
        this.ffmpegProcess = null;
        this.isCapturing = false;
    }

    /**
     * Start capturing audio from a LiveKit participant
     */
    async startCapture(participantIdentity, audioTrackSid, outputFile) {
        console.log(`🎙️ LiveKitAudioCapture: Starting capture`);
        console.log(`   Participant: ${participantIdentity}`);
        console.log(`   Track SID: ${audioTrackSid}`);
        console.log(`   Output: ${outputFile}`);

        this.outputFile = outputFile;

        try {
            // Generate token for transcription participant
            const token = await this.generateToken();

            // Connect to LiveKit room
            const room = new Room();
            this.room = room;

            // Set up event handlers
            room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
                console.log(`✅ Subscribed to track ${track.sid} from ${participant.identity}`);

                if (track.kind === Track.Kind.Audio) {
                    this.handleAudioTrack(track);
                }
            });

            room.on(RoomEvent.Disconnected, () => {
                console.log(`🔌 Disconnected from LiveKit room`);
                this.cleanup();
            });

            // Connect to room
            console.log(`🔗 Connecting to LiveKit room: ${this.config.roomName}`);
            await room.connect(this.config.wsUrl, token);
            console.log(`✅ Connected to LiveKit room`);

            this.isCapturing = true;

            return { success: true };

        } catch (error) {
            console.error(`❌ LiveKitAudioCapture: Failed to start:`, error);
            this.cleanup();
            return { success: false, error: error.message };
        }
    }

    /**
     * Handle subscribed audio track
     */
    async handleAudioTrack(track) {
        console.log(`🎵 Processing audio track: ${track.sid}`);

        try {
            // Get MediaStreamTrack
            const mediaStreamTrack = track.mediaStreamTrack;

            if (!mediaStreamTrack) {
                console.error(`❌ No MediaStreamTrack available`);
                return;
            }

            // Create MediaStream
            const mediaStream = new MediaStream([mediaStreamTrack]);

            // Use FFmpeg to capture audio from stdin
            // We'll pipe raw PCM audio to FFmpeg
            this.startFFmpegCapture(mediaStream);

        } catch (error) {
            console.error(`❌ Error handling audio track:`, error);
        }
    }

    /**
     * Start FFmpeg to convert and save audio
     */
    startFFmpegCapture(mediaStream) {
        console.log(`🎬 Starting FFmpeg audio capture to ${this.outputFile}`);

        // FFmpeg command to convert stdin PCM to WAV
        const ffmpegArgs = [
            '-f', 's16le',           // Input format: signed 16-bit little-endian PCM
            '-ar', '48000',          // Input sample rate (LiveKit default)
            '-ac', '2',              // Input channels (stereo)
            '-i', 'pipe:0',          // Read from stdin
            '-ar', '16000',          // Output sample rate (Whisper compatible)
            '-ac', '1',              // Output channels (mono)
            '-f', 'wav',             // Output format
            '-y',                    // Overwrite output file
            this.outputFile
        ];

        this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

        this.ffmpegProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('size=') || msg.includes('time=')) {
                // Progress updates - can log if needed
            } else if (msg.includes('ERROR')) {
                console.error(`❌ FFmpeg error: ${msg.trim()}`);
            }
        });

        this.ffmpegProcess.on('error', (error) => {
            console.error(`❌ FFmpeg process error:`, error);
        });

        this.ffmpegProcess.on('exit', (code) => {
            console.log(`🎬 FFmpeg process exited with code ${code}`);
        });

        // Note: In Node.js environment without browser APIs, we need a different approach
        // Since LiveKit client SDK is browser-focused, we'll use a server-side approach instead
        console.log(`⚠️ LiveKit client SDK requires browser environment`);
        console.log(`   Falling back to WHIP recording approach...`);

        this.cleanup();
    }

    /**
     * Generate access token for transcription participant
     */
    async generateToken() {
        const at = new AccessToken(this.config.apiKey, this.config.apiSecret, {
            identity: `transcription-${Date.now()}`,
            ttl: '1h',
        });

        at.addGrant({
            roomJoin: true,
            room: this.config.roomName,
            canPublish: false,
            canSubscribe: true,
        });

        return await at.toJwt();
    }

    /**
     * Stop capturing and cleanup
     */
    async stopCapture() {
        console.log(`🛑 Stopping LiveKit audio capture`);
        this.cleanup();
    }

    cleanup() {
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGTERM');
            this.ffmpegProcess = null;
        }

        if (this.room) {
            this.room.disconnect();
            this.room = null;
        }

        this.isCapturing = false;
    }
}

module.exports = LiveKitAudioCapture;
