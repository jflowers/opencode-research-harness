import { addNote, type ToolOutput } from "../tool-output"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type HarnessContext, Rejection } from "../context"
import { SLUG_RE, toProjectRel, topicOfPath, underAllowlist } from "../paths"

// ------------------------------------------------------------------ actions

export type TopicAction =
  | { action: "show" }
  | { action: "set"; slug: string }
  | { action: "new"; slug: string }
  | { action: "all" }
  | { action: "list" }

/** Parses `/topic` arguments: "", "<slug>", "--new <slug>", "--all", "--list". */
export function parseTopicArgs(raw: string): TopicAction | { error: string } {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { action: "show" }
  const [first, second] = parts
  if (first === "--all") return { action: "all" }
  if (first === "--list") return { action: "list" }
  if (first === "--new") {
    if (!second) return { error: "`/topic --new` needs a slug." }
    return { action: "new", slug: second }
  }
  if (first!.startsWith("--")) return { error: `Unknown option ${first}. Use <slug>, --new <slug>, --all or --list.` }
  return { action: "set", slug: first! }
}

function topicLine(ctx: HarnessContext, slug: string): string {
  const t = ctx.topics.get(slug)
  return t?.question ? `${slug} — ${t.question}` : slug
}

/** Applies a topic action for a session and returns text for the model. */
export function runTopicAction(ctx: HarnessContext, sessionId: string, a: TopicAction): string {
  const topicsDir = ctx.config.topicsDir
  switch (a.action) {
    case "list": {
      const current = ctx.view(sessionId).topic?.slug
      const all = ctx.topics.list()
      if (all.length === 0) return `No topics yet. Create one with \`/topic --new <slug>\`.`
      return [
        "Research topics:",
        ...all.map((s) => `- ${s === current ? "**(active)** " : ""}${topicLine(ctx, s)}`),
      ].join("\n")
    }
    case "show": {
      const v = ctx.view(sessionId)
      if (!v.topic) {
        const all = ctx.topics.list()
        return [
          "No research topic is active for this session. Ask the user which topic to work on. Do not choose for them.",
          all.length ? `Existing topics: ${all.join(", ")}.` : "There are no topics yet.",
          "They can also create one with `/topic --new <slug>`.",
        ].join("\n")
      }
      return [
        `Active topic: **${v.topic.slug}**${v.crossTopic ? " (cross-topic searches on)" : ""}.`,
        v.topic.question ? `Question: ${v.topic.question}` : "",
        `Read ${topicsDir}/${v.topic.slug}/TOPIC.md and PLAN.md, then summarize the scope in one line and the next steps.`,
      ]
        .filter(Boolean)
        .join("\n")
    }
    case "set": {
      if (!SLUG_RE.test(a.slug) || !ctx.topics.exists(a.slug)) {
        return `Topic \`${a.slug}\` does not exist. Tell the user, and offer \`/topic --new ${a.slug}\` or one of: ${ctx.topics.list().join(", ") || "(none)"}.`
      }
      const t = ctx.topics.get(a.slug)!
      if (t.dimensions.length === 0) {
        return `Topic \`${a.slug}\` has no "Required synthesis dimensions" in ${topicsDir}/${a.slug}/TOPIC.md. Ask the user for them and add them before researching; the topic was not activated.`
      }
      ctx.setTopic(sessionId, a.slug, false)
      writeWorkspaceDefault(ctx, a.slug)
      return [
        `Active topic is now **${a.slug}** for this session. Dewey searches, session-notes and file writes are scoped to it.`,
        `Read ${topicsDir}/${a.slug}/TOPIC.md and ${topicsDir}/${a.slug}/PLAN.md, then report the scope and the next steps from the plan.`,
      ].join("\n")
    }
    case "all": {
      const v = ctx.view(sessionId)
      ctx.setTopic(sessionId, v.topic?.slug ?? null, true)
      return [
        "Cross-topic mode is on for this session: Dewey, session-notes and file searches are not limited to one topic. Writes stay scoped.",
        'Say "cross-topic" in every reply that uses unscoped results. `/topic <slug>` turns it off.',
      ].join("\n")
    }
    case "new":
      return createTopic(ctx, sessionId, a.slug)
  }
}

