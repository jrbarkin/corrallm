/** Why a message couldn't be sent or taken back: a code, as an operation's failure carries it. */
export class DeliveryError extends Error {
  readonly code: 'not-found' | 'refused' | 'conflict' | 'unavailable';

  constructor(code: DeliveryError['code'], sentence: string) {
    super(sentence);
    this.name = 'DeliveryError';
    this.code = code;
  }
}
