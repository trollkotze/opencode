import { Token } from "@/util/token"
import type { AssistantMessage, Part, Provider, UserMessage } from "@opencode-ai/sdk/v2"

const TEXT_COMPACTED = "[Previous text content compacted]"
const TOOL_COMPACTED = "[Old tool result content cleared]"

type Msg = AssistantMessage | UserMessage

function text(part: Extract<Part, { type: "text" }>) {
  if (part.ignored) return 0
  if (!part.compacted) return Token.estimate(part.text)
  return Token.estimate(part.compacted.summary ?? TEXT_COMPACTED)
}

function tool(part: Extract<Part, { type: "tool" }>) {
  const base = Token.estimate(part.tool) + Token.estimate(JSON.stringify(part.state.input ?? {}))
  if (part.state.status === "completed") {
    return base + Token.estimate(part.state.time.compacted ? TOOL_COMPACTED : part.state.output)
  }
  if (part.state.status === "error") return base + Token.estimate(part.state.error)
  return base + Token.estimate("[Tool execution was interrupted]")
}

export function estimate(messages: Msg[], parts: Record<string, Part[]>) {
  let total = 0
  for (const msg of messages) {
    for (const part of parts[msg.id] ?? []) {
      if (part.type === "text") total += text(part)
      if (part.type === "reasoning" && !part.compacted) total += Token.estimate(part.text)
      if (part.type === "tool") total += tool(part)
      if (part.type === "compaction") total += Token.estimate("What did we do so far?")
      if (part.type === "subtask") total += Token.estimate("The following tool was executed by the user")
      if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
        total += Token.estimate(`[Attached ${part.mime}: ${part.filename ?? "file"}]`)
      }
    }
  }
  return total
}

export function percent(messages: Msg[], providers: Provider[], total: number) {
  const last = messages.findLast((msg) => msg.role === "assistant" && msg.tokens.output > 0) as
    | AssistantMessage
    | undefined
  if (!last) return
  const model = providers.find((item) => item.id === last.providerID)?.models[last.modelID]
  if (!model?.limit.context) return
  return Math.round((total / model.limit.context) * 100)
}
