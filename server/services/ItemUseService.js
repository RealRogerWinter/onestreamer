const logger = require('../bootstrap/logger').child({ svc: 'ItemUseService' });

const AutoTriggerHandler = require('./itemUse/AutoTriggerHandler');
const InteractiveHandler = require('./itemUse/InteractiveHandler');
const BuffDebuffHandler = require('./itemUse/BuffDebuffHandler');
const CooldownModifierHandler = require('./itemUse/CooldownModifierHandler');
const UtilityValidationHandler = require('./itemUse/UtilityValidationHandler');
const RegularHandler = require('./itemUse/RegularHandler');

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
// broadcasts, same log-spam shape (callers tail logs for forensics).
//
// The per-item-type effect handlers live in cohesive collaborators under
// ./itemUse/, each holding an `owner` back-reference to this service. The
// `_apply*` methods below are thin delegators with identical signatures so
// the dispatch tree in `useItem` (and any jest.spyOn on those names) is
// unchanged. The single public entry is `useItem`.

class ItemUseService {
    /**
     * @param {object} [deps]
     * @param {object} [deps.drawingService]   reserved for future delegation
     * @param {object} [deps.throwingService]  reserved for future delegation
     */
    constructor(deps = {}) {
        this.drawingService = deps.drawingService || null;
        this.throwingService = deps.throwingService || null;

        this._autoTriggerHandler = new AutoTriggerHandler(this);
        this._interactiveHandler = new InteractiveHandler(this);
        this._buffDebuffHandler = new BuffDebuffHandler(this);
        this._cooldownModifierHandler = new CooldownModifierHandler(this);
        this._utilityValidationHandler = new UtilityValidationHandler(this);
        this._regularHandler = new RegularHandler(this);
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
     * @param {object} [opts.services.webrtcService]
     * @param {object} [opts.io]
     * @param {object} [opts.sessionService]
     * @param {Function} opts.sendSystemMessage  async (message, username?) -> void
     */
    async useItem({ user, itemId, body: _body, services, io, sessionService, sendSystemMessage, buffNotifier }) {
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

            logger.debug(`🎯 ITEMS: Item "${item.display_name}" (${item.item_type}) being used by user ${userId}`);
            logger.debug(`🎯 ITEMS: Item ID: ${item.id}, Name: ${item.name}`);
            logger.debug(`🎯 ITEMS: Effect Data: ${item.effect_data}`);

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
                logger.debug(`🌩️ ITEMS: ${item.name} detected - setting autoTrigger to true`);
            } else if (isInteractiveItem && canvasFxService) {
                const interactionConfig = canvasFxService.getInteractionConfig(item);
                isAutoTrigger = interactionConfig && interactionConfig.autoTrigger;
                logger.debug(`🔍 ITEMS: Item ${item.name} - autoTrigger: ${isAutoTrigger}`);
            }

            logger.debug(`🎯 ITEMS DEBUG: Item ${item.name} - isInteractiveItem: ${isInteractiveItem}, isAutoTrigger: ${isAutoTrigger}, isTTSItem: ${isTTSItem}, item_type: ${item.item_type}`);

            // Check if this is a buff/debuff item
            const isBuffDebuffItem = itemService.isBuffOrDebuffItem(item);

            // Check if this is a cooldown modifier item (guard or weapon)
            const isCooldownModifier = itemService.isCooldownModifierItem(item);
            logger.debug(`🔍 ITEMS DEBUG: Item "${item.display_name}" - Type: ${item.item_type}, isBuffDebuffItem: ${isBuffDebuffItem}, isCooldownModifier: ${isCooldownModifier}`);

            // Extra debugging for fortress_wall specifically
            if (item.name === 'fortress_wall') {
                logger.debug(`🏰 FORTRESS DEBUG: This is the fortress_wall item!`);
                logger.debug(`🏰 FORTRESS DEBUG: Should take cooldown modifier path`);
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
            logger.error('Error using item:', error);
            if (error.message && error.message.includes('cooldown')) {
                return { ok: false, kind: 'cooldown', message: error.message };
            }
            return { ok: false, kind: 'error', message: error.message || 'Failed to use item', cause: error };
        }
    }

    // ----------------- Sub-methods (thin delegators) -----------------
    //
    // Each delegates to its cohesive collaborator under ./itemUse/. Signatures
    // are identical to the original inline methods so the dispatch tree in
    // `useItem` and any `jest.spyOn(service, '_applyX')` continue to work.

    async _applyAutoTrigger(ctx) {
        return this._autoTriggerHandler._applyAutoTrigger(ctx);
    }

    async _applyInteractiveValidation(ctx) {
        return this._interactiveHandler._applyInteractiveValidation(ctx);
    }

    async _applyBuffOrDebuff(ctx) {
        return this._buffDebuffHandler._applyBuffOrDebuff(ctx);
    }

    async _applyCooldownModifier(ctx) {
        return this._cooldownModifierHandler._applyCooldownModifier(ctx);
    }

    async _applyUtilityValidation(ctx, opts) {
        return this._utilityValidationHandler._applyUtilityValidation(ctx, opts);
    }

    async _applyRegular(ctx) {
        return this._regularHandler._applyRegular(ctx);
    }
}

module.exports = ItemUseService;
