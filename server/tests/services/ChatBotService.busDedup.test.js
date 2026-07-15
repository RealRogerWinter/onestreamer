// Audit A4 (Plan 07): every connected bot socket receives every chat
// 'new-message' broadcast, and the per-socket handler used to re-emit each
// message onto the BotEventBus once PER BOT — N duplicates per message,
// O(N²) event volume into the LLM "recent chat" context. These tests pin the
// fix: the bus sees each chat message exactly once, keyed by message
// identity, regardless of how many bot sockets observed it.

jest.mock('../../services/ChatBotLLMService', () => jest.fn(() => ({})));

jest.mock('socket.io-client', () => {
    const sockets = [];
    const io = jest.fn(() => {
        const handlers = {};
        const socket = {
            on: jest.fn((event, fn) => { handlers[event] = fn; }),
            emit: jest.fn(),
            disconnect: jest.fn(),
            handlers,
        };
        sockets.push(socket);
        return socket;
    });
    io.__sockets = sockets;
    return { io };
});

const { io: ioClientMock } = require('socket.io-client');
const ChatBotService = require('../../services/ChatBotService');

function botData(id) {
    return {
        id,
        name: `Bot${id}`,
        use_assigned_name: 1,
        show_robot_emoji: 0,
        is_enabled: 1,
    };
}

describe('ChatBotService BotEventBus emit dedup (audit A4)', () => {
    let svc;
    let bus;

    beforeEach(() => {
        ioClientMock.__sockets.length = 0;
        bus = { emit: jest.fn(), on: jest.fn() };
        svc = new ChatBotService({
            botEventBus: bus,
            chatBotRepository: {
                createSession: jest.fn().mockResolvedValue({ id: 'sess' }),
                markSessionDisconnected: jest.fn().mockResolvedValue(),
            },
        });
        svc.isInitialized = true;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('N bot sockets receiving the same message emit exactly one bus event', async () => {
        const N = 5;
        for (let i = 1; i <= N; i++) {
            await svc.startBot(botData(i));
        }
        expect(ioClientMock.__sockets).toHaveLength(N);

        const message = {
            id: 'msg-uuid-1',
            username: 'viewer42',
            message: 'hello chat',
            timestamp: '12:00:00',
            fullTimestamp: '2026-07-15T12:00:00.000Z',
        };
        for (const socket of ioClientMock.__sockets) {
            socket.handlers['new-message'](message);
        }

        expect(bus.emit).toHaveBeenCalledTimes(1);
        expect(bus.emit).toHaveBeenCalledWith('chat-message', {
            username: 'viewer42',
            message: 'hello chat',
        });
    });

    test('distinct messages each emit once', async () => {
        await svc.startBot(botData(1));
        await svc.startBot(botData(2));

        const first = { id: 'msg-1', username: 'a', message: 'one' };
        const second = { id: 'msg-2', username: 'a', message: 'two' };
        for (const socket of ioClientMock.__sockets) {
            socket.handlers['new-message'](first);
            socket.handlers['new-message'](second);
        }

        expect(bus.emit).toHaveBeenCalledTimes(2);
        expect(bus.emit).toHaveBeenNthCalledWith(1, 'chat-message', { username: 'a', message: 'one' });
        expect(bus.emit).toHaveBeenNthCalledWith(2, 'chat-message', { username: 'a', message: 'two' });
    });

    test('falls back to timestamp+username+message identity when no id is present', () => {
        const msg = { username: 'a', message: 'same', fullTimestamp: '2026-07-15T12:00:00.000Z' };
        svc._emitChatMessageToBus(msg);
        svc._emitChatMessageToBus({ ...msg });
        // Same user, same text, different timestamp → a genuinely new message.
        svc._emitChatMessageToBus({ ...msg, fullTimestamp: '2026-07-15T12:00:05.000Z' });
        expect(bus.emit).toHaveBeenCalledTimes(2);
    });

    test('dedup key set stays bounded', () => {
        for (let i = 0; i < svc.BUS_DEDUP_MAX_KEYS + 50; i++) {
            svc._emitChatMessageToBus({ id: `msg-${i}`, username: 'u', message: `m${i}` });
        }
        expect(svc._busEmittedKeys.size).toBe(svc.BUS_DEDUP_MAX_KEYS);
        expect(svc._busEmittedKeyOrder).toHaveLength(svc.BUS_DEDUP_MAX_KEYS);
    });

    test('no bus / missing fields are silent no-ops', () => {
        svc._emitChatMessageToBus(null);
        svc._emitChatMessageToBus({ username: 'a' });
        svc._emitChatMessageToBus({ message: 'b' });
        expect(bus.emit).not.toHaveBeenCalled();
        const noBus = new ChatBotService({ chatBotRepository: {} });
        expect(() => noBus._emitChatMessageToBus({ id: 'x', username: 'a', message: 'b' })).not.toThrow();
    });
});
