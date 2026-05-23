const express = require('express');
const request = require('supertest');

const audioRouter = require('../../routes/audio');

function buildMockService(overrides = {}) {
  return {
    config: { opus: { maxaveragebitrate: 96000 } },
    stats: {
      globalStats: {
        activeStreams: 3,
        averageQuality: 0.87,
      },
    },
    getOptimizedConstraints: jest.fn().mockReturnValue({
      audio: { sampleRate: 48000 },
    }),
    getOptimizedRtpParameters: jest.fn().mockReturnValue({
      codecs: [{ mimeType: 'audio/opus' }],
    }),
    monitorSession: jest.fn().mockReturnValue({
      sessionId: 'sess-1',
      producerId: 'prod-1',
      startedAt: 123,
    }),
    updateSessionStats: jest.fn(),
    getSessionReport: jest.fn(),
    ...overrides,
  };
}

function buildApp(service) {
  const app = express();
  app.use(express.json());
  if (service !== undefined) {
    app.locals.audioOptimizationService = service;
  }
  app.use('/api/audio', audioRouter);
  // Silence the default 500 stack trace from Express.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

describe('routes/audio', () => {
  let service;
  let app;

  beforeEach(() => {
    service = buildMockService();
    app = buildApp(service);
  });

  test('GET /optimization-settings returns shape from service', async () => {
    const res = await request(app).get('/api/audio/optimization-settings');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      constraints: { audio: { sampleRate: 48000 } },
      rtpParameters: { codecs: [{ mimeType: 'audio/opus' }] },
      config: { opus: { maxaveragebitrate: 96000 } },
    });
    expect(service.getOptimizedConstraints).toHaveBeenCalledWith('streaming');
    expect(service.getOptimizedRtpParameters).toHaveBeenCalled();
  });

  test('GET /profile/streaming returns profile + constraints', async () => {
    const res = await request(app).get('/api/audio/profile/streaming');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      profile: 'streaming',
      constraints: { audio: { sampleRate: 48000 } },
    });
    expect(service.getOptimizedConstraints).toHaveBeenCalledWith('streaming');
  });

  test('GET /profile/voice-chat returns profile + constraints for voice-chat', async () => {
    service.getOptimizedConstraints.mockReturnValueOnce({
      audio: { sampleRate: 16000 },
    });

    const res = await request(app).get('/api/audio/profile/voice-chat');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      profile: 'voice-chat',
      constraints: { audio: { sampleRate: 16000 } },
    });
    expect(service.getOptimizedConstraints).toHaveBeenCalledWith('voice-chat');
  });

  test('POST /monitor/:sessionId forwards sessionId + producerId to service', async () => {
    const res = await request(app)
      .post('/api/audio/monitor/abc-123')
      .send({ producerId: 'prod-xyz' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      session: { sessionId: 'sess-1', producerId: 'prod-1', startedAt: 123 },
    });
    expect(service.monitorSession).toHaveBeenCalledWith('abc-123', 'prod-xyz');
  });

  test('POST /monitor/:sessionId works when producerId is missing', async () => {
    const res = await request(app).post('/api/audio/monitor/abc-123').send({});

    expect(res.status).toBe(200);
    expect(service.monitorSession).toHaveBeenCalledWith('abc-123', undefined);
  });

  test('POST /stats/:sessionId forwards body to updateSessionStats', async () => {
    const body = { audioLevel: 0.42, bitrate: 64000 };

    const res = await request(app).post('/api/audio/stats/sess-9').send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(service.updateSessionStats).toHaveBeenCalledWith('sess-9', body);
  });

  test('GET /report/:sessionId returns the report when service returns one', async () => {
    const report = {
      sessionId: 'sess-9',
      duration: 12345,
      quality: { silence: false, clipping: false },
    };
    service.getSessionReport.mockReturnValue(report);

    const res = await request(app).get('/api/audio/report/sess-9');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
    expect(service.getSessionReport).toHaveBeenCalledWith('sess-9');
  });

  test('GET /report/:sessionId returns 404 when service returns null', async () => {
    service.getSessionReport.mockReturnValue(null);

    const res = await request(app).get('/api/audio/report/missing');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Session not found' });
  });

  test('GET /report/:sessionId returns 404 when service returns undefined', async () => {
    service.getSessionReport.mockReturnValue(undefined);

    const res = await request(app).get('/api/audio/report/missing');

    expect(res.status).toBe(404);
  });

  test('GET /global-stats returns service.stats.globalStats', async () => {
    const res = await request(app).get('/api/audio/global-stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeStreams: 3, averageQuality: 0.87 });
  });

  describe('when audioOptimizationService is not set on app.locals', () => {
    let bareApp;

    beforeEach(() => {
      bareApp = buildApp(null);
    });

    test('GET /optimization-settings returns 500', async () => {
      const res = await request(bareApp).get('/api/audio/optimization-settings');
      expect(res.status).toBe(500);
    });

    test('GET /profile/:profile returns 500', async () => {
      const res = await request(bareApp).get('/api/audio/profile/streaming');
      expect(res.status).toBe(500);
    });

    test('POST /monitor/:sessionId returns 500', async () => {
      const res = await request(bareApp)
        .post('/api/audio/monitor/x')
        .send({ producerId: 'p' });
      expect(res.status).toBe(500);
    });

    test('POST /stats/:sessionId returns 500', async () => {
      const res = await request(bareApp).post('/api/audio/stats/x').send({});
      expect(res.status).toBe(500);
    });

    test('GET /report/:sessionId returns 500', async () => {
      const res = await request(bareApp).get('/api/audio/report/x');
      expect(res.status).toBe(500);
    });

    test('GET /global-stats returns 500', async () => {
      const res = await request(bareApp).get('/api/audio/global-stats');
      expect(res.status).toBe(500);
    });
  });
});
