import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Hooks, ToolContext } from "@opencode-ai/plugin"
import { loadConfig } from "../src/config"
import { HarnessContext } from "../src/context"
import { createHarness } from "../src/index"

export const TOPIC_MD = (slug: string, dims: string[]) => `# Topic: ${slug} title

- **Slug:** \`${slug}\`

## Research question

What about ${slug}?

## Required synthesis dimensions

A synthesis for this topic must address each of these, or say why it can't:

${dims.map((d) => `- ${d}`).join("\n")}

## Scoping keys

| Thing | Value |
|---|---|
| Dewey source | \`disk-${slug}\` |
`

export interface Fixture {
  dir: string
  ctx: HarnessContext
  hooks: Hooks
  cleanup(): void
  call(toolName: string, args: Record<string, unknown>, sessionID?: string): Promise<string>
  before(toolName: string, args: Record<string, unknown>, sessionID?: string, callID?: string): Promise<Record<string, unknown>>
}

export function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "research-harness-"))
  mkdirSync(join(dir, "topics/_template/findings"), { recursive: true })
  writeFileSync(join(dir, "topics/_template/TOPIC.md"), TOPIC_MD("<slug>", ["<dimension 1>"]))
  for (const slug of ["alpha", "beta"]) {
    mkdirSync(join(dir, `topics/${slug}/findings`), { recursive: true })
    writeFileSync(join(dir, `topics/${slug}/TOPIC.md`), TOPIC_MD(slug, ["Deterministic layer", "Failure modes & overhead — costs"]))
  }
  mkdirSync(join(dir, ".uf/dewey"), { recursive: true })
  writeFileSync(join(dir, ".uf/dewey/sources.yaml"), "sources:\n  - id: disk-repo\n    type: disk\n")
  const ctx = new HarnessContext(dir, loadConfig(dir), { warn() {}, error() {} })
  const hooks = createHarness(ctx)
  const toolCtx = (sessionID: string) =>
    ({ sessionID, messageID: "m", agent: "build", directory: dir, worktree: dir, abort: new AbortController().signal, metadata() {}, ask: async () => {} }) as ToolContext
  return {
    dir,
    ctx,
    hooks,
    cleanup() {
      ctx.db.close()
      rmSync(dir, { recursive: true, force: true })
    },
    async call(toolName, args, sessionID = "s1") {
      const t = hooks.tool![toolName]!
      const r = await t.execute(args as never, toolCtx(sessionID))
      return typeof r === "string" ? r : r.output
    },
    async before(toolName, args, sessionID = "s1", callID = "c1") {
      const output = { args: { ...args } }
      await hooks["tool.execute.before"]!({ tool: toolName, sessionID, callID }, output)
      return output.args
    },
  }
}

export const EV = (locator = "src/foo.ts:12") => [
  { source: "foo.ts", locator, observation: "the function does X", relation: "supports" as const },
]

export function claimArgs(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    layer: "deterministic-layer",
    assertion: `Claim ${id} is true`,
    mechanism: "Because the mechanism works like this",
    status: "verified",
    confidence: "likely",
    confidenceBasis: "A second source would raise it",
    evidence: EV(),
    ...over,
  }
}
