// Tests for server/services/BuffNotifier — single emit chokepoint for the
// buff/inventory event cluster (PR 3.3). Three methods, three target scopes:
//   streamerBuffsUpdate({ buffs, toSocket? })   broadcast OR per-socket
//   inventoryUpdated({ toSocketId, action, … }) targeted via io.to(socketId)
//   buffError({ toSocket, error })              per-calling-socket
//
// Coverage:
//   - Ctor contract.
//   - INVENTORY_ACTIONS pinning (6 baseline actions; strict size match).
//   - streamerBuffsUpdate broadcast (no toSocket) vs per-socket
//     (BuffHandler:get-streamer-buffs response path).
//   - streamerBuffsUpdate suppresses on non-array buffs.
//   - inventoryUpdated: targeted via io.to(socketId), payload preserves
//     all fields, `remainingQuantity` is OMITTED when caller didn't pass it.
//   - inventoryUpdated suppresses (no emit) when toSocketId or action is
//     missing; warns on unknown action but still emits.
//   - buffError: per-calling-socket; suppresses on missing toSocket or
//     non-string error.

const BuffNotifier = require('../../services/BuffNotifier');

function makeIo() {
  const to = jest.fn();
  const toReturn = { emit: jest.fn() };
  to.mockReturnValue(toReturn);
  return { emit: jest.fn(), to, _toReturn: toReturn };
}

function makeSocket() {
  return { emit: jest.fn() };
}

