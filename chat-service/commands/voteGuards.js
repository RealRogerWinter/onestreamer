// Mutual-exclusion guard for the public vote commands (!next/!swap/!extend/
// !reduce/!lock/!unlock). Each handler must refuse to start when a DIFFERENT
// vote is already active, emitting a fixed per-type message. Extracted from the
// six near-identical inline check blocks in commandParser.js.
//
// Behavior note: only one vote can be active at a time (these very guards plus
// the start paths enforce that), so iterating in a fixed canonical order is
// equivalent to each handler's original per-type order — at most one entry is
// ever active.

const VOTE_ORDER = ['skip', 'swap', 'extend', 'reduce', 'lock', 'unlock'];

// Byte-exact messages from the original inline blocks.
const IN_PROGRESS_MESSAGE = {
  skip: '❌ A skip vote is currently in progress. Please wait for it to finish.',
  swap: '❌ A swap vote is currently in progress. Please wait for it to finish.',
  extend: '❌ An extend vote is currently in progress. Please wait for it to finish.',
  reduce: '❌ A reduce vote is currently in progress. Please wait for it to finish.',
  lock: '❌ A lock vote is currently in progress. Please wait for it to finish.',
  unlock: '❌ An unlock vote is currently in progress. Please wait for it to finish.',
};

// Returns the "X vote is currently in progress" message for the first OTHER
// active vote (canonical order), or null if no other vote is active.
// `votes` is { skip, swap, extend, reduce, lock, unlock } of vote-service
// objects, each with a `.state.active` boolean.
function otherActiveVoteMessage(currentType, votes) {
  for (const type of VOTE_ORDER) {
    if (type === currentType) continue;
    const v = votes[type];
    if (v && v.state && v.state.active) {
      return IN_PROGRESS_MESSAGE[type];
    }
  }
  return null;
}

module.exports = { otherActiveVoteMessage, VOTE_ORDER, IN_PROGRESS_MESSAGE };
