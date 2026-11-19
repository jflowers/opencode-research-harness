import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { SLUG_RE } from "./paths"

/** What the harness reads from `topics/<slug>/TOPIC.md` (SPEC §3.2). */
export interface TopicConfig {
  slug: string
  title: string
  question: string
  /** Required synthesis dimensions, as written. */
  dimensions: string[]
  /** Allowed claim layers (slugs), always including `cross-cutting`. */
  layers: string[]
  overrides: {
    synthesisGlobs?: string[]
    minCitations?: number
  }
}

export const CROSS_CUTTING = "cross-cutting"

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>()
  let current: string | null = null
  let buf: string[] = []
  let inFence = false
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence
    const m = !inFence && /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (current !== null) out.set(current, buf.join("\n"))
      current = m[1]!.toLowerCase()
      buf = []
    } else if (current !== null) {
      buf.push(line)
    }
  }
  if (current !== null) out.set(current, buf.join("\n"))
  return out
}

function bullets(body: string | undefined): string[] {
  if (!body) return []
  const out: string[] = []
  for (const line of body.split("\n")) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const text = m[1]!
    if (/^<.*>$/.test(text)) continue // template placeholder
    out.push(text)
  }
  return out
}

/** "Failure modes & overhead — why it matters" → "Failure modes & overhead". */
function dimensionName(bullet: string): string {
  return bullet.split(/\s+[—–]\s+|\s+-\s+|:\s+/)[0]!.replace(/[`*_]/g, "").trim()
}

export function parseTopicMarkdown(slug: string, markdown: string): TopicConfig {
  const secs = sections(markdown)
  const title = /^#\s+(?:Topic:\s*)?(.+?)\s*$/m.exec(markdown)?.[1] ?? slug
  const question = (secs.get("research question") ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^<.*>$/.test(l))
    .join(" ")

  const dimensions = bullets(secs.get("required synthesis dimensions")).map(dimensionName).filter(Boolean)

  let layers: string[]
  const layerBullets = bullets(secs.get("claim layers"))
  if (layerBullets.length > 0) {
    layers = layerBullets.map((b) => /`([^`]+)`/.exec(b)?.[1] ?? slugify(dimensionName(b))).map(slugify)
  } else {
    layers = dimensions.map(slugify)
  }
  layers = [...new Set([...layers.filter(Boolean), CROSS_CUTTING])]

  const overrides: TopicConfig["overrides"] = {}
  const harness = secs.get("harness")
  const json = harness && /```json\s*\n([\s\S]*?)```/.exec(harness)?.[1]
  if (json) {
    const parsed = JSON.parse(json) as Record<string, unknown>
    if (Array.isArray(parsed.synthesisGlobs)) overrides.synthesisGlobs = parsed.synthesisGlobs.map(String)
    if (typeof parsed.minCitations === "number") overrides.minCitations = parsed.minCitations
  }

  return { slug, title, question, dimensions, layers, overrides }
}

/** Reads and caches TOPIC.md files by mtime. */
export class TopicRegistry {
  private cache = new Map<string, { mtimeMs: number; config: TopicConfig }>()

  constructor(private readonly topicsRoot: string) {}

  topicDir(slug: string): string {
    return join(this.topicsRoot, slug)
  }

  exists(slug: string): boolean {
    return SLUG_RE.test(slug) && existsSync(join(this.topicDir(slug), "TOPIC.md"))
  }

  list(): string[] {
    if (!existsSync(this.topicsRoot)) return []
    return readdirSync(this.topicsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "_template" && SLUG_RE.test(d.name))
      .filter((d) => existsSync(join(this.topicsRoot, d.name, "TOPIC.md")))
      .map((d) => d.name)
      .sort()
  }

  /** Parsed config, or null when the topic does not exist. */
  get(slug: string): TopicConfig | null {
    if (!this.exists(slug)) return null
    const path = join(this.topicDir(slug), "TOPIC.md")
    const mtimeMs = statSync(path).mtimeMs
    const hit = this.cache.get(slug)
    if (hit && hit.mtimeMs === mtimeMs) return hit.config
    const config = parseTopicMarkdown(slug, readFileSync(path, "utf8"))
    this.cache.set(slug, { mtimeMs, config })
    return config
  }
}
