import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseTopicArgs } from "../src/modules/topic"
import { type Fixture, makeFixture } from "./fixture"

let f: Fixture
beforeEach(() => {
  f = makeFixture()
})
afterEach(() => f.cleanup())

async function setTopic(slug: string, sessionID = "s1") {
  await f.call("research_topic", { action: "set", slug }, sessionID)
}

async function rejects(p: Promise<unknown>, re: RegExp) {
  let msg = ""
  try {
    await p
  } catch (err) {
    msg = (err as Error).message
  }
  expect(msg).toMatch(re)
}

describe("topic state", () => {
  test("no topic: nothing is scoped, ledger tools ask for one", async () => {
    expect(await f.before("dewey_semantic_search", { query: "x" })).toEqual({ query: "x" })
    expect(await f.call("ledger_status", {})).toMatch(/No research topic is active/)
  })

  test("set is per session and writes the workspace default", async () => {
    await setTopic("alpha", "s1")
    expect(readFileSync(join(f.dir, ".research/active-topic"), "utf8")).toBe("alpha\n")
    expect(f.ctx.view("s1").topic?.slug).toBe("alpha")
    await setTopic("beta", "s2")
    expect(f.ctx.view("s1").topic?.slug).toBe("alpha")
    expect(f.ctx.view("s2").topic?.slug).toBe("beta")
  })

  test("new sessions start from the workspace default; children inherit the parent", async () => {
    await setTopic("beta", "s1")
    expect(f.ctx.view("fresh").topic?.slug).toBe("beta")
    await setTopic("alpha", "parent")
    await f.hooks.event!({ event: { type: "session.created", properties: { info: { id: "child", parentID: "parent", title: "sub" } } } as never })
    expect(f.ctx.view("child").topic?.slug).toBe("alpha")
  })

  test("set rejects unknown topics", async () => {
    expect(await f.call("research_topic", { action: "set", slug: "nope" })).toMatch(/does not exist/)
  })

  test("new creates from template, registers the Dewey source, activates", async () => {
    const out = await f.call("research_topic", { action: "new", slug: "gamma" })
    expect(out).toMatch(/Created topics\/gamma/)
    expect(readFileSync(join(f.dir, "topics/gamma/TOPIC.md"), "utf8")).toContain("`gamma`")
    expect(readFileSync(join(f.dir, ".uf/dewey/sources.yaml"), "utf8")).toContain("id: disk-gamma")
    expect(f.ctx.view("s1").topic?.slug).toBe("gamma")
  })

  test("/topic is handled in command.execute.before", async () => {
    const output = { parts: [{ type: "text", text: "template body" }] as never[] }
    await f.hooks["command.execute.before"]!({ command: "topic", sessionID: "s9", arguments: "alpha" }, output as never)
    expect(f.ctx.view("s9").topic?.slug).toBe("alpha")
    expect((output.parts[0] as { text: string }).text).toMatch(/Active topic is now \*\*alpha\*\*/)
  })

  test("parseTopicArgs", () => {
    expect(parseTopicArgs("")).toEqual({ action: "show" })
    expect(parseTopicArgs("--new foo")).toEqual({ action: "new", slug: "foo" })
    expect(parseTopicArgs("--all")).toEqual({ action: "all" })
    expect(parseTopicArgs("--bogus")).toHaveProperty("error")
  })
})

