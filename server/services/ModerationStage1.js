// server/services/ModerationStage1.js
//
// Stage 1 of the AI moderation pipeline (PR-M1, [ADR-0013]).
//
// Pure functions: normalize a transcript chunk and match against a cached
// terms list. **Recall-only** — Stage 1 NEVER auto-bans; it only flags so
// Stage 2 (Groq, PR-M2) can disambiguate use/mention, AAVE reclamation,
// quotation, song lyrics, and educational framing.
//
// Stage 1's job is to be a cheap, high-recall filter so we don't pay Groq
// for every transcript chunk. The cost of a Stage 1 false-positive is one
// extra Groq call; the cost of a Stage 1 false-negative is missing a real
// hit entirely. So we err on the side of flagging.
//
// The normalizer is intentionally aggressive: NFKC + lowercase + homoglyph
// fold (Cyrillic → Latin) + leetspeak fold + repeat collapse + strip
// non-alphanumeric. Documented attack survey:
//   - "fuuuck"       → collapseRepeats → "fuck"
//   - "f.u.c.k"      → stripPunct      → "fuck"
//   - "F U C K"      → collapseSpaces  → "f u c k"  (no fold for spacing yet)
//   - "n!gger"       → leetFold        → "niigger"  → "niger"? — see below
//   - "n@gger"       → leetFold        → "nagger"
//   - "ＦＵＣＫ"      → NFKC + lower   → "fuck"
//   - "fυck"  (Greek upsilon) → homoglyph fold → "fuck"
//
// Spaced obfuscation ("f u c k") is NOT handled by space-collapse alone —
// that would create false positives ("a fagot" → "afagot" → match? no, but
// "I am a fan" → "iamafan" doesn't match either). Real spacing-fold attacks
// need bigram-level detection, deferred to PR-M2 where Stage 2 can rule on
// intent.

const LEET_MAP = {
  '0': 'o',
  '1': 'i',  // 'l' is also valid for some terms; 'i' is the more common slur substitution
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  '$': 's',
  '!': 'i',
};

// Single-codepoint homoglyph map (Cyrillic / Greek visual look-alikes that
// transliterate to Latin equivalents). Covers the high-frequency tropes:
// the Cyrillic а / е / о / р / с / х all render identically to Latin a / e
// / o / p / c / x in most fonts, so attackers prefer them for obfuscation.
const HOMOGLYPH_MAP = {
  // Cyrillic
  'а': 'a', // а
  'е': 'e', // е
  'о': 'o', // о
  'р': 'p', // р
  'с': 'c', // с
  'у': 'y', // у
  'х': 'x', // х
  'һ': 'h', // һ
  'і': 'i', // і (Ukrainian)
  'ј': 'j', // ј (Serbian)
  'ѕ': 's', // ѕ (Macedonian)
  // Greek
  'α': 'a', // α
  'ε': 'e', // ε
  'ι': 'i', // ι
  'ο': 'o', // ο
  'ρ': 'p', // ρ
  'σ': 's', // σ
  'τ': 't', // τ
  'υ': 'u', // υ
  'χ': 'x', // χ
};

/**
 * Normalize a transcript chunk into the canonical form Stage 1 matches
 * against. The same normalization MUST be applied to seed/admin terms when
 * they are written to `moderation_terms.normalized_form` so the matcher
 * compares apples-to-apples.
 *
 * Order matters: NFKC first (collapses compatibility forms — fullwidth
 * Latin, ligatures), then lowercase (after NFKC because some compatibility
 * mappings are case-preserving), then homoglyph fold (per-codepoint), then
 * leetspeak fold (per-codepoint), then strip non-alphanumeric except space,
 * then collapse repeated chars (`fuuuuuck` → `fuck`), then collapse spaces.
 *
 * @param {string} text Raw transcript chunk.
 * @returns {string} Normalized form. Empty string for falsy/non-string input.
 */
function normalize(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  let out = text.normalize('NFKC').toLowerCase();

  // Homoglyph fold (per-codepoint).
  let buf = '';
  for (const ch of out) {
    buf += HOMOGLYPH_MAP[ch] ?? ch;
  }
  out = buf;

  // Leetspeak fold (per-codepoint).
  buf = '';
  for (const ch of out) {
    buf += LEET_MAP[ch] ?? ch;
  }
  out = buf;

  // Strip non-alphanumeric except whitespace.
  out = out.replace(/[^a-z0-9\s]+/g, '');

  // Collapse repeated chars (3+ in a row → 1). Conservative: keep doubles
  // because many legitimate words have them ("book", "pass") but no slur
  // we care about uses 3+ in a row.
  out = out.replace(/(.)\1{2,}/g, '$1');

  // Collapse whitespace.
  out = out.replace(/\s+/g, ' ').trim();

  return out;
}

/**
 * Find all term-list matches inside a normalized transcript chunk.
 *
 * Multi-word terms are matched as substrings (`'kill all jews'` matches
 * `'and then i would kill all jews if i were evil'`). Single-word terms
 * are matched as word-boundaried tokens (`'spic'` does NOT match
 * `'topical'` or `'auspicious'`).
 *
 * The terms cache shape is what `ModerationService` builds on initialize()
 * and refreshes on admin edits: an array of objects each carrying at least
 * `{ id, term, normalized_form, category, severity }`. Disabled terms must
 * be filtered out by the caller; this matcher trusts its input.
 *
 * @param {string} normalizedText  Output of normalize().
 * @param {Array<object>} termsCache  Pre-filtered enabled terms.
 * @returns {Array<object>} Matches, each with
 *   `{ id, term, normalized_form, category, severity, start, end }`.
 *   Empty array if no matches.
 */
function findMatches(normalizedText, termsCache) {
  if (typeof normalizedText !== 'string' || normalizedText.length === 0) {
    return [];
  }
  if (!Array.isArray(termsCache) || termsCache.length === 0) {
    return [];
  }

  const matches = [];

  for (const term of termsCache) {
    if (!term || typeof term.normalized_form !== 'string' || term.normalized_form.length === 0) {
      continue;
    }
    const needle = term.normalized_form;
    const isMultiWord = needle.includes(' ');

    if (isMultiWord) {
      // Substring match.
      let from = 0;
      while (from <= normalizedText.length - needle.length) {
        const idx = normalizedText.indexOf(needle, from);
        if (idx === -1) break;
        matches.push({
          id: term.id,
          term: term.term,
          normalized_form: term.normalized_form,
          category: term.category,
          severity: term.severity,
          start: idx,
          end: idx + needle.length,
        });
        from = idx + needle.length;
      }
    } else {
      // Word-boundary match. Build a regex once per term — termsCache is
      // small enough (~30–300 entries) that doing this per call is fine.
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'g');
      let m;
      while ((m = re.exec(normalizedText)) !== null) {
        matches.push({
          id: term.id,
          term: term.term,
          normalized_form: term.normalized_form,
          category: term.category,
          severity: term.severity,
          start: m.index,
          end: m.index + needle.length,
        });
      }
    }
  }

  // Sort by start offset for deterministic ordering downstream.
  matches.sort((a, b) => a.start - b.start);
  return matches;
}

module.exports = {
  normalize,
  findMatches,
  // Exposed for testing and for any future re-use.
  LEET_MAP,
  HOMOGLYPH_MAP,
};
