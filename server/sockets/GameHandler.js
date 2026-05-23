/**
 * GameHandler
 *
 * Registers the in-game socket events on a per-connection basis.
 * Continuation of PR-H's socket-extraction pattern (see AdminHandler).
 *
 * Handlers (all logic byte-equivalent to the original inline versions):
 *   - admin:start-game     Admin-only. Start a game stream.
 *   - admin:stop-game      Admin-only. Stop a game stream.
 *   - game:join            Player joins the active game (requires auth).
 *   - game:leave           Player leaves the game.
 *   - game:input           Player sends a movement/action input frame.
 *   - game:use-item        Player uses an inventory item in-game.
 *   - game:interact        Player triggers a world interaction.
 *   - disconnect           Game-specific cleanup if the disconnecting socket
 *                          owned the active game player. Coexists with the
 *                          main disconnect handler in server/index.js — both
 *                          run because socket.io allows multiple listeners
 *                          on the same event.
 *
 * `deps` (all required):
 *   - gameService          Active game runtime.
 *   - gameStreamService    Start/stop wrapper around game-stream takeover.
 *   - sessionService       Socket -> session lookup.
 *   - accountService       Used to load `is_admin` for admin-gated events.
 */
module.exports = function registerGameHandler(io, socket, deps) {
  const { gameService, gameStreamService, sessionService, accountService } = deps;

  // Admin: Start game
  socket.on('admin:start-game', async (data, callback) => {
    try {
      // Check if user is admin
      const session = sessionService.getSessionBySocketId(socket.id);
      const userId = session?.userId;

      if (!userId) {
        console.log('🎮 GAME: Unauthenticated user tried to start game');
        if (callback) callback({ success: false, error: 'Authentication required' });
        return;
      }

      // Get user from database to check admin status
      const user = await accountService.getUserById(userId);
      if (!user || !user.is_admin) {
        console.log('🎮 GAME: Non-admin tried to start game');
        if (callback) callback({ success: false, error: 'Admin privileges required' });
        return;
      }

      console.log(`🎮 GAME: Admin ${userId} starting game`);

      const result = await gameStreamService.startGameStream(userId);

      if (callback) callback(result);
    } catch (error) {
      console.error('🎮 GAME: Error starting game:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Admin: Stop game
  socket.on('admin:stop-game', async (data, callback) => {
    try {
      // Check if user is admin
      const session = sessionService.getSessionBySocketId(socket.id);
      const userId = session?.userId;

      if (!userId) {
        console.log('🎮 GAME: Unauthenticated user tried to stop game');
        if (callback) callback({ success: false, error: 'Authentication required' });
        return;
      }

      // Get user from database to check admin status
      const user = await accountService.getUserById(userId);
      if (!user || !user.is_admin) {
        console.log('🎮 GAME: Non-admin tried to stop game');
        if (callback) callback({ success: false, error: 'Admin privileges required' });
        return;
      }

      console.log(`🎮 GAME: Admin ${userId} stopping game`);

      const result = await gameStreamService.stopGameStream(userId);

      if (callback) callback(result);
    } catch (error) {
      console.error('🎮 GAME: Error stopping game:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Player: Join game
  socket.on('game:join', async (data) => {
    try {
      if (!gameService.isActive) {
        socket.emit('game:error', { message: 'Game not active', code: 'GAME_NOT_ACTIVE' });
        return;
      }

      // Get user from session
      const session = sessionService.getSessionBySocketId(socket.id);
      if (!session || !session.userId) {
        socket.emit('game:error', { message: 'Must be logged in to play', code: 'NOT_AUTHENTICATED' });
        return;
      }

      const userId = session.userId;
      const userData = session.userData || {};

      console.log(`🎮 GAME: Player ${userData.username || userId} joining game`);

      const player = await gameService.handlePlayerJoin(socket, userId, {
        username: userData.username || `Player${userId}`,
        chatColor: userData.chat_color
      });

      if (player) {
        socket.emit('game:joined', {
          playerId: player.id,
          player: gameService.playerManager.getPlayerFullState(player)
        });
      }
    } catch (error) {
      console.error('🎮 GAME: Error joining game:', error);
      socket.emit('game:error', { message: 'Failed to join game', code: 'JOIN_ERROR' });
    }
  });

  // Player: Leave game
  socket.on('game:leave', async () => {
    try {
      const session = sessionService.getSessionBySocketId(socket.id);
      if (session?.userId) {
        await gameService.handlePlayerLeave(session.userId, socket.id);
        console.log(`🎮 GAME: Player ${session.userId} left game`);
      }
    } catch (error) {
      console.error('🎮 GAME: Error leaving game:', error);
    }
  });

  // Player: Send input (movement/actions)
  socket.on('game:input', (data) => {
    try {
      if (!gameService.isActive) return;

      const session = sessionService.getSessionBySocketId(socket.id);
      if (!session?.userId) return;

      gameService.handlePlayerInput(session.userId, data);
    } catch (error) {
      console.error('🎮 GAME: Error processing input:', error);
    }
  });

  // Player: Use item
  socket.on('game:use-item', (data) => {
    try {
      if (!gameService.isActive) return;

      const session = sessionService.getSessionBySocketId(socket.id);
      if (!session?.userId) return;

      gameService.handlePlayerInput(session.userId, {
        type: 'action',
        action: { type: 'use-item', itemId: data.itemId }
      });
    } catch (error) {
      console.error('🎮 GAME: Error using item:', error);
    }
  });

  // Player: Interact with world
  socket.on('game:interact', () => {
    try {
      if (!gameService.isActive) return;

      const session = sessionService.getSessionBySocketId(socket.id);
      if (!session?.userId) return;

      gameService.handlePlayerInput(session.userId, {
        type: 'action',
        action: { type: 'interact' }
      });
    } catch (error) {
      console.error('🎮 GAME: Error interacting:', error);
    }
  });

  // Handle game player disconnect on socket disconnect
  socket.on('disconnect', () => {
    // Check if this socket was in the game
    const session = sessionService.getSessionBySocketId(socket.id);
    if (session?.userId && gameService.isActive) {
      const player = gameService.playerManager.getPlayer(session.userId);
      if (player && player.socketId === socket.id) {
        gameService.handlePlayerLeave(session.userId, socket.id).catch(err => {
          console.error('🎮 GAME: Error handling disconnect:', err);
        });
      }
    }
  });
};
