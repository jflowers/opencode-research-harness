import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "../src/config"
import { HarnessContext } from "../src/context"
import { claimArgs, EV, type Fixture, makeFixture } from "./fixture"

let f: Fixture
beforeEach(async () => {
  f = makeFixture()
  await f.call("research_topic", { action: "set", slug: "alpha" })
})
afterEach(() => f.cleanup())

const jsonl = () => join(f.dir, "topics/alpha/claims.jsonl")

describe("ledger", () => {
  test("verified needs a precise locator", async () => {
    const out = await f.call("ledger_upsert_claim", claimArgs("a", { evidence: EV("somewhere vague") }))
    expect(out).toMatch(/needs at least one evidence item/)
    expect(await f.call("ledger_upsert_claim", claimArgs("a", { status: "hypothesis", evidence: [] }))).toMatch(/Recorded/)
    for (const loc of ["https://x.dev/a", "src/a.ts:3-9", "owner/repo@abc1234:src/a.ts:3", "note:n1", "learning/x-1"]) {
      expect(await f.call("ledger_upsert_claim", claimArgs("b", { evidence: EV(loc) }))).toMatch(/verified/)
    }
  })

  test("layer must belong to the topic; cross-cutting always allowed", async () => {
    expect(await f.call("ledger_upsert_claim", claimArgs("a", { layer: "nonsense" }))).toMatch(/deterministic-layer/)
    expect(await f.call("ledger_upsert_claim", claimArgs("a", { layer: "cross-cutting" }))).toMatch(/Recorded/)
  })

  test("claims.jsonl is written sorted, and the DB is rebuilt from it", async () => {
    await f.call("ledger_upsert_claim", claimArgs("zeta"))
    await f.call("ledger_upsert_claim", claimArgs("alpha-one"))
    const ids = readFileSync(jsonl(), "utf8").trim().split("\n").map((l) => JSON.parse(l).id)
    expect(ids).toEqual(["alpha-one", "zeta"])

    // Lose the DB entirely: claims come back from the committed file.
    f.ctx.db.close()
    rmSync(join(f.dir, ".research/ledger.sqlite"), { force: true })
    const ctx2 = new HarnessContext(f.dir, loadConfig(f.dir), { warn() {}, error() {} })
    expect(ctx2.db.claims("alpha").map((c) => c.id)).toEqual(["alpha-one", "zeta"])
    ctx2.db.close()
  })

  test("hand edits to claims.jsonl are picked up", async () => {
    await f.call("ledger_upsert_claim", claimArgs("a"))
    const line = JSON.parse(readFileSync(jsonl(), "utf8").trim())
    line.assertion = "Edited by hand"
    await Bun.sleep(5)
    writeFileSync(jsonl(), `${JSON.stringify(line)}\n`)
    expect(f.ctx.db.claim("alpha", "a")?.assertion).toBe("Edited by hand")
  })

  test("challenge appends counter-evidence and logs events", async () => {
    await f.call("ledger_upsert_claim", claimArgs("a"))
    const out = await f.call("ledger_challenge_claim", {
      id: "a",
      newStatus: "refuted",
      counterEvidence: { source: "s", locator: "b.ts:1", observation: "o", reason: "r" },
    })
    expect(out).toMatch(/now refuted/)
    const c = f.ctx.db.claim("alpha", "a")!
    expect(c.evidence.at(-1)?.relation).toBe("contradicts")
    expect(f.ctx.db.eventCount("alpha", "a")).toBe(2)
  })

  test("challenge lowers confidence so status and confidence agree (#4)", async () => {
    const ce = { source: "s", locator: "b.ts:1", observation: "o", reason: "the scope came from my own argument" }
    await f.call("ledger_upsert_claim", claimArgs("v", { confidence: "verified", confidenceBasis: "Seen directly" }))
    expect(await f.call("ledger_challenge_claim", { id: "v", newStatus: "hypothesis", counterEvidence: ce })).toMatch(
      /now hypothesis \(likely\)/,
    )
    let c = f.ctx.db.claim("alpha", "v")!
    expect([c.status, c.confidence]).toEqual(["hypothesis", "likely"])
    expect(c.confidenceBasis).toContain("the scope came from my own argument")
    expect(c.confidenceBasis).toContain("Was verified: Seen directly")
    const line = JSON.parse(readFileSync(jsonl(), "utf8").trim())
    expect([line.status, line.confidence]).toEqual(["hypothesis", "likely"])

    // A second challenge keeps stepping down.
    await f.call("ledger_challenge_claim", { id: "v", newStatus: "hypothesis", counterEvidence: ce })
    expect(f.ctx.db.claim("alpha", "v")!.confidence).toBe("speculative")

    // Refuted drops to speculative; an explicit confidence and basis win.
    await f.call("ledger_upsert_claim", claimArgs("r", { confidence: "verified" }))
    await f.call("ledger_challenge_claim", { id: "r", newStatus: "refuted", counterEvidence: ce })
    expect(f.ctx.db.claim("alpha", "r")!.confidence).toBe("speculative")
    await f.call("ledger_upsert_claim", claimArgs("e", { confidence: "verified" }))
    await f.call("ledger_challenge_claim", {
      id: "e",
      newStatus: "hypothesis",
      counterEvidence: ce,
      confidence: "speculative",
      confidenceBasis: "A clean rerun would raise it",
    })
    c = f.ctx.db.claim("alpha", "e")!
    expect([c.confidence, c.confidenceBasis]).toEqual(["speculative", "A clean rerun would raise it"])

    // Keeping verified confidence on a challenged hypothesis is rejected and changes nothing.
    await f.call("ledger_upsert_claim", claimArgs("k", { confidence: "verified" }))
    expect(
      await f.call("ledger_challenge_claim", { id: "k", newStatus: "hypothesis", counterEvidence: ce, confidence: "verified" }),
    ).toMatch(/can't stay at `verified` confidence/)
    expect(f.ctx.db.claim("alpha", "k")!.status).toBe("verified")
  })

  test("a hypothesis can't be recorded at verified confidence", async () => {
    expect(
      await f.call("ledger_upsert_claim", claimArgs("h", { status: "hypothesis", confidence: "verified", evidence: [] })),
    ).toMatch(/can't have `verified` confidence/)
    expect(f.ctx.db.claim("alpha", "h")).toBeNull()
  })

  test("claim ids are per topic", async () => {
    await f.call("ledger_upsert_claim", claimArgs("same"))
    await f.call("research_topic", { action: "set", slug: "beta" }, "s2")
    await f.call("ledger_upsert_claim", claimArgs("same", { assertion: "Beta's version" }), "s2")
    expect(f.ctx.db.claim("alpha", "same")?.assertion).toBe("Claim same is true")
    expect(f.ctx.db.claim("beta", "same")?.assertion).toBe("Beta's version")
  })

  test("status, compaction block and per-turn header", async () => {
    await f.call("ledger_upsert_claim", claimArgs("v1"))
    await f.call("ledger_upsert_claim", claimArgs("h1", { status: "hypothesis", evidence: [] }))
    expect(await f.call("ledger_status", {})).toMatch(/1 verified, 1 open hypotheses/)

    const comp = { context: [] as string[] }
    await f.hooks["experimental.session.compacting"]!({ sessionID: "s1" }, comp)
    expect(comp.context[0]).toContain("[claim:h1] (open)")
    expect(comp.context[0]).toContain("[claim:v1] (deterministic-layer)")

    const msgs = { messages: [{ info: { sessionID: "s1" }, parts: [] }] as never[] }
    await f.hooks["experimental.chat.messages.transform"]!({}, msgs as never)
    expect(msgs.messages.length).toBe(2)
    expect(JSON.stringify(msgs.messages[1])).toContain("Active topic: alpha")
  })

  test("compaction block respects its byte budget", async () => {
    for (let i = 0; i < 80; i++) await f.call("ledger_upsert_claim", claimArgs(`c${i}`, { assertion: "x".repeat(80) }))
    const comp = { context: [] as string[] }
    await f.hooks["experimental.session.compacting"]!({ sessionID: "s1" }, comp)
    expect(Buffer.byteLength(comp.context[0]!)).toBeLessThanOrEqual(4096 + 80)
    expect(comp.context[0]).toMatch(/more \(ledger_status lists all\)/)
  })

  test("no topic file on disk means an empty ledger", () => {
    expect(existsSync(join(f.dir, "topics/beta/claims.jsonl"))).toBe(false)
    expect(f.ctx.db.claims("beta")).toEqual([])
  })
})
