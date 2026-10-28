const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "do", "does", "doing", "for", "he", "her", "his", "how", "i", "in", "is", "it", "me", "my", "of", "or", "she", "tell", "that", "the", "their", "this", "to", "what", "when", "where", "which", "who", "why", "with", "you"
]);

function normalizeWord(value) {
  let word = value.toLocaleLowerCase().replace(/['’]s$/u, "");
  if (/ing$/u.test(word) && word.length > 5) word = word.slice(0, -3);
  else if (/ed$/u.test(word) && word.length > 4) word = word.slice(0, -2);
  else if (/es$/u.test(word) && word.length > 5) word = word.slice(0, -2);
  else if (/s$/u.test(word) && word.length > 4) word = word.slice(0, -1);
  return word;
}

function meaningfulWords(value) {
  return [...new Set(String(value || "").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [])]
    .map(normalizeWord)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

export function selectRelevantPinnedMemories(query, memories, limit = 5) {
  const queryWords = meaningfulWords(query);
  if (!queryWords.length || !Array.isArray(memories)) return [];
  const requiredOverlap = Math.min(2, queryWords.length);
  return memories
    .filter((memory) => memory?.pinned)
    .map((memory, index) => {
      const contentWords = new Set(meaningfulWords(`${memory.label || ""} ${memory.content || ""}`));
      const overlap = queryWords.reduce((score, word) => score + Number(contentWords.has(word)), 0);
      return { memory, overlap, index };
    })
    .filter(({ overlap }) => overlap >= requiredOverlap)
    .sort((left, right) => right.overlap - left.overlap || left.index - right.index)
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)))
    .map(({ memory }) => memory);
}

export { meaningfulWords };
