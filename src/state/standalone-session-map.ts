export interface StandaloneSessionGroup {
  groupId: string;
  name: string;
  sessionIds: string[];
}

export interface StandaloneSessionBindings {
  groups: StandaloneSessionGroup[];
  activeSessionId: string | null;
  conflictingSessionIds: string[];
}

export const DEFAULT_STANDALONE_GROUP_ID = "standalone-default";
export const DEFAULT_STANDALONE_GROUP_NAME = "独立会话";

/**
 * Normalize the path-free Agent workbench without ever stealing a Session
 * already owned by a file/folder target. Legacy flat membership is migrated
 * into the permanent default group. Content ownership wins because it carries
 * the stable vault/target identity needed for replay.
 */
export function normalizeStandaloneSessionBindings(
  values: readonly StandaloneSessionGroup[],
  legacySessionIds: readonly string[],
  activeSessionId: string | null,
  contentSessionIds: ReadonlySet<string> = new Set()
): StandaloneSessionBindings {
  const seenGroupIds = new Set<string>();
  const seenSessionIds = new Set<string>();
  const conflictingSessionIds: string[] = [];
  const groups: StandaloneSessionGroup[] = [];

  for (const value of values) {
    if (!isGroupId(value.groupId) || seenGroupIds.has(value.groupId) || !isGroupName(value.name)) continue;
    seenGroupIds.add(value.groupId);
    groups.push({
      groupId: value.groupId,
      name: value.name.trim(),
      sessionIds: normalizeSessionIds(
        value.sessionIds,
        seenSessionIds,
        contentSessionIds,
        conflictingSessionIds
      )
    });
  }

  let defaultGroup = groups.find((group) => group.groupId === DEFAULT_STANDALONE_GROUP_ID);
  if (defaultGroup === undefined) {
    defaultGroup = {
      groupId: DEFAULT_STANDALONE_GROUP_ID,
      name: DEFAULT_STANDALONE_GROUP_NAME,
      sessionIds: []
    };
    groups.unshift(defaultGroup);
  }
  defaultGroup.sessionIds.push(...normalizeSessionIds(
    legacySessionIds,
    seenSessionIds,
    contentSessionIds,
    conflictingSessionIds
  ));

  const sessionIds = standaloneSessionIds(groups);
  return {
    groups,
    activeSessionId: activeSessionId !== null && sessionIds.includes(activeSessionId)
      ? activeSessionId
      : sessionIds[0] ?? null,
    conflictingSessionIds
  };
}

export function addStandaloneSessionGroup(
  values: readonly StandaloneSessionGroup[],
  groupId: string,
  name: string
): StandaloneSessionGroup[] {
  if (!isGroupId(groupId)) throw new Error("cannot add an empty standalone group id");
  if (!isGroupName(name)) throw new Error("standalone group name must contain 1-80 characters");
  if (values.some((group) => group.groupId === groupId)) {
    throw new Error(`standalone group already exists ${groupId}`);
  }
  const normalizedName = name.trim();
  if (values.some((group) => group.name === normalizedName)) {
    throw new Error(`standalone group name already exists ${normalizedName}`);
  }
  return [...cloneGroups(values), { groupId, name: normalizedName, sessionIds: [] }];
}

export function addStandaloneSessionBinding(
  values: readonly StandaloneSessionGroup[],
  groupId: string,
  sessionId: string
): { groups: StandaloneSessionGroup[]; activeSessionId: string } {
  if (!isSessionId(sessionId)) throw new Error("cannot add an empty standalone session id");
  if (!values.some((group) => group.groupId === groupId)) {
    throw new Error(`cannot add a Session to missing standalone group ${groupId}`);
  }
  if (standaloneSessionIds(values).includes(sessionId)) {
    return { groups: cloneGroups(values), activeSessionId: sessionId };
  }
  return {
    groups: values.map((group) => ({
      ...group,
      sessionIds: group.groupId === groupId ? [...group.sessionIds, sessionId] : [...group.sessionIds]
    })),
    activeSessionId: sessionId
  };
}

export function selectStandaloneSessionBinding(
  values: readonly StandaloneSessionGroup[],
  activeSessionId: string | null,
  sessionId: string
): string {
  if (!standaloneSessionIds(values).includes(sessionId)) {
    throw new Error(`cannot select unbound standalone session ${sessionId}`);
  }
  return activeSessionId === sessionId ? activeSessionId : sessionId;
}

export function standaloneSessionIds(values: readonly StandaloneSessionGroup[]): string[] {
  return values.flatMap((group) => group.sessionIds);
}

function normalizeSessionIds(
  values: readonly string[],
  seenSessionIds: Set<string>,
  contentSessionIds: ReadonlySet<string>,
  conflictingSessionIds: string[]
): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!isSessionId(value) || seenSessionIds.has(value)) continue;
    seenSessionIds.add(value);
    if (contentSessionIds.has(value)) {
      conflictingSessionIds.push(value);
      continue;
    }
    result.push(value);
  }
  return result;
}

function cloneGroups(values: readonly StandaloneSessionGroup[]): StandaloneSessionGroup[] {
  return values.map((group) => ({ ...group, sessionIds: [...group.sessionIds] }));
}

function isGroupId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isGroupName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
