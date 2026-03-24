import z from "zod"
import { Tool } from "./tool"
import { AgentCreate } from "@/agent/create"
import { ProviderID, ModelID } from "@/provider/schema"

export const GenerateAgentTool = Tool.define("generate-agent", {
  description:
    "Generate and optionally load a reusable agent from the current session context. Leave description blank to infer it live.",
  parameters: z.object({
    description: z
      .string()
      .optional()
      .describe("What the agent should do. If omitted, infer it from the current session."),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional()
      .describe("Model to use when generating the new agent."),
    mode: z.enum(["all", "primary", "subagent"]).optional().describe("Where the new agent can be used."),
    permission: AgentCreate.Permission.describe(
      'Permission config for the new agent. Defaults to {"*": "deny"} when omitted.',
    ),
    path: z.string().optional().describe("Directory where the generated markdown file should be written."),
    load: z.boolean().optional().describe("Load the generated agent into the current running instance immediately."),
  }),
  async execute(input, ctx) {
    const result = await AgentCreate.create({
      ...input,
      model: input.model
        ? {
            providerID: ProviderID.make(input.model.providerID),
            modelID: ModelID.make(input.model.modelID),
          }
        : undefined,
      agent: ctx.agent,
      sessionID: ctx.sessionID,
      messages: ctx.messages,
    })

    return {
      title: `Generated ${result.info.name}`,
      output: [
        `Created agent \`${result.info.name}\` at \`${result.path}\`.`,
        `Generation request: ${result.description}`,
        result.discoverable
          ? "It was stored in a discoverable path, so it should remain available after restart."
          : result.loaded
            ? "It was loaded into the current running instance, but future startup availability is not guaranteed because the file is outside a discoverable path."
            : "It was stored outside a discoverable path and was not loaded into the current running instance.",
      ].join("\n"),
      metadata: {
        path: result.path,
        name: result.info.name,
        loaded: result.loaded,
        discoverable: result.discoverable,
      },
    }
  },
})
