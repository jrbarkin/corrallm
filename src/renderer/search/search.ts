const FUZZY = 4;

/**
 * Type to search: the items whose text matches `query`, best first, ignoring case. A match on the
 * whole text ranks first, then a prefix, then the start of a word, then anywhere in the text. Only
 * when nothing matches that well do the query's characters in order count ("bna" finds "Banana"),
 * unless `fuzzy` is false. Equally good matches keep their order; a blank query returns every item.
 */
export function search<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  { fuzzy = true }: { fuzzy?: boolean } = {},
): T[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...items];
  const ranked = items.map((item, index) => ({
    item,
    index,
    rank: rank(text(item).toLowerCase(), q),
  }));
  const worst = !fuzzy || ranked.some((r) => r.rank < FUZZY) ? FUZZY - 1 : FUZZY;
  return ranked
    .filter((r) => r.rank <= worst)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.item);
}

function rank(text: string, query: string): number {
  if (text === query) return 0;
  if (text.startsWith(query)) return 1;
  if (text.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query))) return 2;
  if (text.includes(query)) return 3;
  return inOrder(text, query) ? FUZZY : Infinity;
}

/** Whether the characters of `query` appear in `text` in the same order. */
function inOrder(text: string, query: string): boolean {
  let at = 0;
  for (const char of query) {
    at = text.indexOf(char, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}
