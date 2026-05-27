// Tests for server/services/ModerationNotifier — single emit chokepoint
// for AI-moderation socket events (PR-M1 of ADR-0013).
//
// Coverage:
//   - Constructor contract: io required.
//   - eventCreated(): emits 'moderation-event-created' to admin room with
//     the event payload; suppresses + warns on missing event / decision.
//   - actionTaken(): emits 'moderation-action-taken' to admin room.
//   - streamerBanner(): emits 'moderation-streamer-banner' to the streamer's
//     socket id with shaped payload.
//   - botOutputDropped(): emits 'moderation-bot-output-dropped' to admin room.
//   - MODERATION_EVENT_DECISIONS set is the authoritative enum mirror.

const ModerationNotifier = require('../../services/ModerationNotifier');

function makeIo() {
  const adminRoom = { emit: jest.fn() };
  const socketRoom = { emit: jest.fn() };
  const io = {
    to: jest.fn((target) => {
      if (target === 'admin') return adminRoom;
      return socketRoom;
    }),
    _adminRoom: adminRoom,
    _socketRoom: socketRoom,
  };
  return io;
}

describe('ModerationNotifier', () => {
  describe('constructor', () => {
    test('requires an io argument', () => {
      expect(() => new ModerationNotifier()).toThrow(/requires a Socket.IO/);
      expect(() => new ModerationNotifier(null)).toThrow(/requires a Socket.IO/);
    });

    test('stores io on the instance', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      expect(n.io).toBe(io);
    });
  });

  describe('eventCreated', () => {
    test('emits moderation-event-created to admin room', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const event = { id: 1, final_decision: 'admin_review', transcript_excerpt: 'oops' };
      n.eventCreated({ event });
      expect(io.to).toHaveBeenCalledWith('admin');
      expect(io._adminRoom.emit).toHaveBeenCalledWith('moderation-event-created', { event });
    });

    test('suppresses emit when event missing', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      n.eventCreated({});
      n.eventCreated();
      expect(io._adminRoom.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('suppresses emit when event lacks final_decision', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      n.eventCreated({ event: { id: 1 } });
      expect(io._adminRoom.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    test('warns on unknown final_decision but still emits (forward-compat)', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const event = { id: 1, final_decision: 'unknown_future_decision' };
      n.eventCreated({ event });
      expect(io._adminRoom.emit).toHaveBeenCalledWith('moderation-event-created', { event });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown final_decision'));
      warnSpy.mockRestore();
    });
  });

  describe('actionTaken', () => {
    test('emits moderation-action-taken to admin room', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const event = { id: 7, final_decision: 'auto_ban' };
      const action = { kind: 'ban', details: { streamerId: 'sock_42' } };
      n.actionTaken({ event, action });
      expect(io.to).toHaveBeenCalledWith('admin');
      expect(io._adminRoom.emit).toHaveBeenCalledWith('moderation-action-taken', { event, action });
    });

    test('suppresses emit when event or action missing', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      n.actionTaken({ event: { id: 1 } });
      n.actionTaken({ action: { kind: 'ban' } });
      n.actionTaken({});
      expect(io._adminRoom.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(3);
      warnSpy.mockRestore();
    });
  });

  describe('streamerBanner', () => {
    test('emits moderation-streamer-banner to the target socket id with shaped payload', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const event = {
        id: 9,
        transcript_excerpt: 'this is what i said',
        stage2_categories_json: JSON.stringify(['hate_speech']),
      };
      n.streamerBanner({ socketId: 'sock_42', event, appealUrl: '/appeals/9' });
      expect(io.to).toHaveBeenCalledWith('sock_42');
      expect(io._socketRoom.emit).toHaveBeenCalledWith('moderation-streamer-banner', {
        event_id: 9,
        transcript_excerpt: 'this is what i said',
        categories: ['hate_speech'],
        appeal_url: '/appeals/9',
      });
    });

    test('defaults categories to empty array when stage2_categories_json is missing', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const event = { id: 10, transcript_excerpt: 'x' };
      n.streamerBanner({ socketId: 'sock_99', event });
      expect(io._socketRoom.emit).toHaveBeenCalledWith('moderation-streamer-banner', {
        event_id: 10,
        transcript_excerpt: 'x',
        categories: [],
        appeal_url: null,
      });
    });

    test('suppresses emit when socketId or event missing', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      n.streamerBanner({ event: { id: 1 } });
      n.streamerBanner({ socketId: 'sock_1' });
      expect(io._socketRoom.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      warnSpy.mockRestore();
    });
  });

  describe('botOutputDropped', () => {
    test('emits moderation-bot-output-dropped to admin room', () => {
      const io = makeIo();
      const n = new ModerationNotifier(io);
      const event = { id: 11, stream_type: 'moviebot-output' };
      n.botOutputDropped({ event });
      expect(io.to).toHaveBeenCalledWith('admin');
      expect(io._adminRoom.emit).toHaveBeenCalledWith('moderation-bot-output-dropped', { event });
    });
  });

  describe('MODERATION_EVENT_DECISIONS set', () => {
    test('contains the six schema enum values verbatim', () => {
      // If you change either side, change both — schema CHECK constraint
      // and this Set must stay in lockstep.
      expect(ModerationNotifier.MODERATION_EVENT_DECISIONS).toEqual(new Set([
        'clean',
        'admin_review',
        'auto_ban',
        'auto_skip',
        'mb_output_dropped',
        'deferred_degraded',
      ]));
    });
  });
});
