import { replaceText, type ToolOutput } from "../tool-output"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import type { Claim } from "../claims"
import { type HarnessContext, Rejection } from "../context"
import { pathWithinTopic, toProjectRel, topicOfPath } from "../paths"
import { slugify, type TopicConfig } from "../topic-config"
import { editTargets } from "./topic"

export interface GateResult {
  gate: "open-hypotheses" | "citations" | "dimensions"
  ok: boolean
  details: string
}

/** Lines outside fenced code blocks. */
function proseLines(markdown: string): string[] {
  const out: string[] = []
  let fence = false
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      continue
    }
    if (!fence) out.push(line)
  }
  return out
}

export function validateSynthesis(markdown: string, topic: TopicConfig, claims: Claim[], minCitations: number): GateResult[] {
  const results: GateResult[] = []
  const open = claims.filter((c) => c.status === "hypothesis")
  results.push({
    gate: "open-hypotheses",
    ok: open.length === 0,
    details: open.length
      ? `Open hypotheses: ${open.map((c) => `\`${c.id}\``).join(", ")}. Verify, refute or mark them \`out-of-scope\` with ledger_upsert_claim / ledger_challenge_claim first.`
      : "none open",
  })

  const lines = proseLines(markdown)
  const prose = lines.join("\n")
  const cited = new Set([...prose.matchAll(/\[claim:([a-z0-9][a-z0-9-]*)\]/g)].map((m) => m[1]!))
  const byId = new Map(claims.map((c) => [c.id, c]))
  const unknown = [...cited].filter((id) => !byId.has(id))
  const notVerified = [...cited].filter((id) => byId.has(id) && byId.get(id)!.status !== "verified")
  const verifiedCount = claims.filter((c) => c.status === "verified").length
  const need = Math.min(minCitations, verifiedCount)
  const distinctVerified = [...cited].filter((id) => byId.get(id)?.status === "verified").length
  const citeProblems: string[] = []
  if (unknown.length) citeProblems.push(`unknown claims cited: ${unknown.map((i) => `\`${i}\``).join(", ")}`)
  if (notVerified.length) {
    citeProblems.push(
      `cited claims that are not verified: ${notVerified.map((i) => `\`${i}\` (${byId.get(i)!.status})`).join(", ")}`,
    )
  }
  if (distinctVerified < need) citeProblems.push(`cites ${distinctVerified} distinct verified claims; needs at least ${need}`)
  results.push({
    gate: "citations",
    ok: citeProblems.length === 0,
    details: citeProblems.length ? `${citeProblems.join("; ")}.` : `${distinctVerified} verified claims cited`,
  })

  const headings = lines
    .map((l) => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l)?.[1])
    .filter((h): h is string => !!h)
    .map(slugify)
  const missing = topic.dimensions.filter((d) => {
    const s = slugify(d)
    return !headings.some((h) => h.includes(s))
  })
  results.push({
    gate: "dimensions",
    ok: missing.length === 0,
    details: missing.length
      ? `Missing a heading for: ${missing.map((d) => `"${d}"`).join(", ")}. Add each (it may say why the dimension can't be addressed).`
      : "all required dimensions present",
  })
  return results
}

function failureText(rel: string, results: GateResult[]): string {
  const failed = results.filter((r) => !r.ok)
  return [
    `Synthesis gate blocked the write to \`${rel}\`:`,
    ...failed.map((r) => `- ${r.gate}: ${r.details}`),
    "Fix these and write the document again.",
  ].join("\n")
}