describe('BuffNotifier', () => {
  describe('constructor', () => {
    test('requires an io argument', () => {
      expect(() => new BuffNotifier()).toThrow(/requires a Socket.IO/);
      expect(() => new BuffNotifier(null)).toThrow(/requires a Socket.IO/);
    });

    test('stores io on the instance', () => {
      const io = makeIo();
      const notifier = new BuffNotifier(io);
      expect(notifier.io).toBe(io);
    });
  });

  describe('INVENTORY_ACTIONS', () => {
    // 6 baseline actions, one per distinct emit-site action string at the
    // PR 3.3 baseline. Strict size equality forces future PRs that add a
    // new action to update this list deliberately.
    const PR_3_3_BASELINE = ['purchase', 'sell', 'grant', 'use', 'draw', 'throw'];

    test('is a Set', () => {
      expect(BuffNotifier.INVENTORY_ACTIONS).toBeInstanceOf(Set);
    });

    test.each(PR_3_3_BASELINE)('contains the PR 3.3 baseline action %s', (action) => {
      expect(BuffNotifier.INVENTORY_ACTIONS.has(action)).toBe(true);
    });

    test('INVENTORY_ACTIONS size matches baseline — additions must update both lists', () => {
      expect(BuffNotifier.INVENTORY_ACTIONS.size).toBe(PR_3_3_BASELINE.length);
    });
  });

  describe('streamerBuffsUpdate()', () => {
    let io;
    let notifier;
    let warnSpy;

    beforeEach(() => {
      io = makeIo();
      notifier = new BuffNotifier(io);
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    test('broadcasts via io.emit when no toSocket is provided', () => {
      const buffs = [{ id: 1, displayName: 'test' }];
      notifier.streamerBuffsUpdate({ buffs });

      expect(io.emit).toHaveBeenCalledTimes(1);
      expect(io.emit).toHaveBeenCalledWith('streamer-buffs-update', { buffs });
      expect(io.to).not.toHaveBeenCalled();
    });

    test('emits only to toSocket when provided (per-query response variant)', () => {
      const socket = makeSocket();
      const buffs = [{ id: 1 }];
      notifier.streamerBuffsUpdate({ buffs, toSocket: socket });

      expect(io.emit).not.toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith('streamer-buffs-update', { buffs });
    });

    test('passes through empty buffs array (stream-end clear case)', () => {
      notifier.streamerBuffsUpdate({ buffs: [] });
      expect(io.emit).toHaveBeenCalledWith('streamer-buffs-update', { buffs: [] });
    });

    test('suppresses + warns when buffs is not an array', () => {
      notifier.streamerBuffsUpdate({ buffs: null });
      expect(io.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test('toSocket key is not leaked into the wire payload', () => {
      const socket = makeSocket();
      notifier.streamerBuffsUpdate({ buffs: [], toSocket: socket });
      expect(socket.emit.mock.calls[0][1]).not.toHaveProperty('toSocket');
    });
  });

  describe('inventoryUpdated()', () => {
    let io;
    let notifier;
    let warnSpy;

    beforeEach(() => {
      io = makeIo();
      notifier = new BuffNotifier(io);
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    test('targets the specified socket via io.to(socketId).emit', () => {
      notifier.inventoryUpdated({
        toSocketId: 'sock-1',
        action: 'purchase',
        itemId: 42,
        quantity: 1,
      });

      expect(io.to).toHaveBeenCalledTimes(1);
      expect(io.to).toHaveBeenCalledWith('sock-1');
      expect(io._toReturn.emit).toHaveBeenCalledWith('inventory-updated', {
        action: 'purchase',
        itemId: 42,
        quantity: 1,
      });
      expect(io.emit).not.toHaveBeenCalled();
    });

    test('omits remainingQuantity from the payload when not provided', () => {
      // purchase/sell/grant don't carry remainingQuantity; use/draw/throw
      // DO. Pinning the omission so a future caller that passes undefined
      // explicitly doesn't accidentally add the key.
      notifier.inventoryUpdated({
        toSocketId: 'sock-1',
        action: 'sell',
        itemId: 5,
        quantity: 2,
      });
      expect(io._toReturn.emit.mock.calls[0][1]).not.toHaveProperty('remainingQuantity');
    });

    test('includes remainingQuantity when provided', () => {
      notifier.inventoryUpdated({
        toSocketId: 'sock-2',
        action: 'use',
        itemId: 9,
        quantity: 1,
        remainingQuantity: 7,
      });
      expect(io._toReturn.emit.mock.calls[0][1]).toEqual({
        action: 'use',
        itemId: 9,
        quantity: 1,
        remainingQuantity: 7,
      });
    });

    test.each(['purchase', 'sell', 'grant', 'use', 'draw', 'throw'])(
      'accepts baseline action %s without warning',
      (action) => {
        notifier.inventoryUpdated({ toSocketId: 's', action, itemId: 1, quantity: 1 });
        expect(warnSpy).not.toHaveBeenCalled();
      }
    );

    test('unknown action still emits but logs a warn (surface drift)', () => {
      notifier.inventoryUpdated({
        toSocketId: 'sock-1',
        action: 'mysterious_new_action',
        itemId: 1,
        quantity: 1,
      });
      expect(io._toReturn.emit).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/unknown inventory action/);
    });

    test('suppresses + warns when toSocketId is missing', () => {
      notifier.inventoryUpdated({ action: 'purchase', itemId: 1, quantity: 1 });
      expect(io.to).not.toHaveBeenCalled();
      expect(io._toReturn.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test('suppresses + warns when action is missing', () => {
      notifier.inventoryUpdated({ toSocketId: 'sock-1', itemId: 1, quantity: 1 });
      expect(io.to).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('buffError()', () => {
    let io;
    let notifier;
    let warnSpy;
    let errorSpy;

    beforeEach(() => {
      io = makeIo();
      notifier = new BuffNotifier(io);
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      // Post-review breadcrumb: the bad-error-arg suppression path also
      // calls console.error so the operator can see the original argument
      // in the logs even when the wire emit is dropped.
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    test('emits buff-error to the specified socket', () => {
      const socket = makeSocket();
      notifier.buffError({ toSocket: socket, error: 'Authentication required' });

      expect(socket.emit).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith('buff-error', { error: 'Authentication required' });
      expect(io.emit).not.toHaveBeenCalled();
      expect(io.to).not.toHaveBeenCalled();
    });

    test('suppresses + warns when toSocket is missing', () => {
      notifier.buffError({ error: 'oops' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    test('suppresses + warns when error is empty string (with breadcrumb)', () => {
      const socket = makeSocket();
      notifier.buffError({ toSocket: socket, error: '' });
      expect(socket.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Post-review breadcrumb: console.error preserves the original
      // argument in the server logs.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][1]).toBe('');
    });

    test('suppresses + warns when error is not a string (breadcrumb captures the original value)', () => {
      const socket = makeSocket();
      const original = { message: 'oops' };
      notifier.buffError({ toSocket: socket, error: original });
      expect(socket.emit).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // The original non-string argument is logged so an operator can see
      // what the caller was trying to send.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][1]).toBe(original);
    });
  });
});
