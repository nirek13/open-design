// The chat stream, and the two things a client pushes back into it.
//
// `GET /api/orgs/:orgId/chat/stream` is a Server-Sent Events connection. SSE
// rather than a WebSocket because everything here flows one way — the server
// tells the client what happened, and the client's own writes are ordinary
// POSTs that already have auth, validation, and error handling. A socket would
// buy bidirectionality nobody needs and cost a second code path for every
// mutation.
//
// Resume is the part that matters. Each durable frame carries the `id:` field
// SSE defines, so the browser's EventSource automatically sends it back as
// `Last-Event-ID` when the connection drops. The handler reads it, replays
// everything after it from the log, and only then starts live delivery. A
// laptop that closes for an hour reopens and catches up rather than reloading.

import type { Express, Response } from 'express';
import {
  PRESENCE_HEARTBEAT_MS,
  createApiError,
  type ChatPresenceState,
  type ChatStreamFrame,
  type ChatStreamHello,
} from '@open-design/contracts';
import { sendApiError } from '../http/response.js';
import { currentChatSeq, replayChatEvents } from '../workspace-data/chat-events.js';
import { getChannel } from '../workspace-data/chat.js';
import { listLiveHuddles } from '../workspace-data/chat-huddles.js';
import {
  chatHandler,
  chatParam,
  sendChatError,
  type ChatContext,
  type ChatRequest,
} from './chat-context.js';

/** A ping this often keeps proxies from closing an idle connection, and lets
 * the client notice a dead link without waiting for TCP to give up. Comfortably
 * under the 60 seconds most reverse proxies default to. */
const HEARTBEAT_MS = 25_000;

/** How the hub writes to one open response. Kept behind an interface in the
 * hub so it never has to know about Express; this is the only place the two
 * meet. */
function sinkFor(res: Response) {
  return {
    write(chunk: string): boolean {
      return res.write(chunk);
    },
    bufferedBytes(): number {
      // `writableLength` is what Node has already accepted but not yet flushed
      // to the socket. A client that has stopped reading makes this grow
      // without bound, which is exactly the signal the hub disconnects on.
      return res.writableLength ?? 0;
    },
    close(): void {
      try {
        res.end();
      } catch {
        // Already closed.
      }
    },
  };
}

