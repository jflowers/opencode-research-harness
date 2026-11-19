import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  harnessSharedState,
  injectedPart,
  MAX_INJECTED_ARGS,
  recordInjectedArgs,
} from "../src/shared-state"
import { type Fixture, makeFixture } from "./fixture"

const injected = () => harnessSharedState().injectedArgs

describe("injectedPart", () => {
  test("a key the model left out carries the whole value", () => {
    expect(injectedPart({ query: "q" }, { query: "q", source_id: "disk-a" })).toEqual({ source_id: "disk-a" })
    expect(injectedPart({ path: "" }, { path: "/p" })).toEqual({ path: "/p" })
  })

  test("an array lists only the appended elements", () => {
    expect(injectedPart({ tags: ["wire"] }, { tags: ["wire", "topic:a"] })).toEqual({ tags: ["topic:a"] })
    expect(injectedPart({ tags: ["topic:a"] }, { tags: ["topic:a"] })).toEqual({})
  })

  test("a changed scalar carries the new value; unchanged keys are left out", () => {
    expect(injectedPart({ tag: "Alpha", information: "x" }, { tag: "alpha", information: "x" })).toEqual({ tag: "alpha" })
  })
})

describe("recordInjectedArgs", () => {
  beforeEach(() => injected().clear())

  test("lives on the process-wide symbol", () => {
    recordInjectedArgs("c1", "s1", "grep", { path: "/p" })
    const state = (globalThis as Record<symbol, { injectedArgs?: Map<string, unknown> }>)[
      Symbol.for("opencode-research-harness.shared-state")
    ]
    expect(state?.injectedArgs?.get("c1")).toEqual({ sessionID: "s1", tool: "grep", args: { path: "/p" } })
  })

  test("skips calls with nothing injected", () => {
    recordInjectedArgs("c1", "s1", "grep", {})
    expect(injected().has("c1")).toBe(false)
  })

  test("is bounded, evicting the oldest callIDs first", () => {
    for (let i = 0; i < MAX_INJECTED_ARGS + 5; i += 1) recordInjectedArgs(`c${i}`, "s1", "grep", { path: "/p" })
    expect(injected().size).toBe(MAX_INJECTED_ARGS)
    expect(injected().has("c0")).toBe(false)
    expect(injected().has(`c${MAX_INJECTED_ARGS + 4}`)).toBe(true)
  })
})

describe("tool.execute.before records what scoping injected", () => {
  let f: Fixture
  beforeEach(async () => {
    injected().clear()
    f = makeFixture()
    await f.call("research_topic", { action: "set", slug: "alpha" })
  })
  afterEach(() => f.cleanup())

  test("note_save topic tag", async () => {
    await f.before("note_save", { content: "c", tags: ["wire"] }, "s1", "n1")
    expect(injected().get("n1")).toEqual({ sessionID: "s1", tool: "note_save", args: { tags: ["topic:alpha"] } })
  })

  test("dewey_store_learning tag and filtered search source_id", async () => {
    await f.before("dewey_store_learning", { information: "x" }, "s1", "d1")
    expect(injected().get("d1")?.args).toEqual({ tag: "alpha" })
    await f.before("dewey_semantic_search_filtered", { query: "q" }, "s1", "d2")
    expect(injected().get("d2")?.args).toEqual({ source_id: "disk-alpha" })
  })

  test("grep/glob default path", async () => {
    await f.before("glob", { pattern: "**/*.md" }, "s1", "g1")
    expect(injected().get("g1")?.args).toEqual({ path: join(f.dir, "topics", "alpha") })
  })

  test("nothing recorded when the model already supplied everything", async () => {
    await f.before("grep", { pattern: "x", path: join(f.dir, "topics", "alpha") }, "s1", "g2")
    await f.before("note_save", { content: "c", tags: ["topic:alpha"] }, "s1", "n2")
    expect(injected().has("g2")).toBe(false)
    expect(injected().has("n2")).toBe(false)
  })
})
