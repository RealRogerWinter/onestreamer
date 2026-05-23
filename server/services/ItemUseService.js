// server/services/ItemUseService.js
//
// Stateless orchestrator for the `/inventory/use/:itemId` mega-handler
// extracted from server/routes/items.js (PR-J3). Mirrors the DrawingService
// (PR-J) and ThrowingService (PR-J2) discriminated-result pattern so the
// route handler stays a thin mapping layer over HTTP status codes.
//
// This service owns the full per-item dispatch tree previously embedded in
// the route handler:
//   1. auto-trigger items (fart, thunderstorm)
//   2. interactive items (click-to-throw / click-to-draw — validate only,
//      defer consumption to /inventory/throw or /inventory/drawing-start)
//   3. buff/debuff items targeting the current streamer
//   4. cooldown-modifier items (guard / weapon)
//   5. TTS / soundboard / summon-bot items (validate only, await follow-up)
//   6. regular consumed items (incl. kill_switch and fart-from-regular-path)
//
// Behaviour MUST be byte-equivalent to the original handler: same status
// codes, same response shape, same DB writes, same socket emits, same chat
// broadcasts, same console.log spam (callers tail logs for forensics).
//
// Sub-methods are organised by item-type branch and are private-by-convention
// (leading underscore). The single public entry is `useItem`.

class ItemUseService {
    /**
     * @param {object} [deps]
     * @param {object} [deps.drawingService]   reserved for future delegation
     * @param {object} [deps.throwingService]  reserved for future delegation
     */
    constructor(deps = {}) {
        this.drawingService = deps.drawingService || null;
        this.throwingService = deps.throwingService || null;
    }

