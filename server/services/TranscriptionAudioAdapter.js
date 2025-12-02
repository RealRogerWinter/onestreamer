/**
 * Transcription Audio Adapter
 * Provides a unified interface for capturing audio for transcription
 * Supports both MediaSoup and LiveKit backends
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { RoomServiceClient, IngressClient, AccessToken } = require('livekit-server-sdk');
const { Room, RoomEvent, TrackKind, AudioStream } = require('@livekit/rtc-node');

class TranscriptionAudioAdapter {
    constructor(webrtcService) {
        this.webrtcService = webrtcService;
        this.backendType = this.detectBackend();
        console.log(`🎙️ TranscriptionAudioAdapter: Initialized with ${this.backendType.toUpperCase()} backend`);
    }

    detectBackend() {
        // Check if the service has the getBackendType method (from WebRTCAdapterV2)
        if (typeof this.webrtcService.getBackendType === 'function') {
            return this.webrtcService.getBackendType();
        }
        // Check if it's a LiveKit service
        if (this.webrtcService.constructor.name === 'LiveKitService') {
            return 'livekit';
        }
        // Default to mediasoup
        return 'mediasoup';
    }

    isMediaSoup() {
        return this.backendType === 'mediasoup';
    }

    isLiveKit() {
        return this.backendType === 'livekit';
    }

    /**
     * Get the current streamer ID
     */
    async getCurrentStreamer() {
        return await this.webrtcService.getCurrentStreamer();
    }

    /**
     * Get audio producer for a given streamer
     * Returns null if not available (or a placeholder for LiveKit)
     */
    async getAudioProducer(streamerId) {
        if (this.isMediaSoup()) {
            const producerMap = this.webrtcService.producers.get(streamerId);
            return producerMap?.get('audio') || null;
        } else if (this.isLiveKit()) {
            // For LiveKit, query the room directly since viewbots publish via WHIP
            // not through the produce() API
            try {
                const config = require('../config/webrtc.config').livekit;
                const { RoomServiceClient } = require('livekit-server-sdk');

                const host = config.host.startsWith('http')
                    ? config.host
                    : `http://${config.host}`;

                const roomClient = new RoomServiceClient(
                    host,
                    config.apiKey,
                    config.apiSecret
                );

                const participants = await roomClient.listParticipants(config.roomName);
                const TRACK_TYPE_AUDIO = 0;

                console.log(`🔍 TranscriptionAudioAdapter: Looking for audio for streamer: ${streamerId}`);
                console.log(`   Found ${participants.length} participants in LiveKit room`);

                // In LiveKit mode, streamerId might be a socket ID that doesn't match participant identity
                // Try to find by identity first, then fall back to any participant with audio
                let participant = participants.find(p => p.identity === streamerId);

                if (!participant) {
                    console.log(`   Streamer ID ${streamerId} not found, searching for any participant with audio...`);
                    // Find any participant with audio tracks
                    participant = participants.find(p =>
                        p.tracks && p.tracks.some(t => t.type === TRACK_TYPE_AUDIO)
                    );

                    if (participant) {
                        console.log(`   Using participant ${participant.identity} with audio`);
                    }
                }

                if (participant && participant.tracks) {
                    const audioTrack = participant.tracks.find(t => t.type === TRACK_TYPE_AUDIO);
                    if (audioTrack) {
                        console.log(`✅ Found audio track ${audioTrack.sid} from ${participant.identity}`);
                        // Return a MediaSoup-compatible producer object
                        return {
                            id: audioTrack.sid,
                            kind: 'audio',
                            participantSid: participant.sid,
                            participantIdentity: participant.identity,
                            livekit: true
                        };
                    }
                } else {
                    console.log(`   No participants with audio tracks found`);
                }
            } catch (error) {
                console.error('❌ TranscriptionAudioAdapter: Failed to query LiveKit participants:', error.message);
            }
            return null;
        }
        return null;
    }

    /**
     * Create audio transport and consumer for transcription
     * Returns transport, consumer, and audio capture info
     */
    async createAudioCapture(sessionId, streamerId) {
        if (this.isMediaSoup()) {
            return await this.createMediaSoupAudioCapture(sessionId, streamerId);
        } else if (this.isLiveKit()) {
            return await this.createLiveKitAudioCapture(sessionId, streamerId);
        }
        throw new Error(`Unsupported backend: ${this.backendType}`);
    }

    /**
     * MediaSoup audio capture implementation
     */
    async createMediaSoupAudioCapture(sessionId, streamerId) {
        console.log(`📡 TranscriptionAudioAdapter: Creating MediaSoup audio capture for ${streamerId}`);

        // Get the audio producer
        const producerMap = this.webrtcService.producers.get(streamerId);
        const audioProducer = producerMap?.get('audio');

        if (!audioProducer) {
            return { success: false, error: 'No audio producer available' };
        }

        // Create MediaSoup plain transport
        const router = this.webrtcService.router;
        if (!router) {
            return { success: false, error: 'MediaSoup router not available' };
        }

        // Choose dynamic port for FFmpeg
        const ffmpegRtpPort = 5004 + Math.floor(Math.random() * 100) * 2;
        const ffmpegRtcpPort = ffmpegRtpPort + 1;

        const transport = await router.createPlainTransport({
            listenIp: {
                ip: '0.0.0.0',
                announcedIp: '127.0.0.1'
            },
            rtcpMux: false,
            comedia: false
        });

        await transport.connect({
            ip: '127.0.0.1',
            port: ffmpegRtpPort,
            rtcpPort: ffmpegRtcpPort
        });

        // Create audio consumer
        const rtpCapabilities = {
            codecs: [{
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
                parameters: {},
                rtcpFeedback: [{ type: 'transport-cc' }]
            }],
            headerExtensions: []
        };

        const consumer = await transport.consume({
            producerId: audioProducer.id,
            rtpCapabilities: rtpCapabilities,
            paused: true
        });

        return {
            success: true,
            transport,
            consumer,
            ffmpegRtpPort,
            ffmpegRtcpPort,
            captureType: 'mediasoup-rtp'
        };
    }

    /**
     * LiveKit audio capture implementation via RTC client SDK subscription
     */
    async createLiveKitAudioCapture(sessionId, streamerId) {
        console.log(`📡 TranscriptionAudioAdapter: Creating LiveKit audio capture for ${streamerId}`);

        try {
            const config = require('../config/webrtc.config').livekit;

            // Ensure host has protocol
            const host = config.host.startsWith('http')
                ? config.host
                : `http://${config.host}`;

            // Use configured WebSocket URL or construct from host
            const wsUrl = config.wsUrl || (config.host.startsWith('ws')
                ? config.host
                : `ws://${config.host.replace(/^https?:\/\//, '')}`);

            // Query participants to find the audio track
            const roomClient = new RoomServiceClient(
                host,
                config.apiKey,
                config.apiSecret
            );

            console.log(`🔍 Querying LiveKit participants in room: ${config.roomName}`);

            const participants = await roomClient.listParticipants(config.roomName);
            console.log(`📋 Found ${participants.length} participant(s)`);

            // Find participant with audio track
            const TRACK_TYPE_AUDIO = 0;
            let audioParticipant = null;
            let audioTrack = null;

            for (const participant of participants) {
                if (participant.tracks && participant.tracks.length > 0) {
                    const track = participant.tracks.find(t => t.type === TRACK_TYPE_AUDIO);
                    if (track) {
                        audioParticipant = participant;
                        audioTrack = track;
                        console.log(`✅ Found audio track ${track.sid} from participant ${participant.identity}`);
                        break;
                    }
                }
            }

            if (!audioParticipant || !audioTrack) {
                return {
                    success: false,
                    error: 'No participant with audio track found in room'
                };
            }

            // Create access token for transcription bot to join room
            const at = new AccessToken(config.apiKey, config.apiSecret, {
                identity: `transcription-bot-${sessionId}`,
                ttl: '10m'
            });
            at.addGrant({
                roomJoin: true,
                room: config.roomName,
                canSubscribe: true,
                canPublish: false
            });
            const token = await at.toJwt();

            return {
                success: true,
                captureType: 'livekit-rtc',
                wsUrl: wsUrl,
                token: token,
                roomName: config.roomName,
                participantIdentity: audioParticipant.identity,
                participantSid: audioParticipant.sid,
                trackSid: audioTrack.sid,
                // Compatibility placeholders
                transport: { id: 'rtc-transport', closed: false },
                consumer: { id: 'rtc-consumer', paused: false }
            };

        } catch (error) {
            console.error('❌ LiveKit audio capture failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Start audio buffering with FFmpeg
     */
    async startAudioBuffering(session, captureInfo, audioBufferService) {
        if (captureInfo.captureType === 'mediasoup-rtp') {
            // Use existing AudioBufferService for MediaSoup
            return await audioBufferService.startBuffering(
                session.id,
                captureInfo.transport,
                captureInfo.consumer,
                captureInfo.ffmpegRtpPort,
                captureInfo.ffmpegRtcpPort
            );
        } else if (captureInfo.captureType === 'livekit-rtc') {
            // Use RTC client SDK for LiveKit
            return await this.startLiveKitRTCCapture(session, captureInfo, audioBufferService);
        }
        throw new Error(`Unsupported capture type: ${captureInfo.captureType}`);
    }

    /**
     * Start LiveKit RTC audio capture using client SDK
     */
    async startLiveKitRTCCapture(session, captureInfo, audioBufferService) {
        console.log(`🎵 TranscriptionAudioAdapter: Starting RTC audio capture for session ${session.id}`);

        const bufferDir = path.join(__dirname, '..', '..', 'audio-buffers');
        const bufferFile = path.join(bufferDir, `${session.id}.wav`);

        // Ensure directory exists
        if (!fs.existsSync(bufferDir)) {
            fs.mkdirSync(bufferDir, { recursive: true });
        }

        try {
            // Connect to LiveKit room
            const room = new Room();

            console.log(`🔗 Connecting to LiveKit room: ${captureInfo.roomName}`);
            console.log(`🔗 Using wsUrl: ${captureInfo.wsUrl}`);
            await room.connect(captureInfo.wsUrl, captureInfo.token, {
                autoSubscribe: true
            });
            console.log(`✅ Connected to room`);

            // Save to PCM file first (will convert to WAV later with proper header)
            const pcmFile = bufferFile.replace('.wav', '.pcm');
            const pcmStream = fs.createWriteStream(pcmFile);

            let sampleRate = 48000;  // Default, will be updated from first frame
            let frameCount = 0;

            // Wait for track to be subscribed and start capturing
            const capturePromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timeout waiting for track subscription'));
                }, 10000);

                room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
                    console.log(`📡 Track subscribed: ${track.sid} from ${participant.identity}`);

                    if (track.kind === TrackKind.KIND_AUDIO) {
                        console.log(`🎧 Audio track subscribed, starting capture...`);
                        clearTimeout(timeout);

                        try {
                            // Create AudioStream to receive frames
                            const stream = new AudioStream(track);
                            session.audioStreamReader = stream;

                            console.log(`📥 Reading audio frames...`);

                            // Read frames asynchronously in background
                            // Track if we should stop writing (to prevent write-after-end errors)
                            let stopWriting = false;
                            session.stopAudioCapture = () => { stopWriting = true; };

                            (async () => {
                                try {
                                    for await (const frame of stream) {
                                        // Check if we should stop writing (stream may be closing)
                                        if (stopWriting || pcmStream.closed || pcmStream.destroyed) {
                                            console.log(`   ⏹️ Audio capture stopped (stopWriting: ${stopWriting}, closed: ${pcmStream.closed})`);
                                            break;
                                        }

                                        // Update sample rate from first frame
                                        if (frameCount === 0) {
                                            sampleRate = frame.sampleRate;
                                            console.log(`   Sample rate: ${sampleRate} Hz`);
                                        }

                                        // frame.data is Int16Array with PCM samples
                                        // Properly convert Int16Array to Buffer
                                        const pcmData = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);

                                        // Safely write with error handling to prevent crashes
                                        try {
                                            if (!pcmStream.closed && !pcmStream.destroyed && pcmStream.writable) {
                                                pcmStream.write(pcmData);
                                            }
                                        } catch (writeError) {
                                            console.warn(`   ⚠️ Write error (stream likely closed): ${writeError.message}`);
                                            break;
                                        }
                                        frameCount++;

                                        // Check for non-zero audio on first few frames
                                        if (frameCount <= 10) {
                                            const hasAudio = frame.data.some(sample => Math.abs(sample) > 100);
                                            console.log(`   🔊 Frame ${frameCount}: ${frame.data.length} samples, hasAudio: ${hasAudio}, max: ${Math.max(...frame.data.map(Math.abs))}`);
                                        }

                                        // Log progress
                                        if (frameCount % 100 === 0) {
                                            const duration = (frameCount * frame.samplesPerChannel) / frame.sampleRate;
                                            console.log(`   📊 Captured ${duration.toFixed(1)}s (${frameCount} frames)`);
                                        }
                                    }
                                } catch (error) {
                                    console.error(`❌ Error reading audio frames:`, error.message);
                                } finally {
                                    pcmStream.end();
                                }
                            })();

                            resolve({ sampleRate, pcmFile, pcmStream });
                        } catch (error) {
                            reject(error);
                        }
                    }
                });
            });

            const { pcmFile: pcmPath, pcmStream: stream } = await capturePromise;

            // Store room info in session
            session.livekitRoom = room;
            session.pcmFile = pcmPath;
            session.pcmStream = stream;
            session.sampleRate = sampleRate;
            session.bufferFile = bufferFile;

            console.log(`✅ TranscriptionAudioAdapter: RTC audio capture started`);
            console.log(`   PCM file: ${pcmPath}`);
            console.log(`   Sample rate: ${sampleRate} Hz`);

            return {
                success: true,
                bufferFile: bufferFile,
                room: room
            };

        } catch (error) {
            console.error(`❌ Failed to start RTC audio capture:`, error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Create a WAV file header for raw PCM data
     */
    createWAVHeader(sampleRate, numChannels, bitsPerSample, dataSize) {
        const header = Buffer.alloc(44);
        const byteRate = sampleRate * numChannels * bitsPerSample / 8;
        const blockAlign = numChannels * bitsPerSample / 8;

        // "RIFF" chunk descriptor
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataSize, 4);  // File size - 8
        header.write('WAVE', 8);

        // "fmt " sub-chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);  // Subchunk size
        header.writeUInt16LE(1, 20);   // Audio format (1 = PCM)
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);  // Byte rate
        header.writeUInt16LE(blockAlign, 32);  // Block align
        header.writeUInt16LE(bitsPerSample, 34);

        // "data" sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(dataSize, 40);  // Data size

        return header;
    }

    /**
     * Finalize LiveKit RTC capture by converting PCM to WAV
     */
    async finalizeLiveKitCapture(session) {
        if (!session.pcmFile || !session.bufferFile) {
            console.log(`⚠️ No PCM file to finalize for session ${session.id}`);
            return;
        }

        try {
            // CRITICAL: Signal audio capture to stop BEFORE ending stream
            if (session.stopAudioCapture) {
                session.stopAudioCapture();
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            // Wait for PCM stream to finish writing
            if (session.pcmStream && !session.pcmStream.closed && !session.pcmStream.destroyed) {
                await new Promise(resolve => {
                    session.pcmStream.on('finish', resolve);
                    session.pcmStream.on('error', (err) => {
                        console.warn(`   ⚠️ PCM stream error during finalize: ${err.message}`);
                        resolve();
                    });
                    try {
                        session.pcmStream.end();
                    } catch (endError) {
                        console.warn(`   ⚠️ Error ending PCM stream: ${endError.message}`);
                        resolve();
                    }
                });
            }

            // Small delay to ensure file is fully written
            await new Promise(resolve => setTimeout(resolve, 100));

            // Read PCM data
            if (!fs.existsSync(session.pcmFile)) {
                console.error(`❌ PCM file not found: ${session.pcmFile}`);
                return;
            }

            const pcmData = fs.readFileSync(session.pcmFile);
            const sampleRate = session.sampleRate || 48000;

            console.log(`📝 Finalizing WAV file...`);
            console.log(`   PCM data: ${pcmData.length} bytes`);
            console.log(`   Sample rate: ${sampleRate} Hz`);

            // Create WAV file with proper header
            const wavHeader = this.createWAVHeader(sampleRate, 1, 16, pcmData.length);
            const wavData = Buffer.concat([wavHeader, pcmData]);

            fs.writeFileSync(session.bufferFile, wavData);
            console.log(`✅ WAV file created: ${session.bufferFile} (${wavData.length} bytes)`);

            // Clean up PCM file
            fs.unlinkSync(session.pcmFile);

            // Mark as finalized to prevent double finalization
            session.pcmFile = null;

        } catch (error) {
            console.error(`❌ Error finalizing WAV file:`, error.message);
        }
    }

    /**
     * Fallback method - Subscribe with headless Chrome + FFmpeg
     */
    async fallbackFFmpegCapture(session, captureInfo, bufferFile) {
        console.log(`🔄 TranscriptionAudioAdapter: Using Puppeteer + FFmpeg fallback`);

        try {
            // Use Puppeteer to subscribe to LiveKit audio in headless browser
            // Then capture system audio with FFmpeg
            const puppeteer = require('puppeteer');

            console.log(`🌐 Launching headless browser to subscribe to LiveKit audio...`);

            const browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--use-fake-ui-for-media-stream',
                    '--use-fake-device-for-media-stream',
                    '--autoplay-policy=no-user-gesture-required'
                ]
            });

            const page = await browser.newPage();

            // Create a simple HTML page that connects to LiveKit
            const html = `
<!DOCTYPE html>
<html>
<head>
    <script src="https://unpkg.com/livekit-client/dist/livekit-client.umd.min.js"></script>
</head>
<body>
    <audio id="audio" autoplay></audio>
    <script>
        const connect = async () => {
            const room = new LivekitClient.Room();

            room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
                if (track.kind === 'audio') {
                    const audioElement = document.getElementById('audio');
                    track.attach(audioElement);
                    console.log('Audio track attached');
                }
            });

            await room.connect('${captureInfo.wsUrl}', '${captureInfo.token}');
            console.log('Connected to LiveKit room');
        };

        connect().catch(console.error);
    </script>
</body>
</html>
            `;

            await page.setContent(html);
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Close browser and use simpler approach
            await browser.close();

            console.log(`⚠️ Browser-based capture complex, using silent placeholder`);
            return this.createSilentPlaceholder(session, bufferFile);

        } catch (error) {
            console.error(`❌ Puppeteer fallback failed:`, error);
            return this.createSilentPlaceholder(session, bufferFile);
        }
    }

    /**
     * Create silent audio file as placeholder
     */
    async createSilentPlaceholder(session, bufferFile) {
        console.log(`🔇 Creating silent audio placeholder`);

        try {
            // Generate 20 seconds of silence at 16kHz mono
            const ffmpegArgs = [
                '-f', 'lavfi',
                '-i', 'anullsrc=r=16000:cl=mono',
                '-t', '20',
                '-f', 'wav',
                '-y',
                bufferFile
            ];

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

            ffmpegProcess.on('close', () => {
                console.log(`✅ Silent placeholder created (transcription will show no words)`);
            });

            session.audioProcess = ffmpegProcess;
            session.bufferFile = bufferFile;

            return {
                success: true,
                bufferFile: bufferFile,
                isSilent: true
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Cleanup resources
     */
    async cleanup(session) {
        console.log(`🧹 TranscriptionAudioAdapter: Cleaning up session ${session.id}`);

        // CRITICAL: Signal audio capture to stop BEFORE finalizing
        // This prevents ERR_STREAM_WRITE_AFTER_END crashes
        if (session.stopAudioCapture) {
            console.log(`   ⏹️ Signaling audio capture to stop...`);
            session.stopAudioCapture();
            // Brief delay to allow current write to complete
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // Finalize LiveKit RTC capture (convert PCM to WAV)
        if (session.pcmFile) {
            await this.finalizeLiveKitCapture(session);
        }

        // Stop any audio capture processes (FFmpeg for MediaSoup RTP)
        if (session.audioProcess) {
            try {
                session.audioProcess.kill('SIGTERM');
                console.log(`   ✅ Stopped audio capture process`);
            } catch (error) {
                console.error(`   ⚠️ Error stopping audio process:`, error.message);
            }
        }

        // Close MediaSoup transport and consumer (if present)
        if (session.transport && !session.transport.closed) {
            if (typeof session.transport.close === 'function') {
                try {
                    session.transport.close();
                    console.log(`   ✅ Closed transport`);
                } catch (error) {
                    console.error(`   ⚠️ Error closing transport:`, error.message);
                }
            }
        }

        if (session.consumer && !session.consumer.closed) {
            if (typeof session.consumer.close === 'function') {
                try {
                    session.consumer.close();
                    console.log(`   ✅ Closed consumer`);
                } catch (error) {
                    console.error(`   ⚠️ Error closing consumer:`, error.message);
                }
            }
        }

        // Signal audio capture to stop BEFORE disconnecting from LiveKit
        // This prevents race conditions with the frame reading loop
        if (session.stopAudioCapture) {
            session.stopAudioCapture();
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // Close LiveKit room (if present)
        if (session.livekitRoom) {
            try {
                await session.livekitRoom.disconnect();
                console.log(`   ✅ Disconnected from LiveKit room`);
            } catch (error) {
                console.error(`   ⚠️ Error disconnecting from room:`, error.message);
            }
        }

        // Close PCM stream (if present)
        if (session.pcmStream) {
            try {
                if (!session.pcmStream.closed && !session.pcmStream.destroyed) {
                    session.pcmStream.end();
                }
                console.log(`   ✅ Closed PCM stream`);
            } catch (error) {
                console.error(`   ⚠️ Error closing PCM stream:`, error.message);
            }
        }
    }
}

module.exports = TranscriptionAudioAdapter;
