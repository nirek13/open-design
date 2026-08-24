// Reporting chain: who can see whose work.
//
// Scope is the chain, not the role. You see yourself, everyone above you
// (manager, their manager, …), and everyone below you (direct reports and
// theirs). A peer who shares your manager is out of scope unless they also
// sit on that chain. Unowned / legacy rows (no creator) stay visible so
// pre-hierarchy data does not vanish.

export interface HierarchyMember {
  id: string;
  reportsTo: string | null;
  status?: string;
}

/** Member ids the viewer may see: self ∪ ancestors ∪ descendants. */
export function visibleMemberIds(
  members: readonly HierarchyMember[],
  viewerMemberId: string,
): Set<string> {
  const active = members.filter((member) => member.status !== 'removed');
  const byId = new Map(active.map((member) => [member.id, member]));
  const children = new Map<string, string[]>();
  for (const member of active) {
    if (!member.reportsTo || !byId.has(member.reportsTo)) continue;
    const list = children.get(member.reportsTo) ?? [];
    list.push(member.id);
    children.set(member.reportsTo, list);
  }

  const visible = new Set<string>();
  if (!byId.has(viewerMemberId)) return visible;
  visible.add(viewerMemberId);

  const seenUp = new Set<string>();
  let cursor = byId.get(viewerMemberId)?.reportsTo ?? null;
  while (cursor && byId.has(cursor) && !seenUp.has(cursor)) {
    seenUp.add(cursor);
    visible.add(cursor);
    cursor = byId.get(cursor)?.reportsTo ?? null;
  }

  const stack = [...(children.get(viewerMemberId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visible.has(id)) continue;
    visible.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return visible;
}

/** True when setting `memberId.reportsTo = managerId` would loop. */
export function reportsToWouldCycle(
  members: readonly HierarchyMember[],
  memberId: string,
  managerId: string,
): boolean {
  if (memberId === managerId) return true;
  const byId = new Map(members.map((member) => [member.id, member]));
  const seen = new Set<string>();
  let cursor: string | null = managerId;
  while (cursor) {
    if (cursor === memberId) return true;
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = byId.get(cursor)?.reportsTo ?? null;
  }
  return false;
}

/** An item is in scope when it has no owner (legacy) or its owner sits on
 * the viewer's reporting chain. */
export function ownerInHierarchyScope(
  visibleMemberIds: ReadonlySet<string>,
  visibleUserIds: ReadonlySet<string>,
  ownerMemberId: string | null | undefined,
  ownerUserId: string | null | undefined = null,
): boolean {
  if (!ownerMemberId && !ownerUserId) return true;
  if (ownerMemberId && visibleMemberIds.has(ownerMemberId)) return true;
  if (ownerUserId && visibleUserIds.has(ownerUserId)) return true;
  return false;
}
