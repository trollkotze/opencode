import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

const BLOCKED = new Set(["StructuredOutputError", "ContextOverflowError"])

function hasBody(parts: Part[]) {
  return parts.some((part) => part.type === "text" || part.type === "tool" || part.type === "reasoning")
}

export function canResume(msg: AssistantMessage, parts: Part[]) {
  if (!hasBody(parts)) return false
  if (!msg.time.completed) return true
  if (!msg.error) return false
  return !BLOCKED.has(msg.error.name)
}

export function canContinue(msg: AssistantMessage, parts: Part[]) {
  return hasBody(parts)
}
