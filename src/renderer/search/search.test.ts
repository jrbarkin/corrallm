import { describe, expect, it } from 'vitest';

import { search } from './search';

const fruit = ['Banana', 'Apple pie', 'Pineapple', 'apple', 'Grape', 'Papaya'];
const find = (query: string) => search(fruit, query, (name) => name);

describe('search', () => {
  it('returns everything, in order, for an empty or blank query', () => {
    expect(find('')).toEqual(fruit);
    expect(find('   ')).toEqual(fruit);
  });

  it('ignores case, and ranks exact, then prefix, then word-start, then anywhere', () => {
    expect(find('APPLE')).toEqual(['apple', 'Apple pie', 'Pineapple']);
    expect(find('pie')).toEqual(['Apple pie']);
  });

  it('matches letters in order when nothing contains the query as a whole', () => {
    expect(find('bna')).toEqual(['Banana']);
    expect(find('ppy')).toEqual(['Papaya']);
  });

  it('can leave out matches of letters in order', () => {
    expect(search(fruit, 'bna', (name) => name, { fuzzy: false })).toEqual([]);
    expect(search(fruit, 'pie', (name) => name, { fuzzy: false })).toEqual(['Apple pie']);
  });

  it('returns nothing when nothing matches', () => {
    expect(find('kiwi')).toEqual([]);
  });

  it('keeps the original order among equally good matches', () => {
    expect(find('a')).toEqual(['Apple pie', 'apple', 'Banana', 'Pineapple', 'Grape', 'Papaya']);
  });
});
