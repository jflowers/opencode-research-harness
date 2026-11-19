# opencode-research-harness — Specification

- **Status:** Proposed (spec only; nothing is implemented)
- **Date:** 2026-11-18
- **Target runtime:** OpenCode 1.19.0, `@opencode-ai/plugin` 1.19.0 (Bun runtime, `bun:sqlite`)
- **First consumer:** `jflowers/research` (multi-topic Dewey vault, `topics/<slug>/`)
- **Source:** the "opencode-research-harness" Google Doc (ADR-001 + PRD + technical spec, 2026-10-27), generalized and reconciled with `adlc-research/PLAN.md` and the installed plugin types.

This document has five parts: **Part 1 — ADR-002**, **Part 2 — PRD**, **Part 3 — Technical specification**, **Part 4 — Decisions** (D1–D10, resolved 2026-11-18), **Part 5 — Enhancements to companion tools** (changes in Dewey, opencode-session-notes and opencode-agent-supervisor that the harness depends on or benefits from).

### What changed from the Google Doc

| # | Doc | This spec |
|---|---|---|
| 1 | ADLC-specific `layer` enum (`deterministic` / `non-deterministic` / `hybrid-gate`) and ADLC default `requiredDimensions` | Both come from each topic's `TOPIC.md` → "Required synthesis dimensions". No ADLC vocabulary in the plugin. |
| 2 | `research_init_or_toggle` with one global active row (`active = 1`) | Topic is **per-session plugin state**. It backs `.research/active-topic` and `/topic`, and it scopes Dewey, session-notes and file paths by rewriting or rejecting tool args in `tool.execute.before`. |
| 3 | Ledger stays inside the plugin | Verified claims are exported to Dewey as learnings tagged `<slug>` with `validity` / `as_of` / `evidence` (the `kb_to_dewey.py` pattern), plus a git-reviewable `topics/<slug>/CLAIMS.md`. |
| 4 | Ignores prior decisions | Reconciles with `adlc-research/PLAN.md`, which rejected a custom ledger, hard ratchet, weasel-word lint and AST extraction. ADR-002 says what is revisited and what stays rejected. |
| 5 | Hook signatures written from memory | Checked against `@opencode-ai/plugin` 1.19.0 `dist/index.d.ts`. Notable: `tool.execute.after` input now has `args`; `experimental.chat.system.transform` input has `sessionID?` and `model` — **but OpenCode 1.19.0 discards system-transform mutations** (see §3.4). |
| 6 | No mention of other plugins' state | Explicit coexistence rules with the globally loaded `opencode-agent-supervisor@2.12.0`, including the 2026-11-18 double-load runaway, and a double-load guard of our own. |
| 7 | Four modules ship together | Ledger, topic scope and gate ship first. Ratchet ships in `warn` mode by default. Repo scout is deferred indefinitely (D9). |
| 8 | Works around the other tools as they are | Where a gap is in a tool Jay owns (Dewey, session-notes, supervisor), the fix goes there (Part 5) and the harness has an interim behavior until it lands. |

---

# Part 1 — ADR-002: Plugin-enforced topic scope and epistemic ledger

- **Status:** Proposed
- **Supersedes:** ADR-001 in the Google Doc (keeps its problem statement, replaces its decision)
- **Revisits:** `adlc-research/PLAN.md` → "What this plan deliberately skips" (custom ledger plugin, research ratchet, weasel-word linting, AST extraction)

## 1. Context

`jflowers/research` holds several research topics side by side. Each topic is its own Dewey disk source (`disk-<slug>` → `topics/<slug>/`). The method came from `adlc-research`, made topic-neutral. Today the scoping and the claim discipline are all prompt-level:

- `AGENTS.md` tells the agent to read `.research/active-topic` and to pass `source_id: "disk-<slug>"` on every Dewey search and tag `topic:<slug>` on every session-note.
- `/topic` (`.opencode/commands/topic.md`) is a prompt that asks the agent to write the slug into `.research/active-topic`. The file is per-checkout, not per-session: two opencode sessions in the same checkout share one topic.
- The `epistemic-discipline` skill keeps a claim ledger in session-notes using tags as foreign keys (`claim-status:*`, `confidence:*`, `evidence-for:<id>`).
- The supervisor directives `research-discipline` and `epistemic-rigor` audit that discipline after the fact.

The Google Doc's four failure modes still apply: exploratory sprawl, context pollution from raw reads, compaction losing citations, and unsupported synthesis. Multi-topic adds a fifth: **cross-topic contamination**, where a search or a note silently pulls in another topic's material.

Evidence that prompt-level scoping does not hold: across this machine's opencode logs, `dewey_semantic_search` (no source filter) appears 1,414 times and `dewey_semantic_search_filtered` 89 times. These logs span all projects, so this is suggestive, not a measurement of `research`. It does show that the agent defaults to the unfiltered tool. The durable fix is in Dewey (E2, Part 5): give every read tool an optional `source_id`, so the harness can scope it instead of rejecting it.

## 2. Decision drivers

- **Mechanical offloading.** Rules that must never be broken (topic scope, "no synthesis on open hypotheses") go in hooks, not prompts.
- **The twice-test is met.** `PLAN.md`'s own escalation path says to move from skill to tools "when behavioral reliability demands it." Scoping has to hold across three tool families (Dewey, session-notes, files) in every call. The user has asked for plugin enforcement.
- **Topic-neutral.** The plugin carries no domain vocabulary. Each topic defines its own claim layers and synthesis dimensions.
- **Zero server footprint.** In-process plugin, `bun:sqlite`, no MCP server, no LLM calls, no side sessions.
- **Coexist with the supervisor.** The supervisor audits; the harness enforces. Neither may double-load, and the harness must never touch supervisor side sessions.
- **Durable knowledge lives in Dewey.** The ledger is working state; Dewey is where verified knowledge goes.

## 3. Options considered

