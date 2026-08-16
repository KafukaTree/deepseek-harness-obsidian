import { createHash } from "node:crypto";

export function deterministicSessionId(vaultRoot: string, filePath: string): string {
  const digest = createHash("sha256")
    .update(vaultRoot)
    .update("\0")
    .update(filePath)
    .digest("hex")
    .slice(0, 24);
  return `obsidian-${digest}`;
}

export function moveSessionBinding(
  bindings: Record<string, string>,
  oldPath: string,
  newPath: string
): Record<string, string> {
  if (oldPath === newPath) return bindings;
  const affected = Object.entries(bindings).filter(([path]) => isPathOrChild(path, oldPath));
  if (affected.length === 0) return bindings;
  const next = { ...bindings };
  for (const [path] of affected) delete next[path];
  for (const [path, sessionId] of affected) {
    const suffix = path.slice(oldPath.length);
    next[`${newPath}${suffix}`] = sessionId;
  }
  return next;
}

/** Move exact/descendant values while preserving the value type and input on no-op. */
export function movePathBindings<T>(
  bindings: Readonly<Record<string, T>>,
  oldPath: string,
  newPath: string
): Record<string, T> {
  if (oldPath === newPath) return bindings as Record<string, T>;
  const affected = Object.entries(bindings).filter(([path]) => isPathOrChild(path, oldPath));
  if (affected.length === 0) return bindings as Record<string, T>;
  const next = { ...bindings };
  for (const [path] of affected) delete next[path];
  for (const [path, value] of affected) {
    const suffix = path.slice(oldPath.length);
    next[`${newPath}${suffix}`] = value;
  }
  return next;
}

/** Remove the exact path and every descendant binding after a vault delete. */
export function removeSessionBindings(
  bindings: Record<string, string>,
  path: string
): Record<string, string> {
  const affected = Object.keys(bindings).filter((candidate) => isPathOrChild(candidate, path));
  if (affected.length === 0) return bindings;
  const next = { ...bindings };
  for (const candidate of affected) delete next[candidate];
  return next;
}

/** Generic exact/descendant removal used by membership and target maps. */
export function removePathBindings<T>(
  bindings: Readonly<Record<string, T>>,
  path: string
): Record<string, T> {
  const affected = Object.keys(bindings).filter((candidate) => isPathOrChild(candidate, path));
  if (affected.length === 0) return bindings as Record<string, T>;
  const next = { ...bindings };
  for (const candidate of affected) delete next[candidate];
  return next;
}

export interface NormalizedSessionBindings {
  sessionsByPath: Record<string, string[]>;
  sessionByPath: Record<string, string>;
  conflictingSessionIds: string[];
  conflictingPathCount: number;
}

/**
 * Normalize the one-to-many membership and reject the legacy corruption where
 * one Session id was assigned to multiple Obsidian targets. No target wins an
 * ambiguous history: every conflicting reference is detached, while the DSH
 * Session itself remains untouched.
 */
export function normalizeSessionBindings(
  memberships: Readonly<Record<string, readonly string[]>>,
  activeByPath: Readonly<Record<string, string>>
): NormalizedSessionBindings {
  const paths = new Set([...Object.keys(memberships), ...Object.keys(activeByPath)]);
  const candidates: Record<string, string[]> = {};
  for (const path of paths) {
    if (path === "") continue;
    const ids = uniqueSessionIds(memberships[path] ?? []);
    const active = activeByPath[path];
    if (ids.length === 0 && isSessionId(active)) ids.push(active);
    if (ids.length > 0) candidates[path] = ids;
  }

  const pathsBySession = new Map<string, Set<string>>();
  for (const [path, ids] of Object.entries(candidates)) {
    for (const sessionId of ids) {
      const owners = pathsBySession.get(sessionId) ?? new Set<string>();
      owners.add(path);
      pathsBySession.set(sessionId, owners);
    }
  }
  const conflicts = new Set(
    [...pathsBySession].filter(([, owners]) => owners.size > 1).map(([sessionId]) => sessionId)
  );
  const conflictPaths = new Set<string>();
  for (const sessionId of conflicts) {
    for (const path of pathsBySession.get(sessionId) ?? []) conflictPaths.add(path);
  }

  const sessionsByPath: Record<string, string[]> = {};
  const sessionByPath: Record<string, string> = {};
  for (const [path, ids] of Object.entries(candidates)) {
    const clean = ids.filter((sessionId) => !conflicts.has(sessionId));
    if (clean.length === 0) continue;
    sessionsByPath[path] = clean;
    const requested = activeByPath[path];
    sessionByPath[path] = requested !== undefined && clean.includes(requested) ? requested : clean[0]!;
  }
  return {
    sessionsByPath,
    sessionByPath,
    conflictingSessionIds: [...conflicts].sort(),
    conflictingPathCount: conflictPaths.size
  };
}

