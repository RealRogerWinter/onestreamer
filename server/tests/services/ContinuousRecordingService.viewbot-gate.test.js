/**
 * Auto-record viewbot gate — checkAndAutoRecord must only START a recording
 * for a real (human) streamer. Viewbot/url-relay publishers used to trigger a
 * 24/7 room-composite egress (headless Chrome + encoder, ~0.8 CPU cores)
 * recording re-broadcast content; that auto-start path is now skipped.
 * Manual recordings (admin-recordings-ext → startRecording()) are unaffected
 * — this only gates the poll.
 *
 * Pattern reused from ContinuousRecordingService.cleanup-race.test.js: mock
 * the DB module before require, real service instance, collaborators stubbed
 * directly on the instance.
 */

jest.mock('../../database/database', () => ({
  getAsync: jest.fn().mockResolvedValue(undefined),
  runAsync: jest.fn().mockResolvedValue(undefined),
  allAsync: jest.fn().mockResolvedValue([]),
}));

const ContinuousRecordingService = require('../../services/ContinuousRecordingService');

function makeService({ participants, realStreamer }) {
  const service = new ContinuousRecordingService({
    apiKey: 'k',
    apiSecret: 's',
    outputDir: '/tmp/egress-test-noop',
  });
  service.roomServiceClient = {
    listParticipants: jest.fn().mockResolvedValue(participants),
  };
  service.inspector = {
    findRealStreamer: jest.fn().mockResolvedValue(realStreamer),
  };
  service.sessionStore = {
    trackStreamIdentityChange: jest.fn().mockResolvedValue(undefined),
  };
  service.startRecording = jest.fn().mockResolvedValue(undefined);
  service.stopRecording = jest.fn().mockResolvedValue(undefined);
  return service;
}

const publishingParticipant = (identity) => ({
  identity,
  tracks: [{ type: 1, muted: false }], // type 1 = VIDEO
});

describe('ContinuousRecordingService.checkAndAutoRecord viewbot gate', () => {
  test('viewbot-only publisher does NOT start a recording', async () => {
    const service = makeService({
      participants: [publishingParticipant('url-stream-123-1')],
      realStreamer: null,
    });
    await service.checkAndAutoRecord();
    expect(service.startRecording).not.toHaveBeenCalled();
  });

  test('real streamer still starts a participant recording', async () => {
    const service = makeService({
      participants: [publishingParticipant('human-abc')],
      realStreamer: 'human-abc',
    });
    await service.checkAndAutoRecord();
    expect(service.startRecording).toHaveBeenCalledWith('human-abc');
  });

  test('an in-flight recording still stops when its real streamer leaves, and does not restart for the viewbot', async () => {
    const service = makeService({
      participants: [publishingParticipant('url-stream-123-1')],
      realStreamer: null,
    });
    service.isRecording = true;
    service.currentRecordingTarget = 'human-abc'; // participant target, streamer gone
    await service.checkAndAutoRecord();
    expect(service.stopRecording).toHaveBeenCalled();
    expect(service.startRecording).not.toHaveBeenCalled();
  });

  test('viewbot skip is logged once per stretch, not per poll tick', async () => {
    const service = makeService({
      participants: [publishingParticipant('url-stream-123-1')],
      realStreamer: null,
    });
    await service.checkAndAutoRecord();
    await service.checkAndAutoRecord();
    expect(service._viewbotSkipLogged).toBe(true);
  });
});
