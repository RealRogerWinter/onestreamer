/**
 * Tests for LiveKitClient's serialized reconnect worker (audit Plan 05, C1 —
 * see ADR-0031) and the replaceAudioTrack/replaceVideoTrack fix (C2).
 *
 * livekit-client is fully mocked with a fake Room (event-emitter semantics +
 * jest.fn connect/disconnect), and the /api/livekit/token endpoint is mocked
 * via global.fetch. Timers are faked so the worker's exponential backoff can
 * be driven deterministically.
 */

import { LiveKitClient } from '../LiveKitClient';
import { Room, RoomEvent, DisconnectReason } from 'livekit-client';

jest.mock('livekit-client', () => {
  class FakeRoom {
    static instances: any[] = [];

    handlers: Record<string, Array<(...args: any[]) => void>> = {};
    state = 'disconnected';
    localParticipant = {
      trackPublications: new Map(),
      publishTrack: jest.fn(),
      unpublishTrack: jest.fn(),
    };
    remoteParticipants = new Map();
    connect = jest.fn();
    disconnect = jest.fn();

    constructor() {
      FakeRoom.instances.push(this);
    }

    on(event: string, handler: (...args: any[]) => void) {
      (this.handlers[event] = this.handlers[event] || []).push(handler);
      return this;
    }

    once(event: string, handler: (...args: any[]) => void) {
      return this.on(event, handler);
    }

    off(event: string, handler: (...args: any[]) => void) {
      this.handlers[event] = (this.handlers[event] || []).filter(h => h !== handler);
      return this;
    }

    removeAllListeners() {
      this.handlers = {};
      return this;
    }

    emit(event: string, ...args: any[]) {
      (this.handlers[event] || []).slice().forEach(h => h(...args));
    }
  }

  return {
    Room: FakeRoom,
    RoomEvent: {
      Connected: 'connected',
      Disconnected: 'disconnected',
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      ParticipantConnected: 'participantConnected',
      ParticipantDisconnected: 'participantDisconnected',
      Reconnecting: 'reconnecting',
      Reconnected: 'reconnected',
      ConnectionStateChanged: 'connectionStateChanged',
      SignalConnected: 'signalConnected',
      MediaDevicesError: 'mediaDevicesError',
      ConnectionQualityChanged: 'connectionQualityChanged',
    },
    DisconnectReason: {
      UNKNOWN_REASON: 0,
      CLIENT_INITIATED: 1,
    },
    VideoPresets: {
      h180: { resolution: { width: 320, height: 180 } },
      h360: { resolution: { width: 640, height: 360 } },
      h720: { resolution: { width: 1280, height: 720 } },
    },
    VideoQuality: {},
    Track: {},
    createLocalTracks: jest.fn(),
  };
});

const FakeRoom = Room as any;

const tokenResponse = {
  token: 'fresh-token',
  url: 'ws://livekit.test',
  roomName: 'onestreamer-main',
  identity: 'sock-1',
};

/** Flush chained promise continuations (microtasks) under fake timers. */
const flush = async () => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

const makeClient = (callbacks: Partial<{
  onConnectionRecovered: () => void;
  onConnectionLost: () => void;
  onReconnectionFailed: (error: Error) => void;
}> = {}) =>
  new LiveKitClient({
    socket: { id: 'sock-1' } as any,
    serverUrl: 'http://test-server',
    ...callbacks,
  });

