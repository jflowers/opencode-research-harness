import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/** Harness configuration (SPEC §3.2). Paths are relative to the project directory. */
export interface HarnessConfig {
  topicsDir: string
  workspaceDefaultFile: string
  writeWorkspaceDefaultOnSet: boolean
  dbPath: string
  claimsFile: string
  writeAllowlist: string[]
  dewey: {
    filteredSearchTool: string
    readTools: string[]
    storeLearningTool: string
    learningsDir: string
    sourcesFile: string
  }
  notes: {
    saveTool: string
    taggedReadTools: string[]
    tagPrefix: string
  }
  editTools: string[]
  gate: {
    synthesisGlobs: string[]
    minCitations: number
  }
  ignoreSessionTitlePrefixes: string[]
  compactionBudgetBytes: number
  author: string
}

export const DEFAULT_CONFIG: HarnessConfig = {
  topicsDir: "topics",
  workspaceDefaultFile: ".research/active-topic",
  writeWorkspaceDefaultOnSet: true,
  dbPath: ".research/ledger.sqlite",
  claimsFile: "claims.jsonl",
  writeAllowlist: [".research/"],
  dewey: {
    filteredSearchTool: "dewey_semantic_search_filtered",
    readTools: [
      "dewey_semantic_search_filtered",
      "dewey_semantic_search",
      "dewey_search",
      "dewey_similar",
      "dewey_find_by_tag",
    ],
    storeLearningTool: "dewey_store_learning",
    learningsDir: ".uf/dewey/learnings",
    sourcesFile: ".uf/dewey/sources.yaml",
  },
  notes: {
    saveTool: "note_save",
    taggedReadTools: ["note_search", "note_list"],
    tagPrefix: "topic:",
  },
  editTools: ["write", "edit", "patch", "apply_patch"],
  gate: {
    synthesisGlobs: ["findings/*synthesis*.md"],
    minCitations: 3,
  },
  ignoreSessionTitlePrefixes: ["supervisor-audit @", "supervisor-repair @"],
  compactionBudgetBytes: 4096,
  author: "research-harness",
}

const CONFIG_FILE = ".opencode/research-harness.json"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Deep merge: objects merge key by key, everything else (arrays included) replaces. */
function merge<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue
    out[k] = k in out ? merge(out[k], v) : v
  }
  return out as T
}

/** Defaults ← `.opencode/research-harness.json` ← plugin options. */
export function loadConfig(directory: string, options?: Record<string, unknown>): HarnessConfig {
  let fromFile: unknown
  const path = join(directory, CONFIG_FILE)
  if (existsSync(path)) {
    fromFile = JSON.parse(readFileSync(path, "utf8"))
  }
  return merge(merge(DEFAULT_CONFIG, fromFile), options)
}
