// Post a newly built app into team chat: a DM with a coworker, a named team,
// or a channel. Include grants people; except withholds both the ping and access.

import type { AppAccessPolicy, AppGrantRole, OrgApp, TeamChatAttachment } from '@open-design/contracts';
import {
  fetchAppAccess,
  fetchOrgTeams,
  openChatDirectMessage,
  postChatMessage,
  setAppAccess,
} from '../../providers/registry';

export type SendAppDestination =
  | { kind: 'person'; memberId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'channel'; channelRef: string };

export function appChatAttachment(app: Pick<OrgApp, 'id' | 'name'>): TeamChatAttachment {
  return { kind: 'app', id: app.id, label: app.name };
}

function grantMap(policy: AppAccessPolicy): Map<string, AppGrantRole> {
  return new Map(policy.grants.map((grant) => [grant.memberId, grant.role]));
}

async function applyAudience(
  orgId: string,
  app: Pick<OrgApp, 'id' | 'accessMode'>,
  includeIds: string[],
  exceptIds: string[],
): Promise<void> {
  const policy = await fetchAppAccess(orgId, app.id);
  const grants = grantMap(policy);
  const denials = new Set(policy.denials.map((row) => row.memberId));
  for (const memberId of includeIds) {
    denials.delete(memberId);
    if (app.accessMode === 'restricted' && !grants.has(memberId)) grants.set(memberId, 'view');
  }
  for (const memberId of exceptIds) {
    grants.delete(memberId);
    denials.add(memberId);
  }
  await setAppAccess(orgId, app.id, {
    grants: [...grants].map(([memberId, role]) => ({ memberId, role })),
    teamGrants: policy.teamGrants.map((grant) => ({ teamId: grant.teamId, role: grant.role })),
    denials: [...denials].map((memberId) => ({ memberId })),
  });
}

export async function ensureAppViewGrant(
  orgId: string,
  appId: string,
  memberId: string,
): Promise<void> {
  await applyAudience(orgId, { id: appId, accessMode: 'restricted' }, [memberId], []);
}

/** Send `app` to each destination. Returns the channel refs that received it. */
export async function sendAppToChat(
  orgId: string,
  app: Pick<OrgApp, 'id' | 'name' | 'accessMode'>,
  destinations: SendAppDestination[],
  body: string,
  exceptMemberIds: string[] = [],
): Promise<string[]> {
  const text = body.trim();
  if (destinations.length === 0 && exceptMemberIds.length === 0) {
    throw new Error('pick someone, a team, or a channel');
  }
  if (destinations.length > 0 && !text) throw new Error('a message needs something in it');
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

  try {
    const policy = await fetchAppAccess(orgId, app.id);
    const grants = grantMap(policy);
    const denials = new Set(policy.denials.map((row) => row.memberId));
    const teamGrantMap = new Map(policy.teamGrants.map((grant) => [grant.teamId, grant.role]));
    for (const memberId of personIds) {
      denials.delete(memberId);
      if (app.accessMode === 'restricted' && !grants.has(memberId)) grants.set(memberId, 'view');
    }
    for (const destination of destinations) {
      if (destination.kind === 'team' && app.accessMode === 'restricted') {
        if (!teamGrantMap.has(destination.teamId)) teamGrantMap.set(destination.teamId, 'view');
      }
    }
    for (const memberId of except) {
      grants.delete(memberId);
      denials.add(memberId);
    }
    await setAppAccess(orgId, app.id, {
      grants: [...grants].map(([memberId, role]) => ({ memberId, role })),
      teamGrants: [...teamGrantMap].map(([teamId, role]) => ({ teamId, role })),
      denials: [...denials].map((memberId) => ({ memberId })),
    });
  } catch (err) {
    // Org-wide apps, or a grant the caller cannot change, still send —
    // except-only withhold has no other effect, so that path must fail loudly.
    if (destinations.length === 0) throw err;
  }

  const attachments = [appChatAttachment(app)];
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
