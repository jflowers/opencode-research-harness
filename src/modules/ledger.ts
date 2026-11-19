import { ratchetLine } from "./ratchet"
import {
  type Category,
  type Claim,
  CLAIM_ID_RE,
  type Confidence,
  type Evidence,
  isVerifiableLocator,
  type Status,
} from "../claims"
import { type HarnessContext, Rejection } from "../context"
import type { TopicConfig } from "../topic-config"

export interface UpsertInput {
  id: string
  layer: string
  assertion: string
  mechanism: string
  failureMode?: string
  status: Status
  confidence: Confidence
  confidenceBasis: string
  category?: Category
  evidence: Evidence[]
}

export function upsertClaim(ctx: HarnessContext, sessionId: string, input: UpsertInput): { claim: Claim; created: boolean } {
  const topic = ctx.requireTopic(sessionId)
  if (!CLAIM_ID_RE.test(input.id)) throw new Rejection(`Claim id \`${input.id}\` must match ${CLAIM_ID_RE}.`)
  if (!topic.layers.includes(input.layer)) {
    throw new Rejection(
      `Layer \`${input.layer}\` is not defined for topic \`${topic.slug}\`. Use one of: ${topic.layers.map((l) => `\`${l}\``).join(", ")}. Layers come from "Required synthesis dimensions" in TOPIC.md.`,
    )
  }
  if (input.status === "hypothesis" && input.confidence === "verified") {
    throw new Rejection(
      "A `hypothesis` can't have `verified` confidence: verified confidence means it was observed directly, which makes it a `verified` claim. Record it as `verified` with that evidence, or lower the confidence to `likely` or `speculative`.",
    )
  }
  if (input.status === "verified") {
    const good = input.evidence.filter((e) => e.locator.trim() && isVerifiableLocator(e.locator))
    if (good.length === 0) {
      throw new Rejection(
        "A `verified` claim needs at least one evidence item whose `locator` is a URL, `path:line`, `owner/repo@sha:path`, `note:<id>` or `learning/<identity>`. Record it as `hypothesis` until you have one.",
      )
    }
  }
  const prior = ctx.db.claim(topic.slug, input.id)
  const now = new Date().toISOString()
  const claim: Claim = {
    id: input.id,
    layer: input.layer,
    assertion: input.assertion,
    mechanism: input.mechanism,
    failureMode: input.failureMode ?? prior?.failureMode ?? null,
    status: input.status,
    confidence: input.confidence,
    confidenceBasis: input.confidenceBasis,
    category: input.category ?? prior?.category ?? "context",
    evidence: input.evidence,
    deweyIdentity: prior?.deweyIdentity ?? null,
    exportedHash: prior?.exportedHash ?? null,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  }
  ctx.db.saveClaims(topic.slug, sessionId, "upsert", [claim])
  return { claim, created: !prior }
}

export interface ChallengeInput {
  id: string
  newStatus: "hypothesis" | "refuted"
  counterEvidence: { source: string; locator: string; observation: string; reason: string }
  /** New confidence in the assertion; defaults to one step below the old one, never above `likely`. */
  confidence?: Confidence
  /** What would change the new confidence; defaults to the challenge reason. */
  confidenceBasis?: string
}

/**
 * Confidence after a challenge, when the caller gives none. Counter-evidence
 * lowers confidence one step (verified → likely → speculative). A refuted
 * assertion drops to speculative. A hypothesis is never left at verified.
 */
export function challengedConfidence(prior: Confidence, newStatus: ChallengeInput["newStatus"]): Confidence {
  if (newStatus === "refuted") return "speculative"
  return prior === "verified" ? "likely" : "speculative"
}

export function challengeClaim(ctx: HarnessContext, sessionId: string, input: ChallengeInput): Claim {
  const topic = ctx.requireTopic(sessionId)
  const prior = ctx.db.claim(topic.slug, input.id)
  if (!prior) throw new Rejection(`No claim \`${input.id}\` in topic \`${topic.slug}\`. \`ledger_status\` lists them.`)
  const ce = input.counterEvidence
  if (input.newStatus === "hypothesis" && input.confidence === "verified") {
    throw new Rejection(
      "A challenged claim can't stay at `verified` confidence: the counter-evidence is the reason it's no longer verified. Pass `likely` or `speculative`, or leave `confidence` out.",
    )
  }
  const confidence = input.confidence ?? challengedConfidence(prior.confidence, input.newStatus)
  const confidenceBasis =
    input.confidenceBasis?.trim() ||
    `Challenged (${ce.locator}): ${ce.reason}. Was ${prior.confidence}: ${prior.confidenceBasis}`
  const claim: Claim = {
    ...prior,
    status: input.newStatus,
    confidence,
    confidenceBasis,
    evidence: [
      ...prior.evidence,
      { source: ce.source, locator: ce.locator, observation: `${ce.observation} — ${ce.reason}`, relation: "contradicts" },
    ],
    updatedAt: new Date().toISOString(),
  }
  ctx.db.saveClaims(topic.slug, sessionId, "challenge", [claim])
  return claim
}

