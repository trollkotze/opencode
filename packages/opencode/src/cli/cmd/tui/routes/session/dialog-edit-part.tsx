import { onMount } from "solid-js"
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { useDialog } from "../../ui/dialog"
import { useTheme } from "../../context/theme"

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
