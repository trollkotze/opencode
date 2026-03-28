import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { useRenderer, useKeyboard } from "@opentui/solid"
import { TextareaRenderable } from "@opentui/core"
import { Editor } from "../../util/editor"
import type { Part, TextPart, ToolPart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { useRoute } from "@tui/context/route"
import type { PromptInfo } from "@tui/component/prompt/history"
import { buildMessageActions, messagePrompt } from "./dialog-message-actions"
import { DialogEditPart } from "./dialog-edit-part"

export function DialogPart(props: {
  sessionID: string
  messageID: string
  partID: string
  role: "user" | "assistant"
}) {
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const dialog = useDialog()
  const renderer = useRenderer()
  const route = useRoute()
  const toast = useToast()

  const part = createMemo(() => {
    const parts = sync.data.part[props.messageID] ?? []
    return parts.find((p) => p.id === props.partID) as Part | undefined
  })
  const msg = createMemo(() => sync.data.message[props.sessionID]?.find((item) => item.id === props.messageID))
  const parts = createMemo(() => sync.data.part[props.messageID] ?? [])
  const text = createMemo(() => parts().find((p) => p.type === "text" && !p.synthetic) as TextPart | undefined)
  const compacted = createMemo(() => {
    return parts().some((part) => {
      if (part.type === "text") return !!part.compacted
      if (part.type === "reasoning") return !!part.compacted
      return part.type === "tool" && part.state.status === "completed" && !!part.state.time.compacted
    })
  })

  async function patchPart(data: Part) {
    await sdk.fetch(`${sdk.url}/session/${props.sessionID}/message/${props.messageID}/part/${props.partID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  }

  async function act(data: Record<string, unknown>) {
    await sdk.fetch(`${sdk.url}/session/${props.sessionID}/message/${props.messageID}/part/${props.partID}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  }

  async function deletePart() {
    await sdk.client.part.delete({
      sessionID: props.sessionID,
      messageID: props.messageID,
      partID: props.partID,
    })
  }

  async function fork() {
    const forked = await sdk.client.session.fork({
      sessionID: props.sessionID,
      messageID: props.messageID,
    })
    route.navigate({
      sessionID: forked.data!.id,
      type: "session",
    })
    dialog.clear()
  }

  function picked() {
    const model = local.model.current()
    if (model) return model
    toast.show({ message: "No model selected", variant: "warning", duration: 3000 })
  }

  async function actMessage(data: Record<string, unknown>) {
    await sdk.fetch(`${sdk.url}/session/${props.sessionID}/message/${props.messageID}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  }

  function prompt() {
    return messagePrompt(parts() as PromptInfo["parts"])
  }

  function textActions(p: TextPart): DialogSelectOption<string>[] {
    const actions: DialogSelectOption<string>[] = []

    actions.push({
      title: "Edit",
      value: "edit",
      description: "edit text in-place",
      onSelect: () => {
        dialog.replace(() => (
          <DialogEditPart
            text={p.text}
            onSave={async (text) => {
              await patchPart({ ...p, text, compacted: undefined } as any)
              dialog.clear()
            }}
          />
        ))
      },
    })

    if (process.env["VISUAL"] || process.env["EDITOR"]) {
      actions.push({
        title: "Edit in $EDITOR",
        value: "editor",
        description: process.env["VISUAL"] || process.env["EDITOR"]!,
        onSelect: async () => {
          dialog.clear()
          const result = await Editor.open({ value: p.text, renderer })
          if (result !== undefined) {
            await patchPart({ ...p, text: result, compacted: undefined } as any)
          }
        },
      })
    }

    if (p.compacted) {
      actions.push({
        title: "Restore full text",
        value: "uncompact",
        description: "restore full text in context",
        onSelect: async (ctx) => {
          await act({ action: "restore" })
          ctx.clear()
        },
      })
    } else {
      actions.push({
        title: "Compact",
        value: "compact",
        description: "replace with concise summary in context",
        onSelect: async (ctx) => {
          const model = picked()
          if (!model) return
          await act({ action: "summarize", model })
          ctx.clear()
        },
      })
      actions.push({
        title: "Compact as placeholder",
        value: "compact.placeholder",
        description: "replace with compacted placeholder",
        onSelect: async (ctx) => {
          await act({ action: "compact" })
          ctx.clear()
        },
      })
    }

    if (p.ignored) {
      actions.push({
        title: "Include in context",
        value: "include",
        description: "restore to LLM context",
        onSelect: async (ctx) => {
          await act({ action: "include" })
          ctx.clear()
        },
      })
    } else {
      actions.push({
        title: "Exclude from context",
        value: "exclude",
        description: "hide from LLM, keep visible",
        onSelect: async (ctx) => {
          await act({ action: "exclude" })
          ctx.clear()
        },
      })
    }

    actions.push({
      title: "Remove",
      value: "remove",
      description: "delete this part entirely",
      onSelect: async (ctx) => {
        await deletePart()
        ctx.clear()
      },
    })

    return actions.map((item) => ({ ...item, category: "Part" }))
  }

  function toolActions(p: ToolPart): DialogSelectOption<string>[] {
    const actions: DialogSelectOption<string>[] = []

    if (p.state.status === "completed") {
      if (p.state.time.compacted) {
        actions.push({
          title: "Restore output",
          value: "uncompact",
          description: "restore tool output in context",
          onSelect: async (ctx) => {
            await act({ action: "restore" })
            ctx.clear()
          },
        })
      } else {
        actions.push({
          title: "Compact",
          value: "compact",
          description: "clear tool output from context",
          onSelect: async (ctx) => {
            await act({ action: "compact" })
            ctx.clear()
          },
        })
      }
    }

    actions.push({
      title: "Remove",
      value: "remove",
      description: "delete this tool call entirely",
      onSelect: async (ctx) => {
        await deletePart()
        ctx.clear()
      },
    })

    return actions.map((item) => ({ ...item, category: "Part" }))
  }

  function reasoningActions(p: ReasoningPart): DialogSelectOption<string>[] {
    const actions: DialogSelectOption<string>[] = []

    if (p.compacted) {
      actions.push({
        title: "Restore reasoning",
        value: "uncompact",
        description: "restore reasoning in context",
        onSelect: async (ctx) => {
          await act({ action: "restore" })
          ctx.clear()
        },
      })
    } else {
      actions.push({
        title: "Compact",
        value: "compact",
        description: "exclude reasoning from context",
        onSelect: async (ctx) => {
          await act({ action: "compact" })
          ctx.clear()
        },
      })
    }

    actions.push({
      title: "Remove",
      value: "remove",
      description: "delete reasoning entirely",
      onSelect: async (ctx) => {
        await deletePart()
        ctx.clear()
      },
    })

    return actions.map((item) => ({ ...item, category: "Part" }))
  }

  const options = createMemo(() => {
    const p = part()
    if (!p) return []
    const message = buildMessageActions({
      sessionID: props.sessionID,
      messageID: props.messageID,
      message: msg(),
      parts: parts(),
      text: text(),
      compacted: compacted(),
      currentModel: () => local.model.current(),
      currentAgent: () => local.agent.current().name,
      patchText: async (part, value) => patchPart({ ...part, text: value }),
      act: actMessage,
      revert: (skipFiles) => {
        sdk.client.session.revert({
          sessionID: props.sessionID,
          messageID: props.messageID,
          ...(skipFiles ? { skipFiles: true } : {}),
        })
        route.navigate({ type: "session", sessionID: props.sessionID, initialPrompt: prompt() })
      },
      fork,
      navigate: (sessionID) => route.navigate({ type: "session", sessionID }),
      fetchResume: (data) => sdk.client.session.resume(data),
      open: (fn) => dialog.replace(fn),
      clear: () => dialog.clear(),
      edit: (value) => Editor.open({ value, renderer }),
      show: (message, variant) => toast.show({ message, variant, duration: 3000 }),
      category: "Message",
    })
    if (p.type === "text") return [...message, ...textActions(p)]
    if (p.type === "tool") return [...message, ...toolActions(p)]
    if (p.type === "reasoning") return [...message, ...reasoningActions(p)]
    return []
  })

  return <DialogSelect title="Actions" options={options()} />
}
