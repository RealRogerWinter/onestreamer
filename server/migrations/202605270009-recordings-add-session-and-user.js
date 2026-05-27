/**
 * Backfill the recording tables with session/user references.
 *
 * - recordings.session_id: which continuous-recording session this segment
 *   belongs to.
 * - recordings.user_id: streamer who owned the segment.
 * - recording_events.user_id: actor on the event row.
 *
 * The bootstrap CREATE TABLE for both tables already includes these
 * columns; this migration only matters on DBs created before they were
 * added inline.
 */

'use strict';

const { addColumn } = require('./_runner');

function run(db, logger) {
    addColumn(db, 'recordings', 'session_id', 'TEXT', logger);
    addColumn(db, 'recordings', 'user_id', 'INTEGER', logger);
    addColumn(db, 'recording_events', 'user_id', 'INTEGER', logger);
}

module.exports = { run };
