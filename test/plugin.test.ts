import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"
import { harnessSharedState } from "../src/shared-state"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  harnessSharedState().loadsByDirectory.clear()
})

function workspace(withTopics: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "research-harness-plugin-"))
  dirs.push(dir)
  if (withTopics) mkdirSync(join(dir, "topics"), { recursive: true })
  return dir
}

const input = (directory: string) => ({ directory, worktree: directory, client: undefined }) as never

test("inert outside a research workspace (NFR-4)", async () => {
  expect(await plugin.server(input(workspace(false)))).toEqual({})
})

test("loads in a research workspace", async () => {
  const hooks = await plugin.server(input(workspace(true)))
  expect(Object.keys(hooks.tool ?? {})).toContain("ledger_upsert_claim")
  await hooks.dispose?.()
})

test("a second copy for the same directory returns no hooks (§3.8 rule 2)", async () => {
  const dir = workspace(true)
  const first = await plugin.server(input(dir))
  harnessSharedState().loadsByDirectory.get(dir)!.add("file:///other/copy/index.ts")
  harnessSharedState().loadsByDirectory.get(dir)!.delete(import.meta.resolve("../src/index.ts"))
  const second = await plugin.server(input(dir))
  expect(second).toEqual({})
  await first.dispose?.()
})
