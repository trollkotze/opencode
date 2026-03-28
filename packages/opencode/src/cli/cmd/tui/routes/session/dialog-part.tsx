import { createMemo, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useLocal } from "@tui/context/local"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { useRenderer, useKeyboard } from "@opentui/solid"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { Clipboard } from "@tui/util/clipboard"
import { Editor } from "../../util/editor"
import { useTheme } from "../../context/theme"
import type { Part, TextPart, ToolPart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { useRoute } from "@tui/context/route"
import { canContinue } from "../../util/continue"
import type { PromptInfo } from "@tui/component/prompt/history"
import type { DialogContext } from "@tui/ui/dialog"

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
    const message = msg()
    if (!message) return
    return parts().reduce(
      (agg, part) => {
        if (part.type === "text" && !part.synthetic) agg.input += part.text
        if (part.type === "file") agg.parts.push(part)
        return agg
      },
      { input: "", parts: [] as PromptInfo["parts"] },
    )
  }

  function resume(ctx: DialogContext, fork: boolean) {
    const message = msg()
    const model = local.model.current()
    if (!message || message.role !== "assistant") return
    if (!model) {
      toast.show({ message: "No model selected", variant: "warning", duration: 3000 })
      return
    }
    sdk.client.session
      .resume({
        sessionID: props.sessionID,
        messageID: message.id,
        model: { providerID: model.providerID, modelID: model.modelID },
        agent: local.agent.current().name,
        fork,
      })
      .then((res) => {
        if (fork && res.data?.sessionID) {
          route.navigate({
            type: "session",
            sessionID: res.data.sessionID,
          })
        }
      })
      .catch((err: unknown) => {
        toast.show({
          message: err instanceof Error ? err.message : "Failed to continue",
          variant: "error",
        })
      })
    ctx.clear()
  }

  function messageActions(): DialogSelectOption<string>[] {
    const message = msg()
    if (!message) return []

    const actions: DialogSelectOption<string>[] = []

    if (message.role === "assistant" && canContinue(message, parts())) {
      actions.push({
        title: "Continue here",
        value: "session.continue.here",
        description: "remove later messages and continue",
        category: "Message",
        onSelect: (ctx) => resume(ctx, false),
      })
      actions.push({
        title: "Continue in fork",
        value: "session.continue.fork",
        description: "continue from here in a new session",
        category: "Message",
        onSelect: (ctx) => resume(ctx, true),
      })
    }

    if (text()) {
      actions.push({
        title: "Edit text",
        value: "message.edit",
        description: "edit message text",
        category: "Message",
        onSelect: () => {
          const p = text()!
          dialog.replace(() => (
            <DialogEditPart
              text={p.text}
              onSave={async (value) => {
                await patchPart({ ...p, text: value })
                dialog.clear()
              }}
            />
          ))
        },
      })

      if (process.env["VISUAL"] || process.env["EDITOR"]) {
        actions.push({
          title: "Edit in $EDITOR",
          value: "message.editor",
          description: process.env["VISUAL"] || process.env["EDITOR"]!,
          category: "Message",
          onSelect: async () => {
            dialog.clear()
            const p = text()!
            const result = await Editor.open({ value: p.text, renderer })
            if (result !== undefined) {
              await patchPart({ ...p, text: result })
            }
          },
        })
      }
    }

    if (message.role === "assistant" && text()) {
      actions.push({
        title: "Compact message",
        value: "message.compact",
        description: "summarize this whole assistant turn",
        category: "Message",
        onSelect: async (ctx) => {
          const model = picked()
          if (!model) return
          await actMessage({ action: "summarize", model })
          ctx.clear()
        },
      })

      if (compacted()) {
        actions.push({
          title: "Restore message",
          value: "message.restore",
          description: "restore full parts in context",
          category: "Message",
          onSelect: async (ctx) => {
            await actMessage({ action: "restore" })
            ctx.clear()
          },
        })
      }
    }

    actions.push({
      title: "Revert",
      value: "session.revert",
      description: "undo messages and file changes",
      category: "Message",
      onSelect: (ctx) => {
        sdk.client.session.revert({
          sessionID: props.sessionID,
          messageID: props.messageID,
        })
        const value = prompt()
        if (value) route.navigate({ type: "session", sessionID: props.sessionID, initialPrompt: value })
        ctx.clear()
      },
    })

    actions.push({
      title: "Revert messages",
      value: "session.revert.messages",
      description: "keep file changes",
      category: "Message",
      onSelect: (ctx) => {
        sdk.client.session.revert({
          sessionID: props.sessionID,
          messageID: props.messageID,
          skipFiles: true,
        })
        const value = prompt()
        if (value) route.navigate({ type: "session", sessionID: props.sessionID, initialPrompt: value })
        ctx.clear()
      },
    })

    actions.push({
      title: "Copy",
      value: "message.copy",
      description: "message text to clipboard",
      category: "Message",
      onSelect: async (ctx) => {
        const value = parts().reduce((agg, part) => {
          if (part.type === "text" && !part.synthetic) agg += part.text
          return agg
        }, "")
        await Clipboard.copy(value)
        ctx.clear()
      },
    })

    actions.push({
      title: "Fork",
      value: "session.fork",
      description: "create a new session",
      category: "Message",
      onSelect: fork,
    })

    return actions
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
    if (p.type === "text") return [...messageActions(), ...textActions(p)]
    if (p.type === "tool") return [...messageActions(), ...toolActions(p)]
    if (p.type === "reasoning") return [...messageActions(), ...reasoningActions(p)]
    return []
  })

  return <DialogSelect title="Actions" options={options()} />
}

export function DialogEditPart(props: { text: string; onSave: (text: string) => void }) {
  const dialog = useDialog()
  const { theme } = useTheme()
  let textarea: TextareaRenderable

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "s") {
      evt.preventDefault()
      props.onSave(textarea.plainText)
    }
  })

  onMount(() => {
    dialog.setSize("large")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Edit Part
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <textarea
        onSubmit={() => {
          props.onSave(textarea.plainText)
        }}
        height={15}
        ref={(val: TextareaRenderable) => (textarea = val)}
        initialValue={props.text}
        placeholder="Enter text"
        textColor={theme.text}
        focusedTextColor={theme.text}
        cursorColor={theme.text}
      />
      <box paddingBottom={1} gap={1} flexDirection="row">
        <text fg={theme.text}>
          ctrl+s <span style={{ fg: theme.textMuted }}>save</span>
        </text>
        <text fg={theme.text}>
          esc <span style={{ fg: theme.textMuted }}>cancel</span>
        </text>
      </box>
    </box>
  )
}
