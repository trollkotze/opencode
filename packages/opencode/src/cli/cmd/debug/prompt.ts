import { EOL } from "os"
import z from "zod"

import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

import { Session } from "../../../session"
import { MessageV2 } from "../../../session/message-v2"
import { SessionID } from "../../../session/schema"
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

export const PromptCommand = cmd({
  command: "prompt <session>",
  describe: "show the exact LLM request payload (redacted)",
  builder: (yargs) =>
    yargs
      .positional("session", {
        type: "string",
        demandOption: true,
        description: "Session id",
      })
      .option("redact", {
        type: "boolean",
        default: true,
        describe: "Redact secrets from headers/options",
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const id = SessionID.make(args.session as string)
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

      const model = await Provider.getModel(user.model.providerID, user.model.modelID)
      const agent = await Agent.get(user.agent)
      if (!agent) throw new Error(`Agent not found: ${user.agent}`)

      const skills = await SystemPrompt.skills(agent)
      const system = [
        ...(await SystemPrompt.environment(model)),
        ...(skills ? [skills] : []),
        ...(await InstructionPrompt.system()),
      ]
      if (user.format?.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)

      const list = await ToolRegistry.tools(
        { modelID: ModelID.make(model.api.id), providerID: model.providerID },
        agent,
      )
      const tools: Record<string, any> = {}
      const defs: Record<string, { description: string; schema: any }> = {}
      for (const item of list) {
        const schema = ProviderTransform.schema(model, z.toJSONSchema(item.parameters))
        defs[item.id] = {
          description: item.description,
          schema,
        }
        tools[item.id] = tool({
          id: item.id as any,
          description: item.description,
          inputSchema: jsonSchema(schema as any),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }

      const mcp = await MCP.tools()
      for (const [key, item] of Object.entries(mcp)) {
        tools[key] = item
        const meta = (item as any).__opencode
        if (meta && meta.schema) {
          defs[key] = {
            description: typeof item.description === "string" ? item.description : "",
            schema: meta.schema,
          }
        }
      }

      if (user.format?.type === "json_schema") {
        defs.StructuredOutput = {
          description: "Return structured output",
          schema: user.format.schema,
        }
        tools.StructuredOutput = tool({
          id: "StructuredOutput" as any,
          description: "Return structured output",
          inputSchema: jsonSchema(user.format.schema as any),
          execute: async () => ({ output: "", title: "", metadata: {} }),
        })
      }

      const out = await LLM.debug(
        {
          user,
          sessionID: session.id,
          model,
          agent,
          permission: session.permission,
          system,
          abort: new AbortController().signal,
          messages: MessageV2.toModelMessages(msgs, model),
          tools,
          toolChoice: user.format?.type === "json_schema" ? "required" : undefined,
        },
        {
          redact: args.redact as boolean,
          toolDefs: defs,
        },
      )

      process.stdout.write(JSON.stringify(out, null, 2) + EOL)
    })
  },
})