    /**
     * Use an inventory item. Discriminated result:
     *
     *   { ok: true, status?: number, body: <response JSON> }
     *     -> route maps to res.status(status || 200).json(body)
     *
     *   { ok: false, kind: 'item-not-found' }
     *   { ok: false, kind: 'not-in-inventory' }
     *   { ok: false, kind: 'no-active-stream' }
     *   { ok: false, kind: 'no-streamer-target' }
     *   { ok: false, kind: 'no-active-streamer-killswitch' }
     *   { ok: false, kind: 'service-unavailable', service: string }
     *   { ok: false, kind: 'killswitch-failed' }
     *   { ok: false, kind: 'validation-failed', error, cooldownRemaining? }
     *   { ok: false, kind: 'cooldown', message }
     *   { ok: false, kind: 'error', message, cause? }
     *
     * @param {object} opts
     * @param {object} opts.user
     * @param {string|number} opts.itemId
     * @param {object} opts.body  reserved — currently unused for use-item; kept for parity with sibling services
     * @param {object} opts.services
     * @param {object} opts.services.inventoryService
     * @param {object} opts.services.itemService
     * @param {object} opts.services.streamService
     * @param {object} [opts.services.canvasFxService]
     * @param {object} [opts.services.buffDebuffService]
     * @param {object} [opts.services.takeoverService]
     * @param {object} [opts.services.soundFxService]
     * @param {object} [opts.services.mediasoupService]
     * @param {object} [opts.io]
     * @param {object} [opts.sessionService]
     * @param {Function} opts.sendSystemMessage  async (message, username?) -> void
     */
    async useItem({ user, itemId, body: _body, services, io, sessionService, sendSystemMessage }) {
        const userId = user.userId || user.id;
        const { inventoryService, itemService, streamService, canvasFxService } = services;

        try {
            const streamStatus = streamService.getStreamStatus();
            const streamId = streamStatus.hasActiveStream ? streamStatus.streamerId : null;

            // Get item details first
            const item = await itemService.getItemById(itemId);
            if (!item) {
                return { ok: false, kind: 'item-not-found' };
            }

            console.log(`🎯 ITEMS: Item "${item.display_name}" (${item.item_type}) being used by user ${userId}`);
            console.log(`🎯 ITEMS: Item ID: ${item.id}, Name: ${item.name}`);
            console.log(`🎯 ITEMS: Effect Data: ${item.effect_data}`);

            // Check if this is a TTS item that needs text input
            const isTTSItem = item.name === 'megaphone' || item.name === 'tts_message';

            // Check if this is a soundboard item that needs URL input
            const isSoundboardItem = item.name === '101soundboards';

            // Check if this is a summon bot item
            const isSummonBotItem = item.name === 'summon_bot' || item.name === 'summon_lesser_bot';

            // Check if this is an interactive item that needs click-to-throw
            const isInteractiveItem = canvasFxService && canvasFxService.isInteractiveItem(item);

            // But first check if it's an auto-trigger item that should fire immediately
            // Special case for fart and thunderstorm which are auto-trigger but not interactive
            let isAutoTrigger = false;
            if (item.name === 'fart' || item.name === 'thunderstorm') {
                isAutoTrigger = true; // Fart and thunderstorm always auto-trigger
                console.log(`🌩️ ITEMS: ${item.name} detected - setting autoTrigger to true`);
            } else if (isInteractiveItem && canvasFxService) {
                const interactionConfig = canvasFxService.getInteractionConfig(item);
                isAutoTrigger = interactionConfig && interactionConfig.autoTrigger;
                console.log(`🔍 ITEMS: Item ${item.name} - autoTrigger: ${isAutoTrigger}`);
            }

            console.log(`🎯 ITEMS DEBUG: Item ${item.name} - isInteractiveItem: ${isInteractiveItem}, isAutoTrigger: ${isAutoTrigger}, isTTSItem: ${isTTSItem}, item_type: ${item.item_type}`);

            // Check if this is a buff/debuff item
            const isBuffDebuffItem = itemService.isBuffOrDebuffItem(item);

            // Check if this is a cooldown modifier item (guard or weapon)
            const isCooldownModifier = itemService.isCooldownModifierItem(item);
            console.log(`🔍 ITEMS DEBUG: Item "${item.display_name}" - Type: ${item.item_type}, isBuffDebuffItem: ${isBuffDebuffItem}, isCooldownModifier: ${isCooldownModifier}`);

            // Extra debugging for fortress_wall specifically
            if (item.name === 'fortress_wall') {
                console.log(`🏰 FORTRESS DEBUG: This is the fortress_wall item!`);
                console.log(`🏰 FORTRESS DEBUG: Should take cooldown modifier path`);
            }

            const ctx = {
                user, userId, itemId, item, streamId, streamStatus,
                services, io, sessionService, sendSystemMessage
            };

            // IMPORTANT: Check auto-trigger FIRST, then interactive items
            if (isAutoTrigger) {
                return this._applyAutoTrigger(ctx);
            } else if (isInteractiveItem) {
                return this._applyInteractiveValidation(ctx);
            } else if (isBuffDebuffItem && !isInteractiveItem) {
                return this._applyBuffOrDebuff(ctx);
            } else if (isCooldownModifier) {
                return this._applyCooldownModifier(ctx);
            } else if (isTTSItem) {
                return this._applyUtilityValidation(ctx, { mode: 'tts', flag: 'ttsMode', message: 'TTS input required', includeCooldownRemaining: false });
            } else if (isSummonBotItem) {
                return this._applyUtilityValidation(ctx, { mode: 'summon-bot', flag: 'summonBotMode', message: 'Bot customization required', includeCooldownRemaining: true });
            } else if (isSoundboardItem) {
                return this._applyUtilityValidation(ctx, { mode: 'soundboard', flag: 'soundboardMode', message: 'Soundboard URL input required', includeCooldownRemaining: false });
            } else if (isInteractiveItem && !isAutoTrigger) {
                // Dead in practice because the first isInteractiveItem branch
                // above already covers this — but kept for parity with the
                // original handler's control flow.
                return this._applyInteractiveValidation(ctx);
            } else {
                return this._applyRegular(ctx);
            }
        } catch (error) {
            console.error('Error using item:', error);
            if (error.message && error.message.includes('cooldown')) {
                return { ok: false, kind: 'cooldown', message: error.message };
            }
            return { ok: false, kind: 'error', message: error.message || 'Failed to use item', cause: error };
        }
    }

    // ----------------- Sub-methods -----------------

