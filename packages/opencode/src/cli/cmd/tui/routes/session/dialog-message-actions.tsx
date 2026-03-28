import type { PromptInfo } from "@tui/component/prompt/history"
import type { DialogContext } from "@tui/ui/dialog"
import type { DialogSelectOption } from "@tui/ui/dialog-select"
import { Clipboard } from "@tui/util/clipboard"
import type { AssistantMessage, Part, TextPart } from "@opencode-ai/sdk/v2"
import type { JSX } from "solid-js"
import { canContinue } from "../../util/continue"
import { DialogEditPart } from "./dialog-edit-part"

type Msg = {
  id: string
  role: string
}

type Model = {
  providerID: string
  modelID: string
}

export function messagePrompt(parts: PromptInfo["parts"]) {
  return parts.reduce(
    (agg, part) => {
      if (part.type === "text" && !part.synthetic) agg.input += part.text
      if (part.type === "file") agg.parts.push(part)
      return agg
    },
    { input: "", parts: [] as PromptInfo["parts"] },
  )
}

export function buildMessageActions(input: {
  sessionID: string
  messageID: string
  message?: Msg
  parts: Part[]
  text?: TextPart
  compacted: boolean
  currentModel: () => Model | undefined
  currentAgent: () => string
  patchText: (part: TextPart, text: string) => Promise<void>
  act: (data: Record<string, unknown>) => Promise<void>
  revert: (skipFiles?: boolean) => void
  fork: () => Promise<void>
  navigate: (sessionID: string) => void
  fetchResume: (data: {
    sessionID: string
    messageID: string
    model: Model
    agent: string
    fork?: boolean
  }) => Promise<{ data?: { sessionID?: string } }>
  open: (fn: () => JSX.Element) => void
  clear: () => void
  edit: (value: string) => Promise<string | undefined>
  show: (message: string, variant: "warning" | "error") => void
  category?: string
}) {
  const actions: DialogSelectOption<string>[] = []
  const category = input.category

  function picked() {
    const model = input.currentModel()
    if (model) return model
    input.show("No model selected", "warning")
  }

  function assistant() {
    return input.message?.role === "assistant" ? (input.message as AssistantMessage) : undefined
  }

  function withCategory<T extends DialogSelectOption<string>>(item: T): T {
    if (!category) return item
    return { ...item, category }
  }

  function resume(ctx: DialogContext, fork: boolean) {
    const msg = assistant()
    const model = input.currentModel()
    if (!msg) return
    if (!model) {
      input.show("No model selected", "warning")
      return
    }
    input
      .fetchResume({
        sessionID: input.sessionID,
        messageID: msg.id,
        model,
        agent: input.currentAgent(),
        fork,
      })
      .then((res) => {
        if (fork && res.data?.sessionID) input.navigate(res.data.sessionID)
      })
      .catch((err: unknown) => {
        input.show(err instanceof Error ? err.message : "Failed to continue", "error")
      })
    ctx.clear()
  }

  if (assistant() && canContinue(assistant()!, input.parts)) {
    actions.push(
      withCategory({
        title: "Continue here",
        value: "session.continue.here",
        description: "remove later messages and continue",
        onSelect: (ctx) => resume(ctx, false),
      }),
    )
    actions.push(
      withCategory({
        title: "Continue in fork",
        value: "session.continue.fork",
        description: "continue from here in a new session",
        onSelect: (ctx) => resume(ctx, true),
      }),
    )
  }

  if (input.text) {
    actions.push(
      withCategory({
        title: "Edit text",
        value: "message.edit",
        description: "edit message text",
        onSelect: () => {
          const part = input.text!
          input.open(() => (
            <DialogEditPart
              text={part.text}
              onSave={async (value) => {
                await input.patchText(part, value)
                input.clear()
              }}
            />
          ))
        },
      }),
    )

    if (process.env["VISUAL"] || process.env["EDITOR"]) {
      actions.push(
        withCategory({
          title: "Edit in $EDITOR",
          value: "message.editor",
          description: process.env["VISUAL"] || process.env["EDITOR"]!,
          onSelect: async () => {
            input.clear()
            const value = await input.edit(input.text!.text)
            if (value !== undefined) await input.patchText(input.text!, value)
          },
        }),
      )
    }
  }

  if (assistant() && input.text) {
    actions.push(
      withCategory({
        title: "Compact message",
        value: "message.compact",
        description: "summarize this whole assistant turn",
        onSelect: async (ctx) => {
          const model = picked()
          if (!model) return
          await input.act({ action: "summarize", model })
          ctx.clear()
        },
      }),
    )

    if (input.compacted) {
      actions.push(
        withCategory({
          title: "Restore message",
          value: "message.restore",
          description: "restore full parts in context",
          onSelect: async (ctx) => {
            await input.act({ action: "restore" })
            ctx.clear()
          },
        }),
      )
    }
  }

  actions.push(
    withCategory({
      title: "Revert",
      value: "session.revert",
      description: "undo messages and file changes",
      onSelect: (ctx) => {
        input.revert(false)
        ctx.clear()
      },
    }),
  )
  actions.push(
    withCategory({
      title: "Revert messages",
      value: "session.revert.messages",
      description: "keep file changes",
      onSelect: (ctx) => {
        input.revert(true)
        ctx.clear()
      },
    }),
  )
  actions.push(
    withCategory({
      title: "Copy",
      value: "message.copy",
      description: "message text to clipboard",
      onSelect: async (ctx) => {
        const text = input.parts.reduce((agg, part) => {
          if (part.type === "text" && !part.synthetic) agg += part.text
          return agg
        }, "")
        await Clipboard.copy(text)
        ctx.clear()
      },
    }),
  )
  actions.push(
    withCategory({
      title: "Fork",
      value: "session.fork",
      description: "create a new session",
      onSelect: input.fork,
    }),
  )

  return actions
}
