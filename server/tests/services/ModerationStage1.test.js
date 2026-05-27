// Tests for server/services/ModerationStage1 — the pure-functions module
// that powers Stage 1 of the AI moderation pipeline (PR-M1 of ADR-0013).
//
// Stage 1 has two responsibilities: (a) normalize incoming transcript text
// into a canonical form, (b) match a cached list of terms against the
// normalized text. Both are pure functions; this suite covers the
// normalization rules and the match semantics (substring vs word-boundary).

const Stage1 = require('../../services/ModerationStage1');

describe('ModerationStage1.normalize', () => {
  test('returns empty string for empty / non-string input', () => {
    expect(Stage1.normalize('')).toBe('');
    expect(Stage1.normalize(null)).toBe('');
    expect(Stage1.normalize(undefined)).toBe('');
    expect(Stage1.normalize(42)).toBe('');
  });

  test('lowercases ASCII', () => {
    expect(Stage1.normalize('FUCK')).toBe('fuck');
    expect(Stage1.normalize('Hello World')).toBe('hello world');
  });

  test('NFKC fold collapses fullwidth Latin to ASCII', () => {
    // U+FF26 U+FF55 U+FF43 U+FF4B  → 'fuck'
    expect(Stage1.normalize('ＦＵＣＫ')).toBe('fuck');
  });

  test('folds Cyrillic homoglyphs to Latin', () => {
    // Lowercase Cyrillic а (U+0430), е (U+0435), о (U+043E), р (U+0440), с (U+0441)
    expect(Stage1.normalize('а')).toBe('a');
    expect(Stage1.normalize('е')).toBe('e');
    expect(Stage1.normalize('о')).toBe('o');
    expect(Stage1.normalize('р')).toBe('p');
    expect(Stage1.normalize('с')).toBe('c');
  });

  test('folds Greek upsilon to u', () => {
    // U+03C5 (Greek upsilon) → 'u'
    expect(Stage1.normalize('fυck')).toBe('fuck');
  });

  test('folds leetspeak substitutions', () => {
    expect(Stage1.normalize('n1gger')).toBe('nigger'); // 1→i; 'gg' (2) preserved
    expect(Stage1.normalize('f@ggot')).toBe('faggot');
    expect(Stage1.normalize('5p1c')).toBe('spic');
    // '@$$' → '@', '$', '$' → 'a', 's', 's' → 'ass'. Only 2 s's (not 3+),
    // so no repeat collapse → 'ass'.
    expect(Stage1.normalize('@$$')).toBe('ass');
    expect(Stage1.normalize('h3ll')).toBe('hell');
    expect(Stage1.normalize('!d!ot')).toBe('idiot');
  });

  test('strips punctuation but preserves spaces', () => {
    expect(Stage1.normalize('f.u.c.k')).toBe('fuck');
    // ! is a leet substitution for i, so it survives as an `i` rather
    // than being stripped as punctuation. Trailing `!` in "world!" becomes
    // a trailing `i`. This is a documented behavior of the leet fold —
    // optimizes for catching `n!gger` at the cost of mildly ugly
    // normalization of benign sentences ending in `!`. Matching is
    // unaffected: 'worldi' doesn't match any term in the list.
    expect(Stage1.normalize('hello, world!')).toBe('hello worldi');
    expect(Stage1.normalize('a-b-c')).toBe('abc');
  });

  test('collapses 3+ repeated characters to one', () => {
    expect(Stage1.normalize('fuuuuck')).toBe('fuck');
    expect(Stage1.normalize('aaaaa')).toBe('a');
    expect(Stage1.normalize('bookkeeper')).toBe('bookkeeper'); // doubles preserved
  });

  test('collapses whitespace runs', () => {
    expect(Stage1.normalize('hello    world')).toBe('hello world');
    expect(Stage1.normalize('  spaced  ')).toBe('spaced');
    expect(Stage1.normalize('a\n\tb')).toBe('a b');
  });

  test('combined attack: leet + repeat + punctuation', () => {
    // F!!!UCK!!! — lowercase: f!!!uck!!! — leet ! → i: fiiiuckiii — collapse
    // 3+ → 1: fiuck and trailing iii → i → 'fiucki'. Regression-pinned: if
    // the normalizer rules change the output may drift, but it should still
    // contain 'uck' so Stage 2 can rule on intent.
    expect(Stage1.normalize('F!!!UCK!!!')).toBe('fiucki');
  });

  test('hard-r slur with leet survives normalization', () => {
    expect(Stage1.normalize('N!GG3R')).toBe('nigger');
    // 'n1gg3r' — 1→i, 3→e: niggеr → keep gg (only 2), so output is 'nigger'.
    expect(Stage1.normalize('n1gg3r')).toBe('nigger');
  });
});

