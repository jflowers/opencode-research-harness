import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { addNote, replaceText } from "../src/tool-output"
import { type Fixture, makeFixture, TOPIC_MD } from "./fixture"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

describe("addNote / replaceText", () => {
  test("built-in shape: prepends or appends to output", () => {
    const out = { title: "", output: "body", metadata: {} }
    addNote(out, "first", "start")
    addNote(out, "last", "end")
    expect(out.output).toBe("first\nbody\n\nlast")
    replaceText(out, "only")
    expect(out.output).toBe("only")
  })

  test("empty built-in output just takes the note", () => {
    const out: Record<string, unknown> = { title: "", metadata: {} }
    addNote(out, "note", "end")
    expect(out.output).toBe("note")
  })

  test("MCP shape: notes go into content, never a stray output field", () => {
    const out: Record<string, unknown> = { content: [{ type: "text", text: "result" }] }
    addNote(out, "first", "start")
    addNote(out, "last", "end")
    expect(out.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "result" },
      { type: "text", text: "last" },
    ])
    expect("output" in out).toBe(false)
    replaceText(out, "only")
    expect(out.content).toEqual([{ type: "text", text: "only" }])
  })

  test("undefined output is ignored", () => {
    expect(() => addNote(undefined, "x", "end")).not.toThrow()
  })
})

describe("hooks with an MCP-shaped result", () => {
  let f: Fixture
  beforeEach(async () => {
    f = makeFixture()
    writeFileSync(
      join(f.dir, "topics/alpha/TOPIC.md"),
      `${TOPIC_MD("alpha", ["Deterministic layer"])}\n## Harness\n\n\`\`\`json\n{ "ratchetBudget": 1 }\n\`\`\`\n`,
    )
    await f.call("research_topic", { action: "set", slug: "alpha" })
    f.ctx.caps.params.set("dewey_semantic_search", new Set(["query", "source_id"]))
  })
  afterEach(() => f.cleanup())

  test("the ratchet warning on a Dewey call reaches the model through content", async () => {
    const args = await f.before("dewey_semantic_search", { query: "q" }, "s1", "m1")
    expect(args.source_id).toBe("disk-alpha")
    const result: Record<string, unknown> = { content: [{ type: "text", text: "3 hits" }] }
    await f.hooks["tool.execute.after"]!({ tool: "dewey_semantic_search", sessionID: "s1", callID: "m1", args }, result as never)
    const content = result.content as { type: string; text: string }[]
    expect(content[0]!.text).toBe("3 hits")
    expect(content[1]!.text).toMatch(/^\[research-harness\] Exploratory budget reached \(1\/1/)
    expect("output" in result).toBe(false)
  })
})