1. **Keep prompt-only (status quo).** Rejected: scoping depends on the agent remembering a filter on every call, and the evidence above says it doesn't.
2. **PLAN.md Tier E1 — thin tools wrapping session-notes.** Validated tools write tagged notes. Rejected as the store: the gate needs synchronous relational queries ("open hypotheses for topic X", "does claim Y exist and is it verified"), and session-notes is a separate plugin with a text-output tool API. The harness can't call another plugin's tools or read its DB without coupling to its private schema. Status transitions can't be enforced through tags.
3. **Dewey as the claim store.** Rejected for working state, as in `PLAN.md`: no transactional status transitions, no event emission. Accepted as the **export target** for verified claims: Dewey now has the temporal-validity fields (`validity`, `as_of`, `evidence`, `supersedes`; #146, merged 2026-11-03) that `PLAN.md` said were missing, and re-ingests a learning when its file changes (#221, merged 2026-11-18). As of upstream `main` (`3776105`), `as_of` is stamped from the vault's git HEAD and can't be passed to `dewey_store_learning`; see E3.
4. **Four separate plugins (Google Doc option B).** Rejected for the doc's reason: the ratchet and the gate read ledger and topic state synchronously.
5. **One plugin, `opencode-research-harness`, with modules sharing one SQLite store.** **Accepted.**

## 4. Decision

Build `opencode-research-harness` as one Bun/TypeScript plugin with five modules sharing `.research/ledger.sqlite`:

| Module | Purpose | Phase |
|---|---|---|
| `topic` | Per-session active topic; `/topic` handling; scope injection on Dewey, session-notes and file tools | 1 |
| `ledger` | Claims with topic-defined layers, evidence, status history; compaction and per-turn status injection | 1 |
| `gate` | Blocks writes of synthesis documents with open hypotheses, bad citations or missing dimensions | 1 |
| `export` | Verified claims → Dewey learnings (tag `<slug>`) and `topics/<slug>/CLAIMS.md` | 1 |
| `ratchet` | Exploratory-call budget per session; `warn` by default, `block` opt-in | 2 |
| `scout` | Shallow clone + harness manifest + skeleton extraction | Deferred (D9) |

## 5. What is revisited from `adlc-research/PLAN.md`, and why

| `PLAN.md` call | Now | Why |
|---|---|---|
| Custom ledger plugin is "overengineered for the current stage"; skill + directive + pack give "~80% of the value at ~0% new code" | **Revisited.** A ledger plugin is built. | The stage changed. One topic became many, and scoping now has to hold on every Dewey/notes/file call, which no skill can enforce. The user asked for enforcement by plugin. The gate needs relational queries that tags can't answer. The plugin is smaller than the original 4-table + Dewey-interceptor design: two tables plus an event log, no interceptors, no graduation pipeline. |
| Dewey can't host the ledger (no write-back, no per-entity hashes, no events) | **Partly revisited.** Dewey still doesn't host working state. It does receive exports. | Dewey's temporal-validity fields now exist, and `kb_to_dewey.py` proved the export pattern. |
| Research ratchet (hard blocking) risks the agent gaming the gate with low-quality notes | **Kept as a concern.** Ratchet is phase 2, `warn` by default. | Anti-gaming rule (§3.7): a ledger write only resets the budget if its evidence cites a source the session actually explored since the last reset. Hard blocking is opt-in per topic. |
| Weasel-word detection is brittle regex | **Kept rejected.** Off by default; available as a `warn`-only check. | The supervisor's auditor remains the judge of prose quality. |
| Multi-language AST/skeleton extraction is too much surface | **Kept deferred.** Scout is not planned (D9). | The `repo-scout` skill (HTTP-based) plus `gh` keeps working. Revisit only if ratchet warnings show repo-reading sprawl. |

### What happens to the `epistemic-discipline` skill

- The **claim lifecycle via session-note tags is retired** for topics where the harness is loaded. Claims live in the ledger. The skill is rewritten as a short skill (`research-ledger`, shipped with the plugin) that teaches the tools: when to `ledger_upsert_claim`, how to cite `[claim:<id>]`, how to challenge.
- **Kept from the old skill:** the calibration discipline (confidence levels with a stated "what would change it"), the evidence triple (source / observation / relation), and "never delete, challenge instead". These become required fields and validation rules.
- **Status mapping** for anyone carrying old notes forward: `draft` → `hypothesis`; `supported`/`established` → `verified` (with confidence `likely`/`verified`); `challenged` → `hypothesis` with counter-evidence; `revised` → upsert (old version kept in `claim_events`); `retracted` → `refuted`.
- **Session-notes stay** for narrative: findings, plans, decisions. Findings cite claims as `[claim:<id>]`.
- The supervisor directive `epistemic-rigor.md` must be updated in the same change (its text points at the tag conventions, so the auditor would otherwise flag correct ledger use as non-compliance). `research-discipline.md` should add the ledger tools to its triggers.
- `adlc-research` keeps its own skill and tag ledger unchanged. The harness is not loaded there.

## 6. Consequences

- **Positive:** topic scope can't be forgotten; synthesis can't ship with open hypotheses or dangling citations; verified claims survive compaction and land in Dewey with lineage; two sessions in one checkout can work on different topics.
- **Negative:** a new plugin to maintain. Arg injection on another plugin's tools couples the harness to those tools' arg names (`source_id`, `tags`, `tag`); the spec pins them and tests them. Hard blocks can frustrate the agent; mitigated by `warn` defaults, clear error text, and `research_topic --all`.
- **Risk:** OpenCode experimental hooks change shape between builds (system-transform delivery already broke in 1.19.0). Each experimental hook is registered behind a guard and the feature degrades rather than failing plugin load.

---

# Part 2 — PRD

## 1. Objective

Give OpenCode research sessions a deterministic topic scope and an epistemic ledger, so that research runs **Explore → Extract → Verify → Distill → Culminate** within one topic at a time and every claim in a synthesis traces to evidence.

## 2. Users and use

- **User:** Jay, running opencode in `jflowers/research` (or any repo with the same layout) on more than one topic.
- **Core flow:** `/topic agent-memory` → the session is scoped. Dewey searches return only `disk-agent-memory`; notes get `topic:agent-memory`; writes stay in `topics/agent-memory/`. The agent explores, records claims with evidence, verifies or refutes them, and writes `topics/agent-memory/findings/2026-11-20-synthesis.md`. The gate checks the draft. `ledger_export` pushes verified claims into Dewey.
- A second session in the same checkout can be on a different topic at the same time.

## 3. Functional requirements

### FR-T: Topic scope (module `topic`)

- **FR-T1** Topic state is per session, keyed by `sessionID`, persisted in SQLite so it survives a restart.
- **FR-T2** A new session's topic is, in order: its parent session's topic (subagents inherit), else the workspace default from `.research/active-topic`, else none. With no topic, research tools that need one return an error asking the user to pick one. The harness never picks.
- **FR-T3** Topics are discovered from `topics/*/TOPIC.md` (skipping `_template`). A slug must match `^[a-z0-9][a-z0-9-]*$`.
- **FR-T4** `research_topic` tool with actions `show`, `set <slug>`, `list`, `all` (cross-topic for this session), `new <slug>` (create from `_template`, append the `disk-<slug>` block to `.uf/dewey/sources.yaml`; the agent still fills in `TOPIC.md` with the user).
- **FR-T5** `/topic` is handled deterministically in `command.execute.before`: the harness sets state itself and replaces the prompt parts with a short instruction to report the topic's scope and plan. `set` also writes `.research/active-topic` (the workspace default) unless configured not to.
- **FR-T6** With a topic active and cross-topic mode off, `tool.execute.before` scopes calls. The rule everywhere: **fill in the topic when it's absent; reject an explicit different topic** (D5). The rejection names the topic in force and `research_topic all` as the way to work across topics.
  - **Dewey read tools** (`dewey_semantic_search_filtered`, and once E2 ships, `dewey_semantic_search`, `dewey_search`, `dewey_similar`, `dewey_find_by_tag`): set `source_id = "disk-<slug>"`.
    - *Interim, until E2:* tools without a `source_id` parameter are rejected, with a message giving the equivalent `dewey_semantic_search_filtered` call. The harness detects E2 by the tool's parameter schema (via `tool.definition`), not by a version number.
  - **`dewey_store_learning`**: set `tag = "<slug>"`.
  - **`note_save`, `note_search`**: add `topic:<slug>` to `tags`.
  - **`note_list`**: add `topic:<slug>` to `tags` once E1 ships. *Interim:* reject with a message steering to `note_search` with the tag.
  - **Writes** (`write`, `edit`, `patch`/`apply_patch`, configured edit tools): reject paths outside `topics/<slug>/` plus a configured allowlist (default `.research/`).
  - **Searches over files** (`grep`, `glob`): with no `path`, set `path: "topics/<slug>"`. An explicit `path` inside `topics/<other-slug>/` is rejected; an explicit path elsewhere (repo root files, `.opencode/`) is allowed.
  - **Explicit reads** (`read` of a named file) are allowed anywhere, including another topic's folder (D8). Reading a known path is deliberate and sometimes legitimate (reusing a method or finding). The tool output gets a one-line note when the file belongs to another topic, so the cross-topic source is visible.
  - **`bash`**: commands that name `topics/<other-slug>/` and contain a write operator (`>`, `>>`, `tee`, `mv`, `cp`, `rm`, `sed -i`) are rejected (best-effort string check). Read-only shell commands are allowed, like explicit reads.
- **FR-T7** Cross-topic mode (`research_topic all`) turns off FR-T6 for searches (Dewey, notes, `grep`/`glob`) for the session. Write scoping stays on. The status header says "cross-topic" while it is on.
- **FR-T8** `shell.env` exports `RESEARCH_TOPIC=<slug>` to shell commands.

### FR-L: Epistemic ledger (module `ledger`)

- **FR-L1** The canonical ledger is `topics/<slug>/claims.jsonl`, committed to git: one line per claim, the full current record including hypotheses (D1). Every successful ledger write rewrites the topic's file (sorted by id, stable key order, so diffs stay small). `.research/ledger.sqlite` (gitignored) is the working index: it holds session state and the event log, and the claims tables are rebuilt from `claims.jsonl` whenever the file is newer than the DB or the DB is missing. A fresh clone or a second machine therefore starts with every claim, open hypotheses included.
- **FR-L2** A topic's claim **layers** are the slugs of its "Required synthesis dimensions" bullets (e.g. "Failure modes & overhead" → `failure-modes-overhead`), plus an optional `## Claim layers` section that overrides them. `cross-cutting` is always allowed, so a claim that spans dimensions isn't forced into the wrong one (D6).
- **FR-L3** `ledger_upsert_claim`: `id`, `layer`, `assertion`, `mechanism`, `status`, `confidence`, `confidenceBasis` ("what would change it"), `evidence[]` of `{ source, locator, observation, relation }`, optional `failureMode`, `category`. `layer` is validated at execute time against the session's topic (the zod schema is static and can't be per-topic). `verified` requires ≥1 evidence item with a non-empty locator that is a URL, `path:line`, `owner/repo@sha:path`, `note:<id>`, or `learning/<identity>`. A `hypothesis` can't have `verified` confidence.
- **FR-L4** `ledger_challenge_claim`: `id`, `newStatus` (`hypothesis` | `refuted`), `counterEvidence`, optional `confidence` and `confidenceBasis`. Appends, never deletes. Confidence drops with the status: without an explicit value it goes one step down (`verified` → `likely` → `speculative`), a refuted claim goes to `speculative`, and the basis records the challenge and the old confidence. Keeping `verified` on a hypothesis is rejected.
- **FR-L5** `ledger_status`: markdown summary for the session's topic: counts by status and layer, open hypotheses, ratchet budget, and a table of claims with ready-to-paste `[claim:<id>]` tags.
- **FR-L6** Every change is appended to `claim_events` (audit trail replaces "retracted notes kept for audit").
- **FR-L7** Before compaction, the session's topic, verified claims (id, layer, assertion, one locator) and open hypotheses are pushed into `output.context` (bounded, default 4 KB).
- **FR-L8** Each turn, a ≤5-line status header (topic, cross-topic flag, open hypotheses, ratchet budget) is delivered to the model. Delivery path per §3.4.

