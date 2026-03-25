import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  generateText,
  streamText,
  wrapLanguageModel,
  type GenerateTextResult,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission"
import { Auth } from "@/auth"

export class InvalidToolCallError extends Error {
  constructor(
    public toolName: string,
    public errorMessage: string,
  ) {
    super(`Invalid tool call: ${toolName} - ${errorMessage}`)
    this.name = "InvalidToolCallError"
  }
}

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    permission?: PermissionNext.Ruleset
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  export type GenerateInput = Omit<StreamInput, "tools" | "toolChoice"> & {
    maxOutputTokens?: number
  }

  export type DebugOptions = {
    redact?: boolean
    toolDefs?: Record<string, { description: string; schema: unknown }>
  }

  export type DebugPayload = {
    model: {
      providerID: string
      id: string
    }
    toolChoice?: StreamInput["toolChoice"]
    temperature?: number
    topP?: number
    topK?: number
    maxOutputTokens?: number
    system: string[]
    messages: ModelMessage[]
    wireMessages: ModelMessage[]
    tools: {
      ids: string[]
      active: string[]
      toolDefs?: DebugOptions["toolDefs"]
    }
    providerOptions: Record<string, any>
    headers: Record<string, string>
    note?: string
  }

  function redact(enabled: boolean, input: unknown): unknown {
    if (!enabled) return input

    const secret = (key: string) => /authorization|api[_-]?key|token|secret|password|cookie|set-cookie/i.test(key)

    const walk = (val: unknown, key?: string): unknown => {
      if (key && secret(key)) {
        if (val === undefined || val === null) return val
        return "[REDACTED]"
      }
      if (Array.isArray(val)) return val.map((v) => walk(v))
      if (!val || typeof val !== "object") return val
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = walk(v, k)
      }
      return out
    }

    return walk(input)
  }

  export async function debug(input: StreamInput, opts: DebugOptions = {}): Promise<DebugPayload> {
    const red = opts.redact ?? true
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const sys: string[] = []
    sys.push(
      [
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        ...input.system,
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = sys[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system: sys },
    )
    if (sys.length > 2 && sys[0] === header) {
      const rest = sys.slice(1)
      sys.length = 0
      sys.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const tools = { ...input.tools }
    const resolved = await resolveTools({ tools, agent: input.agent, permission: input.permission, user: input.user })

    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(resolved).length === 0 && hasToolCalls(input.messages)) {
      resolved["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    const msg = [
      ...sys.map(
        (x): ModelMessage => ({
          role: "system",
          content: x,
        }),
      ),
      ...input.messages,
    ]

    const wire = ProviderTransform.message(msg, input.model, options)

    const out: DebugPayload = {
      model: {
        providerID: input.model.providerID,
        id: input.model.id,
      },
      toolChoice: input.toolChoice,
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      maxOutputTokens,
      system: sys,
      messages: msg,
      wireMessages: wire,
      tools: {
        ids: Object.keys(resolved),
        active: Object.keys(resolved).filter((x) => x !== "invalid"),
        toolDefs: opts.toolDefs
          ? Object.fromEntries(Object.entries(opts.toolDefs).filter(([k]) => resolved[k]))
          : undefined,
      },
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      headers: {
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      } as Record<string, string>,
      note: red ? "Secrets are redacted (headers/options)" : undefined,
    }

    return {
      ...out,
      headers: redact(red, out.headers) as Record<string, string>,
      providerOptions: redact(red, out.providerOptions) as Record<string, any>,
    }
  }

  async function prepare(input: Pick<StreamInput, "user" | "sessionID" | "model" | "agent" | "system" | "small">) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    const system = []
    system.push(
      [
        // use agent prompt otherwise provider prompt
        // For Codex sessions, skip SystemPrompt.provider() since it's sent via options.instructions
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    const requestHeaders = {
      ...(input.model.providerID.startsWith("opencode")
        ? {
            "x-opencode-project": Instance.project.id,
            "x-opencode-session": input.sessionID,
            "x-opencode-request": input.user.id,
            "x-opencode-client": Flag.OPENCODE_CLIENT,
          }
        : input.model.providerID !== "anthropic"
          ? {
              "User-Agent": `opencode/${Installation.VERSION}`,
            }
          : undefined),
      ...input.model.headers,
      ...headers,
    }

    return {
      cfg,
      headers,
      isCodex,
      language,
      l,
      maxOutputTokens,
      options,
      params,
      provider,
      requestHeaders,
      system,
    }
  }

  function wrap(input: {
    language: Awaited<ReturnType<typeof Provider.getLanguage>>
    model: Provider.Model
    options: any
  }) {
    return wrapLanguageModel({
      model: input.language,
      middleware: [
        {
          async transformParams(args) {
            if (args.type === "stream" || args.type === "generate") {
              // @ts-expect-error
              args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, input.options)
            }
            return args.params
          },
        },
      ],
    })
  }

  export async function stream(input: StreamInput) {
    const { cfg, l, language, maxOutputTokens, options, params, provider, requestHeaders, system } =
      await prepare(input)

    const tools = await resolveTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        throw new InvalidToolCallError(failed.toolCall.toolName, failed.error.message)
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),
      tools,
      toolChoice: input.toolChoice,
      maxOutputTokens,
      abortSignal: input.abort,
      headers: requestHeaders,
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrap({ language, model: input.model, options }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  export async function generate(input: GenerateInput): Promise<GenerateTextResult<Record<string, Tool>, never>> {
    const { language, maxOutputTokens, options, params, requestHeaders, system } = await prepare(input)

    return generateText({
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      maxOutputTokens: input.maxOutputTokens ?? maxOutputTokens,
      abortSignal: input.abort,
      headers: requestHeaders,
      maxRetries: input.retries ?? 0,
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],
      model: wrap({ language, model: input.model, options }),
    })
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = PermissionNext.disabled(
      Object.keys(input.tools),
      PermissionNext.merge(input.agent.permission, input.permission ?? []),
    )
    for (const tool of Object.keys(input.tools)) {
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
