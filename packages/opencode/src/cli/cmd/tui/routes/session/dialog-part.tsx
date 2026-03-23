import { createMemo, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { useRenderer, useKeyboard } from "@opentui/solid"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { Editor } from "../../util/editor"
import { useTheme } from "../../context/theme"
import type { Part, TextPart, ToolPart, ReasoningPart } from "@opencode-ai/sdk/v2"
import { useRoute } from "@tui/context/route"

export function DialogPart(props: {
  sessionID: string
  messageID: string
  partID: string
  role: "user" | "assistant"
}) {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const renderer = useRenderer()
  const route = useRoute()

  const part = createMemo(() => {
    const parts = sync.data.part[props.messageID] ?? []
    return parts.find((p) => p.id === props.partID) as Part | undefined
  })

  async function patchPart(data: Part) {
    await sdk.fetch(`${sdk.url}/session/${props.sessionID}/message/${props.messageID}/part/${props.partID}`, {
      method: "PATCH",
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

  function withFork(actions: DialogSelectOption<string>[]) {
    if (props.role !== "assistant") return actions
    return [
      ...actions,
      {
        title: "Fork",
        value: "fork",
        description: "create a new session",
        onSelect: fork,
      },
    ]
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
        title: "Uncompact",
        value: "uncompact",
        description: "restore full text in context",
        onSelect: async (ctx) => {
          await patchPart({ ...p, compacted: undefined } as any)
          ctx.clear()
        },
      })
    } else {
      actions.push({
        title: "Compact",
        value: "compact",
        description: "replace with summary in context",
        onSelect: async (ctx) => {
          await patchPart({ ...p, compacted: { time: Date.now() } } as any)
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
          await patchPart({ ...p, ignored: false } as any)
          ctx.clear()
        },
      })
    } else {
      actions.push({
        title: "Exclude from context",
        value: "exclude",
        description: "hide from LLM, keep visible",
        onSelect: async (ctx) => {
          await patchPart({ ...p, ignored: true } as any)
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

    return withFork(actions)
  }

  function toolActions(p: ToolPart): DialogSelectOption<string>[] {
    const actions: DialogSelectOption<string>[] = []

    if (p.state.status === "completed") {
      if ((p.state as any).time?.compacted) {
        actions.push({
          title: "Restore output",
          value: "uncompact",
          description: "restore tool output in context",
          onSelect: async (ctx) => {
            const state = { ...p.state, time: { ...(p.state as any).time, compacted: undefined } }
            await patchPart({ ...p, state } as any)
            ctx.clear()
          },
        })
      } else {
        actions.push({
          title: "Compact output",
          value: "compact",
          description: "clear tool output from context",
          onSelect: async (ctx) => {
            const state = { ...p.state, time: { ...(p.state as any).time, compacted: Date.now() } }
            await patchPart({ ...p, state } as any)
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

    return withFork(actions)
  }

  function reasoningActions(p: ReasoningPart): DialogSelectOption<string>[] {
    const actions: DialogSelectOption<string>[] = []

    if (p.compacted) {
      actions.push({
        title: "Uncompact",
        value: "uncompact",
        description: "restore reasoning in context",
        onSelect: async (ctx) => {
          await patchPart({ ...p, compacted: undefined } as any)
          ctx.clear()
        },
      })
    } else {
      actions.push({
        title: "Compact",
        value: "compact",
        description: "exclude reasoning from context",
        onSelect: async (ctx) => {
          await patchPart({ ...p, compacted: { time: Date.now() } } as any)
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

    return withFork(actions)
  }

  const options = createMemo(() => {
    const p = part()
    if (!p) return []
    if (p.type === "text") return textActions(p)
    if (p.type === "tool") return toolActions(p)
    if (p.type === "reasoning") return reasoningActions(p)
    return []
  })

  return <DialogSelect title="Part Actions" options={options()} />
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
