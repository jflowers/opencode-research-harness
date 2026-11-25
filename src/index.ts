import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Hooks, Plugin, PluginInput, PluginModule } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { CATEGORIES, CONFIDENCES, RELATIONS, STATUSES } from "./claims"
import { loadConfig } from "./config"
import { registerSkills } from "./skills"
import { HarnessContext, type Logger, Rejection } from "./context"
import { exportReportText, exportTopic } from "./modules/export"
import { gateAfter, gateBefore } from "./modules/gate"
import { annotateFilledIn } from "./modules/filled-in"
import { challengeClaim, compactionBlock, statusHeader, statusMarkdown, upsertClaim } from "./modules/ledger"
import { ratchetCheck, ratchetCount, ratchetReset, ratchetSettings, resetNote } from "./modules/ratchet"
import {
  annotateCrossTopicRead,
  parseTopicArgs,
  recordToolDefinition,
  rejectionNoteFor,
  runTopicAction,
  scopeToolCall,
} from "./modules/topic"
import { injectedPart, recordInjectedArgs, registerLoad, releaseLoad, snapshotArgs } from "./shared-state"
import type { ToolOutput } from "./tool-output"

export { HarnessContext, Rejection } from "./context"

const SERVICE = "research-harness"

function makeLogger(client: PluginInput["client"] | undefined): Logger {
  const send = (level: "warn" | "error", message: string) => {
    try {
      void client?.app?.log?.({ body: { service: SERVICE, level, message } })?.catch?.(() => {})
    } catch {}
  }
  return { warn: (m) => send("warn", m), error: (m) => send("error", m) }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs a hook body: rejections propagate, anything else is logged and swallowed (NFR-3). */
function failOpen<T>(log: Logger, hook: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (err) {
    if (err instanceof Rejection) throw err
    log.error(`${hook}: ${errorText(err)}`)
    return undefined
  }
}

/** Tool results for rejections and failures, so the model sees why. */
function toolError(err: unknown): string {
  return err instanceof Rejection ? err.message : `[research-harness] error: ${errorText(err)}`
}

function sessionIdOf(messages: { info?: { sessionID?: unknown } }[]): string | undefined {
  for (const m of messages) if (typeof m?.info?.sessionID === "string") return m.info.sessionID
  return undefined
}

let injectSeq = 0

/** Builds the hooks for one project directory. Exported for tests. */
export function createHarness(ctx: HarnessContext): Hooks {
  const { log } = ctx
  const s = tool.schema

  const evidenceSchema = s.object({
    source: s.string().min(1).describe("What the evidence is (file, page, repo, note)"),
    locator: s
      .string()
      .min(1)
      .describe("Where exactly: URL, path:line, owner/repo@sha:path:line, note:<id>, or learning/<identity>"),
    observation: s.string().min(1).describe("What was actually seen there (quote or specific description)"),
    relation: s.enum(RELATIONS).describe("How it bears on the claim"),
  })

  /** FR-R3: a successful ledger write resets the ratchet; never fails the write. */
  const afterLedgerWrite = (sessionId: string, evidence: { source?: string; locator?: string }[]): string =>
    failOpen(log, "ratchet reset", () => {
      const kind = ratchetReset(ctx, sessionId, evidence)
      const topic = ctx.view(sessionId).topic
      return topic ? resetNote(kind, ratchetSettings(ctx, topic).budget) : ""
    }) ?? ""

  return {
    config: async (opencodeConfig) => registerSkills(opencodeConfig),
    tool: {
      research_topic: tool({
        description:
          "Show, set, list or create the session's research topic, or switch on cross-topic searches. The topic scopes Dewey searches, session-notes tags and file writes for this session.",
        args: {
          action: s.enum(["show", "set", "list", "new", "all"]).describe("show | set <slug> | list | new <slug> | all"),
          slug: s.string().optional().describe("Topic slug for set/new"),
        },
        async execute(args, context) {
          try {
            if ((args.action === "set" || args.action === "new") && !args.slug) {
              return `[research-harness] \`${args.action}\` needs a slug.`
            }
            const action =
              args.action === "set" || args.action === "new"
                ? { action: args.action, slug: args.slug! }
                : { action: args.action }
            return runTopicAction(ctx, context.sessionID, action as Parameters<typeof runTopicAction>[2])
          } catch (err) {
            return toolError(err)
          }
        },
      }),

      ledger_upsert_claim: tool({
        description:
          "Create or update a claim in the active topic's epistemic ledger. A `verified` claim needs evidence with a precise locator. Cite claims in findings and syntheses as [claim:<id>].",
        args: {
          id: s.string().describe("Stable slug, e.g. token-cost-per-call"),
          layer: s.string().describe("One of the topic's layers (from its Required synthesis dimensions) or cross-cutting"),
          assertion: s.string().min(10).describe("One falsifiable sentence"),
          mechanism: s.string().min(20).describe("The concrete how/why behind the assertion"),
          failureMode: s.string().optional().describe("Costs, limits, bypass risks or brittleness, if known"),
          status: s.enum(STATUSES),
          confidence: s.enum(CONFIDENCES),
          confidenceBasis: s.string().min(10).describe("What evidence would raise or lower the confidence"),
          category: s.enum(CATEGORIES).optional().describe("Dewey category; default context"),
          evidence: s.array(evidenceSchema),
        },
        async execute(args, context) {
          try {
            const { claim, created } = upsertClaim(ctx, context.sessionID, args)
            return `${created ? "Recorded" : "Updated"} [claim:${claim.id}] as ${claim.status} (${claim.layer}, ${claim.confidence}).${afterLedgerWrite(context.sessionID, args.evidence)}`
          } catch (err) {
            return toolError(err)
          }
        },
      }),

      ledger_challenge_claim: tool({
        description:
          "Record counter-evidence against a claim and downgrade it to hypothesis or refuted. Nothing is deleted; the evidence is appended. Confidence drops too: pass `confidence` and `confidenceBasis`, or by default it goes one step down (a refuted claim to speculative).",
        args: {
          id: s.string(),
          newStatus: s.enum(["hypothesis", "refuted"]),
          counterEvidence: s.object({
            source: s.string().min(1),
            locator: s.string().min(1),
            observation: s.string().min(1),
            reason: s.string().min(1).describe("How this contradicts or narrows the claim"),
          }),
          confidence: s
            .enum(["speculative", "likely", "verified"])
            .optional()
            .describe("New confidence in the assertion. Default: one step down; speculative when refuted. Never verified for a hypothesis."),
          confidenceBasis: s.string().optional().describe("What would change the new confidence. Default: the challenge reason."),
        },
        async execute(args, context) {
          try {
            const claim = challengeClaim(ctx, context.sessionID, args)
            return `[claim:${claim.id}] is now ${claim.status} (${claim.confidence}); counter-evidence appended.${afterLedgerWrite(context.sessionID, [args.counterEvidence])}`
          } catch (err) {
            return toolError(err)
          }
        },
      }),

      ledger_status: tool({
        description:
          "Summarize the active topic's ledger: counts, open hypotheses, layers, required dimensions, and a table of claims with [claim:<id>] tags.",
        args: {},
        async execute(_args, context) {
          try {
            const v = ctx.view(context.sessionID)
            const topic = ctx.requireTopic(context.sessionID)
            return statusMarkdown(ctx, topic, v.crossTopic, context.sessionID)
          } catch (err) {
            return toolError(err)
          }
        },
      }),

      ledger_export: tool({
        description:
          "Export the active topic's verified claims to Dewey learnings (tag = topic slug, with validity/as_of/evidence) and regenerate topics/<slug>/CLAIMS.md. Idempotent.",
        args: {},
        async execute(_args, context) {
          try {
            const topic = ctx.requireTopic(context.sessionID)
            const report = exportTopic(ctx, context.sessionID, topic)
            return exportReportText(topic, report, ctx.config.dewey.learningsDir)
          } catch (err) {
            return toolError(err)
          }
        },
      }),
    },

    event: async ({ event }) => {
      failOpen(log, "event", () => {
        const e = event as { type: string; properties?: { info?: { id?: string; parentID?: string; title?: string } } }
        const info = e.properties?.info
        if (!info?.id) return
        if (e.type === "session.created" || e.type === "session.updated") {
          ctx.sessionRow(info.id, info.parentID ?? null, info.title)
        } else if (e.type === "session.deleted") {
          ctx.db.deleteSession(info.id)
        }
      })
    },

    "command.execute.before": async (input, output) => {
      failOpen(log, "command.execute.before", () => {
        if (input.command !== "topic") return
        if (ctx.view(input.sessionID).ignored) return
        const parsed = parseTopicArgs(input.arguments ?? "")
        const text =
          "error" in parsed
            ? `[research-harness] ${parsed.error} Tell the user.`
            : `[research-harness] /topic handled by the plugin; the state change below is already done.\n${runTopicAction(ctx, input.sessionID, parsed)}`
        const parts = output.parts as { type: string; text?: string }[]
        const first = parts.find((p) => p.type === "text")
        if (first) {
          first.text = text
          output.parts = [first as (typeof output.parts)[number]]
        } else {
          output.parts.push({ type: "text", text } as unknown as (typeof output.parts)[number])
        }
      })
    },

    "tool.execute.before": async (input, output) => {
      failOpen(log, "tool.execute.before", () => {
        const args = (output.args ?? {}) as Record<string, unknown>
        output.args = args
        if (ctx.view(input.sessionID).ignored) return
        const before = snapshotArgs(args)
        scopeToolCall(ctx, input.tool, input.sessionID, args)
        recordInjectedArgs(input.callID, input.sessionID, input.tool, injectedPart(before, args))
        gateBefore(ctx, input.tool, input.callID, args)
        ratchetCheck(ctx, input.tool, input.sessionID, args)
      })
    },

    "tool.execute.after": async (input, output) => {
      failOpen(log, "tool.execute.after", () => {
        const args = input.args as Record<string, unknown> | undefined
        // MCP tools pass their raw result ({ content: [...] }) here, not { output } (see tool-output.ts).
        const out = output as unknown as ToolOutput
        gateAfter(ctx, input.callID, out)
        annotateCrossTopicRead(ctx, input.tool, input.sessionID, args, out)
        if (!ctx.view(input.sessionID).ignored) {
          annotateFilledIn(ctx, input.sessionID, input.callID, out)
          ratchetCount(ctx, input.tool, input.sessionID, args, out)
        }
      })
    },

    "shell.env": async (input, output) => {
      failOpen(log, "shell.env", () => {
        if (!input.sessionID) return
        const v = ctx.view(input.sessionID)
        if (!v.ignored && v.topic) output.env.RESEARCH_TOPIC = v.topic.slug
      })
    },

    "tool.definition": async (input, output) => {
      failOpen(log, "tool.definition", () => {
        recordToolDefinition(ctx, input.toolID, output.parameters)
        const note = rejectionNoteFor(ctx, input.toolID)
        if (note && !output.description.includes(note)) output.description = `${output.description}\n\n${note}`
      })
    },

    "experimental.session.compacting": async (input, output) => {
      failOpen(log, "experimental.session.compacting", () => {
        const block = compactionBlock(ctx, input.sessionID)
        if (block) output.context.push(block)
      })
    },

    // OpenCode 1.19.0 discards system-transform mutations; deliver per turn here (SPEC §3.4).
    "experimental.chat.messages.transform": async (_input, output) => {
      failOpen(log, "experimental.chat.messages.transform", () => {
        const msgs = Array.isArray(output?.messages) ? output.messages : undefined
        if (!msgs?.length) return
        const sessionID = sessionIdOf(msgs as { info?: { sessionID?: unknown } }[])
        if (!sessionID) return
        const header = statusHeader(ctx, sessionID)
        if (!header) return
        msgs.push({
          info: { id: `research-harness-status-${++injectSeq}`, sessionID, role: "user", time: { created: Date.now() } },
          parts: [{ type: "text", text: `${header}\n(plugin context, not user input)` }],
        } as unknown as (typeof msgs)[number])
      })
    },

    dispose: async () => {
      try {
        ctx.db.close()
      } catch {}
    },
  }
}

const server: Plugin = async (input, options) => {
  const log = makeLogger(input.client)
  try {
    const config = loadConfig(input.directory, options)
    if (!existsSync(join(input.directory, config.topicsDir))) return {} // NFR-4: not a research workspace

    const others = registerLoad(input.directory, import.meta.url)
    if (others.length) {
      log.warn(
        `opencode-research-harness is loaded more than once for ${input.directory} (already running from ${others.join(", ")}; skipping ${import.meta.url}). Remove the duplicate plugin entry.`,
      )
      return {}
    }
    const ctx = new HarnessContext(input.directory, config, log)
    const hooks = createHarness(ctx)
    const dispose = hooks.dispose
    hooks.dispose = async () => {
      await dispose?.()
      releaseLoad(input.directory, import.meta.url)
    }
    return hooks
  } catch (err) {
    log.error(`plugin start failed, harness disabled: ${errorText(err)}`)
    return {}
  }
}

export default { id: "research-harness", server } satisfies PluginModule
