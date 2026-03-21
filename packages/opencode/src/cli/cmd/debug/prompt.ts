import { EOL } from "os"
import z from "zod"

import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

import { Session } from "../../../session"
import { MessageV2 } from "../../../session/message-v2"
import { MessageID, SessionID } from "../../../session/schema"
import { Provider } from "../../../provider/provider"
import { Agent } from "../../../agent/agent"
import { ToolRegistry } from "../../../tool/registry"
import { ProviderTransform } from "../../../provider/transform"
import { MCP } from "../../../mcp"
import { SystemPrompt } from "../../../session/system"
import { InstructionPrompt } from "../../../session/instruction"
import { LLM } from "../../../session/llm"
import { ModelID } from "../../../provider/schema"
import { tool, jsonSchema } from "ai"

const STRUCTURED_OUTPUT_SYSTEM_PROMPT =
  "IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema."

async function tools(input: {
  model: Awaited<ReturnType<typeof Provider.getModel>>
  agent: Agent.Info
  format?: MessageV2.OutputFormat
}) {
  const list = await ToolRegistry.tools(
    { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
    input.agent,
  )
  const set: Record<string, any> = {}
  const defs: Record<string, { description: string; schema: any }> = {}

  for (const item of list) {
    const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
    defs[item.id] = { description: item.description, schema }
    set[item.id] = tool({
      id: item.id as any,
      description: item.description,
      inputSchema: jsonSchema(schema as any),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  const mcp = await MCP.tools()
  for (const [key, item] of Object.entries(mcp)) {
    set[key] = item
    const meta = (item as any).__opencode
    if (meta && meta.schema) {
      defs[key] = {
        description: typeof item.description === "string" ? item.description : "",
        schema: meta.schema,
      }
    }
  }

  if (input.format?.type === "json_schema") {
    defs.StructuredOutput = {
      description: "Return structured output",
      schema: input.format.schema,
    }
    set.StructuredOutput = tool({
      id: "StructuredOutput" as any,
      description: "Return structured output",
      inputSchema: jsonSchema(input.format.schema as any),
      execute: async () => ({ output: "", title: "", metadata: {} }),
    })
  }

  return { set, defs }
}

export const PromptCommand = cmd({
  command: "prompt <name> [model]",
  describe: "show the final prompt payload (agent or session)",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        demandOption: true,
        description: "Agent name or session id (ses_...)",
      })
      .positional("model", {
        type: "string",
        demandOption: false,
        description: "Optional model override as provider/model",
      })
      .option("redact", {
        type: "boolean",
        default: true,
        describe: "Redact secrets from headers/options",
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const name = args.name as string
      const override = args.model ? Provider.parseModel(args.model as string) : undefined

      if (name.startsWith("ses_")) {
        const id = SessionID.make(name)
        const session = await Session.get(id)
        const msgs = await MessageV2.filterCompacted(MessageV2.stream(id))

        let user: MessageV2.User | undefined
        for (let i = msgs.length - 1; i >= 0; i--) {
          const msg = msgs[i]
          if (msg.info.role !== "user") continue
          user = msg.info as MessageV2.User
          break
        }
        if (!user) throw new Error("No user message found")

        const picked = override ?? user.model
        const model = await Provider.getModel(picked.providerID, picked.modelID)
        const agent = await Agent.get(user.agent)
        if (!agent) throw new Error(`Agent not found: ${user.agent}`)

        const skills = await SystemPrompt.skills(agent)
        const system = [
          ...(await SystemPrompt.environment(model)),
          ...(skills ? [skills] : []),
          ...(await InstructionPrompt.system()),
        ]
        if (user.format?.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)

        const t = await tools({ model, agent, format: user.format })
        const out = await LLM.debug(
          {
            user: override ? { ...user, model: picked } : user,
            sessionID: session.id,
            model,
            agent,
            permission: session.permission,
            system,
            abort: new AbortController().signal,
            messages: MessageV2.toModelMessages(msgs, model),
            tools: t.set,
            toolChoice: user.format?.type === "json_schema" ? "required" : undefined,
          },
          {
            redact: args.redact as boolean,
            toolDefs: t.defs,
          },
        )

        process.stdout.write(JSON.stringify(out, null, 2) + EOL)
        return
      }

      const agent = await Agent.get(name)
      if (!agent) throw new Error(`Agent not found: ${name}`)

      const picked = override ?? agent.model ?? (await Provider.defaultModel())
      const model = await Provider.getModel(picked.providerID, picked.modelID)
      const skills = await SystemPrompt.skills(agent)
      const system = [
        ...(await SystemPrompt.environment(model)),
        ...(skills ? [skills] : []),
        ...(await InstructionPrompt.system()),
      ]

      const t = await tools({ model, agent })
      const sid = SessionID.make("ses_debug_prompt")
      const user: MessageV2.User = {
        id: MessageID.ascending(),
        sessionID: sid,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: {
          providerID: picked.providerID,
          modelID: picked.modelID,
        },
      }

      const out = await LLM.debug(
        {
          user,
          sessionID: sid,
          model,
          agent,
          system,
          abort: new AbortController().signal,
          messages: [],
          tools: t.set,
        },
        {
          redact: args.redact as boolean,
          toolDefs: t.defs,
        },
      )

      process.stdout.write(JSON.stringify(out, null, 2) + EOL)
    })
  },
})
