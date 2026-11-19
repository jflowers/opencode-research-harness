import { addNote, type ToolOutput } from "../tool-output"
import type { RatchetMode } from "../config"
import { type HarnessContext, Rejection } from "../context"
import { toProjectRel } from "../paths"
import type { TopicConfig } from "../topic-config"

/**
 * Exploratory-call budget per session (SPEC FR-R, §3.7).
 *
 * - `ratchetCheck` (tool.execute.before): in `block` mode, rejects an
 *   exploratory call once the budget is used.
 * - `ratchetCount` (tool.execute.after): counts executed exploratory calls,
 *   remembers what they looked at, and in `warn` mode appends a reminder.
 * - `ratchetReset` (after a successful ledger write): a claim citing something
 *   explored since the last reset clears the budget; any other claim gives
 *   back half (anti-gaming rule, §3.7).
 *
 * Sessions are counted separately, so a subagent never drains its parent.
 */

export interface RatchetSettings {
  mode: RatchetMode
  budget: number
}

export function ratchetSettings(ctx: HarnessContext, topic: TopicConfig): RatchetSettings {
  const budget = Math.max(1, Math.floor(topic.overrides.ratchetBudget ?? ctx.config.ratchet.budget))
  return { mode: topic.overrides.ratchetMode ?? ctx.config.ratchet.mode, budget }
}

let cachedPattern: { source: string; re: RegExp | null } | null = null

function bashRe(ctx: HarnessContext): RegExp | null {
  const source = ctx.config.ratchet.bashPattern
  if (cachedPattern?.source !== source) {
    let re: RegExp | null = null
    try {
      re = source ? new RegExp(source) : null
    } catch {
      ctx.log.warn(`ratchet.bashPattern is not a valid regex: ${source}`)
    }
    cachedPattern = { source, re }
  }
  return cachedPattern.re
}

/** FR-R1: whether a call counts against the budget. */
export function isExploratory(ctx: HarnessContext, tool: string, args: Record<string, unknown> | undefined): boolean {
  const r = ctx.config.ratchet
  if (r.tools.includes(tool) || ctx.config.dewey.readTools.includes(tool)) return true
  if (r.toolPrefixes.some((p) => p && tool.startsWith(p))) return true
  if (tool === "bash") {
    const cmd = typeof args?.command === "string" ? args.command : ""
    const re = bashRe(ctx)
    return !!cmd && !!re && re.test(cmd)
  }
  return false
}

const URL_RE = /https?:\/\/[^\s"'<>`)]+/g
const LINE_SUFFIX_RE = /(:\d+(-\d+)?)+$/
const REPO_REF_RE = /^([\w.-]+\/[\w.-]+)@[0-9a-f]{7,40}(?::(.+))?$/i

/**
 * Normalizes a locator for comparison: URLs lose fragment, trailing slash and
 * scheme/host case; paths become project-relative without `:line` suffixes.
 */
export function normalizeLocator(ctx: HarnessContext, raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      u.hash = ""
      return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`
    } catch {
      return null
    }
  }
  const repo = REPO_REF_RE.exec(s)
  if (repo) return repo[2] ? `${repo[1]}:${repo[2].replace(LINE_SUFFIX_RE, "")}` : repo[1]!
  const path = s.replace(LINE_SUFFIX_RE, "")
  const rel = toProjectRel(ctx.directory, path)
  if (rel === null) return path // outside the project: compare as written
  return rel === "" || rel === "." ? null : rel.replace(/\/+$/, "")
}

/**
 * GitHub URLs also stand for the repo-ref form evidence uses
 * (`owner/repo@sha:path` normalizes to `owner/repo:path`).
 */
export function githubAliases(url: string): string[] {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return []
  }
  const seg = u.pathname.split("/").filter(Boolean)
  const host = u.host.toLowerCase()
  let owner: string | undefined
  let repo: string | undefined
  let path: string[] = []
  if (host === "github.com" && seg.length >= 2) {
    ;[owner, repo] = seg
    if ((seg[2] === "blob" || seg[2] === "tree") && seg.length >= 4) path = seg.slice(4)
  } else if (host === "raw.githubusercontent.com" && seg.length >= 3) {
    ;[owner, repo] = seg
    path = seg.slice(3)
  } else if (host === "api.github.com" && seg[0] === "repos" && seg.length >= 3) {
    ;[, owner, repo] = seg
    if (seg[3] === "contents") path = seg.slice(4)
  }
  if (!owner || !repo) return []
  repo = repo.replace(/\.git$/, "")
  return path.length ? [`${owner}/${repo}:${path.join("/")}`] : [`${owner}/${repo}`]
}

/** Locators an executed exploratory call looked at (§3.7 "Count"). */
export function exploredLocators(ctx: HarnessContext, tool: string, args: Record<string, unknown> | undefined): string[] {
  if (!args) return []
  const raw: string[] = []
  for (const key of ["filePath", "file_path", "path", "url"]) {
    if (typeof args[key] === "string") raw.push(args[key] as string)
  }
  if (Array.isArray(args.urls)) for (const u of args.urls) if (typeof u === "string") raw.push(u)
  if (tool === "bash" && typeof args.command === "string") raw.push(...(args.command.match(URL_RE) ?? []))
  const out: string[] = []
  for (const r of raw) {
    const n = normalizeLocator(ctx, r)
    for (const l of n?.startsWith("http") ? [n, ...githubAliases(n)] : n ? [n] : []) {
      if (!out.includes(l)) out.push(l)
    }
  }
  return out
}

/**
 * An evidence locator matches an explored one if equal or inside it: a file
 * in a grepped folder, a page under a crawled URL, a path in a fetched repo.
 */
export function matchesExplored(evidence: string, explored: string[]): boolean {
  return explored.some(
    (e) => evidence === e || evidence.startsWith(`${e}/`) || evidence.startsWith(`${e}?`) || evidence.startsWith(`${e}:`),
  )
}

interface Scope {
  topic: TopicConfig
  settings: RatchetSettings
}

function scopeFor(ctx: HarnessContext, sessionId: string): Scope | null {
  const v = ctx.view(sessionId)
  if (v.ignored || !v.topic) return null
  const settings = ratchetSettings(ctx, v.topic)
  if (settings.mode === "off") return null
  return { topic: v.topic, settings }
}

function recentLocators(explored: string[], n = 5): string {
  const recent = explored.slice(-n)
  return recent.length ? recent.map((l) => `\`${l}\``).join(", ") : "(none recorded; cite what you read)"
}