function writeWorkspaceDefault(ctx: HarnessContext, slug: string): void {
  if (!ctx.config.writeWorkspaceDefaultOnSet) return
  const path = join(ctx.directory, ctx.config.workspaceDefaultFile)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${slug}\n`)
}

function createTopic(ctx: HarnessContext, sessionId: string, slug: string): string {
  const { topicsDir } = ctx.config
  if (!SLUG_RE.test(slug)) return `\`${slug}\` is not a valid slug (must match ${SLUG_RE}). Ask the user for a valid one.`
  const dir = join(ctx.directory, topicsDir, slug)
  if (existsSync(dir)) return `${topicsDir}/${slug}/ already exists. Tell the user; use \`/topic ${slug}\` to switch to it.`
  const template = join(ctx.directory, topicsDir, "_template")
  if (existsSync(template)) {
    cpSync(template, dir, { recursive: true })
  } else {
    mkdirSync(join(dir, "findings"), { recursive: true })
    writeFileSync(
      join(dir, "TOPIC.md"),
      `# Topic: ${slug}\n\n## Research question\n\n## Scope\n\n## Required synthesis dimensions\n\n`,
    )
  }
  const topicMd = join(dir, "TOPIC.md")
  if (existsSync(topicMd)) writeFileSync(topicMd, readFileSync(topicMd, "utf8").replaceAll("<slug>", slug))

  const sources = join(ctx.directory, ctx.config.dewey.sourcesFile)
  let sourceNote = ""
  if (existsSync(sources)) {
    const text = readFileSync(sources, "utf8")
    if (!new RegExp(`^\\s*-\\s*id:\\s*disk-${slug}\\s*$`, "m").test(text)) {
      appendFileSync(
        sources,
        `${text.endsWith("\n") ? "" : "\n"}  - id: disk-${slug}\n    type: disk\n    name: ${slug}\n    config:\n      path: "${topicsDir}/${slug}"\n`,
      )
    }
    sourceNote = ` Registered Dewey source \`disk-${slug}\`; run \`dewey_index\` with \`source_id: "disk-${slug}"\` (or \`/dewey-index\`).`
  }

  // Activate even though dimensions are still placeholders: the next step is filling TOPIC.md in.
  ctx.setTopic(sessionId, slug, false)
  writeWorkspaceDefault(ctx, slug)
  return [
    `Created ${topicsDir}/${slug}/ from the template and made it the active topic.${sourceNote}`,
    `Now ask the user for the research question, scope, focus areas, evaluation criteria and required synthesis dimensions, and fill in ${topicsDir}/${slug}/TOPIC.md from their answers. Do not invent scope they didn't give. Claim layers come from the required synthesis dimensions.`,
  ].join("\n")
}

// ------------------------------------------------------------------ scoping

const WRITE_SHELL_RE = /(>>?|\btee\b|\bmv\b|\bcp\b|\brm\b|\bsed\s+-i|\btouch\b|\bmkdir\b)/

function patchPaths(patchText: unknown): string[] {
  if (typeof patchText !== "string") return []
  const out: string[] = []
  for (const m of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    out.push((m[1] ?? m[2])!.trim())
  }
  return out
}

/** File paths an edit tool call writes to. */
export function editTargets(tool: string, args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ["filePath", "file_path", "path"]) {
    if (typeof args[key] === "string") out.push(args[key] as string)
  }
  if (tool === "patch" || tool === "apply_patch") out.push(...patchPaths(args.patchText ?? args.patch ?? args.input))
  return out
}

function crossTopicHint(slug: string): string {
  return `The active topic is \`${slug}\`. If the user wants to work across topics, they can run \`/topic --all\`.`
}

/**
 * FR-T6: fills in scope where absent, rejects an explicit different topic.
 * Mutates `args` in place. Throws Rejection.
 */
