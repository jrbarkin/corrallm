/** What can be queued on a node. Placeholders until the real kinds exist. */
export const QueueItemKind = {
  PlaceholderA: 'Placeholder A',
  PlaceholderB: 'Placeholder B',
  PlaceholderC: 'Placeholder C',
} as const;
// An object rather than a TypeScript `enum`: erasableSyntaxOnly (tsconfig.base.json) rejects enums.
export type QueueItemKind = (typeof QueueItemKind)[keyof typeof QueueItemKind];

export interface QueueItem {
  id: string;
  kind: QueueItemKind;
}