function isSynthesisPath(ctx: HarnessContext, rel: string, topic: TopicConfig, content: string | null): boolean {
  const inner = pathWithinTopic(rel, ctx.config.topicsDir, topic.slug)
  if (inner === null || !inner.endsWith(".md")) return false
  const globs = topic.overrides.synthesisGlobs ?? ctx.config.gate.synthesisGlobs
  if (globs.some((g) => new Bun.Glob(g).match(inner))) return true
  if (content) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(content)?.[1]
    if (fm && /^kind:\s*["']?synthesis["']?\s*$/m.test(fm)) return true
  }
  return false
}

interface Target {
  abs: string
  rel: string
  topic: TopicConfig
}

function synthesisTargets(ctx: HarnessContext, tool: string, args: Record<string, unknown>, contentFor: (abs: string) => string | null): Target[] {
  const out: Target[] = []
  for (const t of editTargets(tool, args)) {
    const rel = toProjectRel(ctx.directory, t)
    if (rel === null) continue
    const slug = topicOfPath(rel, ctx.config.topicsDir)
    const topic = slug ? ctx.topics.get(slug) : null
    if (!topic) continue
    const abs = isAbsolute(t) ? t : join(ctx.directory, t)
    if (isSynthesisPath(ctx, rel, topic, contentFor(abs))) out.push({ abs, rel, topic })
  }
  return out
}

function check(ctx: HarnessContext, t: Target, content: string): GateResult[] {
  const min = t.topic.overrides.minCitations ?? ctx.config.gate.minCitations
  return validateSynthesis(content, t.topic, ctx.db.claims(t.topic.slug), min)
}

/** Snapshots for edit shapes the gate can't compute up front, keyed by callID. */
const snapshots = new Map<string, { target: Target; before: string | null }[]>()

/**
 * `tool.execute.before`: validate `write` / `edit` content directly; snapshot
 * other shapes for `gateAfter`. The gate follows the path's topic, not the
 * session's, so a synthesis can't slip past by switching topics.
 */
export function gateBefore(ctx: HarnessContext, tool: string, callId: string, args: Record<string, unknown>): void {
  if (!ctx.config.editTools.includes(tool)) return
  const read = (abs: string) => (existsSync(abs) ? readFileSync(abs, "utf8") : null)

  if (tool === "write" && typeof args.content === "string") {
    const content = args.content
    for (const t of synthesisTargets(ctx, tool, args, () => content)) {
      const r = check(ctx, t, content)
      if (r.some((x) => !x.ok)) throw new Rejection(failureText(t.rel, r))
    }
    return
  }

  if (tool === "edit" && typeof args.oldString === "string" && typeof args.newString === "string") {
    const oldS = args.oldString
    const newS = args.newString
    const resultFor = (abs: string): string | null => {
      const cur = read(abs)
      if (cur === null) return oldS === "" ? newS : null
      if (oldS === "") return newS
      if (!cur.includes(oldS)) return null
      return args.replaceAll === true ? cur.split(oldS).join(newS) : cur.replace(oldS, () => newS)
    }
    for (const t of synthesisTargets(ctx, tool, args, resultFor)) {
      const next = resultFor(t.abs)
      if (next === null) continue // the edit tool will fail on its own
      const r = check(ctx, t, next)
      if (r.some((x) => !x.ok)) throw new Rejection(failureText(t.rel, r))
    }
    return
  }

  // Unknown shape (patch, hashline edits): validate after, restore on failure.
  const targets = synthesisTargets(ctx, tool, args, read)
  if (targets.length) snapshots.set(callId, targets.map((target) => ({ target, before: read(target.abs) })))
}

/** `tool.execute.after`: verify snapshotted writes; restore and report on failure. */
export function gateAfter(ctx: HarnessContext, callId: string, output: ToolOutput): void {
  const snaps = snapshots.get(callId)
  if (!snaps) return
  snapshots.delete(callId)
  for (const { target, before } of snaps) {
    if (!existsSync(target.abs)) continue
    const now = readFileSync(target.abs, "utf8")
    if (now === before) continue
    const r = check(ctx, target, now)
    if (!r.some((x) => !x.ok)) continue
    let restore = "The previous version was restored."
    try {
      if (before === null) unlinkSync(target.abs)
      else writeFileSync(target.abs, before)
    } catch (err) {
      restore = `RESTORING THE PREVIOUS VERSION FAILED (${err instanceof Error ? err.message : String(err)}); the file now holds the rejected draft.`
    }
    replaceText(output, `[research-harness] ${failureText(target.rel, r)}\n${restore}`)
  }
}
