/**
 * Pure presentation seam extracted from BuffDebuffService: maps a snake_case
 * active_buffs row (joined with item columns) into the camelCase shape the
 * client consumes, parsing the JSON metadata / effect_data columns. Holds an
 * `owner` back-reference for symmetry with the other collaborators; the body
 * is verbatim and stateless.
 */
class BuffFormatter {
    constructor(owner) {
        this.owner = owner;
    }

    // Format buff data for client consumption
    formatBuffForClient(buff) {
        return {
            id: buff.id,
            userId: buff.user_id,
            itemId: buff.item_id,
            itemName: buff.item_name,
            displayName: buff.display_name,
            emoji: buff.emoji,
            buffType: buff.buff_type,
            durationSeconds: buff.duration_seconds,
            remainingSeconds: buff.remaining_seconds,
            streamingTimeUsed: buff.streaming_time_used,
            appliedAt: buff.applied_at,
            appliedByUserId: buff.applied_by_user_id,
            metadata: buff.metadata ? JSON.parse(buff.metadata) : null,
            effectData: buff.effect_data ? JSON.parse(buff.effect_data) : null
        };
    }
}

module.exports = BuffFormatter;
