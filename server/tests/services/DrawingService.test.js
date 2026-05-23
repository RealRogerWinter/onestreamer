const DrawingService = require('../../services/DrawingService');

// Silence the chatty console.log/console.error coming out of the service.
beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
    jest.restoreAllMocks();
});

describe('DrawingService', () => {
    let drawingService;
    let user;
    let item;
    let inventoryService;
    let canvasFxService;
    let streamService;
    let sessionService;
    let io;
    let sendSystemMessage;

    beforeEach(() => {
        drawingService = new DrawingService();

        user = { id: 42, userId: 42, username: 'alice' };
        item = { id: 7, name: 'red-marker', displayName: 'Red Marker' };

        inventoryService = {
            useItem: jest.fn().mockResolvedValue({
                item: { id: 7, displayName: 'Red Marker', cooldown: 5000 },
                remainingQuantity: 3
            })
        };

        canvasFxService = {
            triggerItemEffect: jest.fn().mockResolvedValue({ ok: true })
        };

        streamService = {
            getStreamStatus: jest.fn().mockReturnValue({
                hasActiveStream: true,
                streamerId: 'streamer-1'
            })
        };

        sessionService = {
            getSocketsByUserId: jest.fn().mockReturnValue(['sock-a', 'sock-b'])
        };

        const ioRoom = { emit: jest.fn() };
        io = {
            emit: jest.fn(),
            to: jest.fn().mockReturnValue(ioRoom),
            _room: ioRoom // exposed for assertions
        };

        sendSystemMessage = jest.fn().mockResolvedValue(undefined);
    });

    const invoke = (overrides = {}) =>
        drawingService.startDrawing({
            user,
            item,
            services: { inventoryService, canvasFxService, streamService },
            io,
            sessionService,
            sendSystemMessage,
            ...overrides
        });

    test('happy path: consumes item, triggers fx, broadcasts chat, emits sockets', async () => {
        const result = await invoke();

        expect(result.ok).toBe(true);
        expect(result.item).toEqual({ id: 7, displayName: 'Red Marker', cooldown: 5000 });
        expect(result.remainingQuantity).toBe(3);
        expect(result.displayMessage).toBe('Drawing started with Red Marker!');

        // userId is taken from user.userId (preferred over user.id) — matches the
        // original handler precedence and what authenticateToken populates.
        expect(inventoryService.useItem).toHaveBeenCalledWith(42, 7, 'streamer-1');

        expect(canvasFxService.triggerItemEffect).toHaveBeenCalledWith(
            42,
            7,
            'streamer-1',
            { username: 'alice' }
        );

        expect(sendSystemMessage).toHaveBeenCalledWith('alice started drawing with Red Marker!');

        expect(io.emit).toHaveBeenCalledWith('item-used', expect.objectContaining({
            userId: 42,
            username: 'alice',
            streamId: 'streamer-1',
            drawingStarted: true
        }));

        // Per-socket inventory-updated fanned out to every socket for the user.
        expect(io.to).toHaveBeenCalledWith('sock-a');
        expect(io.to).toHaveBeenCalledWith('sock-b');
        expect(io._room.emit).toHaveBeenCalledWith('inventory-updated', {
            action: 'draw',
            itemId: 7,
            quantity: 1,
            remainingQuantity: 3
        });
    });

    test('missing item returns missing-item kind without touching downstream services', async () => {
        const result = await invoke({ item: undefined });

        expect(result).toEqual({ ok: false, kind: 'missing-item' });
        expect(streamService.getStreamStatus).not.toHaveBeenCalled();
        expect(inventoryService.useItem).not.toHaveBeenCalled();
        expect(sendSystemMessage).not.toHaveBeenCalled();
        expect(io.emit).not.toHaveBeenCalled();
    });

    test('no active stream returns no-active-stream and does not consume inventory', async () => {
        streamService.getStreamStatus.mockReturnValue({ hasActiveStream: false });

        const result = await invoke();

        expect(result).toEqual({ ok: false, kind: 'no-active-stream' });
        expect(inventoryService.useItem).not.toHaveBeenCalled();
        expect(canvasFxService.triggerItemEffect).not.toHaveBeenCalled();
        expect(sendSystemMessage).not.toHaveBeenCalled();
        expect(io.emit).not.toHaveBeenCalled();
    });

    test('cooldown error from inventoryService surfaces as cooldown kind', async () => {
        inventoryService.useItem.mockRejectedValue(new Error('Item is on cooldown for 12s'));

        const result = await invoke();

        expect(result.ok).toBe(false);
        expect(result.kind).toBe('cooldown');
        expect(result.message).toBe('Item is on cooldown for 12s');

        // No side-effects on the cooldown path.
        expect(canvasFxService.triggerItemEffect).not.toHaveBeenCalled();
        expect(sendSystemMessage).not.toHaveBeenCalled();
        expect(io.emit).not.toHaveBeenCalled();
    });

    test('generic inventoryService error surfaces as error kind with original message', async () => {
        inventoryService.useItem.mockRejectedValue(new Error('DB connection lost'));

        const result = await invoke();

        expect(result.ok).toBe(false);
        expect(result.kind).toBe('error');
        expect(result.message).toBe('DB connection lost');
        expect(result.cause).toBeInstanceOf(Error);

        expect(canvasFxService.triggerItemEffect).not.toHaveBeenCalled();
        expect(sendSystemMessage).not.toHaveBeenCalled();
    });

    test('error with undefined message is handled defensively (regression vs. original handler)', async () => {
        // The original route handler did `error.message.includes('cooldown')` and
        // would crash on a thrown value with no .message. The new service guards
        // with `error.message && ...` and returns a clean 'error' result.
        const weird = Object.create(null);
        weird.toString = () => 'weird';
        inventoryService.useItem.mockRejectedValue(weird);

        const result = await invoke();

        expect(result.ok).toBe(false);
        expect(result.kind).toBe('error');
        expect(result.message).toBe('Failed to start drawing');
    });

    test('canvas fx failure is swallowed — chat broadcast and socket fan-out still run', async () => {
        canvasFxService.triggerItemEffect.mockRejectedValue(new Error('fx renderer offline'));

        const result = await invoke();

        expect(result.ok).toBe(true);
        expect(sendSystemMessage).toHaveBeenCalled();
        expect(io.emit).toHaveBeenCalledWith('item-used', expect.any(Object));
    });

    test('canvas fx returning null is non-fatal — flow continues to chat and sockets', async () => {
        canvasFxService.triggerItemEffect.mockResolvedValue(null);

        const result = await invoke();

        expect(result.ok).toBe(true);
        expect(sendSystemMessage).toHaveBeenCalledWith('alice started drawing with Red Marker!');
        expect(io.emit).toHaveBeenCalledTimes(1);
    });

    test('falls back to item.display_name when item.displayName is absent', async () => {
        const snakeItem = { id: 9, name: 'crayon', display_name: 'Blue Crayon' };

        const result = await invoke({ item: snakeItem });

        expect(result.ok).toBe(true);
        expect(result.displayMessage).toBe('Drawing started with Blue Crayon!');
        expect(sendSystemMessage).toHaveBeenCalledWith('alice started drawing with Blue Crayon!');
    });

    test('no io / no sessionService: succeeds without touching socket fan-out', async () => {
        const result = await invoke({ io: undefined, sessionService: undefined });

        expect(result.ok).toBe(true);
        expect(sendSystemMessage).toHaveBeenCalled();
    });

    test('falls back to user.id when user.userId is missing', async () => {
        const result = await invoke({ user: { id: 99, username: 'bob' } });

        expect(result.ok).toBe(true);
        expect(inventoryService.useItem).toHaveBeenCalledWith(99, 7, 'streamer-1');
        expect(canvasFxService.triggerItemEffect).toHaveBeenCalledWith(
            99,
            7,
            'streamer-1',
            { username: 'bob' }
        );
    });
});
