import { describe, expect, test } from "bun:test"
import { parseTopicMarkdown, slugify } from "../src/topic-config"
import { TOPIC_MD } from "./fixture"

describe("TOPIC.md parsing", () => {
  test("dimensions become layer slugs plus cross-cutting", () => {
    const t = parseTopicMarkdown("x", TOPIC_MD("x", ["Deterministic layer", "Failure modes & overhead — costs"]))
    expect(t.dimensions).toEqual(["Deterministic layer", "Failure modes & overhead"])
    expect(t.layers).toEqual(["deterministic-layer", "failure-modes-overhead", "cross-cutting"])
    expect(t.question).toBe("What about x?")
  })

  test("template placeholders are not dimensions", () => {
    const t = parseTopicMarkdown("x", TOPIC_MD("x", ["<dimension 1>"]))
    expect(t.dimensions).toEqual([])
    expect(t.layers).toEqual(["cross-cutting"])
  })

  test("## Claim layers overrides derived layers; ## Harness overrides", () => {
    const md = `${TOPIC_MD("x", ["A", "B"])}
## Claim layers

- \`runtime\` — what runs
- \`policy\` — what gates

## Harness

\`\`\`json
{ "minCitations": 5, "synthesisGlobs": ["final/*.md"] }
\`\`\`
`
    const t = parseTopicMarkdown("x", md)
    expect(t.layers).toEqual(["runtime", "policy", "cross-cutting"])
    expect(t.dimensions).toEqual(["A", "B"])
    expect(t.overrides).toEqual({ minCitations: 5, synthesisGlobs: ["final/*.md"] })
  })

  test("slugify", () => {
    expect(slugify("Failure Modes & Overhead")).toBe("failure-modes-overhead")
    expect(slugify("`Actionable` delta")).toBe("actionable-delta")
  })
})