export function addSessionBinding(
  memberships: Readonly<Record<string, readonly string[]>>,
  activeByPath: Readonly<Record<string, string>>,
  path: string,
  sessionId: string
): { sessionsByPath: Record<string, string[]>; sessionByPath: Record<string, string> } {
  const current = memberships[path] ?? [];
  const nextIds = current.includes(sessionId) ? [...current] : [...current, sessionId];
  const sessionsByPath = Object.fromEntries(
    Object.entries(memberships).map(([candidate, ids]) => [candidate, [...ids]])
  ) as Record<string, string[]>;
  sessionsByPath[path] = nextIds;
  return {
    sessionsByPath,
    sessionByPath: { ...activeByPath, [path]: sessionId }
  };
}

export function selectSessionBinding(
  memberships: Readonly<Record<string, readonly string[]>>,
  activeByPath: Readonly<Record<string, string>>,
  path: string,
  sessionId: string
): Record<string, string> {
  if (!(memberships[path] ?? []).includes(sessionId)) {
    throw new Error(`cannot select unbound session ${sessionId} for ${path}`);
  }
  return activeByPath[path] === sessionId
    ? activeByPath as Record<string, string>
    : { ...activeByPath, [path]: sessionId };
}

/** Replace one path member in place while keeping its active selection stable. */
export function replaceSessionBinding(
  memberships: Readonly<Record<string, readonly string[]>>,
  activeByPath: Readonly<Record<string, string>>,
  path: string,
  previousSessionId: string,
  nextSessionId: string
): { sessionsByPath: Record<string, string[]>; sessionByPath: Record<string, string> } {
  const current = memberships[path] ?? [];
  if (!current.includes(previousSessionId)) {
    throw new Error(`cannot replace unbound session ${previousSessionId} for ${path}`);
  }
  const sessionsByPath = Object.fromEntries(
    Object.entries(memberships).map(([candidate, ids]) => [
      candidate,
      ids.map((sessionId) => sessionId === previousSessionId ? nextSessionId : sessionId)
    ])
  ) as Record<string, string[]>;
  return {
    sessionsByPath,
    sessionByPath: activeByPath[path] === previousSessionId
      ? { ...activeByPath, [path]: nextSessionId }
      : { ...activeByPath }
  };
}

function uniqueSessionIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!isSessionId(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isPathOrChild(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export function bindKnowledgeSession(
  bindings: Readonly<Record<string, string>>,
  orphanedSessions: Readonly<Record<string, string>>,
  path: string,
  sessionId: string
): {
  sessionByPath: Record<string, string>;
  orphanedSessions: Record<string, string>;
  changed: boolean;
} {
  const nextBindings = bindings[path] === sessionId ? bindings : { ...bindings, [path]: sessionId };
  let nextOrphans: Readonly<Record<string, string>> = orphanedSessions;
  for (const [orphanedPath, orphanedSessionId] of Object.entries(orphanedSessions)) {
    if (orphanedPath !== path && orphanedSessionId !== sessionId) continue;
    if (nextOrphans === orphanedSessions) nextOrphans = { ...orphanedSessions };
    delete (nextOrphans as Record<string, string>)[orphanedPath];
  }
  return {
    sessionByPath: nextBindings as Record<string, string>,
    orphanedSessions: nextOrphans as Record<string, string>,
    changed: nextBindings !== bindings || nextOrphans !== orphanedSessions
  };
}
