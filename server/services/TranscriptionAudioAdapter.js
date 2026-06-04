/**
 * Transcription Audio Adapter
 * Provides a unified interface for capturing audio for transcription.
 * LiveKit is the sole backend (ADR-0024).
 */

const fs = require('fs');
const path = require('path');
const { RoomServiceClient, IngressClient, AccessToken } = require('livekit-server-sdk');
const { Room, RoomEvent, TrackKind, AudioStream } = require('@livekit/rtc-node');

const logger = require('../bootstrap/logger').child({ svc: 'TranscriptionAudioAdapter' });

class TranscriptionAudioAdapter {
    constructor(webrtcService) {
        this.webrtcService = webrtcService;
        this.backendType = this.detectBackend();
        logger.debug(`🎙️ TranscriptionAudioAdapter: Initialized with ${this.backendType.toUpperCase()} backend`);
    }

    detectBackend() {
        // LiveKit is the sole backend (ADR-0024). The service may expose
        // getBackendType (the LiveKit backend shim); honor it, otherwise
        // assume LiveKit.
        if (typeof this.webrtcService.getBackendType === 'function') {
            return this.webrtcService.getBackendType();
        }
        return 'livekit';
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

            logger.debug(`🔍 TranscriptionAudioAdapter: Looking for audio for streamer: ${streamerId}`);
            logger.debug(`   Found ${participants.length} participants in LiveKit room`);

            // In LiveKit mode, streamerId might be a socket ID that doesn't match participant identity
            // Try to find by identity first, then fall back to any participant with audio
            let participant = participants.find(p => p.identity === streamerId);

            if (!participant) {
                logger.debug(`   Streamer ID ${streamerId} not found, searching for any participant with audio...`);
                // Find any participant with audio tracks
                participant = participants.find(p =>
                    p.tracks && p.tracks.some(t => t.type === TRACK_TYPE_AUDIO)
                );

                if (participant) {
                    logger.debug(`   Using participant ${participant.identity} with audio`);
                }
            }

            if (participant && participant.tracks) {
                const audioTrack = participant.tracks.find(t => t.type === TRACK_TYPE_AUDIO);
                if (audioTrack) {
                    logger.debug(`✅ Found audio track ${audioTrack.sid} from ${participant.identity}`);
                    // Return a producer-shaped object the transcription path expects
                    return {
                        id: audioTrack.sid,
                        kind: 'audio',
                        participantSid: participant.sid,
                        participantIdentity: participant.identity,
                        livekit: true
                    };
                }
            } else {
                logger.debug(`   No participants with audio tracks found`);
            }
        } catch (error) {
            logger.error('❌ TranscriptionAudioAdapter: Failed to query LiveKit participants:', error.message);
        }
        return null;
    }

    /**
     * Create audio transport and consumer for transcription
     * Returns transport, consumer, and audio capture info
     */
    async createAudioCapture(sessionId, streamerId) {
        return await this.createLiveKitAudioCapture(sessionId, streamerId);
    }

    /**
     * LiveKit audio capture implementation via RTC client SDK subscription
     */
    async createLiveKitAudioCapture(sessionId, streamerId) {
        logger.debug(`📡 TranscriptionAudioAdapter: Creating LiveKit audio capture for ${streamerId}`);

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

            logger.debug(`🔍 Querying LiveKit participants in room: ${config.roomName}`);

            const participants = await roomClient.listParticipants(config.roomName);
            logger.debug(`📋 Found ${participants.length} participant(s)`);

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
                        logger.debug(`✅ Found audio track ${track.sid} from participant ${participant.identity}`);
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
            logger.error('❌ LiveKit audio capture failed:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Start audio buffering with FFmpeg
     */
    async startAudioBuffering(session, captureInfo, audioBufferService) {
        if (captureInfo.captureType === 'livekit-rtc') {
            // Use RTC client SDK for LiveKit
            return await this.startLiveKitRTCCapture(session, captureInfo, audioBufferService);
        }
        throw new Error(`Unsupported capture type: ${captureInfo.captureType}`);
    }

    /**
     * Start LiveKit RTC audio capture using client SDK
     */
    async startLiveKitRTCCapture(session, captureInfo, audioBufferService) {
        logger.debug(`🎵 TranscriptionAudioAdapter: Starting RTC audio capture for session ${session.id}`);

        const bufferDir = path.join(__dirname, '..', '..', 'audio-buffers');
        const bufferFile = path.join(bufferDir, `${session.id}.wav`);

        // Ensure directory exists
        if (!fs.existsSync(bufferDir)) {
            fs.mkdirSync(bufferDir, { recursive: true });
        }

        try {
            // Connect to LiveKit room
            const room = new Room();

            logger.debug(`🔗 Connecting to LiveKit room: ${captureInfo.roomName}`);
            logger.debug(`🔗 Using wsUrl: ${captureInfo.wsUrl}`);
            await room.connect(captureInfo.wsUrl, captureInfo.token, {
                autoSubscribe: true
            });
            logger.debug(`✅ Connected to room`);

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
                    logger.debug(`📡 Track subscribed: ${track.sid} from ${participant.identity}`);

                    if (track.kind === TrackKind.KIND_AUDIO) {
                        logger.debug(`🎧 Audio track subscribed, starting capture...`);
                        clearTimeout(timeout);

                        try {
                            // Create AudioStream to receive frames
                            // Whisper requires 16 kHz mono. @livekit/rtc-node's
                            // AudioStream yields the track's native rate (48 kHz for
                            // Opus) unless told otherwise, and whisper.cpp rejects
                            // non-16 kHz input ("WAV must be 16 kHz" -> no output, so
                            // the transcription-driven bots go silent). Resample at the
                            // source so the captured buffer is whisper-ready.
                            const stream = new AudioStream(track, { sampleRate: 16000, numChannels: 1 });
                            session.audioStreamReader = stream;

                            logger.debug(`📥 Reading audio frames...`);

                            // Read frames asynchronously in background
                            // Track if we should stop writing (to prevent write-after-end errors)
                            let stopWriting = false;
                            session.stopAudioCapture = () => { stopWriting = true; };

                            (async () => {
                                try {
                                    for await (const frame of stream) {
                                        // Check if we should stop writing (stream may be closing)
                                        if (stopWriting || pcmStream.closed || pcmStream.destroyed) {
                                            logger.debug(`   ⏹️ Audio capture stopped (stopWriting: ${stopWriting}, closed: ${pcmStream.closed})`);
                                            break;
                                        }

                                        // Update sample rate from first frame
                                        if (frameCount === 0) {
                                            sampleRate = frame.sampleRate;
                                            logger.debug(`   Sample rate: ${sampleRate} Hz`);
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
                                            logger.warn(`   ⚠️ Write error (stream likely closed): ${writeError.message}`);
                                            break;
                                        }
                                        frameCount++;

                                        // Check for non-zero audio on first few frames
                                        if (frameCount <= 10) {
                                            const hasAudio = frame.data.some(sample => Math.abs(sample) > 100);
                                            logger.debug(`   🔊 Frame ${frameCount}: ${frame.data.length} samples, hasAudio: ${hasAudio}, max: ${Math.max(...frame.data.map(Math.abs))}`);
                                        }

                                        // Log progress
                                        if (frameCount % 100 === 0) {
                                            const duration = (frameCount * frame.samplesPerChannel) / frame.sampleRate;
                                            logger.debug(`   📊 Captured ${duration.toFixed(1)}s (${frameCount} frames)`);
                                        }
                                    }
                                } catch (error) {
                                    logger.error(`❌ Error reading audio frames:`, error.message);
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

            logger.debug(`✅ TranscriptionAudioAdapter: RTC audio capture started`);
            logger.debug(`   PCM file: ${pcmPath}`);
            logger.debug(`   Sample rate: ${sampleRate} Hz`);

            return {
                success: true,
                bufferFile: bufferFile,
                room: room
            };

        } catch (error) {
            logger.error(`❌ Failed to start RTC audio capture:`, error);
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
            logger.debug(`⚠️ No PCM file to finalize for session ${session.id}`);
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
                        logger.warn(`   ⚠️ PCM stream error during finalize: ${err.message}`);
                        resolve();
                    });
                    try {
                        session.pcmStream.end();
                    } catch (endError) {
                        logger.warn(`   ⚠️ Error ending PCM stream: ${endError.message}`);
                        resolve();
                    }
                });
            }

            // Small delay to ensure file is fully written
            await new Promise(resolve => setTimeout(resolve, 100));

            // Read PCM data
            if (!fs.existsSync(session.pcmFile)) {
                logger.error(`❌ PCM file not found: ${session.pcmFile}`);
                return;
            }

            const pcmData = fs.readFileSync(session.pcmFile);
            // The AudioStream is created with { sampleRate: 16000 } (whisper's required
            // rate), so the captured PCM is always 16 kHz mono. session.sampleRate can
            // still hold the 48 kHz default (it races the first frame), which would
            // mislabel the WAV header and make whisper reject it ("must be 16 kHz" ->
            // no output -> silent bots). Pin the header to the actual capture rate.
            const sampleRate = 16000;

            logger.debug(`📝 Finalizing WAV file...`);
            logger.debug(`   PCM data: ${pcmData.length} bytes`);
            logger.debug(`   Sample rate: ${sampleRate} Hz`);

            // Create WAV file with proper header
            const wavHeader = this.createWAVHeader(sampleRate, 1, 16, pcmData.length);
            const wavData = Buffer.concat([wavHeader, pcmData]);

            fs.writeFileSync(session.bufferFile, wavData);
            logger.debug(`✅ WAV file created: ${session.bufferFile} (${wavData.length} bytes)`);

            // Clean up PCM file
            fs.unlinkSync(session.pcmFile);

            // Mark as finalized to prevent double finalization
            session.pcmFile = null;

        } catch (error) {
            logger.error(`❌ Error finalizing WAV file:`, error.message);
        }
    }

    /**
     * Cleanup resources
     */
    async cleanup(session) {
        logger.debug(`🧹 TranscriptionAudioAdapter: Cleaning up session ${session.id}`);

        // CRITICAL: Signal audio capture to stop BEFORE finalizing
        // This prevents ERR_STREAM_WRITE_AFTER_END crashes
        if (session.stopAudioCapture) {
            logger.debug(`   ⏹️ Signaling audio capture to stop...`);
            session.stopAudioCapture();
            // Brief delay to allow current write to complete
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // Finalize LiveKit RTC capture (convert PCM to WAV)
        if (session.pcmFile) {
            await this.finalizeLiveKitCapture(session);
        }

        // Close transport and consumer if they expose a close() (the LiveKit
        // capture path stores inert placeholders that don't, so this no-ops).
        if (session.transport && !session.transport.closed) {
            if (typeof session.transport.close === 'function') {
                try {
                    session.transport.close();
                    logger.debug(`   ✅ Closed transport`);
                } catch (error) {
                    logger.error(`   ⚠️ Error closing transport:`, error.message);
                }
            }
        }

        if (session.consumer && !session.consumer.closed) {
            if (typeof session.consumer.close === 'function') {
                try {
                    session.consumer.close();
                    logger.debug(`   ✅ Closed consumer`);
                } catch (error) {
                    logger.error(`   ⚠️ Error closing consumer:`, error.message);
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
                logger.debug(`   ✅ Disconnected from LiveKit room`);
            } catch (error) {
                logger.error(`   ⚠️ Error disconnecting from room:`, error.message);
            }
        }

        // Close PCM stream (if present)
        if (session.pcmStream) {
            try {
                if (!session.pcmStream.closed && !session.pcmStream.destroyed) {
                    session.pcmStream.end();
                }
                logger.debug(`   ✅ Closed PCM stream`);
            } catch (error) {
                logger.error(`   ⚠️ Error closing PCM stream:`, error.message);
            }
        }
    }
}

module.exports = TranscriptionAudioAdapter;
