// Drop an org thing into team chat: a DM, a named team, or a channel.
// Except withholds the ping from those people.

import type { CalendarEvent, OrgApp, TeamChatAttachment } from '@open-design/contracts';
import {
  fetchOrgCalendarEvent,
  fetchOrgMembers,
  fetchOrgTeams,
  openChatDirectMessage,
  postChatMessage,
  updateOrgCalendarEvent,
} from '../../providers/registry';

export type SendDestination =
  | { kind: 'person'; memberId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'channel'; channelRef: string };

export type SendAppDestination = SendDestination;

export function pageChatAttachment(page: { id: string; title: string }): TeamChatAttachment {
  return { kind: 'page', id: page.id, label: page.title || 'Untitled' };
}

export function eventChatAttachment(event: { id: string; title: string }): TeamChatAttachment {
  return { kind: 'event', id: event.id, label: event.title };
}

export async function resolveSendAudience(
  orgId: string,
  destinations: SendDestination[],
  exceptMemberIds: string[] = [],
): Promise<{ personIds: string[]; channelRefs: string[]; teamIds: string[] }> {
  if (destinations.length === 0 && exceptMemberIds.length === 0) {
    throw new Error('pick someone, a team, or a channel');
  }
  const except = new Set(exceptMemberIds);
  const personIds = new Set<string>();
  const channelRefs: string[] = [];
  const teamIds = destinations.filter((row) => row.kind === 'team').map((row) => row.teamId);
  if (teamIds.length > 0) {
    const teams = await fetchOrgTeams(orgId);
    for (const team of teams) {
      if (!teamIds.includes(team.id)) continue;
      for (const memberId of team.memberIds) personIds.add(memberId);
    }
  }
  for (const destination of destinations) {
    if (destination.kind === 'person') personIds.add(destination.memberId);
    if (destination.kind === 'channel') channelRefs.push(destination.channelRef);
  }
  for (const memberId of except) personIds.delete(memberId);
  return { personIds: [...personIds], channelRefs, teamIds };
}

/** Post `attachments` to each destination. Returns the channel refs that received it. */
export async function sendToChat(
  orgId: string,
  destinations: SendDestination[],
  body: string,
  attachments: TeamChatAttachment[],
  exceptMemberIds: string[] = [],
): Promise<string[]> {
  const text = body.trim();
  if (destinations.length === 0 && exceptMemberIds.length === 0) {
    throw new Error('pick someone, a team, or a channel');
  }
  if (destinations.length > 0 && !text) throw new Error('a message needs something in it');
  const { personIds, channelRefs } = await resolveSendAudience(orgId, destinations, exceptMemberIds);
  const posted: string[] = [];
  for (const memberId of personIds) {
    const channel = await openChatDirectMessage(orgId, [memberId]);
    await postChatMessage(orgId, channel.slug, { body: text, attachments });
    posted.push(channel.slug);
  }
  for (const channelRef of channelRefs) {
    await postChatMessage(orgId, channelRef, { body: text, attachments });
    posted.push(channelRef);
  }
  return posted;
}

export async function sendPageToChat(
  orgId: string,
  page: { id: string; title: string },
  destinations: SendDestination[],
  body: string,
  exceptMemberIds: string[] = [],
): Promise<string[]> {
  return sendToChat(orgId, destinations, body, [pageChatAttachment(page)], exceptMemberIds);
}

function eventUpsertBody(event: CalendarEvent, guestUserIds: string[], guestTeamIds: string[]) {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    calendarId: event.calendarId,
    color: event.color,
    recurrence: event.recurrence,
    timezone: event.timezone,
    attendees: event.attendees,
    guestUserIds,
    guestTeamIds,
  };
}

/** Invite picked people/teams onto the event, then drop it in chat. */
export async function sendEventToChat(
  orgId: string,
  event: Pick<CalendarEvent, 'id' | 'title'>,
  destinations: SendDestination[],
  body: string,
  exceptMemberIds: string[] = [],
): Promise<string[]> {
  const { personIds, teamIds } = await resolveSendAudience(orgId, destinations, exceptMemberIds);
  const [current, members] = await Promise.all([
    fetchOrgCalendarEvent(orgId, event.id),
    fetchOrgMembers(orgId),
  ]);
  const userByMember = new Map(members.map((member) => [member.id, member.userId]));
  const guestUsers = new Set(current.guestUserIds);
  const guestTeams = new Set(current.guestTeamIds);
  for (const memberId of personIds) {
    const userId = userByMember.get(memberId);
    if (userId) guestUsers.add(userId);
  }
  for (const teamId of teamIds) guestTeams.add(teamId);
  await updateOrgCalendarEvent(orgId, event.id, eventUpsertBody(current, [...guestUsers], [...guestTeams]));
  return sendToChat(
    orgId,
    destinations,
    body,
    [eventChatAttachment({ id: event.id, title: event.title || current.title })],
    exceptMemberIds,
  );
}

export function appChatAttachment(app: Pick<OrgApp, 'id' | 'name'>): TeamChatAttachment {
  return { kind: 'app', id: app.id, label: app.name };
}
