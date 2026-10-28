import { EventEmitter } from 'node:events';
import type { Purchase } from './store.js';

export type BusEvent =
  | { type: 'purchase'; purchase: Purchase }
  /** Rules, wallet link or agents changed: clients refetch /api/state. */
  | { type: 'state'; reason: string };

/** In-process fan-out to the dashboard's server-sent events stream. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(event: BusEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: BusEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