    async _applyAutoTrigger(ctx) {
        const { user, userId, itemId, item, streamId, services, sendSystemMessage } = ctx;
        const { inventoryService, canvasFxService, soundFxService } = services;

        console.log(`🔥 ITEMS: Auto-trigger item ${item.display_name} - consuming immediately`);

        // Consume the item
        const usageResult = await inventoryService.useItem(userId, itemId, streamId);

        // Special handling for Fart item
        if (item.name === 'fart') {
            console.log(`💨 ITEMS: Fart item auto-triggered by ${user.username}`);

            // Queue the sound effect first
            if (soundFxService) {
                soundFxService.queue101Soundboard(
                    userId,
                    user.username,
                    'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                    { streamId }
                ).then(() => {
                    console.log(`🔊 ITEMS: Fart sound effect queued`);
                }).catch(error => {
                    console.error('❌ ITEMS: Failed to play fart sound:', error);
                });
            }

            // Delay the visual effect by 1 second to sync with sound
            setTimeout(() => {
                if (canvasFxService) {
                    canvasFxService.triggerItemEffect(
                        userId,
                        usageResult.item.id,
                        streamId,
                        {
                            position: { x: 0.5, y: 0.7 } // Center-bottom of screen
                        }
                    ).then(() => {
                        console.log(`💨 ITEMS: Fart visual effect triggered (after 1000ms delay)`);
                    }).catch(error => {
                        console.error('❌ ITEMS: Failed to trigger fart visual:', error);
                    });
                }
            }, 2000); // 2 second delay to sync with sound

            // Send chat message
            await sendSystemMessage(`💨 ${user.username} let one rip!`, '🤖 StreamBot');
        }

        // Special handling for Thunderstorm item
        if (item.name === 'thunderstorm') {
            console.log(`⛈️ ITEMS: Thunderstorm item auto-triggered by ${user.username}`);

            if (soundFxService) {
                soundFxService.queue101Soundboard(
                    userId,
                    user.username,
                    'https://www.101soundboards.com/sounds/74377-thunderstorm',
                    { streamId }
                ).then(() => {
                    console.log(`🔊 ITEMS: Thunderstorm sound effect queued`);
                }).catch(error => {
                    console.error('❌ ITEMS: Failed to play thunderstorm sound:', error);
                });
            }

            setTimeout(() => {
                if (canvasFxService) {
                    canvasFxService.triggerItemEffect(
                        userId,
                        usageResult.item.id,
                        streamId,
                        {
                            position: { x: 0.5, y: 0.5 } // Center of screen
                        }
                    ).then(() => {
                        console.log(`⛈️ ITEMS: Thunderstorm visual effect triggered (after 2 second delay)`);
                    }).catch(error => {
                        console.error('❌ ITEMS: Failed to trigger thunderstorm visual:', error);
                    });
                }
            }, 2000); // 2 second delay to sync with sound

            await sendSystemMessage(`⛈️ ${user.username} summoned a thunderstorm!`, '🤖 StreamBot');
        }

        // Get interaction config for response
        const interactionConfig = canvasFxService ? canvasFxService.getInteractionConfig(item) : null;

        return {
            ok: true,
            body: {
                success: true,
                item: usageResult.item,
                remainingQuantity: usageResult.remainingQuantity,
                interactionMode: 'auto-trigger',
                interactionConfig,
                message: 'Auto-trigger item activated'
            }
        };
    }

    async _applyInteractiveValidation(ctx) {
        const { user, userId, itemId, item, streamId, streamStatus, services, io, sessionService } = ctx;
        const { inventoryService, itemService, canvasFxService } = services;

        console.log(`🎯 ITEMS: Taking interactive item path for ${item.display_name}`);

        // Check if there's an active stream for interactive items
        // Allow anonymous streamers too - check both hasActiveStream and MediaSoup
        const mediasoupService = services.mediasoupService;
        const hasMediaSoupStreamer = mediasoupService && mediasoupService.currentStreamer;

        if (!streamStatus.hasActiveStream && !hasMediaSoupStreamer) {
            console.log(`❌ ITEMS: No active stream for interactive item ${item.display_name}`);
            console.log(`   StreamService hasActiveStream: ${streamStatus.hasActiveStream}`);
            console.log(`   MediasoupService currentStreamer: ${hasMediaSoupStreamer}`);
            return { ok: false, kind: 'no-active-stream' };
        } else if (!streamStatus.hasActiveStream && hasMediaSoupStreamer) {
            console.log(`⚠️ ITEMS: StreamService says no stream but MediaSoup has streamer - allowing for anonymous`);
        }

        // For interactive items, only validate but don't consume the item yet
        const inventoryItem = await inventoryService.getInventoryItem(userId, itemId);
        if (!inventoryItem || inventoryItem.quantity < 1) {
            return { ok: false, kind: 'not-in-inventory' };
        }

        // Validate item usage (cooldown check)
        const validation = await itemService.validateItemUsage(userId, itemId);
        if (!validation.valid) {
            return {
                ok: false,
                kind: 'validation-failed',
                error: validation.error || 'Cannot use item',
                cooldownRemaining: validation.cooldownRemaining
            };
        }

        // Get interaction config for the item
        const interactionConfig = canvasFxService.getInteractionConfig(item);

        // Return success with interaction mode - client should enable click-to-throw UI
        const result = {
            success: true,
            item: {
                id: item.id,
                name: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: item.item_type
            },
            remainingQuantity: inventoryItem.quantity,
            interactionMode: interactionConfig?.mode || 'click-to-throw',
            interactionConfig: interactionConfig,
            message: 'Interaction mode activated'
        };

        // Create a unique interaction ID for tracking
        const interactionId = `interact_${userId}_${item.id}_${Date.now()}`;
        result.interactionId = interactionId;

        // For drawing items, the interaction mode is different
        if (interactionConfig && interactionConfig.mode === 'click-to-draw') {
            result.message = 'Drawing mode activated';
        }

        // Notify the specific user's socket to enable interaction mode
        if (io && sessionService) {
            const userSocketIds = sessionService.getSocketsByUserId(userId);
            userSocketIds.forEach(socketId => {
                io.to(socketId).emit('canvas-effect-mode', {
                    mode: interactionConfig?.mode || 'click-to-throw',
                    item: result.item,
                    interactionConfig: interactionConfig,
                    userId: userId,
                    username: user.username,
                    streamId,
                    interactionId: interactionId
                });
            });
        }

        return { ok: true, body: result };
    }

