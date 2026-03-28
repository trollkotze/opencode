import { createMemo, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "@tui/component/prompt/history"
import { useTheme } from "@tui/context/theme"
import { forkFromMessage } from "./dialog-message-actions"

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const { theme } = useTheme()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const result = [] as DialogSelectOption<string>[]
    for (const message of messages) {
      const part = (sync.data.part[message.id] ?? []).find(
        (x) => x.type === "text" && !x.synthetic && !x.ignored,
      ) as TextPart
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        description: Locale.titlecase(message.role),
        footer: Locale.time(message.time.created),
        gutter: <text fg={message.role === "user" ? theme.primary : theme.accent}>●</text>,
        onSelect: async (dialog) => {
          await forkFromMessage({
            sessionID: props.sessionID,
            messageID: message.id,
            role: message.role,
            parts: sync.data.part[message.id] as PromptInfo["parts"],
            fork: (data) => sdk.client.session.fork(data),
            navigate: (sessionID, initialPrompt) => route.navigate({ type: "session", sessionID, initialPrompt }),
            clear: () => dialog.clear(),
          })
        },
      })
    }
    result.reverse()
    return result
  })

  return (
    <DialogSelect
      onMove={(option) => props.onMove(option.value)}
      title="Fork from message"
      legend={
        <text fg={theme.textMuted}>
          <span style={{ fg: theme.primary }}>●</span> User
          <span> </span>
          <span style={{ fg: theme.accent }}>●</span> Assistant
        </text>
      }
      options={options()}
    />
  )
}
