/**
 * Token-shingle Jaccard similarity for normalized instruction text.
 *
 * Deterministic. No external dependencies. No LLM.
 */

/**
 * Tokenize normalized instruction text into whitespace-separated tokens.
 * Expects the text produced by normalizeInstructions() (with final newline).
 */
export function tokenize(text: string): string[] {
  // Remove the guaranteed final newline, then split on Unicode whitespace
  const stripped = text.replace(/\n$/, "");
  if (stripped.length === 0) {
    return [];
  }
  return stripped.split(/\s+/u).filter((t) => t.length > 0);
}

const SHINGLE_SIZE = 5;

/**
 * Generate a set of contiguous 5-token shingles from a token array.
 * Each shingle is the five tokens joined with a single ASCII space.
 *
 * If fewer than 5 tokens, the entire token sequence is one shingle.
 */
export function shingleSet(tokens: readonly string[]): Set<string> {
  const set = new Set<string>();

  if (tokens.length === 0) {
    return set;
  }

  if (tokens.length < SHINGLE_SIZE) {
    set.add(tokens.join(" "));
    return set;
  }

  for (let i = 0; i <= tokens.length - SHINGLE_SIZE; i++) {
    set.add(tokens.slice(i, i + SHINGLE_SIZE).join(" "));
  }

  return set;
}

/**
 * Compute Jaccard similarity between two shingle sets.
 *
 * Returns a number between 0 and 1.
 * If both sets are empty, returns 1.
 * If only one is empty, returns 0.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  let intersectionSize = 0;
  // Iterate over the smaller set for efficiency
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of smaller) {
    if (larger.has(item)) {
      intersectionSize++;
    }
  }

  const unionSize = a.size + b.size - intersectionSize;
  return intersectionSize / unionSize;
}

/**
 * Compute instruction similarity from two normalized instruction texts.
 * Returns unrounded value between 0 and 1.
 */
export function instructionSimilarity(
  normalizedA: string,
  normalizedB: string,
): number {
  const tokensA = tokenize(normalizedA);
  const tokensB = tokenize(normalizedB);
  const shinglesA = shingleSet(tokensA);
  const shinglesB = shingleSet(tokensB);
  return jaccardSimilarity(shinglesA, shinglesB);
}