    async _applyBuffOrDebuff(ctx) {
        const { user, userId, itemId, item, streamId, services, io, sessionService, sendSystemMessage } = ctx;
        const { inventoryService, itemService, streamService } = services;

        console.log(`🎭 ITEMS: Taking buff/debuff path for ${item.display_name}`);
        // Handle buff/debuff items
        const buffDebuffService = services.buffDebuffService;
        if (!buffDebuffService) {
            return { ok: false, kind: 'service-unavailable', service: 'buffDebuffService' };
        }

        // Get the current streamer to determine target
        // Try StreamService first (works for MediaSoup and synced LiveKit)
        let currentStreamerSocketId = streamService.getCurrentStreamer();

        // LIVEKIT FIX: Fallback to mediasoupService/webrtcAdapter if StreamService has no streamer
        const mediasoupService = services.mediasoupService;
        if (!currentStreamerSocketId && mediasoupService) {
            currentStreamerSocketId = mediasoupService.getCurrentStreamer();
            if (currentStreamerSocketId) {
                console.log(`🎭 ITEMS: Using mediasoupService/webrtcAdapter fallback for streamer: ${currentStreamerSocketId}`);
            }
        }

        let targetUserId = null;

        if (currentStreamerSocketId && sessionService) {
            const session = sessionService.getSessionBySocketId(currentStreamerSocketId);
            if (session && session.userId) {
                // Accept any user ID, including negative IDs for anonymous/viewbot users
                targetUserId = session.userId;
                if (targetUserId < 0) {
                    console.log(`🎭 ITEMS: Found anonymous/viewbot streamer with synthetic ID: ${targetUserId}`);
                } else {
                    console.log(`🎭 ITEMS: Found current streamer userId: ${targetUserId}`);
                }
            } else {
                console.log(`🎭 ITEMS: No session found for current streamer ${currentStreamerSocketId}`);
            }
        } else {
            console.log(`🎭 ITEMS: No current streamer or session service unavailable`);
        }

        if (!targetUserId) {
            return { ok: false, kind: 'no-streamer-target' };
        }

        // Consume the item from inventory
        const result = await inventoryService.useItem(userId, itemId, streamId);

        // Apply the buff/debuff
        try {
            console.log(`🎭 ITEMS: About to call applyBuffDebuffItem with params:`, {
                targetUserId,
                itemId,
                appliedByUserId: userId,
                hasBuffDebuffService: !!buffDebuffService,
                streamId
            });

            const buffResult = await itemService.applyBuffDebuffItem(
                targetUserId,
                itemId,
                userId,
                buffDebuffService,
                true, // Skip cooldown validation since we already consumed the item
                streamId // Pass the stream ID for visual effects
            );

            console.log(`🎭 ITEMS: applyBuffDebuffItem returned:`, buffResult);

            // Add the buff result to the response
            result.buffResult = buffResult;
            result.targetUserId = targetUserId;
            result.message = `${result.item.displayName} applied to streamer successfully!`;

            console.log(`🎭 ITEMS: Applied ${result.item.displayName} buff/debuff to user ${targetUserId}`);

            // Send system message about the effect
            const effectMessage = `${user.username} used ${result.item.displayName} on the streamer!`;
            console.log(`📨 ITEMS: Sending buff/debuff chat message: "${effectMessage}"`);
            await sendSystemMessage(effectMessage);

        } catch (buffError) {
            console.error('Error applying buff/debuff effect:', buffError);
            result.message = `${result.item.displayName} used but buff/debuff effect failed: ${buffError.message}`;
        }

        // Emit socket events for buff/debuff items
        if (io) {
            io.emit('item-used', {
                userId: userId,
                username: user.username,
                item: result.item,
                targetUserId: targetUserId,
                streamId,
                buffResult: result.buffResult
            });

            // Specific inventory update for the user
            if (sessionService) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    io.to(socketId).emit('inventory-updated', {
                        action: 'use',
                        itemId,
                        quantity: 1,
                        remainingQuantity: result.remainingQuantity
                    });
                });
            }
        }

        return { ok: true, body: result };
    }

    async _applyCooldownModifier(ctx) {
        const { user, userId, itemId, item, streamId, services, io, sessionService, sendSystemMessage } = ctx;
        const { inventoryService, itemService } = services;

        console.log(`🛡️⚔️ ITEMS: Taking cooldown modifier path for ${item.display_name}`);
        // Handle cooldown modifier items
        const takeoverService = services.takeoverService;
        if (!takeoverService) {
            return { ok: false, kind: 'service-unavailable', service: 'takeoverService' };
        }

        // Consume the item from inventory
        const result = await inventoryService.useItem(userId, itemId, streamId);

        // Apply the cooldown modification
        try {
            const cooldownResult = await itemService.applyCooldownModifierItem(
                userId,
                itemId,
                userId,
                takeoverService,
                true // Skip cooldown validation since we already consumed the item
            );

            // Add the cooldown effects to the result
            result.cooldownEffects = cooldownResult.effects;
            result.message = `${result.item.displayName} used successfully! ${cooldownResult.effects.map(e => e.message).join(', ')}`;

            console.log(`🛡️⚔️ ITEMS: Applied ${result.item.displayName} cooldown effects:`, cooldownResult.effects);

            // CRITICAL DEBUG: Check cooldown immediately after modification
            const immediateCheck = await takeoverService.getGlobalCooldownRemaining();
            console.log(`🔍 CRITICAL DEBUG: Cooldown remaining immediately after modification: ${immediateCheck}s`);

            // Send system message about the effect
            const effectMessages = cooldownResult.effects.map(effect => {
                if (effect.type === 'global_cooldown_increase') {
                    return `${user.username} used ${result.item.displayName} - Global cooldown extended by ${effect.amount}s!`;
                } else if (effect.type === 'global_cooldown_decrease') {
                    return `${user.username} used ${result.item.displayName} - Global cooldown reduced by ${effect.amount}s!`;
                } else if (effect.type === 'reset_individual_cooldowns') {
                    return `${user.username} used ${result.item.displayName} - Reset ${effect.count} individual cooldowns!`;
                } else if (effect.type === 'freeze_individual_cooldowns') {
                    return `${user.username} used ${result.item.displayName} - Froze ${effect.count} individual cooldowns for ${effect.duration}s!`;
                }
                return effect.message;
            });

            for (const message of effectMessages) {
                console.log(`📨 ITEMS: Sending cooldown modifier chat message: "${message}"`);
                await sendSystemMessage(message);
            }

        } catch (cooldownError) {
            console.error('Error applying cooldown effect:', cooldownError);
            result.message = `${result.item.displayName} used but cooldown effect failed: ${cooldownError.message}`;
        }

        // Emit socket events for cooldown modifier items
        if (io) {
            io.emit('item-used', {
                userId: userId,
                username: user.username,
                item: result.item,
                streamId,
                cooldownEffects: result.cooldownEffects
            });

            // Broadcast cooldown status update to all users
            const globalCooldownInfo = await itemService.getGlobalCooldownInfo(takeoverService);
            io.emit('cooldown-status-update', {
                globalCooldown: globalCooldownInfo,
                timestamp: Date.now()
            });

            // Specific inventory update for the user
            if (sessionService) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    io.to(socketId).emit('inventory-updated', {
                        action: 'use',
                        itemId,
                        quantity: 1,
                        remainingQuantity: result.remainingQuantity
                    });
                });
            }
        }

        return { ok: true, body: result };
    }

    /**
     * Shared validate-only path for TTS / soundboard / summon-bot items —
     * three near-identical branches that defer consumption to a follow-up
     * request once the client gathers user input.
     *
     * `opts` controls the small per-type differences:
     *   - `mode` log label (e.g. 'tts')
     *   - `flag` extra response flag (e.g. 'ttsMode')
     *   - `message` response.message string
     *   - `includeCooldownRemaining` summon-bot returns `cooldownRemaining`
     *     in the 429 body; tts / soundboard do not. (Matches the original
     *     handler exactly.)
     */
    async _applyUtilityValidation(ctx, opts) {
        const { userId, itemId, item, services } = ctx;
        const { inventoryService, itemService } = services;

        console.log(`🎯 ITEMS: Taking ${opts.mode} path for ${item.display_name}`);

        const inventoryItem = await inventoryService.getInventoryItem(userId, itemId);
        if (!inventoryItem || inventoryItem.quantity < 1) {
            return { ok: false, kind: 'not-in-inventory' };
        }

        // Validate item usage (cooldown check)
        const validation = await itemService.validateItemUsage(userId, itemId);
        if (!validation.valid) {
            const result = {
                ok: false,
                kind: 'validation-failed',
                error: validation.error || 'Cannot use item'
            };
            if (opts.includeCooldownRemaining) {
                result.cooldownRemaining = validation.cooldownRemaining;
            }
            return result;
        }

        // Special-case for summon_bot: log line matches the original handler
        if (opts.mode === 'summon-bot') {
            // Already covered by the top-of-method log; nothing more to add.
        }

        const body = {
            success: true,
            item: {
                id: item.id,
                name: item.name,
                displayName: item.display_name,
                emoji: item.emoji,
                type: item.item_type
                // Don't include cooldown - it should only be applied when item is actually used
            },
            remainingQuantity: inventoryItem.quantity,
            [opts.flag]: true,
            message: opts.message
        };

        return { ok: true, body };
    }

    async _applyRegular(ctx) {
        const {
            user, userId, itemId, item, streamId, services, io, sessionService, sendSystemMessage
        } = ctx;
        const { inventoryService, canvasFxService, streamService, soundFxService } = services;

        console.log(`🎯 ITEMS: Taking regular item path for ${item.display_name}`);
        // For non-interactive, non-cooldown-modifier items, use the original flow
        console.log(`🔍 ITEMS DEBUG: About to call inventoryService.useItem for ${item.display_name}`);
        const result = await inventoryService.useItem(userId, itemId, streamId);
        console.log(`🔍 ITEMS DEBUG: inventoryService.useItem completed for ${item.display_name}, result:`, result);

        // Special handling for Fart item (automatic sound + visual)
        if (item.name === 'fart') {
            console.log(`💨 ITEMS: Fart item activated by ${user.username}`);

            // Trigger the sound effect automatically
            if (soundFxService) {
                try {
                    await soundFxService.queue101Soundboard(
                        userId,
                        user.username,
                        'https://www.101soundboards.com/sounds/23972494-fart-reverb',
                        { streamId }
                    );
                    console.log(`🔊 ITEMS: Fart sound effect queued`);
                } catch (error) {
                    console.error('❌ ITEMS: Failed to play fart sound:', error);
                }
            }

            // Wait 2 seconds then trigger the visual effect
            setTimeout(() => {
                if (canvasFxService) {
                    canvasFxService.triggerItemEffect(
                        userId,
                        result.item.id,
                        streamId,
                        {
                            position: { x: 0.5, y: 0.7 } // Center-bottom of screen
                        }
                    ).then(() => {
                        console.log(`💨 ITEMS: Fart visual effect triggered (after 2 second delay)`);
                    }).catch(error => {
                        console.error('❌ ITEMS: Failed to trigger fart visual:', error);
                    });
                }
            }, 2000); // 2 second delay to sync with sound

            // Send chat message
            await sendSystemMessage(`💨 ${user.username} let one rip!`, '🤖 StreamBot');
        }

        // Special handling for Kill Switch after item consumption
        if (item.name === 'kill_switch') {
            console.log(`💥 ITEMS: Kill Switch activated by ${user.username} (user ${userId}) in regular path`);

            if (!streamService || !sessionService || !io) {
                console.error('❌ KILL SWITCH: Required services not available');
                return { ok: false, kind: 'killswitch-failed' };
            }

            // Get current streamer
            let currentStreamerSocketId = streamService.getCurrentStreamer();

            // LIVEKIT FIX: Fallback to mediasoupService/webrtcAdapter if StreamService has no streamer
            const mediasoupServiceForKillSwitch = services.mediasoupService;
            if (!currentStreamerSocketId && mediasoupServiceForKillSwitch) {
                currentStreamerSocketId = mediasoupServiceForKillSwitch.getCurrentStreamer();
                if (currentStreamerSocketId) {
                    console.log(`💥 KILL SWITCH: Using mediasoupService/webrtcAdapter fallback for streamer: ${currentStreamerSocketId}`);
                }
            }

            if (!currentStreamerSocketId) {
                console.log('❌ KILL SWITCH: No active streamer to disconnect');
                return { ok: false, kind: 'no-active-streamer-killswitch' };
            }

            console.log(`💥 KILL SWITCH: Current streamer socket: ${currentStreamerSocketId}`);

            // Get streamer's session info for logging
            const streamerSession = sessionService.getSessionBySocketId(currentStreamerSocketId);
            const streamerUsername = streamerSession?.username || 'Unknown';
            console.log(`💥 KILL SWITCH: Disconnecting streamer "${streamerUsername}" (socket: ${currentStreamerSocketId})`);

            // Force disconnect the current streamer
            try {
                // Send disconnect message to the streamer
                io.to(currentStreamerSocketId).emit('force-disconnect', {
                    reason: 'Kill Switch activated',
                    activatedBy: user.username,
                    message: '💥 Kill Switch has been activated! You have been disconnected.'
                });

                // Broadcast to all viewers that Kill Switch was used
                io.emit('kill-switch-activated', {
                    activatedBy: user.username,
                    targetStreamer: streamerUsername,
                    message: `💥 ${user.username} activated the Kill Switch! Stream disconnected.`
                });

                // Actually disconnect the socket after a brief delay
                setTimeout(() => {
                    const socket = io.sockets.sockets.get(currentStreamerSocketId);
                    if (socket) {
                        console.log(`💥 KILL SWITCH: Force disconnecting socket ${currentStreamerSocketId}`);
                        socket.disconnect(true);
                    }
                }, 1000); // 1 second delay to allow messages to be sent

                console.log(`✅ KILL SWITCH: Successfully activated by ${user.username}, disconnecting ${streamerUsername}`);

            } catch (error) {
                console.error('❌ KILL SWITCH: Error during force disconnect:', error);
                return { ok: false, kind: 'killswitch-failed' };
            }

            // Update inventory for the user (item already consumed)
            const userSocketIds = sessionService.getSocketsByUserId(userId);
            userSocketIds.forEach(socketId => {
                io.to(socketId).emit('inventory-updated', {
                    action: 'use',
                    itemId,
                    quantity: 1,
                    remainingQuantity: result.remainingQuantity
                });
            });

            return {
                ok: true,
                body: {
                    ...result,
                    killSwitchActivated: true,
                    targetStreamer: streamerUsername,
                    message: `💥 Kill Switch activated! ${streamerUsername} has been disconnected.`
                }
            };
        }

        // Trigger visual effect immediately for non-interactive items
        if (canvasFxService && result.item) {
            const effect = await canvasFxService.triggerItemEffect(
                userId,
                result.item.id,
                streamId,
                { username: user.username }
            );

            if (effect) {
                console.log(`🎨 ITEMS: Triggered visual effect for ${result.item.displayName}`);
            }
        }

        // Emit socket events for non-interactive items only
        if (io) {
            // Global event for all users to see item effects
            io.emit('item-used', {
                userId: userId,
                username: user.username,
                item: result.item,
                streamId
            });

            // Specific inventory update for the user
            if (sessionService) {
                const userSocketIds = sessionService.getSocketsByUserId(userId);
                userSocketIds.forEach(socketId => {
                    io.to(socketId).emit('inventory-updated', {
                        action: 'use',
                        itemId,
                        quantity: 1,
                        remainingQuantity: result.remainingQuantity
                    });
                });
            }
        }

        return { ok: true, body: result };
    }
}

module.exports = ItemUseService;
