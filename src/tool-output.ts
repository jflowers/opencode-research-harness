/**
 * The `output` that `tool.execute.after` receives has two shapes in opencode
 * 1.19.0 (`session/tools.ts`):
 *
 * - built-in and plugin tools: `{ title, output: string, metadata }`;
 * - MCP tools (Dewey, …): the raw MCP result, `{ content: [{ type: "text", text }, …] }`,
 *   which opencode turns into the model-visible text *after* the hook.
 *
 * Writing `output.output` on an MCP result is silently dropped, so every note
 * the harness adds goes through these helpers.
 */
export type ToolOutput = { output?: unknown; content?: unknown } & Record<string, unknown>

interface TextItem {
  type: "text"
  text: string
}

function contentOf(out: ToolOutput): unknown[] | null {
  return typeof out.output !== "string" && Array.isArray(out.content) ? out.content : null
}

/** Adds a note before or after the tool's text, in whichever shape the output has. */
export function addNote(out: ToolOutput | undefined, text: string, where: "start" | "end"): void {
  if (!out) return
  const content = contentOf(out)
  if (content) {
    const item: TextItem = { type: "text", text }
    if (where === "start") content.unshift(item)
    else content.push(item)
    return
  }
  const current = typeof out.output === "string" ? out.output : ""
  if (!current) out.output = text
  else out.output = where === "start" ? `${text}\n${current}` : `${current}\n\n${text}`
}

/** Replaces everything the model will see from this tool call. */
export function replaceText(out: ToolOutput | undefined, text: string): void {
  if (!out) return
  const content = contentOf(out)
  if (content) content.splice(0, content.length, { type: "text", text } satisfies TextItem)
  else out.output = text
}
