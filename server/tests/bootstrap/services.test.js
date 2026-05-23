// Tests for the early-core service composition root introduced in PR-I.
//
// We use jest.mock(..., factory) to replace each service module with a tiny
// stub class that records the constructor args on the instance (as `_args`).
// That gives us:
//   - cheap isolation from the real services' database/io side effects
//     (BuffDebuffService.initialize(), etc.)
//   - a way to assert exactly which deps got threaded into each `new X(...)`.
//
// Coverage:
//   1. Factory returns all 16 expected keys (none missing, none extra).
//   2. Each returned value is an instance of the (mocked) class for that key.
//   3. takeoverService receives (redisClient, sessionService).
//   4. inventoryService receives itemService.
//   5. shopService receives (itemService, inventoryService, accountService, io).
//   6. buffDebuffService receives (io, streamService, timeTrackingService, sessionService).
//   7. canvasFxService receives the *same* buffDebuffService instance the
//      factory built (i.e. construction order: buffs before canvas).
//   8. Factory does NOT throw when `io` is missing but produces a shopService
//      whose `io` arg is undefined — documents current behavior so a future
//      tightening (required-dep validation) gets a deliberate test update.

// ── Mock every service module the factory loads ──────────────────────────
// Each mock is a constructor that stashes its args on `this._args`. We
// inline the class body inside each factory callback because Jest forbids
// out-of-scope references in `jest.mock` factories (only names prefixed
// with `mock` are allowed). Each mock also tags the instance with the
// service name to make instanceof failures obvious.

jest.mock('../../services/StreamService', () => class { constructor(...args) { this._args = args; this._stubName = 'StreamService'; } });
jest.mock('../../services/SessionService', () => class { constructor(...args) { this._args = args; this._stubName = 'SessionService'; } });
jest.mock('../../services/TakeoverService', () => class { constructor(...args) { this._args = args; this._stubName = 'TakeoverService'; } });
jest.mock('../../services/TestStreamService', () => class { constructor(...args) { this._args = args; this._stubName = 'TestStreamService'; } });
jest.mock('../../services/SimpleMediaStreamService', () => class { constructor(...args) { this._args = args; this._stubName = 'SimpleMediaStreamService'; } });
jest.mock('../../services/AudioOptimizationService', () => class { constructor(...args) { this._args = args; this._stubName = 'AudioOptimizationService'; } });
jest.mock('../../services/ResourceMonitor', () => class { constructor(...args) { this._args = args; this._stubName = 'ResourceMonitor'; } });
jest.mock('../../services/AccountService', () => class { constructor(...args) { this._args = args; this._stubName = 'AccountService'; } });
jest.mock('../../services/TimeTrackingService', () => class { constructor(...args) { this._args = args; this._stubName = 'TimeTrackingService'; } });
jest.mock('../../services/ItemService', () => class { constructor(...args) { this._args = args; this._stubName = 'ItemService'; } });
jest.mock('../../services/InventoryService', () => class { constructor(...args) { this._args = args; this._stubName = 'InventoryService'; } });
jest.mock('../../services/ShopService', () => class { constructor(...args) { this._args = args; this._stubName = 'ShopService'; } });
jest.mock('../../services/BuffDebuffService', () => class { constructor(...args) { this._args = args; this._stubName = 'BuffDebuffService'; } });
jest.mock('../../services/CanvasFxService', () => class { constructor(...args) { this._args = args; this._stubName = 'CanvasFxService'; } });
jest.mock('../../services/SoundFxService', () => class { constructor(...args) { this._args = args; this._stubName = 'SoundFxService'; } });
jest.mock('../../services/MediasoupPlainTransportService', () => class { constructor(...args) { this._args = args; this._stubName = 'MediasoupPlainTransportService'; } });

// Pull in the mocked classes for instanceof checks.
const StreamService = require('../../services/StreamService');
const SessionService = require('../../services/SessionService');
const TakeoverService = require('../../services/TakeoverService');
const TestStreamService = require('../../services/TestStreamService');
const SimpleMediaStreamService = require('../../services/SimpleMediaStreamService');
const AudioOptimizationService = require('../../services/AudioOptimizationService');
const ResourceMonitor = require('../../services/ResourceMonitor');
const AccountService = require('../../services/AccountService');
const TimeTrackingService = require('../../services/TimeTrackingService');
const ItemService = require('../../services/ItemService');
const InventoryService = require('../../services/InventoryService');
const ShopService = require('../../services/ShopService');
const BuffDebuffService = require('../../services/BuffDebuffService');
const CanvasFxService = require('../../services/CanvasFxService');
const SoundFxService = require('../../services/SoundFxService');
const MediasoupPlainTransportService = require('../../services/MediasoupPlainTransportService');

const createServices = require('../../bootstrap/services');

function buildDeps(overrides = {}) {
  return {
    io: { _kind: 'io' },
    redisClient: { _kind: 'redis' },
    database: { _kind: 'database' },
    env: { NODE_ENV: 'test' },
    mediasoupService: { _kind: 'mediasoup' },
    ...overrides,
  };
}

