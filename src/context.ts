import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { HarnessConfig } from "./config"
import { claimsPath, LedgerDb, type SessionRow } from "./db"
import { isSupervisorSideSession } from "./shared-state"
import { type TopicConfig, TopicRegistry } from "./topic-config"

/** A deliberate rejection. Hooks rethrow these; any other error fails open. */
export class Rejection extends Error {
  constructor(message: string) {
    super(`[research-harness] ${message}`)
    this.name = "Rejection"
  }
}

export interface Logger {
  warn(message: string): void
  error(message: string): void
}

/** Tool capabilities learned from `tool.definition` (SPEC §3.4, E1/E2). */
export interface Capabilities {
  /** Tool id → whether its parameters include the named key. */
  params: Map<string, Set<string>>
}

export interface SessionView {
  sessionId: string
  ignored: boolean
  topic: TopicConfig | null
  crossTopic: boolean
}

/** Everything the modules share. */
export class HarnessContext {
  readonly topics: TopicRegistry
  readonly db: LedgerDb
  readonly caps: Capabilities = { params: new Map() }

  constructor(
    readonly directory: string,
    readonly config: HarnessConfig,
    readonly log: Logger,
    dbPath?: string,
  ) {
    this.topics = new TopicRegistry(join(directory, config.topicsDir))
    this.db = new LedgerDb(dbPath ?? join(directory, config.dbPath), (slug) =>
      claimsPath(directory, config.topicsDir, slug, config.claimsFile),
    )
  }

  /** The workspace default topic (`.research/active-topic`), if valid. */
  workspaceDefault(): string | null {
    const path = join(this.directory, this.config.workspaceDefaultFile)
    if (!existsSync(path)) return null
    const slug = readFileSync(path, "utf8").trim()
    return slug && this.topics.exists(slug) ? slug : null
  }

  /**
   * The session's row, created on first sight (SPEC FR-T2): inherit the
   * parent's topic, else the workspace default, else none.
   */
  sessionRow(sessionId: string, parentId?: string | null, title?: string): SessionRow {
    let row = this.db.getSession(sessionId)
    const ignoredByTitle =
      typeof title === "string" && this.config.ignoreSessionTitlePrefixes.some((p) => title.startsWith(p))
    if (!row) {
      let topicSlug: string | null = null
      let crossTopic = false
      if (parentId) {
        const parent = this.db.getSession(parentId)
        if (parent) {
          topicSlug = parent.topicSlug
          crossTopic = parent.crossTopic
        }
      }
      topicSlug ??= this.workspaceDefault()
      row = { sessionId, topicSlug, crossTopic, parentId: parentId ?? null, ignored: ignoredByTitle }
      this.db.putSession(row)
    } else if (ignoredByTitle && !row.ignored) {
      row = { ...row, ignored: true }
      this.db.putSession(row)
    }
    return row
  }

  view(sessionId: string): SessionView {
    const row = this.sessionRow(sessionId)
    const ignored = row.ignored || isSupervisorSideSession(sessionId)
    const topic = row.topicSlug ? this.topics.get(row.topicSlug) : null
    return { sessionId, ignored, topic, crossTopic: row.crossTopic }
  }

  /** The session's topic, or a rejection asking the user to pick one. */
  requireTopic(sessionId: string): TopicConfig {
    const v = this.view(sessionId)
    if (!v.topic) {
      throw new Rejection(
        `No research topic is active for this session. Ask the user which topic to work on (\`/topic <slug>\`; \`/topic --list\` shows them). Do not pick one yourself.`,
      )
    }
    return v.topic
  }

  setTopic(sessionId: string, slug: string | null, crossTopic = false): void {
    const row = this.sessionRow(sessionId)
    this.db.putSession({ ...row, topicSlug: slug, crossTopic })
  }

  hasParam(toolId: string, key: string): boolean {
    return this.caps.params.get(toolId)?.has(key) ?? false
  }
}
