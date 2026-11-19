/**
 * Process-wide state shared by every copy of the plugin (SPEC §3.8 rule 2),
 * plus read access to the supervisor's side-session registry (rule 3, E5).
 */

const HARNESS_KEY = Symbol.for("opencode-research-harness.shared-state")
const SUPERVISOR_KEY = Symbol.for("opencode-agent-supervisor.shared-state")

interface HarnessSharedState {
  loadsByDirectory: Map<string, Set<string>>
}

function store(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>
}

export function harnessSharedState(): HarnessSharedState {
  const s = store()
  const state = (s[HARNESS_KEY] ?? {}) as Partial<HarnessSharedState>
  state.loadsByDirectory ??= new Map()
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
