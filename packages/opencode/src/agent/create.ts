import matter from "gray-matter"
import path from "path"
import z from "zod"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Agent } from "./agent"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import { Global } from "@/global"
import { PermissionNext } from "@/permission"
import { Auth } from "@/auth"

const PROMPT = [
  "Infer a concise reusable agent description from the active session.",
  "Return a short description of what agent should be generated so it is reusable in future sessions.",
  "Focus on the underlying repeatable job, not on one-off details, filenames, or branch names.",
  "Use one sentence, imperative or descriptive, under 140 characters.",
  "Do not mention the current conversation, session, or that the description was inferred.",
].join("\n")

const RULE_ACTION = z.enum(["allow", "ask", "deny"])

export namespace AgentCreate {
  export const Permission = Config.Permission.optional()
  export type Permission = z.infer<typeof Permission>

  export const Input = z.object({
    description: z.string().optional(),
    agent: z.string().optional(),
    sessionID: SessionID.zod.optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    mode: Agent.Info.shape.mode.optional(),
    permission: Permission,
    path: z.string().optional(),
    load: z.boolean().optional(),
  })
  export type Input = z.infer<typeof Input>

  export const Result = z.object({
    info: Agent.Info,
    path: z.string(),
    generated: z.object({
      identifier: z.string(),
      whenToUse: z.string(),
      systemPrompt: z.string(),
    }),
    description: z.string(),
    discoverable: z.boolean(),
    loaded: z.boolean(),
  })
  export type Result = z.infer<typeof Result>

  export async function create(input: Input & { messages?: MessageV2.WithParts[] }) {
    const agent = await resolveAgent(input.agent)
    const model = await resolveModel(input.model, input.messages, agent)
    const description = await resolveDescription(input.description, {
      agent,
      model,
      messages: input.messages,
      sessionID: input.sessionID,
    })
    const permission = input.permission ?? { "*": "deny" }
    const mode = input.mode ?? "all"
    const dir = input.path ?? defaultPath()
    const generated = await Agent.generate({ description, model })
    const info = Agent.Info.parse({
      name: generated.identifier,
      description: generated.whenToUse,
      mode,
      native: false,
      permission: PermissionNext.fromConfig(permission),
      model,
      prompt: generated.systemPrompt,
      options: {},
    })
    const file = path.join(dir, `${generated.identifier}.md`)
    if (await Filesystem.exists(file)) {
      throw new Error(`Agent file already exists: ${file}`)
    }
    await Filesystem.write(
      file,
      serialize({
        description: generated.whenToUse,
        mode,
        permission,
        model,
        prompt: generated.systemPrompt,
      }),
    )
    const discoverable = await isDiscoverable(file)
    const load = input.load ?? true
    if (load) await Agent.register(info)
    return Result.parse({
      info,
      path: file,
      generated,
      description,
      discoverable,
      loaded: load,
    })
  }

  export function defaultPath() {
    if (Instance.project.id === "global") return path.join(Global.Path.config, "agent")
    return path.join(Instance.worktree, ".opencode", "agent")
  }

  export async function isDiscoverable(file: string) {
    const dir = path.dirname(file)
    const roots = await Config.directories()
    return roots.some((root) => {
      return [path.join(root, "agent"), path.join(root, "agents")].some((base) => Filesystem.contains(base, dir))
    })
  }

  async function resolveAgent(name?: string) {
    if (name) {
      const result = await Agent.get(name)
      if (result) return result
    }
    return Agent.get(await Agent.defaultAgent()).then((item) => {
      if (!item) throw new Error("Default agent not found")
      return item
    })
  }

  async function resolveModel(model: Input["model"], messages: MessageV2.WithParts[] | undefined, agent: Agent.Info) {
    if (model) return model
    const msg = messages?.findLast((item) => item.info.role === "user")
    if (msg?.info.role === "user") return msg.info.model
    if (agent.model) return agent.model
    return Provider.defaultModel()
  }

  async function resolveDescription(
    description: string | undefined,
    input: {
      agent: Agent.Info
      model: { providerID: ProviderID; modelID: ModelID }
      messages?: MessageV2.WithParts[]
      sessionID?: SessionID
    },
  ) {
    if (description?.trim()) return description.trim()
    const messages = input.messages ?? (input.sessionID ? await Session.messages({ sessionID: input.sessionID }) : [])
    return inferDescription({
      messages,
      agent: input.agent,
      model: input.model,
    })
  }

  async function inferDescription(input: {
    messages: MessageV2.WithParts[]
    agent: Agent.Info
    model: { providerID: ProviderID; modelID: ModelID }
  }) {
    const model = await Provider.getModel(input.model.providerID, input.model.modelID)
    const language = await Provider.getLanguage(model)
    const transcript = formatMessages(input.messages)
    const params = {
      temperature: 0.2,
      model: language,
      schema: z.object({
        description: z.string(),
      }),
      messages: [
        ...(input.agent.prompt
          ? ([
              {
                role: "system",
                content: input.agent.prompt,
              },
            ] satisfies ModelMessage[])
          : []),
        {
          role: "system",
          content: PROMPT,
        },
        {
          role: "user",
          content: [
            `Current agent: ${input.agent.name}`,
            input.agent.description ? `Current agent description: ${input.agent.description}` : undefined,
            transcript ? `Session transcript:\n${transcript}` : "No prior session transcript is available.",
            "Return only the JSON object.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ] satisfies ModelMessage[],
    } satisfies Parameters<typeof generateObject>[0]

    if (input.model.providerID === "openai" && (await Auth.get(input.model.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      const obj = await result.object
      return obj.description.trim()
    }

    const result = await generateObject(params)
    return result.object.description.trim()
  }

  function formatMessages(messages: MessageV2.WithParts[]) {
    const lines: string[] = []
    let size = 0
    for (const msg of messages.slice(-12)) {
      const prefix = msg.info.role === "user" ? "User" : `Assistant (${msg.info.agent})`
      const content = msg.parts
        .flatMap((part) => {
          if (part.type === "text" && !part.synthetic) return [part.text]
          if (part.type === "file" && part.source?.type === "file") return [`[file: ${part.source.path}]`]
          if (part.type === "tool") return [`[tool: ${part.tool}]`]
          return []
        })
        .join("\n")
        .trim()
      if (!content) continue
      const next = `${prefix}:\n${content.slice(0, 1200)}`
      if (size + next.length > 12000) break
      size += next.length
      lines.push(next)
    }
    return lines.join("\n\n")
  }

  function serialize(input: {
    description: string
    mode: Agent.Info["mode"]
    permission: Permission
    model?: { providerID: ProviderID; modelID: ModelID }
    prompt: string
  }) {
    return matter.stringify(input.prompt, {
      description: input.description,
      mode: input.mode,
      permission: normalizePermission(input.permission),
      ...(input.model ? { model: `${input.model.providerID}/${input.model.modelID}` } : {}),
    })
  }

  function normalizePermission(permission: Permission) {
    if (!permission) return { "*": "deny" }
    if (typeof permission === "string") return permission
    const result: Record<string, string | Record<string, z.infer<typeof RULE_ACTION>>> = {}
    for (const [key, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        result[key] = value
        continue
      }
      result[key] = Object.fromEntries(Object.entries(value))
    }
    return result
  }
}
