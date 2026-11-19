import { Database } from "bun:sqlite"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Claim, readClaimsFile, writeClaimsFile } from "./claims"

export interface SessionRow {
  sessionId: string
  topicSlug: string | null
  crossTopic: boolean
  parentId: string | null
  ignored: boolean
}

/**
 * The working index (SPEC §3.3). Claims are canonical in each topic's
 * `claims.jsonl`; this DB holds a rebuildable copy plus session state and
 * the event log.
 */
export class LedgerDb {
  readonly db: Database

  constructor(
    path: string,
    private readonly claimsPathFor: (slug: string) => string,
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 2000")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_topics (
        session_id  TEXT PRIMARY KEY,
        topic_slug  TEXT,
        cross_topic INTEGER NOT NULL DEFAULT 0,
        parent_id   TEXT,
        ignored     INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        topic_slug TEXT NOT NULL,
        id         TEXT NOT NULL,
        status     TEXT NOT NULL,
        json       TEXT NOT NULL,
        PRIMARY KEY (topic_slug, id)
      );
      CREATE TABLE IF NOT EXISTS claim_events (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_slug  TEXT NOT NULL,
        claim_id    TEXT NOT NULL,
        session_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        before_json TEXT,
        after_json  TEXT NOT NULL,
        at          TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS topic_rebuilds (
        topic_slug TEXT PRIMARY KEY,
        mtime_ms   REAL NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  // ---------------------------------------------------------------- sessions

  getSession(sessionId: string): SessionRow | null {
    const row = this.db
      .query("SELECT session_id, topic_slug, cross_topic, parent_id, ignored FROM session_topics WHERE session_id = ?")
      .get(sessionId) as
      | { session_id: string; topic_slug: string | null; cross_topic: number; parent_id: string | null; ignored: number }
      | null
    if (!row) return null
    return {
      sessionId: row.session_id,
      topicSlug: row.topic_slug,
      crossTopic: row.cross_topic === 1,
      parentId: row.parent_id,
      ignored: row.ignored === 1,
    }
  }

  putSession(row: SessionRow): void {
    this.db
      .query(
        `INSERT INTO session_topics (session_id, topic_slug, cross_topic, parent_id, ignored, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET topic_slug = excluded.topic_slug, cross_topic = excluded.cross_topic,
           parent_id = excluded.parent_id, ignored = excluded.ignored, updated_at = excluded.updated_at`,
      )
      .run(
        row.sessionId,
        row.topicSlug,
        row.crossTopic ? 1 : 0,
        row.parentId,
        row.ignored ? 1 : 0,
        new Date().toISOString(),
      )
  }

  deleteSession(sessionId: string): void {
    this.db.query("DELETE FROM session_topics WHERE session_id = ?").run(sessionId)
  }

  // ------------------------------------------------------------------ claims

  /** Rebuilds the topic's claim rows from claims.jsonl when the file is newer. */
  sync(slug: string): void {
    const path = this.claimsPathFor(slug)
    const mtimeMs = existsSync(path) ? statSync(path).mtimeMs : 0
    const seen = this.db.query("SELECT mtime_ms FROM topic_rebuilds WHERE topic_slug = ?").get(slug) as
      | { mtime_ms: number }
      | null
    if (seen && seen.mtime_ms === mtimeMs) return
    const claims = readClaimsFile(path)
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM claims WHERE topic_slug = ?").run(slug)
      const ins = this.db.query("INSERT INTO claims (topic_slug, id, status, json) VALUES (?, ?, ?, ?)")
      for (const c of claims) ins.run(slug, c.id, c.status, JSON.stringify(c))
      this.db
        .query(
          "INSERT INTO topic_rebuilds (topic_slug, mtime_ms) VALUES (?, ?) ON CONFLICT(topic_slug) DO UPDATE SET mtime_ms = excluded.mtime_ms",
        )
        .run(slug, mtimeMs)
    })
    tx()
  }

  claims(slug: string): Claim[] {
    this.sync(slug)
    const rows = this.db.query("SELECT json FROM claims WHERE topic_slug = ? ORDER BY id").all(slug) as {
      json: string
    }[]
    return rows.map((r) => JSON.parse(r.json) as Claim)
  }

  claim(slug: string, id: string): Claim | null {
    this.sync(slug)
    const row = this.db.query("SELECT json FROM claims WHERE topic_slug = ? AND id = ?").get(slug, id) as
      | { json: string }
      | null
    return row ? (JSON.parse(row.json) as Claim) : null
  }

  /**
   * Saves claims (insert or replace), logs one event each, and rewrites the
   * topic's claims.jsonl. The JSONL write happens last; if it fails the DB
   * copy is rebuilt from the old file on the next sync.
   */
  saveClaims(slug: string, sessionId: string, kind: string, claims: Claim[]): void {
    this.sync(slug)
    const now = new Date().toISOString()
    const tx = this.db.transaction(() => {
      for (const c of claims) {
        const before = this.db.query("SELECT json FROM claims WHERE topic_slug = ? AND id = ?").get(slug, c.id) as
          | { json: string }
          | null
        this.db
          .query(
            "INSERT INTO claims (topic_slug, id, status, json) VALUES (?, ?, ?, ?) ON CONFLICT(topic_slug, id) DO UPDATE SET status = excluded.status, json = excluded.json",
          )
          .run(slug, c.id, c.status, JSON.stringify(c))
        this.db
          .query(
            "INSERT INTO claim_events (topic_slug, claim_id, session_id, kind, before_json, after_json, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(slug, c.id, sessionId, kind, before?.json ?? null, JSON.stringify(c), now)
      }
    })
    tx()
    const path = this.claimsPathFor(slug)
    const all = (this.db.query("SELECT json FROM claims WHERE topic_slug = ?").all(slug) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Claim,
    )
    writeClaimsFile(path, all)
    this.db
      .query(
        "INSERT INTO topic_rebuilds (topic_slug, mtime_ms) VALUES (?, ?) ON CONFLICT(topic_slug) DO UPDATE SET mtime_ms = excluded.mtime_ms",
      )
      .run(slug, statSync(path).mtimeMs)
  }

  eventCount(slug: string, claimId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM claim_events WHERE topic_slug = ? AND claim_id = ?")
      .get(slug, claimId) as { n: number }
    return row.n
  }
}

export function claimsPath(directory: string, topicsDir: string, slug: string, claimsFile: string): string {
  return join(directory, topicsDir, slug, claimsFile)
}