export function registerChatRealtimeRoutes(app: Express, ctx: ChatContext): void {
  const { hub } = ctx.services;

  app.get('/api/orgs/:orgId/chat/stream', async (req: ChatRequest, res: Response) => {
    let scope;
    try {
      scope = await ctx.scope(req);
    } catch (err) {
      sendChatError(res, err);
      return;
    }
    const { orgId, member, db } = scope;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx buffers proxied responses by default, which turns a live stream
      // into a batch delivered whenever the buffer happens to fill.
      'X-Accel-Buffering': 'no',
    });
    // Tell the browser how long to wait before reconnecting after a drop. Its
    // default is 3 seconds; a little longer avoids a thundering herd when the
    // daemon restarts and every open tab reconnects at once.
    res.write(`retry: 5000\n\n`);

    // `Last-Event-ID` is set by the browser automatically on reconnect. The
    // query parameter is the escape hatch for clients that are not EventSource
    // — the CLI, and tests.
    const headerId = req.headers['last-event-id'];
    const rawCursor =
      (Array.isArray(headerId) ? headerId[0] : headerId)
      ?? (typeof req.query.since === 'string' ? req.query.since : '');
    const cursor = Number.parseInt(String(rawCursor ?? ''), 10);
    const since = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;

    let hello: ChatStreamHello;
    let backlog: ChatStreamFrame[] = [];
    try {
      const replay = since > 0 ? await replayChatEvents(db, orgId, since) : null;
      hello = {
        orgId,
        memberId: member.id,
        seq: replay?.seq ?? (await currentChatSeq(db, orgId)),
        presence: hub.presence(orgId),
        huddles: await listLiveHuddles(db, orgId, await scope.withNames()),
        truncated: replay?.truncated ?? false,
      };
      // A replayed event is filtered exactly like a live one: the audience list
      // if it has one, and channel visibility otherwise.
      if (replay && !replay.truncated) {
        const visible = new Set<string>();
        for (const stored of replay.events) {
          if (stored.audience && !stored.audience.includes(member.id)) continue;
          if (stored.channelId && !visible.has(stored.channelId)) {
            try {
              await getChannel(db, orgId, stored.channelId, member.id);
              visible.add(stored.channelId);
            } catch {
              continue;
            }
          }
          backlog.push({ seq: stored.seq, orgId, event: stored.event });
        }
      }
    } catch (err) {
      // The stream cannot report an error status — the headers are already
      // out — so say so in-band and close. The client will reconnect.
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`);
      res.end();
      return;
    }

    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    for (const frame of backlog) {
      res.write(`id: ${frame.seq}\nevent: chat\ndata: ${JSON.stringify(frame)}\n\n`);
    }
    backlog = [];

    const subscription = hub.subscribe(orgId, member.id, sinkFor(res));
    const heartbeat = setInterval(() => {
      // A comment line is a valid SSE frame that no handler sees. It exists to
      // move bytes so a dead connection surfaces as a write error.
      try {
        res.write(': ping\n\n');
      } catch {
        subscription.close();
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    const stop = () => {
      clearInterval(heartbeat);
      subscription.close();
    };
    req.on('close', stop);
    req.on('error', stop);
  });

  /** Say you are alive, and how you want to be shown. Called on a timer by
   * every open tab; deliberately cheap — it touches no table. */
  app.post(
    '/api/orgs/:orgId/chat/presence',
    chatHandler(async (req, res) => {
      const { orgId, member } = await ctx.scope(req);
      const requested = req.body?.state;
      const state: ChatPresenceState =
        requested === 'away' || requested === 'offline' || requested === 'active' ? requested : 'active';
      res.json({
        presence: hub.heartbeat(orgId, member.id, state),
        roster: hub.presence(orgId),
        intervalMs: PRESENCE_HEARTBEAT_MS,
      });
    }),
  );

  app.get(
    '/api/orgs/:orgId/chat/presence',
    chatHandler(async (req, res) => {
      const { orgId } = await ctx.scope(req);
      res.json({ roster: hub.presence(orgId), intervalMs: PRESENCE_HEARTBEAT_MS });
    }),
  );

  /** Started or stopped typing. Rate-limited because the composer sends this
   * on a throttle, and a client with a broken throttle should cost the daemon
   * nothing. */
  app.post(
    '/api/orgs/:orgId/chat/channels/:channelRef/typing',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      if (!ctx.allow(res, 'chat:typing', `${orgId}:${member.id}`)) return;
      // Resolving through getChannel is the access check: someone who cannot
      // see the channel cannot announce themselves into it.
      const channel = await getChannel(db, orgId, chatParam(req, 'channelRef'), member.id);
      const parentMessageId =
        typeof req.body?.parentMessageId === 'string' && req.body.parentMessageId
          ? req.body.parentMessageId
          : null;
      const typing = req.body?.typing !== false;
      res.json({ typing: hub.typing(orgId, channel.id, member.id, parentMessageId, typing) });
    }),
  );

  app.get(
    '/api/orgs/:orgId/chat/channels/:channelRef/typing',
    chatHandler(async (req, res) => {
      const { orgId, member, db } = await ctx.scope(req);
      const channel = await getChannel(db, orgId, chatParam(req, 'channelRef'), member.id);
      res.json({ typing: hub.typingIn(orgId, channel.id).filter((row) => row.memberId !== member.id) });
    }),
  );

  /** Where the log is now. A client that has been away can ask this before
   * opening a stream to decide whether a resume is worth attempting or whether
   * it should just reload. */
  app.get(
    '/api/orgs/:orgId/chat/stream/position',
    chatHandler(async (req, res) => {
      const { orgId, db } = await ctx.scope(req);
      res.json({ seq: await currentChatSeq(db, orgId), subscribers: hub.subscriberCount(orgId) });
    }),
  );

  // A guard for the one mistake this surface invites: pointing a browser at
  // the stream URL without an organization. Answering with a clear error beats
  // an open connection that never says anything.
  app.get('/api/orgs/chat/stream', (_req, res) => {
    sendApiError(
      res,
      404,
      createApiError('ORG_NOT_FOUND', 'the chat stream is per organization: /api/orgs/:orgId/chat/stream'),
    );
  });
}
