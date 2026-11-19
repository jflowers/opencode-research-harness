import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { exportTopic, renderLearning } from "../src/modules/export"
import { claimArgs, EV, type Fixture, makeFixture } from "./fixture"

let f: Fixture
beforeEach(async () => {
  f = makeFixture()
  await f.call("research_topic", { action: "set", slug: "alpha" })
})
afterEach(() => f.cleanup())

const learnings = () => join(f.dir, ".uf/dewey/learnings")
const files = () => readdirSync(learnings()).sort()
const topic = () => f.ctx.topics.get("alpha")!

describe("export to Dewey", () => {
  test("learning frontmatter follows Dewey's writer layout", () => {
    const claim = {
      ...claimArgs("x", { evidence: EV("acme/widget@0123456789abcdef0123456789abcdef01234567:src/a.go:10") }),
      failureMode: null,
      category: "pattern",
      deweyIdentity: null,
      exportedHash: null,
      createdAt: "",
      updatedAt: "",
    } as never
    const text = renderLearning({
      slug: "alpha",
      author: "research-harness",
      identity: "alpha-20261120T120000-research-harness",
      createdAt: new Date("2026-11-20T12:00:00.123Z"),
      claim,
      validity: "current",
      supersedes: "alpha-20261119T000000-research-harness",
    })
    // Golden: key order of Dewey's writeLearningFile + temporalFields.frontmatter (upstream 3776105).
    expect(text.split("\n---\n")[0]).toBe(
      [
        "---",
        "tag: alpha",
        "author: research-harness",
        "category: pattern",
        "created_at: 2026-11-20T12:00:00Z",
        "identity: alpha-20261120T120000-research-harness",
        "tier: draft",
        "confidence: medium",
        'as_of: "acme/widget@0123456789abcdef0123456789abcdef01234567"',
        "evidence:",
        '  - "acme/widget@0123456789abcdef0123456789abcdef01234567:src/a.go:10"',
        '  - "research:alpha/claim:x"',
        'validity: "current"',
        'supersedes: "alpha-20261119T000000-research-harness"',
      ].join("\n"),
    )
    expect(text).toContain("# x: Claim x is true")
  })

  test("exports verified claims only, idempotently, and writes CLAIMS.md", async () => {
    await f.call("ledger_upsert_claim", claimArgs("v1"))
    await f.call("ledger_upsert_claim", claimArgs("h1", { status: "hypothesis", evidence: [] }))
    const t1 = new Date("2026-11-20T10:00:00Z")
    const r1 = exportTopic(f.ctx, "s1", topic(), t1)
    expect(r1.exported.map((e) => e.id)).toEqual(["v1"])
    expect(r1.skipped).toEqual(["h1"])
    expect(files()).toEqual(["alpha-20261120T100000-research-harness.md"])
    expect(f.ctx.db.claim("alpha", "v1")?.deweyIdentity).toBe("alpha-20261120T100000-research-harness")
    expect(readFileSync(join(f.dir, "topics/alpha/CLAIMS.md"), "utf8")).toContain("### v1")

    const r2 = exportTopic(f.ctx, "s1", topic(), new Date("2026-11-20T11:00:00Z"))
    expect(r2.exported).toEqual([])
    expect(r2.unchanged).toEqual(["v1"])
  })

  test("a changed claim supersedes its earlier learning", async () => {
    await f.call("ledger_upsert_claim", claimArgs("v1"))
    exportTopic(f.ctx, "s1", topic(), new Date("2026-11-20T10:00:00Z"))
    await f.call("ledger_upsert_claim", claimArgs("v1", { assertion: "Claim v1 is more precisely true" }))
    const r = exportTopic(f.ctx, "s1", topic(), new Date("2026-11-20T11:00:00Z"))
    expect(r.exported[0]?.supersedes).toBe("alpha-20261120T100000-research-harness")
    const old = readFileSync(join(learnings(), "alpha-20261120T100000-research-harness.md"), "utf8")
    expect(old).toContain('validity: "superseded"')
    expect(old).toContain('superseded_by: "alpha-20261120T110000-research-harness"')
    expect(old.match(/^validity:/gm)?.length).toBe(1)
  })

  test("refuting an exported claim exports it as historical", async () => {
    await f.call("ledger_upsert_claim", claimArgs("v1"))
    exportTopic(f.ctx, "s1", topic(), new Date("2026-11-20T10:00:00Z"))
    await f.call("ledger_challenge_claim", {
      id: "v1",
      newStatus: "refuted",
      counterEvidence: { source: "s", locator: "b.ts:2", observation: "o", reason: "r" },
    })
    const r = exportTopic(f.ctx, "s1", topic(), new Date("2026-11-20T11:00:00Z"))
    expect(r.exported[0]).toMatchObject({ id: "v1", validity: "historical" })
  })

  test("identity collisions get a suffix", async () => {
    await f.call("ledger_upsert_claim", claimArgs("a"))
    await f.call("ledger_upsert_claim", claimArgs("b"))
    exportTopic(f.ctx, "s1", topic(), new Date("2026-11-20T10:00:00Z"))
    expect(files()).toEqual([
      "alpha-20261120T100000-research-harness-2.md",
      "alpha-20261120T100000-research-harness.md",
    ])
  })

  test("ledger_export tool reports what it wrote", async () => {
    await f.call("ledger_upsert_claim", claimArgs("v1"))
    expect(await f.call("ledger_export", {})).toMatch(/v1 → learning\/alpha-/)
  })
})
