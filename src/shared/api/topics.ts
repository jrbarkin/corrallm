import type { PartyId } from '../model/messages';
import type { UsageState } from '../usage';
import type { ResultOf } from './registry';

/** The global topics served from B8; canvas topics follow with their operations. */
export const TOPICS = ['usage', 'settings'] as const;
export type TopicKey = (typeof TOPICS)[number];
export interface TopicStates {
  usage: UsageState;
  settings: ResultOf<'settings.get'>;
}
export interface TopicSnapshot<K extends TopicKey = TopicKey> {
  epoch: string;
  rev: number;
  state: TopicStates[K];
}

/** A replacement in the core's epoch, ordered within its topic and across these global topics. */
export type Change = {
  [K in TopicKey]: {
    topic: K;
    epoch: string;
    rev: number;
    seq: number;
    by: PartyId | 'cli';
    at: number;
    replace: TopicStates[K];
  };
}[TopicKey];
