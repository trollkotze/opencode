import z from "zod"
import { text } from "node:stream/consumers"
import { Tool } from "./tool"
import { Ripgrep } from "../file/ripgrep"
import { Process } from "../util/process"

import DESCRIPTION from "./ripgrep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"

export const RipgrepTool = Tool.define("ripgrep", {
  description: DESCRIPTION,
  parameters: z.object({
    args: z.array(z.string()).describe("Arguments to pass to ripgrep (e.g. ['-C', '3', '--type', 'ts', 'pattern'])"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
  }),
  async execute(params, ctx) {
    if (!params.args || params.args.length === 0) {
      throw new Error("args are required")
    }

    let searchPath = params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    await ctx.ask({
      permission: "ripgrep",
      patterns: [searchPath],
      always: ["*"],
      metadata: {
        args: params.args,
        path: params.path,
      },
    })

    const rgPath = await Ripgrep.filepath()
    // pass the path directly at the end of args
    const finalArgs = [...params.args, searchPath]

    const proc = Process.spawn([rgPath, ...finalArgs], {
      stdout: "pipe",
      stderr: "pipe",
      abort: ctx.abort,
    })

    if (!proc.stdout || !proc.stderr) {
      throw new Error("Process output not available")
    }

    const output = await text(proc.stdout)
    const errorOutput = await text(proc.stderr)
    const exitCode = await proc.exited

    if (exitCode === 1 || (exitCode === 2 && !output.trim())) {
      return {
        title: "ripgrep",
        metadata: {},
        output: "No matches found",
      }
    }

    if (exitCode !== 0 && exitCode !== 2) {
      throw new Error(`ripgrep failed: ${errorOutput}`)
    }

    return {
      title: "ripgrep",
      metadata: {},
      output: output.trim() || "(Empty output)",
    }
  },
})