describe("scoping (FR-T6)", () => {
  beforeEach(async () => setTopic("alpha"))

  test("filtered Dewey search gets source_id; a different one is rejected", async () => {
    expect((await f.before("dewey_semantic_search_filtered", { query: "q" })).source_id).toBe("disk-alpha")
    await rejects(f.before("dewey_semantic_search_filtered", { query: "q", source_id: "disk-beta" }), /outside the active topic/)
  })

  test("unfiltered Dewey search: rejected until the tool has source_id (E2), then scoped", async () => {
    await rejects(f.before("dewey_semantic_search", { query: "q" }), /dewey_semantic_search_filtered/)
    await f.hooks["tool.definition"]!(
      { toolID: "dewey_semantic_search" },
      { description: "d", parameters: { type: "object", properties: { query: {}, source_id: {} } } },
    )
    expect((await f.before("dewey_semantic_search", { query: "q" })).source_id).toBe("disk-alpha")
  })

  test("store_learning tag filled in; another tag rejected", async () => {
    expect((await f.before("dewey_store_learning", { information: "x" })).tag).toBe("alpha")
    await rejects(f.before("dewey_store_learning", { information: "x", tag: "beta" }), /tagged `alpha`/)
  })

  test("notes: save and search get the topic tag; another topic tag rejected", async () => {
    expect((await f.before("note_save", { content: "c", tags: ["x"] })).tags).toEqual(["x", "topic:alpha"])
    expect((await f.before("note_search", { query: "q" })).tags).toEqual(["topic:alpha"])
    await rejects(f.before("note_save", { content: "c", tags: ["topic:beta"] }), /outside the active topic/)
  })

  test("note_list: rejected without tags support (E1), scoped with it", async () => {
    await rejects(f.before("note_list", {}), /note_search/)
    await f.hooks["tool.definition"]!(
      { toolID: "note_list" },
      { description: "d", parameters: { type: "object", properties: { tags: {} } } },
    )
    expect((await f.before("note_list", {})).tags).toEqual(["topic:alpha"])
  })

  test("writes stay in the topic folder (segment-aware) or the allowlist", async () => {
    await f.before("write", { filePath: join(f.dir, "topics/alpha/findings/x.md"), content: "x" })
    await f.before("write", { filePath: ".research/scratch.md", content: "x" })
    await rejects(f.before("write", { filePath: "topics/beta/x.md", content: "x" }), /outside it/)
    await rejects(f.before("edit", { filePath: "README.md", oldString: "a", newString: "b" }), /outside it/)
    mkdirSync(join(f.dir, "topics/alphabet"), { recursive: true })
    await rejects(f.before("write", { filePath: "topics/alphabet/x.md", content: "x" }), /outside it/)
    await rejects(
      f.before("apply_patch", { patchText: "*** Begin Patch\n*** Add File: topics/beta/y.md\n+x\n*** End Patch" }),
      /outside it/,
    )
  })

  test("grep/glob default to the topic; other topics rejected; root allowed", async () => {
    expect((await f.before("grep", { pattern: "x" })).path).toBe(join(f.dir, "topics/alpha"))
    await rejects(f.before("glob", { pattern: "*", path: "topics/beta" }), /belongs to topic `beta`/)
    expect((await f.before("grep", { pattern: "x", path: ".opencode" })).path).toBe(".opencode")
  })

  test("bash writes into another topic are rejected; reads pass", async () => {
    await rejects(f.before("bash", { command: "echo x > topics/beta/a.md" }), /outside the active topic/)
    await f.before("bash", { command: "cat topics/beta/TOPIC.md" })
    await f.before("bash", { command: "echo x > topics/alpha/a.md" })
  })

  test("explicit read of another topic passes and is annotated (D8)", async () => {
    await f.before("read", { filePath: "topics/beta/TOPIC.md" })
    const output = { title: "", output: "content", metadata: {} }
    await f.hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s1", callID: "c", args: { filePath: join(f.dir, "topics/beta/TOPIC.md") } },
      output,
    )
    expect(output.output).toMatch(/^\[research-harness\] cross-topic source: topics\/beta\/TOPIC.md/)
  })

  test("cross-topic mode lifts search scoping but not write scoping", async () => {
    await f.call("research_topic", { action: "all" })
    expect(await f.before("dewey_semantic_search", { query: "q" })).toEqual({ query: "q" })
    expect(await f.before("note_search", { query: "q" })).toEqual({ query: "q" })
    await rejects(f.before("write", { filePath: "topics/beta/x.md", content: "x" }), /outside it/)
    expect((await f.before("note_save", { content: "c" })).tags).toEqual(["topic:alpha"])
  })

  test("supervisor side sessions are left alone (title and registry)", async () => {
    await f.hooks.event!({ event: { type: "session.created", properties: { info: { id: "aud", title: "supervisor-audit @ x" } } } as never })
    expect(await f.before("dewey_semantic_search", { query: "q" }, "aud")).toEqual({ query: "q" })
    const key = Symbol.for("opencode-agent-supervisor.shared-state")
    ;(globalThis as Record<symbol, unknown>)[key] = { sideSessionIds: new Set(["rep"]) }
    try {
      await setTopic("alpha", "rep")
      expect(await f.before("dewey_semantic_search", { query: "q" }, "rep")).toEqual({ query: "q" })
    } finally {
      delete (globalThis as Record<symbol, unknown>)[key]
    }
  })

  test("shell.env exports RESEARCH_TOPIC", async () => {
    const output = { env: {} as Record<string, string> }
    await f.hooks["shell.env"]!({ cwd: f.dir, sessionID: "s1" }, output)
    expect(output.env.RESEARCH_TOPIC).toBe("alpha")
  })
})

test("workspace default file pointing at a missing topic is ignored", () => {
  const g = makeFixture()
  try {
    mkdirSync(join(g.dir, ".research"), { recursive: true })
    writeFileSync(join(g.dir, ".research/active-topic"), "ghost\n")
    expect(g.ctx.view("x").topic).toBeNull()
    expect(existsSync(join(g.dir, "topics/ghost"))).toBe(false)
  } finally {
    g.cleanup()
  }
})
