import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { Instance } from "../project/instance"
import { Provider } from "../provider/provider"
import { MessageV2 } from "./message-v2"
import z from "zod"
import { Token } from "../util/token"
import { Log } from "../util/log"
import { SessionProcessor } from "./processor"
import { fn } from "@/util/fn"
import { Agent } from "@/agent/agent"
import { Plugin } from "@/plugin"
import { Config } from "@/config/config"
import { ProviderTransform } from "@/provider/transform"
import { ModelID, ProviderID } from "@/provider/schema"
import { LLM } from "./llm"

export namespace SessionCompaction {
  const log = Log.create({ service: "session.compaction" })

  export const Event = {
    Compacted: BusEvent.define(
      "session.compacted",
      z.object({
        sessionID: SessionID.zod,
      }),
    ),
  }

  const COMPACTION_BUFFER = 20_000
  const ModelRef = z.object({
    providerID: ProviderID.zod,
    modelID: ModelID.zod,
  })

  export const PartAction = z.discriminatedUnion("action", [
    z.object({ action: z.literal("compact") }),
    z.object({ action: z.literal("restore") }),
    z.object({ action: z.literal("exclude") }),
    z.object({ action: z.literal("include") }),
    z.object({ action: z.literal("summarize"), model: ModelRef }),
  ])

  export const MessageAction = z.discriminatedUnion("action", [
    z.object({ action: z.literal("summarize"), model: ModelRef }),
    z.object({ action: z.literal("restore") }),
  ])

  export async function isOverflow(input: { tokens: MessageV2.Assistant["tokens"]; model: Provider.Model }) {
    const config = await Config.get()
    if (config.compaction?.auto === false) return false
    const context = input.model.limit.context
    if (context === 0) return false

    const count =
      input.tokens.total ||
      input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write

    const reserved =
      config.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
    const usable = input.model.limit.input
      ? input.model.limit.input - reserved
      : context - ProviderTransform.maxOutputTokens(input.model)
    return count >= usable
  }

  export const PRUNE_MINIMUM = 20_000
  export const PRUNE_PROTECT = 40_000

  export const PRUNE_PROTECTED_TOOLS = ["skill"]

