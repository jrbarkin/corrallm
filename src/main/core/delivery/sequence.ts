interface Leaf {
  kind: 'leaf';
  seq: number;
  id: string;
  total: number;
}

interface Branch {
  kind: 'branch';
  /** The first sequence under this branch. */
  seq: number;
  total: number;
  /** The highest bit at which the left and right sequences differ. */
  bit: number;
  left: Tree;
  right: Tree;
}

type Tree = Leaf | Branch;

/**
 * A compressed binary radix tree over the store's safe-integer sequences. Branch bits strictly
 * decrease, so any operation visits at most 53 branches, independent of how many records are
 * kept. Compression leaves just one branch per pair of children, including for sparse sequences
 * after a restart. Weights count a self-send twice without duplicating its record.
 */
export class Sequence {
  #root: Tree | undefined;

  get weight(): number {
    return this.#root?.total ?? 0;
  }

  set(seq: number, id: string, weight = 1): void {
    let leaf = this.#root;
    while (leaf?.kind === 'branch') leaf = hasBit(seq, leaf.bit) ? leaf.right : leaf.left;
    const bit = leaf === undefined || leaf.seq === seq ? 0 : difference(seq, leaf.seq);
    this.#root = insert(this.#root, { kind: 'leaf', seq, id, total: weight }, bit);
  }

  delete(seq: number): void {
    this.#root = remove(this.#root, seq);
  }

  first(): string | undefined {
    let node = this.#root;
    while (node?.kind === 'branch') node = node.left;
    return node?.id;
  }

  /** The record containing occurrence `offset`, counting from newest, zero based. */
  newest(offset: number): string | undefined {
    let node = this.#root;
    if (offset < 0 || offset >= (node?.total ?? 0)) return undefined;
    while (node?.kind === 'branch') {
      if (offset < node.right.total) node = node.right;
      else {
        offset -= node.right.total;
        node = node.left;
      }
    }
    return node?.id;
  }

  /** How many occurrences are newer than this sequence. */
  newer(seq: number): number {
    let count = 0;
    let node = this.#root;
    while (node?.kind === 'branch') {
      if (seq < node.right.seq) {
        count += node.right.total;
        node = node.left;
      } else node = node.right;
    }
    return count + (node && node.seq > seq ? node.total : 0);
  }
}

function hasBit(seq: number, bit: number): boolean {
  return Math.floor(seq / bit) % 2 === 1;
}

/** Bitwise JS operators cover only 32 bits; compare the high and low words separately. */
function difference(a: number, b: number): number {
  const high = Math.floor(a / 2 ** 32) ^ Math.floor(b / 2 ** 32);
  return high !== 0 ? 2 ** (63 - Math.clz32(high)) : 2 ** (31 - Math.clz32((a >>> 0) ^ (b >>> 0)));
}

function update(node: Branch): Branch {
  node.seq = node.left.seq;
  node.total = node.left.total + node.right.total;
  return node;
}

function insert(root: Tree | undefined, leaf: Leaf, bit: number): Tree {
  if (!root) return leaf;
  if (root.kind === 'leaf' && root.seq === leaf.seq) return leaf;
  if (root.kind === 'leaf' || root.bit < bit) {
    const [left, right] = hasBit(leaf.seq, bit) ? [root, leaf] : [leaf, root];
    return { kind: 'branch', seq: left.seq, total: left.total + right.total, bit, left, right };
  }
  if (hasBit(leaf.seq, root.bit)) root.right = insert(root.right, leaf, bit);
  else root.left = insert(root.left, leaf, bit);
  return update(root);
}

function remove(root: Tree | undefined, seq: number): Tree | undefined {
  if (!root || root.kind === 'leaf') return root?.seq === seq ? undefined : root;
  if (hasBit(seq, root.bit)) {
    const right = remove(root.right, seq);
    if (!right) return root.left;
    root.right = right;
  } else {
    const left = remove(root.left, seq);
    if (!left) return root.right;
    root.left = left;
  }
  return update(root);
}
