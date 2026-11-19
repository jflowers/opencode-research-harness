import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export const STATUSES = ["hypothesis", "verified", "refuted", "out-of-scope"] as const
export type Status = (typeof STATUSES)[number]
export const CONFIDENCES = ["speculative", "likely", "verified"] as const
export type Confidence = (typeof CONFIDENCES)[number]
export const RELATIONS = ["supports", "contradicts", "qualifies"] as const
export type Relation = (typeof RELATIONS)[number]
export const CATEGORIES = ["decision", "pattern", "gotcha", "context", "reference"] as const
export type Category = (typeof CATEGORIES)[number]

export interface Evidence {
  source: string
  locator: string
  observation: string
  relation: Relation
}

/** One claim, as stored in `topics/<slug>/claims.jsonl` (SPEC §3.3). */
export interface Claim {
  id: string
  layer: string
  assertion: string
  mechanism: string
  failureMode: string | null
  status: Status
  confidence: Confidence
  confidenceBasis: string
  category: Category
  evidence: Evidence[]
  deweyIdentity: string | null
  exportedHash: string | null
  createdAt: string
  updatedAt: string
}

export const CLAIM_ID_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * A locator good enough for a `verified` claim: a URL, `path:line[-line]`,
 * `owner/repo@sha[:path[:line]]`, `note:<id>` or `learning/<identity>`.
 */
export function isVerifiableLocator(locator: string): boolean {
  const l = locator.trim()
  return (
    /^https?:\/\/\S+$/.test(l) ||
    /^[^\s:]+:\d+(-\d+)?$/.test(l) ||
    /^[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}(:\S+)?$/.test(l) ||
    /^note:\S+$/.test(l) ||
    /^learning\/\S+$/.test(l)
  )
}

/** Key order for the JSONL file, so diffs stay small. */
function ordered(c: Claim): Claim {
  return {
    id: c.id,
    layer: c.layer,
    assertion: c.assertion,
    mechanism: c.mechanism,
    failureMode: c.failureMode,
    status: c.status,
    confidence: c.confidence,
    confidenceBasis: c.confidenceBasis,
    category: c.category,
    evidence: c.evidence.map((e) => ({
      source: e.source,
      locator: e.locator,
      observation: e.observation,
      relation: e.relation,
    })),
    deweyIdentity: c.deweyIdentity,
    exportedHash: c.exportedHash,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

function normalize(raw: Record<string, unknown>): Claim {
  const ev = Array.isArray(raw.evidence) ? raw.evidence : []
  return ordered({
    id: String(raw.id),
    layer: String(raw.layer),
    assertion: String(raw.assertion ?? ""),
    mechanism: String(raw.mechanism ?? ""),
    failureMode: raw.failureMode == null ? null : String(raw.failureMode),
    status: (STATUSES as readonly string[]).includes(String(raw.status)) ? (raw.status as Status) : "hypothesis",
    confidence: (CONFIDENCES as readonly string[]).includes(String(raw.confidence))
      ? (raw.confidence as Confidence)
      : "speculative",
    confidenceBasis: String(raw.confidenceBasis ?? ""),
    category: (CATEGORIES as readonly string[]).includes(String(raw.category))
      ? (raw.category as Category)
      : "context",
    evidence: ev.map((e: Record<string, unknown>) => ({
      source: String(e.source ?? ""),
      locator: String(e.locator ?? ""),
      observation: String(e.observation ?? ""),
      relation: (RELATIONS as readonly string[]).includes(String(e.relation)) ? (e.relation as Relation) : "supports",
    })),
    deweyIdentity: raw.deweyIdentity == null ? null : String(raw.deweyIdentity),
    exportedHash: raw.exportedHash == null ? null : String(raw.exportedHash),
    createdAt: String(raw.createdAt ?? new Date(0).toISOString()),
    updatedAt: String(raw.updatedAt ?? new Date(0).toISOString()),
  })
}

export function readClaimsFile(path: string): Claim[] {
  if (!existsSync(path)) return []
  const out: Claim[] = []
  const lines = readFileSync(path, "utf8").split("\n")
  lines.forEach((line, i) => {
    if (!line.trim()) return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (err) {
      throw new Error(`${path}:${i + 1}: invalid JSON (${err instanceof Error ? err.message : String(err)})`)
    }
    const claim = normalize(raw as Record<string, unknown>)
    if (!CLAIM_ID_RE.test(claim.id)) throw new Error(`${path}:${i + 1}: invalid claim id "${claim.id}"`)
    out.push(claim)
  })
  return out
}

/** Writes claims sorted by id, one per line, atomically. */
export function writeClaimsFile(path: string, claims: Claim[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const body = [...claims]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((c) => JSON.stringify(ordered(c)))
    .join("\n")
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body ? `${body}\n` : "")
  renameSync(tmp, path)
}