  // goes backwards through parts until there are 40_000 tokens worth of tool
  // calls. then erases output of previous tool calls. idea is to throw away old
  // tool calls that are no longer relevant.
  export async function prune(input: { sessionID: SessionID }) {
    const config = await Config.get()
    if (config.compaction?.prune === false) return
    log.info("pruning")
    const msgs = await Session.messages({ sessionID: input.sessionID })
    let total = 0
    let pruned = 0
    const toPrune = []
    let turns = 0

    loop: for (let msgIndex = msgs.length - 1; msgIndex >= 0; msgIndex--) {
      const msg = msgs[msgIndex]
      if (msg.info.role === "user") turns++
      if (turns < 2) continue
      if (msg.info.role === "assistant" && msg.info.summary) break loop
      for (let partIndex = msg.parts.length - 1; partIndex >= 0; partIndex--) {
        const part = msg.parts[partIndex]
        if (part.type === "tool")
          if (part.state.status === "completed") {
            if (PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue

            if (part.state.time.compacted) break loop
            const estimate = Token.estimate(part.state.output)
            total += estimate
            if (total > PRUNE_PROTECT) {
              pruned += estimate
              toPrune.push(part)
            }
          }
      }
    }
    log.info("found", { pruned, total })
    if (pruned > PRUNE_MINIMUM) {
      for (const part of toPrune) {
        if (part.state.status === "completed") {
          part.state.time.compacted = Date.now()
          await Session.updatePart(part)
        }
      }
      log.info("pruned", { count: toPrune.length })
    }
  }

  function fail(message: string): never {
    throw new Error(message)
  }

  function renderPart(part: MessageV2.Part) {
    if (part.type === "text") return [`[text ${part.id}]`, part.text].join("\n")
    if (part.type === "reasoning") return [`[reasoning ${part.id}]`, part.text].join("\n")
    if (part.type === "tool") {
      const input = JSON.stringify(part.state.input ?? {}, null, 2)
      if (part.state.status === "completed") {
        return [`[tool ${part.id}] ${part.tool}`, "[input]", input, "[output]", part.state.output].join("\n")
      }
      if (part.state.status === "error") {
        return [`[tool ${part.id}] ${part.tool}`, "[input]", input, "[error]", part.state.error].join("\n")
      }
      return [`[tool ${part.id}] ${part.tool}`, "[input]", input, `[status] ${part.state.status}`].join("\n")
    }
    return `[${part.type} ${part.id}]`
  }

  function renderMessage(msg: MessageV2.WithParts) {
    return [
      `[message ${msg.info.id}] ${msg.info.role}`,
      ...msg.parts
        .filter((part) => part.type === "text" || part.type === "reasoning" || part.type === "tool")
        .map(renderPart),
    ].join("\n\n")
  }

  async function messages(sessionID: SessionID) {
    const msgs = await Session.messages({ sessionID })
    const user = msgs.findLast((msg) => msg.info.role === "user")?.info as MessageV2.User | undefined
    if (!user) fail("No user message found")
    return { msgs, user: user as MessageV2.User }
  }

  function locate(msgs: MessageV2.WithParts[], messageID: MessageID, partID: PartID) {
    const msg = msgs.find((item) => item.info.id === messageID)
    if (!msg) fail(`Message not found: ${messageID}`)
    const part = msg.parts.find((item) => item.id === partID)
    if (!part) fail(`Part not found: ${partID}`)
    return { msg: msg as MessageV2.WithParts, part: part as MessageV2.Part }
  }

  async function model(input: { user: MessageV2.User; model?: z.infer<typeof ModelRef> }) {
    const agent = await Agent.get("compaction")
    if (agent.model) return { agent, model: await Provider.getModel(agent.model.providerID, agent.model.modelID) }
    const ref = input.model ?? input.user.model
    return { agent, model: await Provider.getModel(ref.providerID, ref.modelID) }
  }

  async function summarize(input: {
    sessionID: SessionID
    msgs: MessageV2.WithParts[]
    user: MessageV2.User
    model: z.infer<typeof ModelRef>
    prompt: string
  }) {
    const ctx = await model(input)
    const msgs = structuredClone(input.msgs)
    await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
    const result = await LLM.generate({
      abort: AbortSignal.timeout(60_000),
      agent: ctx.agent,
      messages: [
        ...MessageV2.toModelMessages(msgs, ctx.model, { stripMedia: true }),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: input.prompt,
            },
          ],
        },
      ],
      model: ctx.model,
      retries: 0,
      sessionID: input.sessionID,
      small: false,
      system: [],
      user: input.user,
    })
    return result.text.trim()
  }

  export const part = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      partID: PartID.zod,
      action: PartAction,
    }),
    async (input) => {
      const ctx = await messages(input.sessionID)
      const target = locate(ctx.msgs, input.messageID, input.partID)
      const now = Date.now()

      if (target.part.type === "text") {
        if (input.action.action === "compact") {
          target.part.ignored = false
          target.part.compacted = { time: now }
          return Session.updatePart(target.part)
        }
        if (input.action.action === "restore") {
          target.part.compacted = undefined
          return Session.updatePart(target.part)
        }
        if (input.action.action === "exclude") {
          target.part.ignored = true
          target.part.compacted = undefined
          return Session.updatePart(target.part)
        }
        if (input.action.action === "include") {
          target.part.ignored = false
          return Session.updatePart(target.part)
        }
        const text = await summarize({
          sessionID: input.sessionID,
          msgs: ctx.msgs,
          user: ctx.user,
          model: input.action.model,
          prompt: [
            "You are compacting one text part in the conversation for future context reuse.",
            "Use the full conversation above as context, but only summarize the target text below.",
            "Return only the replacement text. Keep it concise, but preserve facts, decisions, relevant file paths, concrete outputs, and unfinished work.",
            "Do not mention that this is a summary.",
            "",
            `Target message: ${target.msg.info.id}`,
            `Target role: ${target.msg.info.role}`,
            `Target part: ${target.part.id}`,
            "",
            "<target>",
            target.part.text,
            "</target>",
          ].join("\n"),
        })
        target.part.ignored = false
        target.part.compacted = { time: now, summary: text }
        return Session.updatePart(target.part)
      }

      if (target.part.type === "reasoning") {
        if (input.action.action === "compact") {
          target.part.compacted = { time: now }
          return Session.updatePart(target.part)
        }
        if (input.action.action === "restore") {
          target.part.compacted = undefined
          return Session.updatePart(target.part)
        }
        fail(`Unsupported reasoning action: ${input.action.action}`)
      }

      if (target.part.type === "tool") {
        const state = target.part.state
        if (state.status !== "completed") fail("Only completed tool calls can be compacted")
        const done = state as MessageV2.ToolStateCompleted
        if (input.action.action === "compact") {
          done.time.compacted = now
          return Session.updatePart(target.part)
        }
        if (input.action.action === "restore") {
          done.time.compacted = undefined
          return Session.updatePart(target.part)
        }
        fail(`Unsupported tool action: ${input.action.action}`)
      }

      fail(`Unsupported part type: ${target.part.type}`)
    },
  )

  export const message = fn(
    z.object({
      sessionID: SessionID.zod,
      messageID: MessageID.zod,
      action: MessageAction,
    }),
    async (input) => {
      const ctx = await messages(input.sessionID)
      const target = ctx.msgs.find((item) => item.info.id === input.messageID) as MessageV2.WithParts | undefined
      if (!target) fail(`Message not found: ${input.messageID}`)
      const parts = target.parts.filter(
        (part) => part.type === "text" || part.type === "reasoning" || part.type === "tool",
      )
      const text = parts.filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
      if (text.length === 0) fail("Message has no text parts to summarize")

      if (input.action.action === "restore") {
        for (const part of parts) {
          if (part.type === "text") {
            part.compacted = undefined
            await Session.updatePart(part)
            continue
          }
          if (part.type === "reasoning") {
            part.compacted = undefined
            await Session.updatePart(part)
            continue
          }
          if (part.type === "tool" && part.state.status === "completed") {
            part.state.time.compacted = undefined
            await Session.updatePart(part)
          }
        }
        return true
      }

      const sum = await summarize({
        sessionID: input.sessionID,
        msgs: ctx.msgs,
        user: ctx.user,
        model: input.action.model,
        prompt: [
          "You are compacting one full message in the conversation for future context reuse.",
          "Use the full conversation above as context.",
          "Summarize the target message below so another model can continue the work without needing the full original turn.",
          "Preserve concrete results, important decisions, relevant file paths, useful tool outcomes, and any next steps or open questions.",
          "Return only the replacement text. Do not mention that this is a summary.",
          "",
          `Target message: ${target.info.id}`,
          `Target role: ${target.info.role}`,
          "",
          "<target-message>",
          renderMessage(target),
          "</target-message>",
        ].join("\n"),
      })

      const now = Date.now()
      for (const [idx, part] of text.entries()) {
        part.ignored = false
        part.compacted = idx === 0 ? { time: now, summary: sum } : { time: now, summary: "" }
        await Session.updatePart(part)
      }
      for (const part of parts) {
        if (part.type === "reasoning") {
          part.compacted = { time: now }
          await Session.updatePart(part)
          continue
        }
        if (part.type === "tool" && part.state.status === "completed") {
          part.state.time.compacted = now
          await Session.updatePart(part)
        }
      }
      return true
    },
  )

  export async function process(input: {
    parentID: MessageID
    messages: MessageV2.WithParts[]
    sessionID: SessionID
    abort: AbortSignal
    auto: boolean
    overflow?: boolean
  }) {
    const userMessage = input.messages.findLast((m) => m.info.id === input.parentID)!.info as MessageV2.User

    let messages = input.messages
    let replay: MessageV2.WithParts | undefined
    if (input.overflow) {
      const idx = input.messages.findIndex((m) => m.info.id === input.parentID)
      for (let i = idx - 1; i >= 0; i--) {
        const msg = input.messages[i]
        if (msg.info.role === "user" && !msg.parts.some((p) => p.type === "compaction")) {
          replay = msg
          messages = input.messages.slice(0, i)
          break
        }
      }
      const hasContent =
        replay && messages.some((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction"))
      if (!hasContent) {
        replay = undefined
        messages = input.messages
      }
    }

    const agent = await Agent.get("compaction")
    const model = agent.model
      ? await Provider.getModel(agent.model.providerID, agent.model.modelID)
      : await Provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
    const msg = (await Session.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      parentID: input.parentID,
      sessionID: input.sessionID,
      mode: "compaction",
      agent: "compaction",
      variant: userMessage.variant,
      summary: true,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        output: 0,
        input: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.id,
      providerID: model.providerID,
      time: {
        created: Date.now(),
      },
    })) as MessageV2.Assistant
    const processor = SessionProcessor.create({
      assistantMessage: msg,
      sessionID: input.sessionID,
      model,
      abort: input.abort,
    })
    // Allow plugins to inject context or replace compaction prompt
    const compacting = await Plugin.trigger(
      "experimental.session.compacting",
      { sessionID: input.sessionID },
      { context: [], prompt: undefined },
    )
    const defaultPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---`

    const promptText = compacting.prompt ?? [defaultPrompt, ...compacting.context].join("\n\n")
    const msgs = structuredClone(messages)
    await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
    const result = await processor.process({
      user: userMessage,
      agent,
      abort: input.abort,
      sessionID: input.sessionID,
      tools: {},
      system: [],
      messages: [
        ...MessageV2.toModelMessages(msgs, model, { stripMedia: true }),
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptText,
            },
          ],
        },
      ],
      model,
    })

    if (result === "compact") {
      processor.message.error = new MessageV2.ContextOverflowError({
        message: replay
          ? "Conversation history too large to compact - exceeds model context limit"
          : "Session too large to compact - context exceeds model limit even after stripping media",
      }).toObject()
      processor.message.finish = "error"
      await Session.updateMessage(processor.message)
      return "stop"
    }

    if (result === "continue" && input.auto) {
      if (replay) {
        const original = replay.info as MessageV2.User
        const replayMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: original.agent,
          model: original.model,
          format: original.format,
          tools: original.tools,
          system: original.system,
          variant: original.variant,
        })
        for (const part of replay.parts) {
          if (part.type === "compaction") continue
          const replayPart =
            part.type === "file" && MessageV2.isMedia(part.mime)
              ? { type: "text" as const, text: `[Attached ${part.mime}: ${part.filename ?? "file"}]` }
              : part
          await Session.updatePart({
            ...replayPart,
            id: PartID.ascending(),
            messageID: replayMsg.id,
            sessionID: input.sessionID,
          })
        }
      } else {
        const continueMsg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          agent: userMessage.agent,
          model: userMessage.model,
        })
        const text =
          (input.overflow
            ? "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\n"
            : "") +
          "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed."
        await Session.updatePart({
          id: PartID.ascending(),
          messageID: continueMsg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text,
          time: {
            start: Date.now(),
            end: Date.now(),
          },
        })
      }
    }
    if (processor.message.error) return "stop"
    Bus.publish(Event.Compacted, { sessionID: input.sessionID })
    return "continue"
  }

  export const create = fn(
    z.object({
      sessionID: SessionID.zod,
      agent: z.string(),
      model: z.object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      }),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
    }),
    async (input) => {
      const msg = await Session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        model: input.model,
        sessionID: input.sessionID,
        agent: input.agent,
        time: {
          created: Date.now(),
        },
      })
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: msg.sessionID,
        type: "compaction",
        auto: input.auto,
        overflow: input.overflow,
      })
    },
  )
}