/** tool.execute.before (FR-R2, block mode). */
export function ratchetCheck(
  ctx: HarnessContext,
  tool: string,
  sessionId: string,
  args: Record<string, unknown> | undefined,
): void {
  const scope = scopeFor(ctx, sessionId)
  if (!scope || scope.settings.mode !== "block") return
  if (!isExploratory(ctx, tool, args)) return
  const state = ctx.db.getRatchet(sessionId)
  if (state.count < scope.settings.budget) return
  ctx.db.addRatchetEvent(scope.topic.slug, sessionId, "block", state.count)
  throw new Rejection(
    [
      `Exploratory budget used (${state.count}/${scope.settings.budget} since the last claim).`,
      "Record what you learned before exploring further:",
      `  ledger_upsert_claim with evidence citing one of: ${recentLocators(state.explored)}`,
    ].join("\n"),
  )
}

/** tool.execute.after (FR-R1, FR-R4): count executed exploratory calls; warn at budget. */
export function ratchetCount(
  ctx: HarnessContext,
  tool: string,
  sessionId: string,
  args: Record<string, unknown> | undefined,
  output: ToolOutput | undefined,
): void {
  const scope = scopeFor(ctx, sessionId)
  if (!scope || !isExploratory(ctx, tool, args)) return
  const state = ctx.db.getRatchet(sessionId)
  const seen = exploredLocators(ctx, tool, args)
  const explored = [...state.explored.filter((l) => !seen.includes(l)), ...seen]
  const next = { count: state.count + 1, explored: explored.slice(-ctx.config.ratchet.maxExplored) }
  ctx.db.putRatchet(sessionId, next)
  if (scope.settings.mode !== "warn" || next.count < scope.settings.budget || !output) return
  ctx.db.addRatchetEvent(scope.topic.slug, sessionId, "warn", next.count)
  const text = [
    `[research-harness] Exploratory budget reached (${next.count}/${scope.settings.budget} calls since the last claim).`,
    `Distill before exploring further: record a claim with ledger_upsert_claim whose evidence cites one of ${recentLocators(next.explored)}.`,
  ].join("\n")
  addNote(output, text, "end")
}

export type ResetKind = "reset" | "half-reset" | "none"

/** FR-R3: after a successful ledger write, reset fully if the evidence cites something explored, else by half. */
export function ratchetReset(
  ctx: HarnessContext,
  sessionId: string,
  evidence: { source?: string; locator?: string }[],
): ResetKind {
  const scope = scopeFor(ctx, sessionId)
  if (!scope) return "none"
  const state = ctx.db.getRatchet(sessionId)
  if (state.count === 0 && state.explored.length === 0) return "none"
  const cited = evidence
    .flatMap((e) => [e.locator, e.source])
    .filter((x): x is string => typeof x === "string")
    .map((x) => normalizeLocator(ctx, x))
    .filter((x): x is string => !!x)
  if (cited.some((c) => matchesExplored(c, state.explored))) {
    ctx.db.putRatchet(sessionId, { count: 0, explored: [] })
    ctx.db.addRatchetEvent(scope.topic.slug, sessionId, "reset", state.count)
    return "reset"
  }
  if (state.count === 0) return "none"
  const count = Math.max(0, state.count - Math.ceil(scope.settings.budget / 2))
  ctx.db.putRatchet(sessionId, { count, explored: state.explored })
  ctx.db.addRatchetEvent(scope.topic.slug, sessionId, "half-reset", state.count)
  return "half-reset"
}

/** One line for the per-turn header and ledger_status, or null when the ratchet is off. */
export function ratchetLine(ctx: HarnessContext, sessionId: string, topic: TopicConfig): string | null {
  const settings = ratchetSettings(ctx, topic)
  if (settings.mode === "off") return null
  const { count } = ctx.db.getRatchet(sessionId)
  const over = count >= settings.budget ? " — distill before exploring further" : ""
  return `Exploration: ${count}/${settings.budget} calls since the last claim (${settings.mode})${over}.`
}

export function resetNote(kind: ResetKind, budget: number): string {
  if (kind === "reset") return " Exploratory budget reset."
  if (kind === "half-reset") {
    return ` Exploratory budget partly restored (${Math.ceil(budget / 2)} calls): the evidence cites nothing explored since the last reset.`
  }
  return ""
}
