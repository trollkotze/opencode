import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { Clipboard } from "@tui/util/clipboard"
import { useDialog } from "../../ui/dialog"
import { DialogEditPart } from "./dialog-part"
import { useRenderer } from "@opentui/solid"
import { Editor } from "../../util/editor"
import { useToast } from "../../ui/toast"
import type { PromptInfo } from "@tui/component/prompt/history"
import { useLocal } from "@tui/context/local"
import { canContinue } from "../../util/continue"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
  const dialog = useDialog()
  const renderer = useRenderer()
  const toast = useToast()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const parts = createMemo(() => sync.data.part[props.messageID] ?? [])
  const assistant = createMemo(() => {
    const msg = message()
    return msg?.role === "assistant" ? msg : undefined
  })

  function resume(dialog: { clear(): void }, fork: boolean) {
    const msg = message()
    const model = local.model.current()
    if (!msg || msg.role !== "assistant") return
    if (!model) {
      toast.show({ message: "No model selected", variant: "warning", duration: 3000 })
      return
    }
    sdk.client.session
      .resume({
        sessionID: props.sessionID,
        messageID: msg.id,
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
    dialog.clear()
  }

  const textPart = createMemo(() => {
    const parts = sync.data.part[props.messageID] ?? []
    return parts.find((p) => p.type === "text" && !p.synthetic)
  })

  const compacted = createMemo(() => {
    const parts = sync.data.part[props.messageID] ?? []
    return parts.some((part) => {
      if (part.type === "text") return !!part.compacted
      if (part.type === "reasoning") return !!part.compacted
      return part.type === "tool" && part.state.status === "completed" && !!part.state.time.compacted
    })
  })

  async function act(data: Record<string, unknown>) {
    await sdk.fetch(`${sdk.url}/session/${props.sessionID}/message/${props.messageID}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  }

  function picked() {
    const model = local.model.current()
    if (model) return model
    toast.show({ message: "No model selected", variant: "warning", duration: 3000 })
  }

  function prompt() {
    const msg = message()
    if (!msg || !props.setPrompt) return
    const parts = sync.data.part[msg.id]
    props.setPrompt(
      parts.reduce(
        (agg, part) => {
          if (part.type === "text") {
            if (!part.synthetic) agg.input += part.text
          }
          if (part.type === "file") agg.parts.push(part)
          return agg
        },
        { input: "", parts: [] as PromptInfo["parts"] },
      ),
    )
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        ...(assistant() && canContinue(assistant()!, parts())
          ? [
              {
                title: "Continue here",
                value: "session.continue.here",
                description: "remove later messages and continue",
                onSelect: (dialog: { clear(): void }) => resume(dialog, false),
              },
              {
                title: "Continue in fork",
                value: "session.continue.fork",
                description: "continue from here in a new session",
                onSelect: (dialog: { clear(): void }) => resume(dialog, true),
              },
            ]
          : []
        ),
        ...(textPart()
          ? [
              {
                title: "Edit text",
                value: "message.edit",
                description: "edit message text",
                onSelect: () => {
                  const tp = textPart()!
                  dialog.replace(() => (
                    <DialogEditPart
                      text={(tp as any).text}
                      onSave={async (text) => {
                        await sdk.fetch(
                          `${sdk.url}/session/${props.sessionID}/message/${props.messageID}/part/${tp.id}`,
                          {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ ...tp, text }),
                          },
                        )
                        dialog.clear()
                      }}
                    />
                  ))
                },
              },
              ...(process.env["VISUAL"] || process.env["EDITOR"]
                ? [
                    {
                      title: "Edit in $EDITOR",
                      value: "message.editor",
                      description: process.env["VISUAL"] || process.env["EDITOR"]!,
                      onSelect: async () => {
                        const tp = textPart()!
                        dialog.clear()
                        const result = await Editor.open({ value: (tp as any).text, renderer })
                        if (result !== undefined) {
                          await sdk.fetch(
                            `${sdk.url}/session/${props.sessionID}/message/${props.messageID}/part/${tp.id}`,
                            {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ ...tp, text: result }),
                            },
                          )
                        }
                      },
                    },
                  ]
                : []),
            ]
          : []),
        ...(message()?.role === "assistant" && textPart()
          ? [
              {
                title: "Compact message",
                value: "message.compact",
                description: "summarize this whole assistant turn",
                onSelect: async () => {
                  const model = picked()
                  if (!model) return
                  await act({ action: "summarize", model })
                  dialog.clear()
                },
              },
              ...(compacted()
                ? [
                    {
                      title: "Restore message",
                      value: "message.restore",
                      description: "restore full parts in context",
                      onSelect: async () => {
                        await act({ action: "restore" })
                        dialog.clear()
                      },
                    },
                  ]
                : []),
            ]
          : []),
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: () => {
            const msg = message()
            if (!msg) return
            sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
            })
            prompt()
            dialog.clear()
          },
        },
        {
          title: "Revert messages",
          value: "session.revert.messages",
          description: "keep file changes",
          onSelect: () => {
            const msg = message()
            if (!msg) return
            sdk.client.session.revert({
              sessionID: props.sessionID,
              messageID: msg.id,
              skipFiles: true,
            })
            prompt()
            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async () => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async () => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const initialPrompt = (() => {
              const msg = message()
              if (msg?.role !== "user") return undefined
              if (!msg) return undefined
              const parts = sync.data.part[msg.id]
              return parts.reduce(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(part)
                  return agg
                },
                { input: "", parts: [] as PromptInfo["parts"] },
              )
            })()
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              initialPrompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
