/**
 * Per-connection socket handler registration.
 *
 * Extracted from `server/index.js` as part of Phase 15B.5. The pre-PR
 * shape was an inline `io.on('connection', ...)` block at roughly
 * `index.js:4565–4828` (264 LoC), wiring every per-namespace
 * `register*Handler(io, socket, …)` call plus connection-level state
 * (IP-ban check, JWT auth, session register, ViewBot/canvas/visual
 * effects per-socket setup).
 *
 * The post-PR shape is `registerSocketHandlers(io, deps)`, which calls
 * `io.on('connection', ...)` once and forwards the deps bag — same
 * pattern `bootstrap/start-listeners.js` established in PR 4.3.
 *
 * Deps bag is the union of every dep currently used inside the
 * connection block. Most are eager (assigned at index.js module-load);
 * four are lazily-initialized inside `startServer()` and passed via
 * getter functions so the lookup happens at call time, not at
 * registration time:
 *
 *   getViewbotService          → returns module-scope `viewbotService`
 *   getRecordingService        → returns module-scope `recordingService`
 *   getTranscriptionService    → returns module-scope `transcriptionService`
 *
 * The body below is byte-equivalent to the pre-PR inline version — same
 * order, same logger messages, same per-handler dep bags forwarded to
 * each `register*Handler(io, socket, ...)` call.
 */

const logger = require('./logger').child({ svc: 'register-socket-handlers' });

function registerSocketHandlers(io, deps) {
    const {
        // Connection-level services
        IPBanService,
        authService,
        sessionService,

        // Per-handler register functions
        registerStreamHandler,
        registerBuffHandler,
        registerDrawingHandler,
        registerAdminHandler,
        registerGameHandler,
        registerDisconnectHandler,

        // Connection-level service touches
        canvasFxService,

        // Per-handler deps — service refs (eager)
        streamService,
        takeoverService,
        mediasoupService,
        testStreamService,
        timeTrackingService,
        buffDebuffService,
        streamingLogsService,
        SimpleViewBotRotation,
        plainTransportService,
        lifecycleManager,
        itemService,
        inventoryService,
        gameStreamService,
        gameService,
        accountService,

        // Per-handler deps — shared module-scope state
        notifiedStreamers,
        viewbotSocketIds,
        lastEmittedStreamReady,

        // Per-handler deps — orchestration helpers + cache helpers (eager)
        enrichStreamStatus,
        verifyAndEmitStreamReady,
        getStreamerDisplayName,
        notifyViewersStreamStarted,
        notifyViewersStreamEnded,
        broadcastGlobalCooldown,
        cleanupViewbotUsername,

        // Per-handler deps — chokepoint notifiers
        streamNotifier,
        viewerCountNotifier,
        buffNotifier,

        // Per-handler deps — utility imports
        runAsync,
        database,
        axios,
        https,

        // Per-handler deps — LAZY service getters (resolved at call time
        // because viewbotService / recordingService / transcriptionService
        // are assigned inside startServer() — see server/index.js' PR-15B.1
        // closure-audit notes).
        getViewbotService,
        getRecordingService,
        getTranscriptionService,
    } = deps;

    io.on('connection', async (socket) => {
        logger.info(`🆕 NEW CONNECTION: Socket ${socket.id} connected at ${new Date().toISOString()}`);

        // Check if IP is banned
        const clientIP = IPBanService.getIPFromSocket(socket);
        const isBanned = await IPBanService.isIPBanned(clientIP);

        if (isBanned) {
            logger.info(`🚫 CONNECTION: Banned IP attempted to connect: ${clientIP}`);
            socket.emit('banned', {
                reason: 'Your IP address has been banned from this service',
                timestamp: new Date().toISOString(),
            });
            socket.disconnect(true);
            return;
        }

        // Handle authentication if token is provided
        const token = socket.handshake.auth?.token;
        logger.info({ token: !!token }, `🔑 SOCKET AUTH: Token provided for ${socket.id}`);

        let authenticatedUserId = null;
        if (token) {
            try {
                const decoded = authService.verifyToken(token);
                authenticatedUserId = decoded.id;
                logger.info(`✅ SOCKET AUTH: User authenticated: ${socket.id} -> User ID ${authenticatedUserId}`);
            } catch (error) {
                logger.info({ err: error }, `❌ SOCKET AUTH: Invalid token for ${socket.id}`);
            }
        }

        // Register session for this socket
        const session = sessionService.registerSocket(socket);
        const ip = sessionService.getIpAddress(socket);

        // Associate authenticated user with session if available, or clear if anonymous
        if (authenticatedUserId) {
            sessionService.linkUserToSession(ip, authenticatedUserId);
            sessionService.linkUserToSocket(socket.id, authenticatedUserId);
            logger.info(`🔗 SOCKET AUTH: Associated user ${authenticatedUserId} with session for IP ${ip}`);
        } else {
            sessionService.linkUserToSession(ip, null);
            sessionService.linkUserToSocket(socket.id, null);
            logger.info(`🔗 SOCKET AUTH: Cleared user ID for anonymous connection from IP ${ip}`);
        }

        logger.info(`📡 SOCKET: User connected: ${socket.id} from IP: ${ip}, session: ${JSON.stringify(session)}`);

        // Debug: Log all events for ViewBot connections
        socket.onAny((eventName, ...args) => {
            logger.info(`🔴 DEBUG: Socket ${socket.id} received event '${eventName}'`);
            if (eventName === 'request-to-stream') {
                logger.info({ args }, `🔴 DEBUG: request-to-stream args`);
            }
        });

        registerStreamHandler(io, socket, {
            streamService,
            sessionService,
            takeoverService,
            mediasoupService,
            testStreamService,
            timeTrackingService,
            buffDebuffService,
            streamingLogsService,
            recordingService: getRecordingService(),
            SimpleViewBotRotation,
            IPBanService,
            notifiedStreamers,
            viewbotSocketIds,
            lastEmittedStreamReady,
            getViewbotService,
            enrichStreamStatus,
            getStreamerDisplayName,
            notifyViewersStreamStarted,
            notifyViewersStreamEnded,
            broadcastGlobalCooldown,
            runAsync,
            database,
            axios,
            https,
            streamNotifier,
            viewerCountNotifier,
            buffNotifier,
        });

        registerBuffHandler(io, socket, {
            itemService,
            inventoryService,
            buffDebuffService,
            viewbotService: getViewbotService(),
            streamService,
            sessionService,
            buffNotifier,
        });

        // Canvas effects handlers
        canvasFxService.handleClientConnection(socket);

        // Drawing path broadcast handlers (no deps bag).
        registerDrawingHandler(io, socket);

        // Admin socket handlers.
        registerAdminHandler(io, socket, { gameStreamService });

        registerGameHandler(io, socket, {
            gameService,
            gameStreamService,
            sessionService,
            accountService,
        });

        registerDisconnectHandler(io, socket, {
            lifecycleManager,
            mediasoupService,
            sessionService,
            timeTrackingService,
            notifiedStreamers,
            viewbotSocketIds,
            cleanupViewbotUsername,
            plainTransportService,
            streamService,
            takeoverService,
            streamingLogsService,
            streamNotifier,
            notifyViewersStreamEnded,
            viewerCountNotifier,
            SimpleViewBotRotation,
            getViewbotService,
        });
    });
}

module.exports = registerSocketHandlers;
