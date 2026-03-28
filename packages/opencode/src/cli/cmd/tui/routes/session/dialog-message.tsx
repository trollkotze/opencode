import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useDialog } from "../../ui/dialog"
import { useRenderer } from "@opentui/solid"
import { useToast } from "../../ui/toast"
import type { PromptInfo } from "@tui/component/prompt/history"
import { useLocal } from "@tui/context/local"
import { Editor } from "../../util/editor"
import { buildMessageActions, forkFromMessage, messagePrompt } from "./dialog-message-actions"

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
  const route = useRoute()

  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const parts = createMemo(() => sync.data.part[props.messageID] ?? [])
  const text = createMemo(() => parts().find((part) => part.type === "text" && !part.synthetic))
  const compacted = createMemo(() => {
    return parts().some((part) => {
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

  function prompt() {
    const msg = message()
    if (!msg || !props.setPrompt) return
    props.setPrompt(messagePrompt(sync.data.part[msg.id] as PromptInfo["parts"]))
  }

  const options = createMemo(() =>
    buildMessageActions({
      sessionID: props.sessionID,
      messageID: props.messageID,
      message: message(),
      parts: parts(),
      text: text() as any,
      compacted: compacted(),
      currentModel: () => local.model.current(),
      currentAgent: () => local.agent.current().name,
      patchText: async (part, value) => {
        await sdk.fetch(`${sdk.url}/session/${props.sessionID}/message/${props.messageID}/part/${part.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...part, text: value }),
        })
      },
      act,
      revert: (skipFiles) => {
        const msg = message()
        if (!msg) return
        sdk.client.session.revert({
          sessionID: props.sessionID,
          messageID: msg.id,
          ...(skipFiles ? { skipFiles: true } : {}),
        })
        prompt()
      },
      fork: () =>
        forkFromMessage({
          sessionID: props.sessionID,
          messageID: props.messageID,
          role: message()?.role,
          parts: parts() as PromptInfo["parts"],
          fork: (data) => sdk.client.session.fork(data),
          navigate: (sessionID, initialPrompt) => route.navigate({ type: "session", sessionID, initialPrompt }),
          clear: () => dialog.clear(),
        }),
      navigate: (sessionID) => route.navigate({ type: "session", sessionID }),
      fetchResume: (data) => sdk.client.session.resume(data),
      open: (fn) => dialog.replace(fn),
      clear: () => dialog.clear(),
      edit: (value) => Editor.open({ value, renderer }),
      show: (message, variant) => toast.show({ message, variant, duration: 3000 }),
    }),
  )

  return <DialogSelect title="Message Actions" options={options()} />
}
