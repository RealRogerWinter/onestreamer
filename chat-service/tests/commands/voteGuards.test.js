// Characterization tests for the vote mutual-exclusion guard extracted from
// commandParser.js. These pin the exact messages + selection behavior that the
// six inline check blocks had before extraction.

const { otherActiveVoteMessage, VOTE_ORDER, IN_PROGRESS_MESSAGE } = require('../../commands/voteGuards');

// Build a votes map where the given types are active.
function votesWith(...activeTypes) {
  const v = {};
  for (const type of VOTE_ORDER) {
    v[type] = { state: { active: activeTypes.includes(type) } };
  }
  return v;
}

describe('voteGuards.otherActiveVoteMessage', () => {
  test('returns null when no vote is active', () => {
    for (const type of VOTE_ORDER) {
      expect(otherActiveVoteMessage(type, votesWith())).toBeNull();
    }
  });

  test('ignores the current vote being active (only blocks on OTHERS)', () => {
    for (const type of VOTE_ORDER) {
      expect(otherActiveVoteMessage(type, votesWith(type))).toBeNull();
    }
  });

  test('returns the exact in-progress message for each other active vote', () => {
    for (const current of VOTE_ORDER) {
      for (const other of VOTE_ORDER) {
        if (other === current) continue;
        expect(otherActiveVoteMessage(current, votesWith(other))).toBe(IN_PROGRESS_MESSAGE[other]);
      }
    }
  });

  test('tolerates missing/!state entries without throwing', () => {
    expect(otherActiveVoteMessage('skip', {})).toBeNull();
    expect(otherActiveVoteMessage('skip', { swap: {} })).toBeNull();
    expect(otherActiveVoteMessage('skip', { swap: { state: {} } })).toBeNull();
  });

  test('message wording matches the original byte-for-byte', () => {
    expect(IN_PROGRESS_MESSAGE.skip).toBe('❌ A skip vote is currently in progress. Please wait for it to finish.');
    expect(IN_PROGRESS_MESSAGE.extend).toBe('❌ An extend vote is currently in progress. Please wait for it to finish.');
    expect(IN_PROGRESS_MESSAGE.unlock).toBe('❌ An unlock vote is currently in progress. Please wait for it to finish.');
  });
});
