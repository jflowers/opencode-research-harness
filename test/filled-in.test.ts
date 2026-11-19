import { afterEach, beforeEach, expect, test } from "bun:test"
import { join } from "node:path"
import { filledInText } from "../src/modules/filled-in"
import { type Fixture, makeFixture } from "./fixture"

let f: Fixture
let seq = 0
beforeEach(async () => {
  f = makeFixture()
  await f.call("research_topic", { action: "set", slug: "alpha" })
})
afterEach(() => f.cleanup())

/** before + after with a fresh callID; returns the after-hook output object. */
async function run(tool: string, args: Record<string, unknown>, output: Record<string, unknown>, sessionID = "s1") {
  const callID = `fill-${++seq}`
  const finalArgs = await f.before(tool, args, sessionID, callID)
  await f.hooks["tool.execute.after"]!({ tool, sessionID, callID, args: finalArgs }, output as never)
  return output
}

test("a filled-in tag is reported at the top of the output", async () => {
  const out = await run("note_save", { type: "note", title: "t", content: "c", tags: ["wire"] }, { title: "", output: "Saved note", metadata: {} })
  expect(out.output).toBe(
    "[research-harness] Filled in by the harness to scope this call to the topic (not arguments you wrote): tags += topic:alpha.\nSaved note",
  )
})

test("a defaulted path is shown project-relative", async () => {
  const out = await run("grep", { pattern: "x" }, { title: "", output: "No files found", metadata: {} })
  expect(out.output).toMatch(/^\[research-harness\] Filled in .*: path = topics\/alpha\.\n/)
})

test("MCP results get the note as the first content item", async () => {
  f.ctx.caps.params.set("dewey_semantic_search_filtered", new Set(["query", "source_id"]))
  const out = await run("dewey_semantic_search_filtered", { query: "q" }, { content: [{ type: "text", text: "[]" }] })
  const content = out.content as { text: string }[]
  expect(content[0]!.text).toMatch(/source_id = disk-alpha\.$/)
  expect(content[1]!.text).toBe("[]")
})

test("no note when nothing was injected", async () => {
  const out = await run("note_save", { type: "note", title: "t", content: "c", tags: ["topic:alpha"] }, { title: "", output: "Saved note", metadata: {} })
  expect(out.output).toBe("Saved note")
})

test("no note for another session's callID", async () => {
  const callID = `fill-${++seq}`
  const args = await f.before("grep", { pattern: "x" }, "s1", callID)
  const out = { title: "", output: "ok", metadata: {} }
  await f.hooks["tool.execute.after"]!({ tool: "grep", sessionID: "other", callID, args }, out)
  expect(out.output).toBe("ok")
})

test("formatting", () => {
  expect(filledInText(f.ctx, {})).toBeNull()
  expect(filledInText(f.ctx, { path: join(f.dir, "topics/alpha"), tags: ["topic:alpha"], n: 3 })).toBe(
    "[research-harness] Filled in by the harness to scope this call to the topic (not arguments you wrote): path = topics/alpha; tags += topic:alpha; n = 3.",
  )
})
