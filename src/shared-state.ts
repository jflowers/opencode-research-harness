/**
 * Process-wide state shared by every copy of the plugin (SPEC §3.8 rule 2),
 * plus read access to the supervisor's side-session registry (rule 3, E5).
 */

const HARNESS_KEY = Symbol.for("opencode-research-harness.shared-state")
const SUPERVISOR_KEY = Symbol.for("opencode-agent-supervisor.shared-state")

/**
 * What the harness filled in or changed on one tool call (cross-plugin
 * contract, read by opencode-agent-supervisor). `args` holds only the
 * injected part: a key the model left out carries the whole value the
 * harness set; for an array arg it lists just the elements the harness
 * appended; for a changed scalar it carries the new value.
 */
export interface InjectedArgsRecord {
  sessionID: string
  tool: string
  args: Record<string, unknown>
}

/** Bound on `injectedArgs`; the oldest callIDs are evicted first. */
export const MAX_INJECTED_ARGS = 512

interface HarnessSharedState {
  loadsByDirectory: Map<string, Set<string>>
  /** callID → what the harness injected on that call (insertion-ordered, bounded). */
  injectedArgs: Map<string, InjectedArgsRecord>
}

function store(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>
}

export function harnessSharedState(): HarnessSharedState {
  const s = store()
  const state = (s[HARNESS_KEY] ?? {}) as Partial<HarnessSharedState>
  state.loadsByDirectory ??= new Map()
  state.injectedArgs ??= new Map()
  s[HARNESS_KEY] = state
  return state as HarnessSharedState
}

/**
 * Records that the copy at `moduleUrl` started for `directory`.
 * Returns the module URLs of OTHER copies already started there.
 */
export function registerLoad(directory: string, moduleUrl: string): string[] {
  const loads = harnessSharedState().loadsByDirectory
  const urls = loads.get(directory) ?? new Set<string>()
  const others = [...urls].filter((u) => u !== moduleUrl)
  if (others.length === 0) {
    urls.add(moduleUrl)
    loads.set(directory, urls)
  }
  return others
}

export function releaseLoad(directory: string, moduleUrl: string): void {
  const urls = harnessSharedState().loadsByDirectory.get(directory)
  urls?.delete(moduleUrl)
}

/** True when the supervisor has registered `sessionID` as one of its side sessions. */
export function isSupervisorSideSession(sessionID: string): boolean {
  const state = store()[SUPERVISOR_KEY] as { sideSessionIds?: unknown } | undefined
  const ids = state?.sideSessionIds
  return ids instanceof Set && ids.has(sessionID)
}

/** A copy of `args` deep enough to diff after the harness edits it in place. */
export function snapshotArgs(args: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) copy[k] = Array.isArray(v) ? [...v] : v
  return copy
}

/** The part of `after` the harness added or changed relative to `before`; empty when nothing changed. */
export function injectedPart(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(after)) {
    const was = before[k]
    if (was === undefined || was === null || was === "") {
      if (v !== undefined && v !== was) out[k] = v
    } else if (Array.isArray(was) && Array.isArray(v)) {
      const added = v.filter((x) => !was.includes(x))
      if (added.length > 0) out[k] = added
    } else if (was !== v) {
      out[k] = v
    }
  }
  return out
}

/**
 * Records what the harness injected on `callID`, so the supervisor can tell
 * the auditor those args were not the model's. A call with nothing injected
 * is not recorded. The map keeps at most MAX_INJECTED_ARGS entries.
 */
export function recordInjectedArgs(callID: string, sessionID: string, tool: string, injected: Record<string, unknown>): void {
  if (!callID || Object.keys(injected).length === 0) return
  const map = harnessSharedState().injectedArgs
  map.delete(callID)
  map.set(callID, { sessionID, tool, args: injected })
  while (map.size > MAX_INJECTED_ARGS) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}
