import { Database } from "bun:sqlite"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LedgerDb } from "../src/db"
import { exploredLocators, githubAliases, isExploratory, normalizeLocator } from "../src/modules/ratchet"
import { claimArgs, EV, type Fixture, makeFixture, TOPIC_MD } from "./fixture"

let f: Fixture
beforeEach(async () => {
  f = makeFixture()
  await f.call("research_topic", { action: "set", slug: "alpha" })
})
afterEach(() => f.cleanup())

let seq = 0
/** Runs one tool call through before + after, as opencode does. Returns the output text or the rejection. */
async function run(tool: string, args: Record<string, unknown>, sessionID = "s1"): Promise<string> {
  const callID = `c${++seq}`
  let finalArgs: Record<string, unknown>
  try {
    finalArgs = await f.before(tool, args, sessionID, callID)
  } catch (err) {
    return `REJECTED ${(err as Error).message}`
  }
  const output = { title: "", output: "ok", metadata: {} }
  await f.hooks["tool.execute.after"]!({ tool, sessionID, callID, args: finalArgs }, output)
  return output.output
}

const reads = async (n: number, sessionID = "s1", prefix = "topics/alpha/findings/f") => {
  let last = ""
  for (let i = 1; i <= n; i++) last = await run("read", { filePath: `${prefix}${i}.md` }, sessionID)
  return last
}

const count = (sessionID = "s1") => f.ctx.db.getRatchet(sessionID).count

