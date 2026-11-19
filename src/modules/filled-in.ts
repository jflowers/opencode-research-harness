import type { HarnessContext } from "../context"
import { toProjectRel } from "../paths"
import { harnessSharedState } from "../shared-state"
import { addNote, type ToolOutput } from "../tool-output"

/**
 * Tells the model which arguments of a call the harness filled in.
 *
 * opencode stores and shows the tool input after `tool.execute.before`, so the
 * model sees injected values (a `topic:<slug>` tag, a default `path`, a Dewey
 * `source_id`) in its own call and, in the live wire check, claimed them as
 * its own deviations. The supervisor learns the same facts from the shared
 * `injectedArgs` registry; this note gives them to the model directly.
 */
export function filledInText(ctx: HarnessContext, injected: Record<string, unknown>): string | null {
  const parts: string[] = []
  for (const [key, value] of Object.entries(injected)) {
    if (Array.isArray(value)) {
      if (value.length) parts.push(`${key} += ${value.map((v) => show(ctx, v)).join(", ")}`)
    } else {
      parts.push(`${key} = ${show(ctx, value)}`)
    }
  }
  if (!parts.length) return null
  return `[research-harness] Filled in by the harness to scope this call to the topic (not arguments you wrote): ${parts.join("; ")}.`
}

function show(ctx: HarnessContext, value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value)
  if (value.startsWith("/")) {
    const rel = toProjectRel(ctx.directory, value)
    if (rel !== null) return rel || "."
  }
  return value
}

/** tool.execute.after: prepends the note when the harness injected anything on this call. */
export function annotateFilledIn(ctx: HarnessContext, sessionId: string, callId: string, output: ToolOutput): void {
  const record = harnessSharedState().injectedArgs.get(callId)
  if (!record || record.sessionID !== sessionId) return
  const text = filledInText(ctx, record.args)
  if (text) addNote(output, text, "start")
}