export function scopeToolCall(ctx: HarnessContext, tool: string, sessionId: string, args: Record<string, unknown>): void {
  const v = ctx.view(sessionId)
  if (v.ignored || !v.topic) return
  const slug = v.topic.slug
  const { dewey, notes, topicsDir } = ctx.config
  const sourceId = `disk-${slug}`
  const topicTag = `${notes.tagPrefix}${slug}`

  // Dewey reads.
  if (dewey.readTools.includes(tool)) {
    if (v.crossTopic) return
    const scopable = tool === dewey.filteredSearchTool || ctx.hasParam(tool, "source_id")
    if (!scopable) {
      throw new Rejection(
        `\`${tool}\` can't be limited to a topic. Use \`${dewey.filteredSearchTool}\` with \`source_id: "${sourceId}"\` instead (same \`query\`). ${crossTopicHint(slug)}`,
      )
    }
    const given = args.source_id
    if (given === undefined || given === null || given === "") args.source_id = sourceId
    else if (given !== sourceId) {
      throw new Rejection(`\`source_id: "${String(given)}"\` is outside the active topic; use \`"${sourceId}"\`. ${crossTopicHint(slug)}`)
    }
    return
  }

  // Dewey learning writes: always scoped.
  if (tool === dewey.storeLearningTool) {
    let given = args.tag
    if ((given === undefined || given === "") && typeof args.tags === "string") given = args.tags.split(",")[0]?.trim()
    if (given === undefined || given === null || given === "") args.tag = slug
    else if (String(given).toLowerCase() !== slug) {
      throw new Rejection(`Learnings in this session are tagged \`${slug}\`, not \`${String(given)}\`. Use \`tag: "${slug}"\`.`)
    }
    else args.tag = slug
    return
  }

  // Session-notes.
  const isNoteSave = tool === notes.saveTool
  if (isNoteSave || notes.taggedReadTools.includes(tool)) {
    if (!isNoteSave && v.crossTopic) return
    if (!isNoteSave && !ctx.hasParam(tool, "tags") && tool !== "note_search") {
      throw new Rejection(
        `\`${tool}\` can't be limited to a topic in this version of session-notes. Use \`note_search\` with \`tags: ["${topicTag}"]\` instead. ${crossTopicHint(slug)}`,
      )
    }
    const tags = Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : []
    const other = tags.find((t) => t.startsWith(notes.tagPrefix) && t !== topicTag)
    if (other) throw new Rejection(`Tag \`${other}\` is outside the active topic; use \`${topicTag}\`. ${crossTopicHint(slug)}`)
    if (!tags.includes(topicTag)) tags.push(topicTag)
    args.tags = tags
    return
  }

  // File writes: always scoped.
  if (ctx.config.editTools.includes(tool)) {
    for (const target of editTargets(tool, args)) {
      const rel = toProjectRel(ctx.directory, target)
      if (rel === null) continue // outside the project: opencode's external_directory permission decides
      if (underAllowlist(rel, ctx.config.writeAllowlist)) continue
      if (topicOfPath(rel, topicsDir) === slug) continue
      throw new Rejection(
        `Writes in this session stay inside \`${topicsDir}/${slug}/\`; \`${rel}\` is outside it. Files outside the active topic are read-only unless the user asks otherwise.`,
      )
    }
    return
  }

  // File searches.
  if (tool === "grep" || tool === "glob") {
    if (v.crossTopic) return
    const p = args.path
    if (p === undefined || p === null || p === "") {
      args.path = join(ctx.directory, topicsDir, slug)
      return
    }
    const rel = toProjectRel(ctx.directory, String(p))
    const other = rel === null ? null : topicOfPath(rel, topicsDir)
    if (other && other !== slug) {
      throw new Rejection(`\`${rel}\` belongs to topic \`${other}\`. Search \`${topicsDir}/${slug}/\` instead. ${crossTopicHint(slug)}`)
    }
    return
  }

  // Shell: block writes into other topics (best effort).
  if (tool === "bash" && typeof args.command === "string") {
    const cmd = args.command
    if (!WRITE_SHELL_RE.test(cmd)) return
    const re = new RegExp(`(?:^|[\\s"'=/])${topicsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([a-z0-9][a-z0-9-]*)/`, "g")
    for (const m of cmd.matchAll(re)) {
      if (m[1] !== slug && m[1] !== "_template") {
        throw new Rejection(
          `This command appears to write into \`${topicsDir}/${m[1]}/\`, outside the active topic \`${slug}\`. Files outside the active topic are read-only unless the user asks otherwise.`,
        )
      }
    }
  }
}

/** D8: an explicit read of another topic's file passes, flagged in the output. */
export function annotateCrossTopicRead(
  ctx: HarnessContext,
  tool: string,
  sessionId: string,
  args: Record<string, unknown> | undefined,
  output: ToolOutput,
): void {
  if (tool !== "read" || !args) return
  const v = ctx.view(sessionId)
  if (v.ignored || !v.topic) return
  const target = args.filePath ?? args.file_path ?? args.path
  if (typeof target !== "string") return
  const rel = toProjectRel(ctx.directory, target)
  const other = rel === null ? null : topicOfPath(rel, ctx.config.topicsDir)
  if (other && other !== v.topic.slug) {
    addNote(output, `[research-harness] cross-topic source: ${rel} (topic \`${other}\`, active topic \`${v.topic.slug}\`)`, "start")
  }
}

/** Records whether a tool's parameter schema has each key (E1/E2 detection). */
export function recordToolDefinition(ctx: HarnessContext, toolId: string, parameters: unknown): void {
  const keys = new Set<string>()
  const p = parameters as { properties?: Record<string, unknown>; shape?: Record<string, unknown>; _def?: { shape?: () => Record<string, unknown> } } | undefined
  for (const k of Object.keys(p?.properties ?? {})) keys.add(k)
  for (const k of Object.keys(p?.shape ?? {})) keys.add(k)
  ctx.caps.params.set(toolId, keys)
}

export function rejectionNoteFor(ctx: HarnessContext, toolId: string): string | null {
  const { dewey } = ctx.config
  if (dewey.readTools.includes(toolId) && toolId !== dewey.filteredSearchTool && !ctx.hasParam(toolId, "source_id")) {
    return `Rejected while a research topic is active; use ${dewey.filteredSearchTool} with source_id instead.`
  }
  return null
}