function setHarness(slug: string, json: Record<string, unknown>) {
  writeFileSync(
    join(f.dir, `topics/${slug}/TOPIC.md`),
    `${TOPIC_MD(slug, ["Deterministic layer", "Failure modes & overhead"])}\n## Harness\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`\n`,
  )
}

describe("counting (FR-R1, FR-R4)", () => {
  test("exploratory tools count; ledger and edit tools don't", async () => {
    await run("read", { filePath: "topics/alpha/TOPIC.md" })
    await run("grep", { pattern: "x" })
    await run("webfetch", { url: "https://example.com/a" })
    await run("tavily_search", { query: "q" })
    await run("websearch", { query: "q" })
    expect(count()).toBe(5)
    await run("write", { filePath: "topics/alpha/findings/n.md", content: "x" })
    await run("ledger_status", {})
    expect(count()).toBe(5)
  })

  test("a call another module rejects is not counted", async () => {
    // No source_id capability reported yet, so topic scoping rejects it (FR-T6) before it runs.
    expect(await run("dewey_semantic_search", { query: "q" })).toMatch(/^REJECTED/)
    expect(count()).toBe(0)
    f.ctx.caps.params.set("dewey_semantic_search", new Set(["query", "source_id"]))
    expect(await run("dewey_semantic_search", { query: "q" })).toBe("ok")
    expect(count()).toBe(1)
  })

  test("bash counts only when the command matches bashPattern", async () => {
    await run("bash", { command: "ls topics/alpha" })
    expect(count()).toBe(0)
    await run("bash", { command: "curl -s https://example.com/x" })
    await run("bash", { command: "git log --oneline -3" })
    expect(count()).toBe(2)
    expect(f.ctx.db.getRatchet("s1").explored).toContain("https://example.com/x")
  })

  test("a call blocked before it runs is not counted", async () => {
    await f.before("read", { filePath: "topics/alpha/a.md" }, "s1", "never-ran")
    expect(count()).toBe(0)
  })

  test("subagents have their own budget", async () => {
    f.ctx.sessionRow("child", "s1")
    await reads(3, "child")
    expect(count("child")).toBe(3)
    expect(count("s1")).toBe(0)
  })

  test("sessions without a topic, ignored sessions and mode off are not counted", async () => {
    f.ctx.setTopic("none", null)
    await reads(2, "none")
    expect(count("none")).toBe(0)
    f.ctx.sessionRow("aud", null, "supervisor-audit @ 12:00")
    f.ctx.setTopic("aud", "alpha")
    await reads(2, "aud")
    expect(count("aud")).toBe(0)
    setHarness("alpha", { ratchetMode: "off" })
    await reads(2)
    expect(count()).toBe(0)
  })
})

describe("warn mode (default, D7)", () => {
  test("appends the reminder from the budget-th call on, and records each warning", async () => {
    expect(await reads(7)).toBe("ok")
    const out = await reads(1, "s1", "topics/alpha/findings/g")
    expect(out).toMatch(/Exploratory budget reached \(8\/8/)
    expect(out).toContain("`topics/alpha/findings/g1.md`")
    expect(await run("glob", { pattern: "*.md" })).toMatch(/9\/8/)
    expect(f.ctx.db.ratchetEventCounts("alpha").warn).toBe(2)
  })

  test("the per-turn header and ledger_status show the budget", async () => {
    await reads(3)
    const header = (await import("../src/modules/ledger")).statusHeader(f.ctx, "s1")!
    expect(header).toContain("Exploration: 3/8 calls since the last claim (warn).")
    expect(header.split("\n").length).toBeLessThanOrEqual(5)
    await reads(5)
    expect(await f.call("ledger_status", {})).toMatch(/8\/8 .*distill before exploring further.*1 warnings, 0 blocks/)
  })
})

describe("block mode", () => {
  beforeEach(() => setHarness("alpha", { ratchetMode: "block", ratchetBudget: 3 }))

  test("rejects exploratory calls at budget with the distill instruction", async () => {
    await reads(3)
    const msg = await run("read", { filePath: "topics/alpha/x.md" })
    expect(msg).toMatch(/^REJECTED \[research-harness\] Exploratory budget used \(3\/3 since the last claim\)/)
    expect(msg).toContain("ledger_upsert_claim with evidence citing one of: `topics/alpha/findings/f1.md`")
    expect(count()).toBe(3)
    expect(f.ctx.db.ratchetEventCounts("alpha").block).toBe(1)
  })

  test("non-exploratory calls still work at budget", async () => {
    await reads(3)
    expect(await run("write", { filePath: "topics/alpha/findings/n.md", content: "x" })).toBe("ok")
    expect(await f.call("ledger_upsert_claim", claimArgs("v1", { evidence: EV("topics/alpha/findings/f2.md:4") }))).toMatch(
      /Exploratory budget reset/,
    )
    expect(await run("read", { filePath: "topics/alpha/x.md" })).toBe("ok")
  })
})

describe("reset (FR-R3, anti-gaming)", () => {
  test("a claim citing an explored source resets to zero", async () => {
    await reads(6)
    expect(await f.call("ledger_upsert_claim", claimArgs("v1", { evidence: EV("topics/alpha/findings/f4.md:10-12") }))).toMatch(
      /budget reset/,
    )
    expect(f.ctx.db.getRatchet("s1")).toEqual({ count: 0, explored: [] })
    expect(f.ctx.db.ratchetEventCounts("alpha").reset).toBe(1)
  })

  test("a claim citing nothing explored restores half the budget and keeps the list", async () => {
    await reads(6)
    expect(await f.call("ledger_upsert_claim", claimArgs("v1", { evidence: EV("src/elsewhere.ts:1") }))).toMatch(
      /partly restored \(4 calls\)/,
    )
    expect(count()).toBe(2)
    expect(f.ctx.db.getRatchet("s1").explored).toHaveLength(6)
    await f.call("ledger_upsert_claim", claimArgs("h1", { status: "hypothesis", evidence: [] }))
    expect(count()).toBe(0)
    expect(f.ctx.db.ratchetEventCounts("alpha")["half-reset"]).toBe(2)
  })

  test("a challenge citing an explored source resets too", async () => {
    await f.call("ledger_upsert_claim", claimArgs("v1"))
    await run("webfetch", { url: "https://example.com/docs/page#section" })
    await f.call("ledger_challenge_claim", {
      id: "v1",
      newStatus: "hypothesis",
      counterEvidence: { source: "docs", locator: "https://EXAMPLE.com/docs/page/", observation: "o", reason: "r" },
    })
    expect(count()).toBe(0)
  })

  test("a file inside a grepped folder counts as explored", async () => {
    await run("grep", { pattern: "retry" }) // scoped to topics/alpha by the topic module
    await f.call("ledger_upsert_claim", claimArgs("v1", { evidence: EV("topics/alpha/findings/x.md:3") }))
    expect(count()).toBe(0)
  })

  test("GitHub pages match owner/repo@sha evidence", async () => {
    await run("webfetch", { url: "https://raw.githubusercontent.com/acme/widget/main/src/a.go" })
    await f.call(
      "ledger_upsert_claim",
      claimArgs("v1", { evidence: EV("acme/widget@0123456789abcdef0123456789abcdef01234567:src/a.go:10") }),
    )
    expect(count()).toBe(0)
  })

  test("a failed ledger write doesn't reset", async () => {
    await reads(4)
    expect(await f.call("ledger_upsert_claim", claimArgs("v1", { layer: "nope", evidence: EV("topics/alpha/findings/f1.md") }))).toMatch(
      /layer/,
    )
    expect(count()).toBe(4)
  })
})

describe("locators", () => {
  test("normalization", () => {
    expect(normalizeLocator(f.ctx, "https://Example.COM/a/b/#x")).toBe("https://example.com/a/b")
    expect(normalizeLocator(f.ctx, "src/a.ts:10-12")).toBe("src/a.ts")
    expect(normalizeLocator(f.ctx, join(f.dir, "src/a.ts"))).toBe("src/a.ts")
    expect(normalizeLocator(f.ctx, "acme/w@abcdef1:lib/x.go:3")).toBe("acme/w:lib/x.go")
    expect(normalizeLocator(f.ctx, ".")).toBeNull()
  })

  test("GitHub aliases", () => {
    expect(githubAliases("https://github.com/acme/widget/blob/main/src/a.go")).toEqual(["acme/widget:src/a.go"])
    expect(githubAliases("https://api.github.com/repos/acme/widget")).toEqual(["acme/widget"])
    expect(githubAliases("https://example.com/x")).toEqual([])
  })

  test("tavily_extract urls and dewey tools", () => {
    expect(exploredLocators(f.ctx, "tavily_extract", { urls: ["https://a.dev/x", "https://b.dev/y/"] })).toEqual([
      "https://a.dev/x",
      "https://b.dev/y",
    ])
    expect(isExploratory(f.ctx, "dewey_find_by_tag", {})).toBe(true)
    expect(isExploratory(f.ctx, "dewey_get_page", {})).toBe(false)
  })
})

test("a phase-1 ledger DB gains the ratchet columns without losing sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "research-harness-migrate-"))
  try {
    const path = join(dir, "ledger.sqlite")
    const old = new Database(path)
    old.exec(
      "CREATE TABLE session_topics (session_id TEXT PRIMARY KEY, topic_slug TEXT, cross_topic INTEGER NOT NULL DEFAULT 0, parent_id TEXT, ignored INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)",
    )
    old.query("INSERT INTO session_topics VALUES ('s', 'alpha', 0, NULL, 0, 'x')").run()
    old.close()
    const db = new LedgerDb(path, () => join(dir, "none.jsonl"))
    expect(db.getSession("s")?.topicSlug).toBe("alpha")
    db.putRatchet("s", { count: 2, explored: ["a"] })
    expect(db.getRatchet("s")).toEqual({ count: 2, explored: ["a"] })
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