describe('LiveKitClient serialized reconnect worker (C1)', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    FakeRoom.instances.length = 0;
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => tokenResponse,
    });
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  const initClientAndRoom = async (callbacks = {}) => {
    const client = makeClient(callbacks);
    await client.init();
    const room = FakeRoom.instances[0];
    return { client, room };
  };

  it('survives a simulated outage: fresh token per attempt, counted attempts, recovery resets the counter', async () => {
    const onConnectionRecovered = jest.fn();
    const onConnectionLost = jest.fn();
    const { client, room } = await initClientAndRoom({ onConnectionRecovered, onConnectionLost });

    // Attempt 1: network still down — even the token refetch fails.
    // Attempt 2: token ok but room connect fails.
    // Attempt 3: fully recovered.
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    let connectCalls = 0;
    room.connect.mockImplementation(async () => {
      connectCalls++;
      if (connectCalls < 2) {
        throw new Error('sfu unreachable');
      }
      room.state = 'connected';
      room.emit('connected');
    });

    room.emit('disconnected', (DisconnectReason as any).UNKNOWN_REASON);
    expect(onConnectionLost).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled(); // worker waits out the first backoff

    // Attempt 1 after 1s backoff: token refetch fails => failed attempt.
    jest.advanceTimersByTime(1000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(room.connect).not.toHaveBeenCalled();
    expect(client.reconnectionInfo.attempts).toBe(1);

    // Attempt 2 after 2s backoff: fresh token fetched, connect fails.
    jest.advanceTimersByTime(2000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(room.connect).toHaveBeenCalledTimes(1);
    expect(room.connect).toHaveBeenCalledWith('ws://livekit.test', 'fresh-token', {
      autoSubscribe: true,
    });
    expect(client.reconnectionInfo.attempts).toBe(2);

    // Attempt 3 after 4s backoff: succeeds.
    jest.advanceTimersByTime(4000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(room.connect).toHaveBeenCalledTimes(2);
    expect(onConnectionRecovered).toHaveBeenCalled();
    expect(client.reconnectionInfo.attempts).toBe(0);

    // No further attempts scheduled.
    jest.advanceTimersByTime(600000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not start on a client-initiated disconnect (thrash guard)', async () => {
    const { room } = await initClientAndRoom();

    room.emit('disconnected', (DisconnectReason as any).CLIENT_INITIATED);

    jest.advanceTimersByTime(600000);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(room.connect).not.toHaveBeenCalled();
  });

  it('does not start for a PUBLISHER client — reconnecting without republishing would silently break the streamer', async () => {
    const { client, room } = await initClientAndRoom();
    // Mark this client as a publisher (what produce() does on success).
    (client as any).videoProducer = { id: 'v' };

    room.emit('disconnected', (DisconnectReason as any).UNKNOWN_REASON);

    jest.advanceTimersByTime(600000);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(room.connect).not.toHaveBeenCalled();
    expect(client.reconnectionInfo.attempts).toBe(0);
  });

  it('aborts when destroy() runs mid-backoff', async () => {
    const { client, room } = await initClientAndRoom();

    room.emit('disconnected', (DisconnectReason as any).UNKNOWN_REASON);
    await client.destroy();

    jest.advanceTimersByTime(600000);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(room.connect).not.toHaveBeenCalled();
  });

  it('aborts when cleanup() runs mid-backoff', async () => {
    const { client, room } = await initClientAndRoom();

    room.emit('disconnected', (DisconnectReason as any).UNKNOWN_REASON);
    await client.cleanup();

    jest.advanceTimersByTime(600000);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(room.connect).not.toHaveBeenCalled();
  });

  it('aborts when reset() supersedes the worker (epoch bump)', async () => {
    const { client, room } = await initClientAndRoom();

    room.emit('disconnected', (DisconnectReason as any).UNKNOWN_REASON);
    await client.reset();

    jest.advanceTimersByTime(600000);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(room.connect).not.toHaveBeenCalled();
  });

  it('exhausts after 8 attempts (~121s of backoff) and fires onReconnectionFailed', async () => {
    const onReconnectionFailed = jest.fn();
    const { client, room } = await initClientAndRoom({ onReconnectionFailed });

    room.connect.mockRejectedValue(new Error('still down'));
    room.emit('disconnected', (DisconnectReason as any).UNKNOWN_REASON);

    // Backoff schedule: 1s, 2s, 4s, 8s, 16s, then capped at 30s (x3) = 121s.
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    for (let i = 0; i < delays.length; i++) {
      expect(onReconnectionFailed).not.toHaveBeenCalled();
      jest.advanceTimersByTime(delays[i]);
      await flush();
      expect(client.reconnectionInfo.attempts).toBe(i + 1);
    }

    expect(room.connect).toHaveBeenCalledTimes(8);
    expect(onReconnectionFailed).toHaveBeenCalledTimes(1);
    expect(onReconnectionFailed.mock.calls[0][0]).toBeInstanceOf(Error);

    // Worker is done — no further attempts.
    jest.advanceTimersByTime(600000);
    await flush();
    expect(room.connect).toHaveBeenCalledTimes(8);
  });

  it('is single-flight: a second Disconnected while the worker runs does not spawn a second loop', async () => {
    const { room } = await initClientAndRoom();

    room.connect.mockRejectedValue(new Error('still down'));
    room.emit('disconnected', (DisconnectReason as any).UNKNOWN_REASON);
    room.emit('disconnected', (DisconnectReason as any).UNKNOWN_REASON);

    // Only one attempt after the first backoff window...
    jest.advanceTimersByTime(1000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // ...and nothing extra queued inside the second backoff window.
    jest.advanceTimersByTime(1999);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('LiveKitClient.replaceAudioTrack / replaceVideoTrack (C2)', () => {
  beforeEach(() => {
    FakeRoom.instances.length = 0;
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    delete (global as any).fetch;
  });

  const initClientAndRoom = async () => {
    const client = makeClient();
    await client.init();
    const room = FakeRoom.instances[0];
    return { client, room };
  };

  it('awaits localAudioTrack.replaceTrack and keeps the same LocalTrack/producer refs', async () => {
    const { client, room } = await initClientAndRoom();
    const localAudio = { replaceTrack: jest.fn().mockResolvedValue(undefined) };
    (client as any).localAudioTrack = localAudio;
    (client as any).audioProducer = localAudio;

    const newTrack = { kind: 'audio' } as any;
    await client.replaceAudioTrack(newTrack);

    expect(localAudio.replaceTrack).toHaveBeenCalledWith(newTrack);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    // The refs must still point at the real LocalTrack — never a Promise.
    expect((client as any).localAudioTrack).toBe(localAudio);
    expect((client as any).audioProducer).toBe(localAudio);
  });

  it('awaits localVideoTrack.replaceTrack and keeps the same LocalTrack/producer refs', async () => {
    const { client, room } = await initClientAndRoom();
    const localVideo = { replaceTrack: jest.fn().mockResolvedValue(undefined) };
    (client as any).localVideoTrack = localVideo;
    (client as any).videoProducer = localVideo;

    const newTrack = { kind: 'video' } as any;
    await client.replaceVideoTrack(newTrack);

    expect(localVideo.replaceTrack).toHaveBeenCalledWith(newTrack);
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(room.localParticipant.unpublishTrack).not.toHaveBeenCalled();
    expect((client as any).localVideoTrack).toBe(localVideo);
    expect((client as any).videoProducer).toBe(localVideo);
  });

  it('propagates a replaceTrack rejection to the caller', async () => {
    const { client } = await initClientAndRoom();
    const localAudio = { replaceTrack: jest.fn().mockRejectedValue(new Error('replace failed')) };
    (client as any).localAudioTrack = localAudio;

    await expect(client.replaceAudioTrack({ kind: 'audio' } as any)).rejects.toThrow('replace failed');
  });

  it('publishes and adopts publication.track when no local audio track exists yet', async () => {
    const { client, room } = await initClientAndRoom();
    const publishedTrack = { kind: 'audio', mediaStreamTrack: {} };
    room.localParticipant.publishTrack.mockResolvedValue({ track: publishedTrack });

    const newTrack = { kind: 'audio' } as any;
    await client.replaceAudioTrack(newTrack);

    expect(room.localParticipant.publishTrack).toHaveBeenCalledWith(newTrack);
    expect((client as any).localAudioTrack).toBe(publishedTrack);
    expect((client as any).audioProducer).toBe(publishedTrack);
  });

  it('propagates a publishTrack rejection in the no-local-track fallback', async () => {
    const { client, room } = await initClientAndRoom();
    room.localParticipant.publishTrack.mockRejectedValue(new Error('publish failed'));

    await expect(client.replaceVideoTrack({ kind: 'video' } as any)).rejects.toThrow('publish failed');
    expect((client as any).localVideoTrack).toBeNull();
  });
});