describe('ModerationStage1.findMatches', () => {
  // The terms cache shape matches what ModerationService loads from the
  // moderation_terms table — id, term (raw), normalized_form, category,
  // severity. Only normalized_form is consulted by the matcher.
  const termsCache = [
    { id: 1, term: 'faggot', normalized_form: 'faggot', category: 'hate_speech', severity: 'hard' },
    { id: 2, term: 'nigger', normalized_form: 'nigger', category: 'hate_speech', severity: 'hard' },
    { id: 3, term: 'kill all jews', normalized_form: 'kill all jews', category: 'threat', severity: 'hard' },
    { id: 4, term: 'kys', normalized_form: 'kys', category: 'threat', severity: 'soft' },
    { id: 5, term: 'spic', normalized_form: 'spic', category: 'hate_speech', severity: 'hard' },
  ];

  test('returns empty array on empty input', () => {
    expect(Stage1.findMatches('', termsCache)).toEqual([]);
    expect(Stage1.findMatches(null, termsCache)).toEqual([]);
  });

  test('returns empty array when cache is empty', () => {
    expect(Stage1.findMatches('any text here', [])).toEqual([]);
    expect(Stage1.findMatches('any text here', null)).toEqual([]);
  });

  test('finds a single-word slur via word-boundary match', () => {
    const matches = Stage1.findMatches('he called me a faggot', termsCache);
    expect(matches).toHaveLength(1);
    expect(matches[0].term).toBe('faggot');
    expect(matches[0].category).toBe('hate_speech');
    expect(matches[0].severity).toBe('hard');
  });

  test('does NOT match a single-word slur inside another word (word-boundary)', () => {
    // The classic Scunthorpe scenario for a benign word.
    expect(Stage1.findMatches('auspicious occasion', termsCache)).toEqual([]);
    // 'spic' would substring-match 'auspicious' but is gated by \b.
    expect(Stage1.findMatches('typical', termsCache)).toEqual([]);
  });

  test('matches multi-word phrase as substring (no word boundary required)', () => {
    const matches = Stage1.findMatches('i would never kill all jews ever', termsCache);
    expect(matches).toHaveLength(1);
    expect(matches[0].term).toBe('kill all jews');
    expect(matches[0].category).toBe('threat');
  });

  test('returns multiple matches in start-offset order', () => {
    const matches = Stage1.findMatches('faggot and nigger together', termsCache);
    expect(matches).toHaveLength(2);
    expect(matches[0].term).toBe('faggot');
    expect(matches[1].term).toBe('nigger');
    expect(matches[0].start).toBeLessThan(matches[1].start);
  });

  test('reports the span (start/end) of each match', () => {
    const matches = Stage1.findMatches('  faggot  ', termsCache);
    expect(matches[0].start).toBe(2);
    expect(matches[0].end).toBe(8);
  });

  test('finds repeated occurrences of the same term', () => {
    const matches = Stage1.findMatches('kys kys kys', termsCache);
    expect(matches).toHaveLength(3);
  });

  test('skips malformed cache entries', () => {
    const bad = [
      { id: 99, term: 'has-no-norm' /* missing normalized_form */ },
      null,
      undefined,
      { id: 1, term: 'faggot', normalized_form: 'faggot', category: 'hate_speech', severity: 'hard' },
    ];
    const matches = Stage1.findMatches('he is a faggot', bad);
    expect(matches).toHaveLength(1);
    expect(matches[0].id).toBe(1);
  });

  test('regex special characters in term do not break matching', () => {
    const cache = [
      { id: 99, term: 'a.b.c', normalized_form: 'a.b.c', category: 'hate_speech', severity: 'hard' },
    ];
    // The normalizer would strip the dots in real flow; here we just want to
    // confirm that if a multi-word term contains regex metacharacters they
    // don't blow up the matcher. ('a.b.c' has dots → treated as substring match.)
    expect(() => Stage1.findMatches('blah', cache)).not.toThrow();
  });
});

describe('ModerationStage1 integration: normalize + findMatches', () => {
  const cache = [
    { id: 1, term: 'faggot', normalized_form: 'faggot', category: 'hate_speech', severity: 'hard' },
  ];

  test('Stage 1 catches a leetspeaked slur after normalization', () => {
    const normalized = Stage1.normalize('what a f@gg0t');
    expect(normalized).toContain('faggot');
    const matches = Stage1.findMatches(normalized, cache);
    expect(matches).toHaveLength(1);
  });

  test('Stage 1 catches a fullwidth slur after NFKC normalization', () => {
    // Fullwidth letters in NFKC fold to ASCII.
    const normalized = Stage1.normalize('ｆａｇｇｏｔ');
    expect(normalized).toBe('faggot');
    expect(Stage1.findMatches(normalized, cache)).toHaveLength(1);
  });

  test('Stage 1 catches a homoglyph-obfuscated slur', () => {
    // Cyrillic а replacing the Latin a in 'faggot'.
    const normalized = Stage1.normalize('fаggot');
    expect(normalized).toBe('faggot');
    expect(Stage1.findMatches(normalized, cache)).toHaveLength(1);
  });

  test('Stage 1 catches a punctuation-padded slur', () => {
    const normalized = Stage1.normalize('f.a.g.g.o.t');
    expect(normalized).toBe('faggot');
    expect(Stage1.findMatches(normalized, cache)).toHaveLength(1);
  });

  test('Stage 1 collapses 3+ repeats but preserves doubles', () => {
    // 'faaaggggoot' — aaa (3+) → a; gggg (4) → g; oo (2, kept) → oo.
    // Result is 'fagoot'. Doesn't match 'faggot' (which has gg, not g) —
    // this is a documented Stage 1 false-negative: a streamer can evade
    // by exploiting the repeat-collapse to break a double. PR-M2's Stage 2
    // LLM catches intent regardless of this fold; Stage 1 is recall-only
    // so a few misses are acceptable.
    const normalized = Stage1.normalize('faaaggggoot');
    expect(normalized).toBe('fagoot');
    expect(Stage1.findMatches(normalized, cache)).toHaveLength(0);
  });
});
