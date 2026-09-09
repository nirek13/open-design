# Team chat: the realtime layer

Read this before changing anything under `apps/daemon/src/workspace-data/chat*.ts`,
`apps/daemon/src/services/chat-*.ts`, `apps/daemon/src/routes/chat-*.ts`, or
`apps/web/src/components/team/`.

## What changed and why

Team chat used to refresh by asking the daemon for the whole open channel every
five seconds. That is fine for a dashboard and wrong for a conversation:

- Every idle tab cost a full channel render per tick whether or not anything
  had happened. Forty tabs was forty requests a second against a laptop.
- The person you were talking to appeared to answer up to five seconds late.
- Nothing could show that somebody was typing. You cannot poll for that.

Chat is now driven by one authenticated Server-Sent Events stream per
organization, backed by an append-only event log that makes reconnects
lossless.

## The two kinds of event

This split is the design, not an implementation detail.

**Durable** — a message was posted, a channel was renamed, a reaction changed.
Written to `od_chat_events` with a per-organization sequence number **before**
any subscriber is told. A client that reconnects says "I had 4182" and is handed
4183 onward.

**Ephemeral** — presence, typing, huddle signalling, read markers. True only for
the moment they are sent. Never logged, never replayed. Replaying "Ada is
typing" from four minutes ago is worse than not knowing.

`isDurableChatEvent` in `packages/contracts/src/api/chat-realtime.ts` is the
single place that decides which is which. The writer and the reader both call
it rather than each keeping a list that can drift. `appendChatEvent` throws if
handed an ephemeral event, so the mistake fails loudly at the call site.

## Ordering is the invariant

`ChatContext.emit` (in `apps/daemon/src/routes/chat-context.ts`) appends to the
log, then fans out. **Never the other way round.** A stream that fans out first
and persists after has a window in which a client reconnecting in between is
told nothing happened, and no amount of care at the call site fixes that if the
call site is free to choose the order. This is why `emit` exists at all instead
of each route doing both steps itself.

Sequence numbers come from `od_chat_event_cursor`, an upsert that reads and
increments in one statement. `MAX(seq) + 1` would let two concurrent posts claim
the same number, and the unique index would turn a race into a failed message.

## Who hears what

Every channel-scoped event is filtered per subscriber before delivery:

1. An explicit `audience` list wins — used for DMs, private channel creation,
   and huddle signalling. Nobody outside the list can be reached by accident.
2. Otherwise, `channelId === null` means organization-wide.
3. Otherwise, the hub asks the data layer whether this member can see the
   channel, memoised for 15 seconds per member and **dropped immediately** on
   any membership or visibility change (`hub.invalidateVisibility`).

If visibility cannot be established, the answer is no. A missed event is a
refresh away; a leaked one is not recoverable.

Replay applies the same two filters, so resuming cannot deliver something live
delivery would have withheld.

## Backpressure

A subscriber whose socket has buffered more than 1 MB is disconnected rather
than allowed to grow without bound. Nothing is lost: durable events are already
in the log, and the client reconnects with `Last-Event-ID`. Letting the buffer
grow instead trades one stalled tab for the whole process.

## Retention

The log keeps `CHAT_EVENT_RETENTION_MS` (one week) — long enough that a laptop
shut over a weekend resumes, short enough that the table stays small. Replay is
capped at `CHAT_EVENT_REPLAY_LIMIT` frames; beyond that the client is told
`truncated: true` and reloads, because handing it six thousand frames to apply
one at a time is slower than a fresh fetch.

The cursor is **never** reset by pruning, so a stale client's position is still
recognisable as being behind rather than ahead.

`ChatMaintenance` (`apps/daemon/src/services/chat-maintenance.ts`) runs hourly
and does three jobs that fail silently and slowly if nobody runs them: prune the
log, apply per-channel retention, and close huddles whose last participant's
browser crashed without sending a leave.

## The browser end

`openTeamChatStream` uses `EventSource` rather than a `fetch` reader for one
reason: the browser already implements resume. It stores the last `id:` and
replays it as `Last-Event-ID` automatically. Reimplementing that is
reimplementing the part most likely to be subtly wrong.

The session travels as the `od_session` cookie — `EventSource` cannot set an
Authorization header, which is why that cookie exists. The organization is in
the path, not a header, for the same reason.

**Degradation is deliberate.** When the stream is not open (no `EventSource`, a
proxy that will not hold a connection, a restarting daemon), `TeamChatView`
falls back to a 30-second poll and refetches after sending. Chat degrades to
what it was before rather than to silence.

## Rate limits

`CHAT_RATE_RULES` are token buckets, not fixed windows: a burst of twenty
messages is a heated conversation and must never be refused; two a second
sustained is not a person. An action with no rule is **allowed** — a limiter is
a guard rail, and a typo in a rule name must not silently disable a feature.

In memory on purpose. The limit protects this process; a hosted deployment that
needs a shared limit belongs behind a proxy that has one.

## Storage boundaries

- `chat.ts` — channels, membership, messages, threads, read state, search.
- `chat-messaging.ts` — pins, saved, reminders, bookmarks, scheduled, status.
- `chat-org.ts` — custom emoji, user groups, sidebar sections, drafts, quiet
  hours, incoming webhooks, retention.
- `chat-huddles.ts` — huddle rooms and rosters.
- `chat-events.ts` — the durable log.

They are split by **access rule**, not by size. A message is written once and
read by a room; a draft is rewritten on every keystroke and read by one person;
a webhook token is written once and never read back at all. One file where "who
may see this" has six different answers is how a leak gets written.

## Search

`searchMessages` uses SQLite FTS5 (`od_chat_fts`, maintained by triggers) or
Postgres `websearch_to_tsquery` against a GIN index. It falls back to `LIKE`
only when the FTS5 table is absent — a SQLite built without FTS5 should search
slowly rather than not at all. `hasFullTextIndex` caches the answer per executor;
the FTS5 query builder quotes every term, because a search box that throws a
parse error at the person using it is broken.

## Huddles

The daemon carries no audio. It relays offers, answers, and ICE candidates, and
the browsers talk peer-to-peer in a full mesh. Glare is made impossible rather
than recovered from: for any pair, the member whose id sorts lower is the only
one that offers. Both sides compute that from the roster they already have.

Signalling frames are checked for both ends being in the same huddle, so holding
a huddle id is not enough to push JSON at somebody's browser. There is no TURN
server — a call that cannot traverse a symmetric NAT fails rather than being
relayed through infrastructure this product does not run.

## Both surfaces, always

Per the repository's capability rule, every one of these is reachable from the
web UI **and** `od team …`: `stream`, `presence`, `typing`, `emoji*`, `group*`,
`section*`, `draft*`, `dnd`, `huddles`, `forward`, `webhook*`, `retention`,
`export`, `catch-up`, `announce`. If you add a capability here, land all three
of contract, endpoint, and CLI subcommand in the same PR.
