// The housekeeping chat needs to keep working over weeks rather than hours.
//
// Three jobs, all of them the kind that never fails loudly and slowly ruins
// the thing they are attached to if nobody runs them:
//
//   prune events    The durable log grows with every message. Without pruning
//                   it is the largest table in the database within a month,
//                   and almost all of it is older than any client could ask
//                   for.
//   apply retention A retention policy that only takes effect when an admin
//                   remembers to press a button is not a policy.
//   reap huddles    A browser that crashes never sends "I left". Without this,
//                   a channel shows a live huddle nobody is in, forever.
//
// Everything here is best-effort and per organization: one organization with a
// corrupt row must not stop the others from being tidied.

import { pruneChatEvents } from '../workspace-data/chat-events.js';
import { applyRetention } from '../workspace-data/chat-org.js';
import { reapStaleHuddles } from '../workspace-data/chat-huddles.js';
import { listOrganizations } from '../workspace-data/tenancy.js';
import type { WorkspaceDbManager } from '../storage/workspace-db.js';

/** Once an hour. None of these jobs is urgent — an event pruned an hour late
 * costs a few kilobytes — and a sweep that runs often enough to notice is a
 * sweep that shows up in someone's battery life. */
const SWEEP_MS = 60 * 60_000;

/** A huddle with nobody in it for this long has been abandoned rather than
 * paused. Ten minutes is long enough to survive a reconnect and short enough
 * that the sidebar stops lying about it within one coffee. */
const HUDDLE_STALE_MS = 10 * 60_000;

/** First sweep runs shortly after startup rather than immediately: the daemon
 * has better things to do in its first seconds than delete week-old rows. */
const FIRST_SWEEP_MS = 60_000;

export interface ChatMaintenanceReport {
  organizations: number;
  eventsPruned: number;
  messagesExpired: number;
  huddlesEnded: number;
}

export class ChatMaintenance {
  readonly #manager: WorkspaceDbManager;
  #timer: ReturnType<typeof setInterval> | null = null;
  #kickoff: ReturnType<typeof setTimeout> | null = null;

  constructor(manager: WorkspaceDbManager) {
    this.#manager = manager;
  }

  start(): void {
    if (this.#timer) return;
    this.#kickoff = setTimeout(() => void this.sweep(), FIRST_SWEEP_MS);
    this.#kickoff.unref?.();
    this.#timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#kickoff) clearTimeout(this.#kickoff);
    if (this.#timer) clearInterval(this.#timer);
    this.#kickoff = null;
    this.#timer = null;
  }

  /** Run every job once. Exported rather than private so a test can drive it
   * without waiting an hour, and so an operator can trigger it by hand. */
  async sweep(now = Date.now()): Promise<ChatMaintenanceReport> {
    const report: ChatMaintenanceReport = {
      organizations: 0,
      eventsPruned: 0,
      messagesExpired: 0,
      huddlesEnded: 0,
    };
    let organizations;
    try {
      organizations = await listOrganizations(this.#manager.directoryExecutor);
    } catch {
      return report;
    }
    for (const org of organizations) {
      report.organizations += 1;
      const db = this.#manager.workspaceExecutor(org.id);
      try {
        report.eventsPruned += await pruneChatEvents(db, org.id, now);
      } catch {
        // A pruning failure is not worth stopping the sweep for; the next one
        // will try again against the same rows.
      }
      try {
        for (const count of (await applyRetention(db, org.id, now)).values()) {
          report.messagesExpired += count;
        }
      } catch {
        // Same.
      }
      try {
        report.huddlesEnded += (await reapStaleHuddles(db, org.id, HUDDLE_STALE_MS, now)).length;
      } catch {
        // Same.
      }
    }
    return report;
  }
}
