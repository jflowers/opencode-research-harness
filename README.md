# opencode-research-harness

An opencode plugin for multi-topic research workspaces (a repo with `topics/<slug>/TOPIC.md`, such as `jflowers/research`). It enforces what used to be prompt conventions:

- **Topic scope per session.** `/topic` sets the session's topic. Dewey searches get `source_id: "disk-<slug>"`, learnings get `tag: "<slug>"`, session-notes get `topic:<slug>`, and writes stay in `topics/<slug>/`.
- **Epistemic ledger.** Claims with topic-defined layers, calibrated confidence and evidence, stored in `topics/<slug>/claims.jsonl` (committed) with a SQLite working copy in `.research/ledger.sqlite`.
- **Synthesis gate.** A synthesis can't be written while hypotheses are open, citations are wrong, or required dimensions are missing.
- **Dewey export.** Verified claims become Dewey learnings with `validity` / `as_of` / `evidence`, plus a generated `CLAIMS.md`.

The design is in [SPEC.md](SPEC.md). This is phase 1 (topic, ledger, gate, export). The ratchet is phase 2.

## Install

```bash
bun install
```

In the research workspace's `opencode.json`, load it by absolute path:

```jsonc
{
  "plugin": ["/Users/jflowers/Projects/github/jflowers/opencode-research-harness"]
}
```

Copy or symlink `skills/research-ledger/` into the workspace's `.opencode/skills/`.

Load it **once**, from the project config only. A second copy for the same directory disables itself and logs a warning. Do not load `opencode-agent-supervisor` from the project config either; it is already global.

The plugin does nothing in a directory without `topics/`.

## Configuration

Optional `.opencode/research-harness.json`, or plugin options (`["<path>", { … }]`). Defaults are in [src/config.ts](src/config.ts). Per-topic overrides go in a `## Harness` section of `TOPIC.md`:

````markdown
## Harness

```json
{ "minCitations": 5, "synthesisGlobs": ["findings/*synthesis*.md"] }
```
````

## Tools

| Tool | Does |
|---|---|
| `research_topic` | show / set / list / new / all (cross-topic) |
| `ledger_upsert_claim` | create or update a claim |
| `ledger_challenge_claim` | append counter-evidence, downgrade to hypothesis or refuted |
| `ledger_status` | counts, open hypotheses, claim table with `[claim:<id>]` tags |
| `ledger_export` | verified claims → Dewey learnings; regenerate `CLAIMS.md` |

## Development

```bash
bun test
bun run typecheck
```