describe('server/bootstrap/services factory', () => {
  test('returns all 16 expected keys (no more, no less)', () => {
    const services = createServices(buildDeps());

    const expectedKeys = [
      'streamService',
      'sessionService',
      'takeoverService',
      'testStreamService',
      'mediaStreamService',
      'audioOptimizationService',
      'resourceMonitor',
      'accountService',
      'timeTrackingService',
      'itemService',
      'inventoryService',
      'shopService',
      'buffDebuffService',
      'canvasFxService',
      'soundFxService',
      'plainTransportService',
    ];

    expect(Object.keys(services).sort()).toEqual(expectedKeys.slice().sort());
    expect(expectedKeys).toHaveLength(16);
  });

  test('each returned value is an instance of the matching service class', () => {
    const s = createServices(buildDeps());

    expect(s.streamService).toBeInstanceOf(StreamService);
    expect(s.sessionService).toBeInstanceOf(SessionService);
    expect(s.takeoverService).toBeInstanceOf(TakeoverService);
    expect(s.testStreamService).toBeInstanceOf(TestStreamService);
    expect(s.mediaStreamService).toBeInstanceOf(SimpleMediaStreamService);
    expect(s.audioOptimizationService).toBeInstanceOf(AudioOptimizationService);
    expect(s.resourceMonitor).toBeInstanceOf(ResourceMonitor);
    expect(s.accountService).toBeInstanceOf(AccountService);
    expect(s.timeTrackingService).toBeInstanceOf(TimeTrackingService);
    expect(s.itemService).toBeInstanceOf(ItemService);
    expect(s.inventoryService).toBeInstanceOf(InventoryService);
    expect(s.shopService).toBeInstanceOf(ShopService);
    expect(s.buffDebuffService).toBeInstanceOf(BuffDebuffService);
    expect(s.canvasFxService).toBeInstanceOf(CanvasFxService);
    expect(s.soundFxService).toBeInstanceOf(SoundFxService);
    expect(s.plainTransportService).toBeInstanceOf(MediasoupPlainTransportService);
  });

  test('takeoverService is constructed with (redisClient, sessionService)', () => {
    const deps = buildDeps();
    const s = createServices(deps);

    expect(s.takeoverService._args).toHaveLength(2);
    expect(s.takeoverService._args[0]).toBe(deps.redisClient);
    expect(s.takeoverService._args[1]).toBe(s.sessionService);
  });

  test('inventoryService is constructed with itemService', () => {
    const s = createServices(buildDeps());

    expect(s.inventoryService._args).toHaveLength(1);
    expect(s.inventoryService._args[0]).toBe(s.itemService);
  });

  test('shopService is constructed with (itemService, inventoryService, accountService, io)', () => {
    const deps = buildDeps();
    const s = createServices(deps);

    expect(s.shopService._args).toHaveLength(4);
    expect(s.shopService._args[0]).toBe(s.itemService);
    expect(s.shopService._args[1]).toBe(s.inventoryService);
    expect(s.shopService._args[2]).toBe(s.accountService);
    expect(s.shopService._args[3]).toBe(deps.io);
  });

  test('buffDebuffService is constructed with (io, streamService, timeTrackingService, sessionService)', () => {
    const deps = buildDeps();
    const s = createServices(deps);

    expect(s.buffDebuffService._args).toHaveLength(4);
    expect(s.buffDebuffService._args[0]).toBe(deps.io);
    expect(s.buffDebuffService._args[1]).toBe(s.streamService);
    expect(s.buffDebuffService._args[2]).toBe(s.timeTrackingService);
    expect(s.buffDebuffService._args[3]).toBe(s.sessionService);
  });

  test('canvasFxService receives the buffDebuffService built by the factory (order)', () => {
    const deps = buildDeps();
    const s = createServices(deps);

    // Per the dependency graph, buffDebuffService must exist before
    // canvasFxService can be built — check via identity.
    expect(s.canvasFxService._args).toHaveLength(3);
    expect(s.canvasFxService._args[0]).toBe(deps.io);
    expect(s.canvasFxService._args[1]).toBe(s.itemService);
    expect(s.canvasFxService._args[2]).toBe(s.buffDebuffService);
  });

  test('plainTransportService is constructed with the passed-in mediasoupService', () => {
    const deps = buildDeps();
    const s = createServices(deps);

    expect(s.plainTransportService._args).toHaveLength(1);
    expect(s.plainTransportService._args[0]).toBe(deps.mediasoupService);
  });

  test('omitting required deps leaves the corresponding ctor arg undefined (no validation today)', () => {
    // The current factory does NOT validate inputs; it simply forwards
    // whatever is destructured. This test pins that behavior so a future
    // PR that adds required-dep checks deliberately updates this case.
    const deps = buildDeps({ io: undefined });
    const s = createServices(deps);

    expect(s.shopService._args[3]).toBeUndefined();
    expect(s.buffDebuffService._args[0]).toBeUndefined();
    expect(s.canvasFxService._args[0]).toBeUndefined();
  });

  test('throws when called with no deps object (destructure of undefined)', () => {
    expect(() => createServices()).toThrow(TypeError);
  });
});
