// Unit tests for chat-service/claims/claimEventService.js
//
// Behavior under test (byte-equivalent to the inline implementation that
// previously lived in chat-service/index.js):
//   - generateClaimCode produces a 4-digit numeric string
//   - startClaimEvent broadcasts via io.emit + appends to chatMessages
//   - startClaimEvent refuses to start when one is already active
//   - getActiveClaim returns the live reference (mutation visible)
//   - clearActiveClaim resets to null
//   - scheduleNextClaimEvent picks a delay in [20min, 60min)
//   - calling scheduleNextClaimEvent twice clears the previous timer
//   - the 60s expiry timer auto-clears unclaimed events + emits an expiry msg
//   - manuallyTriggered=true is reflected on the active claim object
//
// All timers are mocked with jest.useFakeTimers().

const createClaimEventService = require('../../claims/claimEventService');

describe('claimEventService', () => {
  let io;
  let chatMessages;
  let formatTime;
  let getUniqueViewerCount;
  let service;

  const MAX_CHAT_HISTORY = 100;

  beforeEach(() => {
    jest.useFakeTimers();
    io = { emit: jest.fn() };
    chatMessages = [];
    formatTime = jest.fn(() => '12:34');
    getUniqueViewerCount = jest.fn(() => 0);

    service = createClaimEventService({
      io,
      chatMessages,
      MAX_CHAT_HISTORY,
      formatTime,
      getUniqueViewerCount
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('generateClaimCode', () => {
    test('returns a 4-digit numeric string', () => {
      // Run a handful of iterations; the formula is
      // Math.floor(1000 + Math.random()*9000), so range is [1000, 9999].
      for (let i = 0; i < 25; i++) {
        const code = service.generateClaimCode();
        expect(typeof code).toBe('string');
        expect(code).toMatch(/^\d{4}$/);
        const n = parseInt(code, 10);
        expect(n).toBeGreaterThanOrEqual(1000);
        expect(n).toBeLessThanOrEqual(9999);
      }
    });
  });

  describe('startClaimEvent', () => {
    test('broadcasts via io.emit, appends to chatMessages, sets activeClaim', () => {
      // Pin Math.random so reward + code + message id are deterministic.
      jest.spyOn(Math, 'random').mockReturnValue(0.5);

      const result = service.startClaimEvent();

      expect(result).toBe(true);

      const active = service.getActiveClaim();
      expect(active).not.toBeNull();
      expect(active.code).toMatch(/^\d{4}$/);
      // reward = 1000 + floor(random * 1001) => with 0.5 => 1000 + 500 = 1500
      expect(active.reward).toBe(1500);
      expect(active.claimedBy).toBeNull();
      expect(active.manuallyTriggered).toBe(false);
      expect(typeof active.startedAt).toBe('number');

      expect(chatMessages.length).toBe(1);
      const msg = chatMessages[0];
      expect(msg.username).toBe('🤖 StreamBot');
      expect(msg.color).toBe('#FFD700');
      expect(msg.isClaimEvent).toBe(true);
      expect(msg.isSystem).toBe(true);
      expect(msg.message).toContain('CLAIM EVENT');
      expect(msg.message).toContain(active.code);
      expect(msg.message).toContain('1500');

      expect(io.emit).toHaveBeenCalledTimes(1);
      expect(io.emit).toHaveBeenCalledWith('new-message', msg);
    });

    test('returns false (no-op) when an event is already active', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.1);

      expect(service.startClaimEvent()).toBe(true);
      const first = service.getActiveClaim();

      expect(service.startClaimEvent()).toBe(false);
      expect(service.getActiveClaim()).toBe(first); // unchanged

      // No additional broadcast.
      expect(io.emit).toHaveBeenCalledTimes(1);
      expect(chatMessages.length).toBe(1);
    });

    test('records manuallyTriggered=true on the active claim object', () => {
      service.startClaimEvent(true);
      expect(service.getActiveClaim().manuallyTriggered).toBe(true);
    });

    test('after CLAIM_TIMEOUT with no claim, auto-expires and broadcasts expiry', () => {
      service.startClaimEvent();
      expect(service.getActiveClaim()).not.toBeNull();
      expect(chatMessages.length).toBe(1);

      // Advance the 60-second timeout.
      jest.advanceTimersByTime(60 * 1000);

      expect(service.getActiveClaim()).toBeNull();
      expect(chatMessages.length).toBe(2);
      const expiryMsg = chatMessages[1];
      expect(expiryMsg.color).toBe('#FF6B6B');
      expect(expiryMsg.message).toContain('expired');
      expect(expiryMsg.isClaimEvent).toBeUndefined(); // expiry msg omits flag
      expect(io.emit).toHaveBeenCalledTimes(2);
      expect(io.emit).toHaveBeenLastCalledWith('new-message', expiryMsg);
    });

    test('CLAIM_TIMEOUT does NOT expire / broadcast when a winner has been recorded', () => {
      service.startClaimEvent();
      const active = service.getActiveClaim();
      active.claimedBy = 'alice'; // simulate the !claim parser recording a winner

      jest.advanceTimersByTime(60 * 1000);

      // The service should not emit an expiry; the active object stays as-is
      // (the parser is responsible for calling clearActiveClaim()).
      expect(io.emit).toHaveBeenCalledTimes(1); // only the start broadcast
      expect(chatMessages.length).toBe(1);
      expect(service.getActiveClaim()).toBe(active);
    });

    test('honors custom CLAIM_TIMEOUT via constants override', () => {
      const customSvc = createClaimEventService({
        io,
        chatMessages,
        MAX_CHAT_HISTORY,
        formatTime,
        constants: { CLAIM_TIMEOUT: 5000 }
      });

      customSvc.startClaimEvent();
      jest.advanceTimersByTime(4999);
      expect(customSvc.getActiveClaim()).not.toBeNull();
      jest.advanceTimersByTime(1);
      expect(customSvc.getActiveClaim()).toBeNull();
    });
  });

  describe('getActiveClaim / clearActiveClaim', () => {
    test('getActiveClaim returns a live reference (mutation visible to service)', () => {
      service.startClaimEvent();

      const ref = service.getActiveClaim();
      ref.claimedBy = 'bob';

      // Re-fetching should see the mutation — same object reference.
      expect(service.getActiveClaim().claimedBy).toBe('bob');
      expect(service.getActiveClaim()).toBe(ref);
    });

    test('clearActiveClaim sets activeClaim back to null', () => {
      service.startClaimEvent();
      expect(service.getActiveClaim()).not.toBeNull();

      service.clearActiveClaim();
      expect(service.getActiveClaim()).toBeNull();

      // A new claim can now be started.
      expect(service.startClaimEvent()).toBe(true);
    });
  });

  describe('scheduleNextClaimEvent', () => {
    test('schedules a timer with delay in [20min, 60min)', () => {
      // Random=0 => 20min, Random just under 1 => approaches 60min.
      jest.spyOn(Math, 'random').mockReturnValue(0);
      service.scheduleNextClaimEvent();

      // No new claim until the timer fires.
      expect(service.getActiveClaim()).toBeNull();

      // Just before 20 min: nothing.
      jest.advanceTimersByTime(20 * 60 * 1000 - 1);
      expect(service.getActiveClaim()).toBeNull();

      // At 20 min exactly: startClaimEvent fires.
      jest.advanceTimersByTime(1);
      expect(service.getActiveClaim()).not.toBeNull();
    });

    test('schedules near the 60-minute upper bound when Math.random() is near 1', () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.9999);
      service.scheduleNextClaimEvent();

      // Just shy of 60 min: nothing yet.
      jest.advanceTimersByTime(60 * 60 * 1000 - 1000);
      expect(service.getActiveClaim()).toBeNull();

      // Push past the scheduled delay.
      jest.advanceTimersByTime(2000);
      expect(service.getActiveClaim()).not.toBeNull();
    });

    test('calling scheduleNextClaimEvent twice clears the previous timer', () => {
      // Spy on clearTimeout so we can assert the re-schedule cancelled the
      // first timer without depending on the recursive scheduling side-effects
      // (the rescheduled callback also fires startClaimEvent + the 60s expiry
      // timeout, which makes "did the event fire?" assertions brittle).
      const clearSpy = jest.spyOn(global, 'clearTimeout');

      jest.spyOn(Math, 'random').mockReturnValue(0); // first: 20 min
      service.scheduleNextClaimEvent();
      const callsAfterFirst = clearSpy.mock.calls.length;

      Math.random.mockReturnValue(0.5); // ~40 min
      service.scheduleNextClaimEvent();

      // The second call must have cleared the first timer.
      expect(clearSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);

      // Advancing 20 min must NOT trigger an event (first timer was cancelled).
      jest.advanceTimersByTime(20 * 60 * 1000);
      expect(service.getActiveClaim()).toBeNull();
    });
  });
});