### FR-G: Synthesis gate (module `gate`)

- **FR-G1** Applies to writes whose path matches the topic's synthesis globs (default `topics/<slug>/findings/*synthesis*.md`, plus any file whose frontmatter has `kind: synthesis`).
- **FR-G2** Checks, each reported by name:
  1. **Open hypotheses:** no `hypothesis` claims in the topic (unless `out-of-scope`).
  2. **Citations:** every `[claim:<id>]` exists and is `verified`; at least `min(3, verifiedCount)` distinct citations.
  3. **Dimensions:** every required dimension from `TOPIC.md` appears as a heading (case-insensitive, normalized), or the document has a heading for it with an explicit "not addressed because…" line.
  4. **Weasel words:** off by default; `warn` mode adds a note to the tool output, never blocks.
- **FR-G3** `write` content is checked directly. `edit` is checked by applying `oldString → newString` to the file on disk. Any other edit shape (e.g. the hashline plugin's edit format) is handled by snapshot-and-verify (§3.6).

### FR-E: Export (module `export`)

- **FR-E1** `ledger_export` (tool, also run by `/topic` switch-away if configured) writes verified claims of the session's topic to Dewey learnings tagged `<slug>` with `validity`, `as_of`, `evidence`, and `supersedes` when a previously exported claim changed. It writes the learning files itself (D3, §3.9); it does not depend on the agent making `dewey_store_learning` calls.
- **FR-E2** It also regenerates `topics/<slug>/CLAIMS.md` (git-reviewable, one section per claim), which Dewey indexes under `disk-<slug>`.
- **FR-E3** Re-running is idempotent: unchanged claims are skipped; changed claims produce a new learning that supersedes the old one. Refuted claims that were exported get a superseding learning with `validity: historical` and the refutation.

### FR-R: Ratchet (module `ratchet`, phase 2)

- **FR-R1** Per session, count exploratory calls since the last distillation. Exploratory = `read`, `grep`, `glob`, `webfetch`, `websearch`, Tavily tools, Dewey read tools, scout tools, and `bash` matching a configured regex.
- **FR-R2** At budget (default 8 per topic, overridable in `TOPIC.md` or config): `warn` appends a reminder to the tool output; `block` rejects the call with the distill instruction.
- **FR-R3** The budget resets when `ledger_upsert_claim` or `ledger_challenge_claim` succeeds **and** cites at least one source explored since the last reset. A claim with no such evidence resets half the budget.
- **FR-R4** Only counts calls that executed (counted in `tool.execute.after`), so a call blocked by another plugin doesn't consume budget.
- **FR-R5** Default mode is `warn`, budget 8 (D7). Every warning is recorded in `ratchet_events`, and `ledger_status` shows the topic's warning count. `block` is turned on per topic in `TOPIC.md` once those counts show the budget is regularly exceeded without distillation.

### FR-S: Scout (module `scout`, deferred)

Not planned (D9). Recorded so it can be picked up later without re-deriving it. As in the Google Doc FR-2, with three changes: clone to `/tmp/opencode-scout/<owner>__<repo>` and record `HEAD` sha so evidence can be pinned `owner/repo@sha:path:line`; skeleton extraction uses `ast-grep` if on `PATH` and returns "unsupported" otherwise (no hand-written multi-language parser); no `gaze` integration in v1.

## 4. Non-functional requirements

- **NFR-1** No external services, no LLM calls, no side sessions. `bun:sqlite` only.
- **NFR-2** `tool.execute.before` work < 15 ms p95 (cached topic config; SQLite in WAL mode).
- **NFR-3** Fail open on internal errors: a bug in the harness logs and lets the call through. Only deliberate rejections throw.
- **NFR-4** Inert outside a research workspace (no `topics/` directory and no config): registers no hooks.
- **NFR-5** Double-load safe (§3.8).
- **NFR-6** Every rejection message says what was rejected, why, and the exact corrected call.

## 5. Out of scope (v1)

Automatic claim invalidation by an event sidecar (PLAN.md Tier E2); FTS over claims; multi-user merge of `claims.jsonl` beyond what git gives; the repo scout; a TUI; npm publishing (D10).

---

# Part 3 — Technical specification

## 3.1 Repository layout

```text
opencode-research-harness/
├── package.json              # "@opencode-ai/plugin": "1.19.0", zod via tool.schema
├── tsconfig.json
├── src/
│   ├── index.ts              # Plugin entry: guard, config, compose module hooks
│   ├── config.ts             # Options + .opencode/research-harness.json + defaults
│   ├── shared-state.ts       # globalThis registry (double-load guard)
│   ├── topic-config.ts       # TOPIC.md parser (dimensions → layers, budget, globs)
│   ├── db.ts                 # bun:sqlite schema, migrations, queries
│   ├── modules/
│   │   ├── topic.ts          # research_topic tool, /topic, scope injection
│   │   ├── ledger.ts         # ledger_* tools, compaction + status injection
│   │   ├── gate.ts           # synthesis gate
│   │   ├── export.ts         # Dewey learnings + CLAIMS.md
│   │   ├── ratchet.ts        # phase 2
│   │   └── (scout.ts)        # deferred, D9
│   └── util/
│       ├── markdown.ts       # headings, [claim:id] parse, code-fence aware
│       └── paths.ts          # normalize, topic containment
├── skills/research-ledger/SKILL.md   # replaces epistemic-discipline for harness users
└── test/                     # bun:test, temp-dir SQLite and fixtures
```

Hosted as a private GitHub repo, `jflowers/opencode-research-harness`, with the usual `origin`/PR flow (D10). Loaded per project from the research repo's `opencode.json` `plugin` array **by absolute path**, the way `opencode-session-notes` is loaded globally. No npm package until phase 1 has run in real sessions. **Not** loaded globally: it is inert elsewhere, but project scope keeps it out of unrelated sessions.

## 3.2 Configuration

Plugin options (the `[name, options]` tuple form that `Config.plugin` accepts) merged over `.opencode/research-harness.json`, merged over defaults:

```jsonc
{
  "topicsDir": "topics",
  "workspaceDefaultFile": ".research/active-topic",
  "writeWorkspaceDefaultOnSet": true,
  "dbPath": ".research/ledger.sqlite",
  "writeAllowlist": [".research/"],
  "claimsFile": "claims.jsonl",                 // per topic, committed (D1)
  "dewey": {
    "filteredSearchTool": "dewey_semantic_search_filtered",
    // Scoped by source_id when their schema has it (E2); rejected otherwise.
    "readTools": ["dewey_semantic_search_filtered", "dewey_semantic_search", "dewey_search",
                  "dewey_similar", "dewey_find_by_tag"],
    // Never scoped, never rejected (graph navigation from a page already found).
    "passthroughTools": ["dewey_get_page", "dewey_get_block", "dewey_traverse", "dewey_health"],
    "learningsDir": ".uf/dewey/learnings"
  },
  "notes": { "taggedTools": ["note_save", "note_search", "note_list"], "tagPrefix": "topic:" },
  "editTools": ["write", "edit", "patch", "apply_patch"],
  "gate": { "synthesisGlobs": ["findings/*synthesis*.md"], "weaselWords": "off", "minCitations": 3 },
  "ratchet": {
    "mode": "warn", "budget": 8,                // "warn" | "block" | "off"
    "tools": ["read", "grep", "glob", "list", "webfetch", "websearch", "codesearch"],  // plus dewey.readTools
    "toolPrefixes": ["tavily_"],
    "bashPattern": "\\b(curl|wget|gh|rg|grep|cat|head|tail|less|find|git\\s+(log|show|grep|blame))\\b",
    "maxExplored": 50
  },
  // Fallback only; the supervisor's shared side-session registry is checked first (E5).
  "ignoreSessionTitlePrefixes": ["supervisor-audit @", "supervisor-repair @"],
  "injection": "messages",                      // "messages" | "system" — see §3.4
  "compactionBudgetBytes": 4096
}
```

### `TOPIC.md` contract

The parser reads these sections of `topics/<slug>/TOPIC.md` (the existing `_template` already has the first):

- `## Required synthesis dimensions` — bullet list. Each bullet's text (before any ` — ` explanation) is a dimension. Its slug is a layer.
- `## Claim layers` (optional) — bullet list of `` `slug` — description ``. When present, it replaces the derived layers. Dimensions still drive the gate.
- `## Harness` (optional) — a fenced `json` block with per-topic overrides: `ratchetBudget`, `ratchetMode`, `synthesisGlobs`, `minCitations`.

Parsed config is cached by file mtime. A topic with no dimensions is an error at `set` time ("add Required synthesis dimensions to TOPIC.md").

## 3.3 Data model (`db.ts`)

Two stores (D1):

- **`topics/<slug>/claims.jsonl`** (committed, canonical for claims). One JSON object per line with the `claims` columns below (camelCase), `evidence` as an array, sorted by `id`. Written atomically (temp file + rename) after each successful ledger write. Hand edits are allowed; they are picked up on the next rebuild.
- **`.research/ledger.sqlite`** (gitignored, working index), `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 2000` (two opencode processes can share a checkout). On plugin start and before each ledger read, the `claims` rows for a topic are rebuilt from its `claims.jsonl` when the file's mtime is newer than the topic's `rebuilt_at`. `session_topics`, `claim_events` and `ratchet_events` exist only here; losing them loses session state and history, not claims.

```sql
CREATE TABLE session_topics (
  session_id   TEXT PRIMARY KEY,
  topic_slug   TEXT,                 -- NULL = no topic
  cross_topic  INTEGER NOT NULL DEFAULT 0,
  parent_id    TEXT,
  ignored      INTEGER NOT NULL DEFAULT 0,   -- supervisor side session etc.
  explored_since_reset TEXT NOT NULL DEFAULT '[]', -- JSON array of locators (ratchet)
  exploratory_count    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

CREATE TABLE claims (
  topic_slug   TEXT NOT NULL,
  id           TEXT NOT NULL CHECK (id GLOB '[a-z0-9]*' AND id NOT GLOB '*[^a-z0-9-]*'),
  layer        TEXT NOT NULL,        -- validated in code against the topic's layers
  assertion    TEXT NOT NULL,
  mechanism    TEXT NOT NULL,
  failure_mode TEXT,
  status       TEXT NOT NULL CHECK (status IN ('hypothesis','verified','refuted','out-of-scope')),
  confidence   TEXT NOT NULL CHECK (confidence IN ('speculative','likely','verified')),
  confidence_basis TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'context',  -- Dewey category
  evidence_json TEXT NOT NULL,       -- [{source, locator, observation, relation}]
  dewey_identity TEXT,               -- last exported learning identity
  exported_hash  TEXT,               -- hash of exported fields; idempotency
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (topic_slug, id)
);

CREATE TABLE claim_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_slug   TEXT NOT NULL,
  claim_id     TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- upsert | challenge | export
  before_json  TEXT,
  after_json   TEXT NOT NULL,
  at           TEXT NOT NULL
);

CREATE TABLE ratchet_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_slug   TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,        -- warn | block | reset | half-reset
  count        INTEGER NOT NULL,
  at           TEXT NOT NULL
);

CREATE TABLE topic_rebuilds (
  topic_slug   TEXT PRIMARY KEY,
  rebuilt_at   TEXT NOT NULL          -- mtime of claims.jsonl at last rebuild
);
```

Claim ids are unique per topic, not globally, so two topics can each have `token-cost`.

## 3.4 Hook contract (verified against `@opencode-ai/plugin` 1.19.0)

Signatures copied from `research/.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts` (1.19.0, matching `opencode --version` 1.19.0). `get-out/.opencode` pins 1.4.6, which lacks `dispose` and `experimental.provider.small_model`; target 1.19.0 only.

| Hook | 1.19.0 signature | Harness use |
|---|---|---|
| `event` | `({ event: Event }) => Promise<void>` | `session.created`: record parent, inherit topic, mark ignored when the supervisor's registry lists the session (E5) or its title starts with an ignored prefix. `session.updated`: re-check. `session.deleted`: drop row. |
| `tool` | `{ [key]: ToolDefinition }`; `execute(args, ctx: ToolContext)` with `ctx.sessionID`, `ctx.directory`, `ctx.worktree`, `ctx.agent` | `research_topic`, `ledger_upsert_claim`, `ledger_challenge_claim`, `ledger_status`, `ledger_export`. |
| `command.execute.before` | `(input: { command; sessionID; arguments }, output: { parts: Part[] })` | `/topic`: set state deterministically, replace `parts` with a short instruction. |
| `tool.execute.before` | `(input: { tool; sessionID; callID }, output: { args: any })` | Scope injection/rejection (FR-T6), gate (FR-G), ratchet check. Mutate `output.args` in place; reject by throwing `Error`. |
| `tool.execute.after` | `(input: { tool; sessionID; callID; args: any }, output: { title; output; metadata })` | **`args` is new in this version.** Ratchet: count executed exploratory calls and record explored locators from `input.args` (`filePath`, `url`, `path`). Reset on successful ledger writes. Gate snapshot verification (§3.6). Ratchet `warn` text appended to the output. **For MCP tools `output` is the raw MCP result (`{ content: [...] }`), not `{ title; output; metadata }`** (`session/tools.ts`, v1.19.0), so notes go through `src/tool-output.ts`, which writes to whichever shape is present (found in the live wire check). |
| `shell.env` | `(input: { cwd; sessionID?; callID? }, output: { env })` | `RESEARCH_TOPIC`. |
| `experimental.session.compacting` | `(input: { sessionID }, output: { context: string[]; prompt?: string })` | Push ledger block (FR-L7). Never set `prompt` (would override the DCP plugin and OpenCode's default). |
| `experimental.chat.messages.transform` | `(input: {}, output: { messages: { info; parts }[] })` | **Default delivery path for the status header** (FR-L8). No `sessionID` in input; derive it from `messages[i].info.sessionID`, as the supervisor does. |
| `experimental.chat.system.transform` | `(input: { sessionID?: string; model: Model }, output: { system: string[] })` | **Not used by default.** The types now pass `sessionID`, but the supervisor's wire capture on the installed 1.19.0 build showed that no plugin's system-transform mutation reaches the request (supervisor `design.md`, FR-016 amendment 2026-10-27). Enabled only with `injection: "system"`, for a future build where delivery is verified. Never both, to avoid double delivery. |
| `tool.definition` | `(input: { toolID }, output: { description; parameters })` | Capability detection: record whether each configured Dewey read tool's `parameters` has `source_id` (E2) and whether `note_list` has `tags` (E1). Those flags choose scope-vs-reject in §3.5. For tools that will be rejected, append a one-line note to the description ("rejected while a research topic is active; use dewey_semantic_search_filtered"). Input has no session, so the text is static. If the hook never fires for a tool, assume the capability is absent. |
| `dispose` | `() => Promise<void>` | Close the DB; release the shared-state load record. |

Not used: `chat.message`, `chat.params`, `chat.headers`, `permission.ask`, `experimental.text.complete`, `experimental.compaction.autocontinue`.

Every `experimental.*` registration is wrapped so that a missing or renamed hook degrades the feature (logged once) instead of failing plugin load.

**To verify during implementation (wire tests, not assumptions):**

1. That args mutated in `tool.execute.before` reach MCP tools (Dewey) and plugin tools (session-notes) on 1.19.0. The supervisor's arg-repair depends on the same behavior for plugin tools; MCP tools need their own check.
2. That `experimental.session.compacting` `output.context` reaches the compaction request on this build.
3. The exact edit-tool names and arg shapes when the global hashline plugin is loaded.

## 3.5 Topic module

- **Resolution** per call: `session_topics[sessionID]` → (created lazily) parent's row → workspace default file → none.
- **Ignored sessions** (supervisor side sessions; §3.8 rule 3): every hook returns immediately. No scoping, no counting, no injection.
- **`/topic`** in `command.execute.before` when `input.command === "topic"`: parse `input.arguments` the same way as the current command (`""`, `<slug>`, `--new <slug>`, `--all`, `--list`). Apply the state change, then replace `output.parts` with one text part that tells the model what happened and what to do next (e.g. "Active topic is now `x`. Read `topics/x/TOPIC.md` and `PLAN.md` and report the scope and next steps."). `--new` creates files and the sources entry, then instructs the model to interview the user for `TOPIC.md`. The current `research/.opencode/commands/topic.md` stays as the command definition (so `/topic` exists in the menu) but its body shrinks to a fallback for when the plugin isn't loaded.
- **Arg rewriting** (FR-T6): implemented as a table of `{ tool, capability?, apply(args, topic) → args | Rejection }`. An entry with a `capability` (`dewey.source_id`, `notes.list_tags`) scopes when `tool.definition` saw the parameter and falls back to its interim rejection otherwise, so E1/E2 take effect without a harness release. Rejections throw `Error` with text beginning `[research-harness] ` and include the corrected call.
- **Cross-topic reads** (D8): `read` of a file under `topics/<other>/` passes; `tool.execute.after` prefixes `output.output` with `[research-harness] cross-topic source: topics/<other>/…`.
- **Paths**: normalize against `ctx`-equivalent project directory (`PluginInput.directory`), resolve `..`, and compare by path segments, not string prefix (`topics/ab` must not match `topics/abc`).

## 3.6 Gate module

- Trigger: an edit tool on a path matching the topic's synthesis globs.
- `write`: validate `args.content`.
- `edit`: read the file, apply `args.oldString → args.newString` (respecting `replaceAll`), validate the result. If `oldString` is not found, let the call through (the tool will fail on its own).
- **Any other edit shape** (hashline, `patch`/`apply_patch`): in `before`, snapshot the current file (or "absent"). In `after`, read the written file and validate. On failure, restore the snapshot and replace `output.output` with the gate failure, so the agent sees a failed write. This path is fail-safe only if the restore succeeds; a restore error is logged and reported in `output.output`.
- `validateSynthesis(markdown, topic, db)` returns `{ gate, ok, details }[]`. Markdown parsing ignores fenced code blocks.
- Rejection text lists each failed gate with the exact fix (ids to verify, missing headings, unknown citations).

## 3.7 Ratchet module (phase 2)

- **Check** in `tool.execute.before`: if `exploratory_count >= budget` and mode is `block`, throw:
  ```text
  [research-harness] Exploratory budget used (8/8 since the last claim).
  Record what you learned before exploring further:
    ledger_upsert_claim with evidence citing one of: <up to 5 locators explored since the last reset>
  ```
- **Count** in `tool.execute.after` (executed calls only), and record the locator from `input.args` (`filePath`, `path`+`pattern`, `url`, scout repo).
- **Reset** in `tool.execute.after` of `ledger_upsert_claim` / `ledger_challenge_claim`: if any evidence `locator` or `source` matches a recorded explored locator (normalized), reset to 0 and clear the list. Otherwise subtract `ceil(budget / 2)`.
- Subagent sessions have their own budgets; they don't drain the parent's.
- **Matching** (as built): locators are normalized (URLs lose fragment, trailing slash and host case; paths become project-relative without `:line`; `owner/repo@sha:path` becomes `owner/repo:path`). GitHub URLs (`github.com/…/blob/…`, `raw.githubusercontent.com`, `api.github.com/repos/…`) are also recorded in that `owner/repo:path` form. Evidence matches when it equals an explored locator or lies inside it (a file in a grepped folder). The reset runs inside the ledger tools on success rather than in `tool.execute.after`, so a rejected write never resets.
- A phase-1 `ledger.sqlite` gains the two `session_topics` columns in place (`ALTER TABLE`), keeping session state.

## 3.8 Coexistence with `opencode-agent-supervisor`

The supervisor (`opencode-agent-supervisor@2.12.0`) is loaded globally from `~/.config/opencode/opencode.jsonc`. On 2026-11-18 an adlc-research session created 5,062 `supervisor-audit @ …` side sessions in 73 minutes. Root cause: the supervisor was loaded twice (npm package globally, local checkout in the project `opencode.json`); each copy kept self-suppression in module scope, so each audited the other's side sessions; tool-enabled auditors with no timeout or concurrency cap turned that into a runaway (supervisor commit `ade385f`, FR-099..FR-103).

Rules for the harness:

1. **Never load the supervisor from the research repo's `opencode.json`.** (Already documented there.) The harness README repeats this.
2. **Our own double-load guard.** Process-wide state lives on `globalThis[Symbol.for("opencode-research-harness.shared-state")]`, with `loadsByDirectory: Map<directory, Set<moduleUrl>>`, as in the supervisor's `registerPluginLoad`. A second copy for the same directory logs one warning naming both module URLs and **returns `{}`** (no hooks, no tools). The supervisor only warns; the harness must not run twice because double scoping is harmless but double counting and double injection are not.
3. **Ignore supervisor side sessions.** The primary check reads the supervisor's process-wide registry, `globalThis[Symbol.for("opencode-agent-supervisor.shared-state")].sideSessionIds`, which every supervisor copy shares since FR-099. E5 makes that registry a documented contract. The fallback, for supervisor builds without it, is the title prefix `supervisor-audit @` / `supervisor-repair @`, checked on `session.created`/`session.updated`. The supervisor's FR-100 disables tools in those sessions; ignoring them anyway means a future supervisor regression can't make the harness scope or block an auditor, and the harness never injects into an audit prompt.
4. **No side sessions, no model calls.** The harness creates no sessions and never calls `client.session.prompt`. It can't contribute to a runaway.
5. **Hook ordering.** Both plugins mutate `output.args` in `tool.execute.before`. The supervisor's arg-repair should run before the harness's scope injection, so the harness sees repaired args. Global plugins are expected to run before project plugins; verify on 1.19.0 and record the order in a test fixture. If the order turns out reversed, the supervisor's repair must keep keys it didn't write (`source_id`, `tags`, `tag`). Args can't be changed after `tool.execute.before`, so that guarantee belongs in the supervisor (E4), not in the harness.
6. **Blocks look like tool failures to the supervisor.** That is intended. The supervisor's directives must not instruct the agent to work around them; update `epistemic-rigor.md` (§5 of the ADR).
7. **Injection channel.** The supervisor delivers its memo via `experimental.chat.messages.transform`, appending one trailing user message per prompt. The harness uses the same hook and appends its status header to that same trailing synthetic position only if present, otherwise as its own small trailing text part. Keep the header ≤5 lines so the two do not crowd each other.

## 3.9 Export to Dewey

Pattern from `adlc-research/scripts/kb_to_dewey.py` (frontmatter `tag`, `category`, `confidence`, `created_at`, `validity`, `as_of`, `evidence`; idempotent; owner-qualified `as_of`). For each verified (or newly refuted, previously exported) claim in the session's topic whose `exported_hash` differs:

| Learning field | Value |
|---|---|
| `tag` | `<slug>` |
| identity | `<slug>-<YYYYMMDDTHHMMSS>-research-harness` (Dewey's `{tag}-{timestamp}-{author}` grammar), stored in `claims.dewey_identity` |
| `category` | `claims.category` (`decision` / `pattern` / `gotcha` / `context` / `reference`) |
| `confidence` | `verified` → `high`, `likely` → `medium`, `speculative` → `low` |
| `validity` | `current` for verified; `historical` for refuted |
| `as_of` | `owner/repo@<full sha>` from the first evidence locator with a repo pin (scout records it); omitted when no evidence carries a pin. Owner-qualified for the reason `kb_to_dewey.py` gives: a bare `repo@sha` makes `dewey lint` check the pin against the vault's own repo. |
| `evidence` | Evidence locators verbatim, ≤50 entries, ≤512 chars each (Dewey's limits), plus `research:<slug>/claim:<id>` |
| `supersedes` | Previous `dewey_identity` when the claim was exported before |
| body | `# <id>: <assertion>`, then mechanism, failure mode, layer, confidence basis |

**Mechanism (D3): the harness writes `.uf/dewey/learnings/<identity>.md` itself**, atomically, in the frontmatter format Dewey's `learning_temporal.go` writes (the same contract `kb_to_dewey.py` relies on). Reasons:

- It is deterministic. A plugin can't call another server's MCP tools, so the alternative was handing the agent a list of `dewey_store_learning` calls to make, which puts the agent back in the loop for the one step that must not be skipped.
- It keeps a per-claim `as_of`. `dewey_store_learning` stamps `as_of` from the vault's git HEAD and has no input for it (upstream `main`, `3776105`).
- Dewey already converges to file changes: since #221 (merged 2026-11-18) a learning whose file changed is re-ingested, not only one whose page is missing. Today that happens when the server starts; E3b makes it happen while the server runs. Until then `ledger_export`'s output says the learnings are searchable after the next Dewey start or `dewey reindex` (#223).

A golden-file test pins the frontmatter shape against Dewey's own writer output, so a Dewey format change fails the harness tests instead of producing learnings Dewey can't read.

`CLAIMS.md` is regenerated on every export.

## 3.10 Tests (`bun test`)

- `topic-config.test.ts`: dimension → layer slugs; `## Claim layers` override; `## Harness` overrides; missing dimensions error.
- `topic.test.ts`: per-session state and parent inheritance; `/topic` arg parsing; each FR-T6 rewrite and rejection, both with and without the E1/E2 capabilities; mismatched explicit topic rejected; cross-topic read annotated, not blocked; `topics/ab` vs `topics/abc`; cross-topic mode; ignored supervisor sessions (registry and title fallback) untouched.
- `ledger.test.ts`: `verified` without a valid locator throws; layer outside the topic throws; `cross-cutting` accepted; `claim_events` appended; per-topic id namespace; `claims.jsonl` written sorted and stable; SQLite deleted → claims rebuilt from `claims.jsonl`; hand-edited `claims.jsonl` picked up.
- `gate.test.ts`: open hypothesis, unknown citation, refuted citation, missing dimension, pass; `edit` applied in memory; snapshot-restore path.
- `ratchet.test.ts`: budget reached → block in `block` mode, warn text in `warn` mode; reset only with explored-source evidence; half reset otherwise; blocked-by-other-plugin calls not counted.
- `export.test.ts`: frontmatter matches a golden file produced by Dewey's own learning writer; idempotency; supersession; refuted → historical; owner-qualified `as_of`.
- `double-load.test.ts`: second copy for the same directory returns `{}` and warns once.

## 3.11 Rollout

1. Create the private GitHub repo `jflowers/opencode-research-harness` and push this spec.
2. Companion enhancements (Part 5), in parallel with step 3; none blocks phase 1 because each has an interim behavior.
3. Phase 1 (topic, ledger, gate, export) in `opencode-research-harness`; load it by absolute path in `research/opencode.json`.
4. Same change in `research`: shrink `commands/topic.md` to a fallback, replace `epistemic-discipline` with the plugin's `research-ledger` skill, update `epistemic-rigor.md` and `research-discipline.md`, and update `AGENTS.md`'s scoping section to "enforced by the harness". No `.gitignore` change is needed: `claims.jsonl` lives under the tracked `topics/`, and `.research/` is already ignored.
5. Run the wire checks in §3.4 on 1.19.0. Fix any surprises before turning on `block` anywhere.
6. Phase 2 ratchet in `warn`; promote to `block` per topic once `ratchet_events` show the need.

---

# Part 4 — Decisions

Resolved 2026-11-18 (Jay accepted the recommendations). Each states the choice and why.

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Ledger location | `topics/<slug>/claims.jsonl` committed and canonical; `.research/ledger.sqlite` gitignored and rebuildable (FR-L1, §3.3) | Claims are the research product. A gitignored DB is one `git clean` away from loss, and `CLAIMS.md` only carries verified claims, so open hypotheses would vanish on a fresh clone or second machine. JSONL sorted by id diffs well in PRs. |
| D2 | `.research/active-topic` | Kept, only as the default topic for new sessions; `/topic <slug>` updates it (FR-T2, FR-T5) | Per-session state stops sessions overwriting each other; the default avoids running `/topic` in every session. A stale default is visible in the per-turn status header. |
| D3 | Export mechanism | Harness writes Dewey learning files itself (§3.9) | Deterministic (no agent in the loop), per-claim `as_of`, and Dewey re-ingests changed learning files since #221. E3 (`as_of` input) is still worth doing for agent-stored learnings, but the harness doesn't need it. |
| D4 | `note_list` scoping | Add a `tags` filter in `opencode-session-notes` (E1); reject `note_list` until then | Clean fix in code Jay owns; the alternatives are blunt (reject forever) or fragile (filter text output). |
| D5 | Explicit different topic in args | Reject, with the corrected call and the cross-topic escape | The harness already fills in absent scope, so a rejection only fires when the agent deliberately targets another topic — exactly the case worth surfacing. Costs one turn. |
| D6 | Claim layers | Derived from "Required synthesis dimensions", optional `## Claim layers` override, `cross-cutting` always allowed (FR-L2) | One source of truth per topic, already in the template. `cross-cutting` avoids mis-filing claims that span dimensions. |
| D7 | Ratchet default | `warn`, budget 8; `block` per topic when `ratchet_events` show the need (FR-R5) | Respects `PLAN.md`'s gaming concern; the supervisor already audits; warning counts give evidence before blocking. |
| D8 | Read scoping | Explicit reads allowed anywhere (annotated when cross-topic); searches scoped; writes blocked outside the topic (FR-T6) | Contamination comes from unscoped searches, not deliberate reads of a named file, and reusing another topic's finding is sometimes legitimate. |
| D9 | Repo scout | Not planned | The `repo-scout` skill plus `gh` works; `PLAN.md` rejected the surface area. Revisit if ratchet warnings show repo-reading sprawl. |
| D10 | Hosting | Private GitHub repo `jflowers/opencode-research-harness` now; loaded by absolute path; no npm until phase 1 has run in real sessions | Backup and the usual PR flow from the start; publishing is premature. |

---

# Part 5 — Enhancements to companion tools

Gaps found while writing this spec that belong in tools Jay owns, not in the harness. Each has an interim harness behavior, so none blocks phase 1. Upstream state checked against `unbound-force/dewey` `main` at `3776105` (2026-11-18).

| # | Repo | Enhancement | What the harness does until it lands | What changes once it lands |
|---|---|---|---|---|
| E1 | `jflowers/opencode-session-notes` | Optional `tags` filter on `note_list`, same semantics as `note_search`. | Rejects `note_list` while a topic is active, steering to `note_search` with the tag. | Adds `topic:<slug>` to `note_list` like the other note tools (detected via `tool.definition`). |
| E2 | `unbound-force/dewey` | Optional `source_id` (and `has_tag`) on `semantic_search`, `search`, `similar` and `find_by_tag`, matching `semantic_search_filtered`. | Rejects those tools while a topic is active, with the equivalent `semantic_search_filtered` call. | Scopes every Dewey read tool by filling in `source_id`. Removes the most frequent rejection (unfiltered `semantic_search` is the agent's default). |
| E3 | `unbound-force/dewey` | Optional caller-supplied `as_of` on `store_learning`, validated as `owner/repo@sha`; the git-HEAD stamp stays the default. | Not needed by the harness (it writes files, D3). | Agents storing learnings outside the harness can pin them to the source they observed, not to the vault's HEAD. |
| E3b | `unbound-force/dewey` | Re-ingest changed learning files while serving (watch `.uf/dewey/learnings/`), building on #221; or finish #223 (`dewey reindex` re-ingests learnings). | `ledger_export` says exported learnings are searchable after the next Dewey start or reindex. | Exported claims are searchable in the same session. |
| E4 | `jflowers/opencode-supervisor` | Arg repair preserves keys it didn't change (`source_id`, `tags`, `tag`), with a test. | Relies on hook order (global plugins first); §3.4 wire check verifies. | Correct regardless of hook order. |
| E5 | `jflowers/opencode-supervisor` | Document `Symbol.for("opencode-agent-supervisor.shared-state").sideSessionIds` as a stable cross-plugin contract (README + test that it's populated before the side session's first event). | Reads the registry if present, falls back to title prefixes. | Side-session detection no longer depends on title text. |

Not enhancements Jay can make:

- **OpenCode 1.19.0 drops `experimental.chat.system.transform` mutations** (supervisor design.md FR-016 amendment). Worked around by using `experimental.chat.messages.transform` (§3.4).
- **Whether args mutated in `tool.execute.before` reach MCP tools, and plugin hook order**, are OpenCode behavior. Covered by the §3.4 wire checks.
- Housekeeping, unrelated to the harness: `get-out/.opencode` pins `@opencode-ai/plugin` 1.4.6 against an installed 1.19.0.
