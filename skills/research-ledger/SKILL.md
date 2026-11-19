---
name: research-ledger
description: How to research with opencode-research-harness — the active topic, the claim ledger (ledger_upsert_claim, ledger_challenge_claim, ledger_status, ledger_export), [claim:<id>] citations and the synthesis gate. Load at the start of any research session in a workspace with topics/.
tags: [research, epistemic, claims, evidence]
---

# Research ledger

The `opencode-research-harness` plugin enforces what used to be conventions. This skill tells you how to work with it rather than against it.

## The active topic

- Every session has one research topic (or none). `/topic` shows it, `/topic <slug>` switches, `/topic --new <slug>` creates one, `/topic --list` lists them. The `research_topic` tool does the same.
- If no topic is active, ask the user which one. Never pick one yourself.
- While a topic is active, the plugin scopes your calls for you:
  - Dewey searches get `source_id: "disk-<slug>"`; learnings get `tag: "<slug>"`.
  - Session-notes get the tag `topic:<slug>`.
  - `grep`/`glob` without a path search `topics/<slug>/`.
  - Writes outside `topics/<slug>/` (and `.research/`) are rejected.
- If a call is rejected, read the message: it says exactly what to call instead. Don't try to route around it (for example through `bash`).
- Reading a specific file from another topic is allowed and flagged as a cross-topic source. Say so if you use it.
- `/topic --all` lifts search scoping for the session. Say "cross-topic" in every reply that uses unscoped results.

## Claims

A claim is one falsifiable sentence with a mechanism and evidence. Record it as soon as you have learned something, not at the end.

```
ledger_upsert_claim({
  id: "retry-budget-per-call",          // stable slug; reuse it to update
  layer: "<one of the topic's layers>", // from TOPIC.md "Required synthesis dimensions", or "cross-cutting"
  assertion: "…",                       // one sentence, falsifiable
  mechanism: "…",                       // the concrete how/why
  failureMode: "…",                     // optional: costs, limits, bypass risks
  status: "hypothesis" | "verified" | "refuted" | "out-of-scope",
  confidence: "speculative" | "likely" | "verified",
  confidenceBasis: "…",                 // what evidence would raise or lower it
  evidence: [{ source, locator, observation, relation: "supports" | "contradicts" | "qualifies" }]
})
```

- **Calibrate confidence**, and always say what would change it:
  - `verified`: observed directly or confirmed by 2+ independent authoritative sources.
  - `likely`: consistent with several sources, or one authoritative source plus your analysis.
  - `speculative`: inferred from incomplete data or a single weak source.
- **Locators must be precise** for a `verified` claim: a URL, `path:line`, `owner/repo@sha:path:line`, `note:<id>` or `learning/<identity>`. Without one, record it as a `hypothesis`.
- **Never delete or silently rewrite.** When evidence contradicts a claim, use `ledger_challenge_claim` (to `hypothesis` or `refuted`). The history is kept. Confidence drops one step with it (to `speculative` when refuted) unless you pass a new `confidence` and `confidenceBasis`.
- `ledger_status` shows counts, open hypotheses and a table of claims with ready-to-paste `[claim:<id>]` tags.

## Findings and syntheses

- Findings go in `topics/<slug>/findings/YYYY-MM-DD-<name>.md` and cite claims as `[claim:<id>]`. Keep narrative notes in session-notes as before.
- A synthesis (`findings/*synthesis*.md`, or any file with `kind: synthesis` frontmatter) is gated. The write is rejected unless:
  1. no claim in the topic is still a `hypothesis` (verify, refute, or mark `out-of-scope`);
  2. every `[claim:<id>]` cited exists and is `verified`, and at least 3 distinct verified claims are cited (fewer if the topic has fewer);
  3. every required synthesis dimension from `TOPIC.md` has a heading (it may say why the dimension can't be addressed).
- The rejection lists exactly what failed. Fix the ledger or the draft, then write again.

## Export

`ledger_export` writes verified claims to Dewey learnings (tag `<slug>`, with `validity`, `as_of`, `evidence`) and regenerates `topics/<slug>/CLAIMS.md`. Run it after a synthesis or when a batch of claims is verified. Exported learnings are searchable after the next Dewey start or `dewey reindex`.

## Exploration budget

The harness counts exploratory calls (reads, searches, fetches, Dewey and Tavily queries) since your last claim. The per-turn header shows `Exploration: n/8`.

- At budget it tells you to distill (or, in topics set to `block`, rejects further exploration). Stop and record what you learned with `ledger_upsert_claim`.
- The budget resets fully only when the claim's evidence cites something you actually explored since the last reset: the file, folder, URL or GitHub path. Cite the real locator.
- A claim citing nothing you explored (a hypothesis, say) gives back half the budget. That is fine for genuine hypotheses; don't use it to buy more exploration.
- Subagents have their own budget.

## What persists

Claims live in `topics/<slug>/claims.jsonl`, which is committed. Commit it along with findings. The ledger survives compaction: the plugin re-injects open hypotheses and verified claims, so keep `[claim:<id>]` tags verbatim in summaries.
