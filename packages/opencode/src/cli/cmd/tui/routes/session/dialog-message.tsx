import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { Clipboard } from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { useLocal } from "@tui/context/local"
import { useToast } from "../../ui/toast"
import { canContinue } from "../../util/continue"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const local = useLocal()
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
          : []),
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
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
          onSelect: (dialog) => {
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
          onSelect: async (dialog) => {
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
          onSelect: async (dialog) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const initialPrompt = (() => {
              const msg = message()
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
