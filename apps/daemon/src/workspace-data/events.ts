import { EventEmitter } from 'node:events';
import type { WorkspaceDataChangedSsePayload } from '@open-design/contracts';

/** In-process fan-out for workspace data changes. The daemon SSE route
 * (`GET /api/data/events`) subscribes here; the record chokepoint publishes
 * after each committed write so open dashboards refresh live. */
export class WorkspaceDataEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emitRecordChange(payload: WorkspaceDataChangedSsePayload): void {
    this.emitter.emit('record-change', payload);
  }

  onRecordChange(listener: (payload: WorkspaceDataChangedSsePayload) => void): () => void {
    this.emitter.on('record-change', listener);
    return () => this.emitter.off('record-change', listener);
  }
}
