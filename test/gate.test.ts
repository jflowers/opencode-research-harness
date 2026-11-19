import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { claimArgs, type Fixture, makeFixture } from "./fixture"

let f: Fixture
beforeEach(async () => {
  f = makeFixture()
  await f.call("research_topic", { action: "set", slug: "alpha" })
  for (const id of ["v1", "v2", "v3"]) await f.call("ledger_upsert_claim", claimArgs(id))
})
afterEach(() => f.cleanup())

const PATH = "topics/alpha/findings/2026-11-20-synthesis.md"
const GOOD = `# Synthesis

## Deterministic layer
Uses X [claim:v1] and Y [claim:v2].

## Failure modes & overhead
Costs Z [claim:v3].
`

async function blocked(args: Record<string, unknown>, tool = "write"): Promise<string> {
  try {
    await f.before(tool, args)
    return ""
  } catch (err) {
    return (err as Error).message
  }
}

describe("synthesis gate", () => {
  test("passes a complete, cited synthesis", async () => {
    expect(await blocked({ filePath: PATH, content: GOOD })).toBe("")
  })

  test("non-synthesis files are not gated", async () => {
    expect(await blocked({ filePath: "topics/alpha/findings/2026-11-20-notes.md", content: "no citations" })).toBe("")
  })

  test("frontmatter kind: synthesis opts a file in", async () => {
    const msg = await blocked({ filePath: "topics/alpha/findings/final.md", content: "---\nkind: synthesis\n---\n# x\n" })
    expect(msg).toMatch(/dimensions/)
  })

  test("open hypothesis blocks", async () => {
    await f.call("ledger_upsert_claim", claimArgs("h1", { status: "hypothesis", evidence: [] }))
    expect(await blocked({ filePath: PATH, content: GOOD })).toMatch(/open-hypotheses: Open hypotheses: `h1`/)
  })

  test("unknown and unverified citations block", async () => {
    await f.call("ledger_upsert_claim", claimArgs("r1", { status: "refuted" }))
    const msg = await blocked({ filePath: PATH, content: `${GOOD}\nAlso [claim:ghost] and [claim:r1].` })
    expect(msg).toMatch(/unknown claims cited: `ghost`/)
    expect(msg).toMatch(/`r1` \(refuted\)/)
  })

  test("too few distinct citations block; citations in code fences don't count", async () => {
    const content = GOOD.replace("[claim:v3]", "").replace("[claim:v2]", "\n```\n[claim:v2]\n```\n")
    expect(await blocked({ filePath: PATH, content })).toMatch(/cites 1 distinct verified claims; needs at least 3/)
  })

  test("missing dimension heading blocks", async () => {
    const content = GOOD.replace("## Failure modes & overhead", "## Costs")
    expect(await blocked({ filePath: PATH, content })).toMatch(/Missing a heading for: "Failure modes & overhead"/)
  })

  test("edit is checked against the resulting document", async () => {
    writeFileSync(join(f.dir, PATH), GOOD)
    expect(await blocked({ filePath: PATH, oldString: "## Deterministic layer", newString: "## Other" }, "edit")).toMatch(
      /Deterministic layer/,
    )
    expect(await blocked({ filePath: PATH, oldString: "Uses X", newString: "Uses W" }, "edit")).toBe("")
  })

  test("gate follows the path's topic, even in a session with no topic", async () => {
    await f.call("ledger_upsert_claim", claimArgs("h1", { status: "hypothesis", evidence: [] }))
    f.ctx.setTopic("s4", null)
    let msg = ""
    try {
      await f.before("write", { filePath: PATH, content: GOOD }, "s4")
    } catch (err) {
      msg = (err as Error).message
    }
    expect(msg).toMatch(/h1/)
  })

  test("unknown edit shapes: snapshot, verify after, restore on failure", async () => {
    writeFileSync(join(f.dir, PATH), GOOD)
    await f.before("apply_patch", { patchText: `*** Begin Patch\n*** Update File: ${PATH}\n*** End Patch` }, "s1", "p1")
    writeFileSync(join(f.dir, PATH), "# broken\n") // what the patch tool wrote
    const output = { title: "", output: "Success", metadata: {} }
    await f.hooks["tool.execute.after"]!({ tool: "apply_patch", sessionID: "s1", callID: "p1", args: {} }, output)
    expect(output.output).toMatch(/Synthesis gate blocked/)
    expect(output.output).toMatch(/previous version was restored/)
    expect(readFileSync(join(f.dir, PATH), "utf8")).toBe(GOOD)
  })

  test("unknown edit shape creating a bad new file removes it", async () => {
    const p = "topics/alpha/findings/new-synthesis.md"
    await f.before("apply_patch", { patchText: `*** Begin Patch\n*** Add File: ${p}\n*** End Patch` }, "s1", "p2")
    writeFileSync(join(f.dir, p), "# nope\n")
    const output = { title: "", output: "Success", metadata: {} }
    await f.hooks["tool.execute.after"]!({ tool: "apply_patch", sessionID: "s1", callID: "p2", args: {} }, output)
    expect(existsSync(join(f.dir, p))).toBe(false)
  })
})