function counts(claims: Claim[]): Record<Status, number> {
  const c: Record<Status, number> = { hypothesis: 0, verified: 0, refuted: 0, "out-of-scope": 0 }
  for (const x of claims) c[x.status]++
  return c
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

export function statusMarkdown(ctx: HarnessContext, topic: TopicConfig, crossTopic: boolean, sessionId?: string): string {
  const claims = ctx.db.claims(topic.slug)
  const n = counts(claims)
  const lines = [
    `## Research ledger — topic \`${topic.slug}\`${crossTopic ? " (cross-topic searches on)" : ""}`,
    "",
    `- Claims: ${n.verified} verified, ${n.hypothesis} open hypotheses, ${n.refuted} refuted, ${n["out-of-scope"]} out of scope`,
    `- Layers: ${topic.layers.map((l) => `\`${l}\``).join(", ")}`,
    `- Required synthesis dimensions: ${topic.dimensions.join("; ") || "(none set)"}`,
  ]
  const ratchet = sessionId ? ratchetLine(ctx, sessionId, topic) : null
  if (ratchet) {
    const ev = ctx.db.ratchetEventCounts(topic.slug)
    lines.push(
      `- ${ratchet} Topic history: ${ev.warn} warnings, ${ev.block} blocks, ${ev.reset} resets, ${ev["half-reset"]} half-resets.`,
    )
  }
  const byLayer = new Map<string, number>()
  for (const c of claims) byLayer.set(c.layer, (byLayer.get(c.layer) ?? 0) + 1)
  if (byLayer.size) lines.push(`- By layer: ${[...byLayer].map(([l, k]) => `${l} ${k}`).join(", ")}`)
  const open = claims.filter((c) => c.status === "hypothesis")
  if (open.length) {
    lines.push("", "### Open hypotheses (verify, refute or mark out-of-scope before a synthesis)")
    for (const c of open) lines.push(`- \`[claim:${c.id}]\` ${c.assertion}`)
  }
  if (claims.length) {
    lines.push("", "| Cite as | Status | Layer | Confidence | Assertion | Evidence |", "|---|---|---|---|---|---|")
    for (const c of claims) {
      lines.push(
        `| \`[claim:${c.id}]\` | ${c.status} | ${c.layer} | ${c.confidence} | ${cell(c.assertion)} | ${c.evidence.length} |`,
      )
    }
  } else {
    lines.push("", "No claims yet. Record them with `ledger_upsert_claim`.")
  }
  return lines.join("\n")
}

/** ≤5-line header delivered every turn (FR-L8). */
export function statusHeader(ctx: HarnessContext, sessionId: string): string | null {
  const v = ctx.view(sessionId)
  if (v.ignored) return null
  if (!v.topic) {
    return "[research-harness] No research topic is active in this session. Before researching, ask the user which topic to use (`/topic`). Do not pick one."
  }
  const n = counts(ctx.db.claims(v.topic.slug))
  const ratchet = ratchetLine(ctx, sessionId, v.topic)
  return [
    `[research-harness] Active topic: ${v.topic.slug}${v.crossTopic ? " — CROSS-TOPIC searches on; say \"cross-topic\" when using unscoped results" : ""}.`,
    `Ledger: ${n.verified} verified, ${n.hypothesis} open hypotheses. Record claims with ledger_upsert_claim; cite them as [claim:<id>].`,
    ...(ratchet ? [ratchet] : []),
  ].join("\n")
}

/** FR-L7: the block pushed into compaction context, bounded in bytes. */
export function compactionBlock(ctx: HarnessContext, sessionId: string): string | null {
  const v = ctx.view(sessionId)
  if (v.ignored || !v.topic) return null
  const claims = ctx.db.claims(v.topic.slug)
  const budget = ctx.config.compactionBudgetBytes
  const head = [
    `## Research ledger (topic: ${v.topic.slug})`,
    `Claims persist in topics/${v.topic.slug}/claims.jsonl; keep [claim:<id>] citations verbatim in the summary.`,
  ]
  const open = claims.filter((c) => c.status === "hypothesis").map((c) => `- [claim:${c.id}] (open) ${c.assertion}`)
  const verified = claims
    .filter((c) => c.status === "verified")
    .map((c) => `- [claim:${c.id}] (${c.layer}) ${c.assertion} — ${c.evidence[0]?.locator ?? ""}`)
  const out = [...head, "### Open hypotheses", ...(open.length ? open : ["- none"]), "### Verified claims"]
  let size = Buffer.byteLength(out.join("\n"))
  let dropped = 0
  for (const line of verified) {
    const b = Buffer.byteLength(line) + 1
    if (size + b > budget) {
      dropped++
      continue
    }
    out.push(line)
    size += b
  }
  if (dropped) out.push(`- …and ${dropped} more (ledger_status lists all)`)
  return out.join("\n")
}
