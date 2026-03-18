import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { Snapshot } from "../snapshot"
import { MessageV2 } from "./message-v2"
import { Session } from "."
import { Log } from "../util/log"
import { Database, eq } from "../storage/db"
import { MessageTable, PartTable } from "./session.sql"
import { Storage } from "@/storage/storage"
import { Bus } from "../bus"
import { SessionPrompt } from "./prompt"
import { SessionSummary } from "./summary"
import { SessionCompaction } from "./compaction"
import { Token } from "../util/token"

export namespace SessionRevert {
  const log = Log.create({ service: "session.revert" })

  export const RevertInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
    partID: PartID.zod.optional(),
    skipFiles: z.boolean().optional(),
    skipMessages: MessageID.zod.array().optional(),
  })
  export type RevertInput = z.infer<typeof RevertInput>

  export const MessageFileInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
  })
  export type MessageFileInput = z.infer<typeof MessageFileInput>

  export interface Conflict {
    file: string
    /** assistant message whose files are being undone */
    reverted: MessageID
    /** assistant message whose files are being kept — touches the same file */
    kept: MessageID
  }

  interface PatchGroup {
    messageID: MessageID
    patches: Snapshot.Patch[]
    /** step-finish snapshot hashes (state after this message's changes) */
    after: string[]
  }

  /**
   * Collect patches grouped by assistant message, in order, starting from revertPoint.
   */
  function collectPatches(all: MessageV2.WithParts[], point: MessageID): PatchGroup[] {
    const groups: PatchGroup[] = []
    let past = false
    for (const msg of all) {
      if (!past && msg.info.id >= point) past = true
      if (!past) continue
      if (msg.info.role !== "assistant") continue
      const patches: Snapshot.Patch[] = []
      const after: string[] = []
      for (const part of msg.parts) {
        if (part.type === "patch") patches.push(part)
        if (part.type === "step-finish" && part.snapshot) after.push(part.snapshot)
      }
      if (patches.length) groups.push({ messageID: msg.info.id, patches, after })
    }
    return groups
  }

  /**
   * Resolve the "after" tree hash for patch `i` in a group.
   *
   * Priority:
   * 1. group.after[i] — direct step-finish snapshot (most precise)
   * 2. group.patches[i+1].hash — the next patch's before-hash IS this patch's after-state
   * 3. groups[groupIdx+1].patches[0].hash — next group's before-hash
   * 4. base — the snapshot captured at revert time (contains all assistant changes)
   * 5. undefined — no reference available
   */
  function resolveAfterHash(groups: PatchGroup[], idx: number, patch: number, base?: string): string | undefined {
    const group = groups[idx]
    if (group.after[patch]) return group.after[patch]
    if (group.patches[patch + 1]) return group.patches[patch + 1].hash
    if (groups[idx + 1]?.patches[0]) return groups[idx + 1].patches[0].hash
    return base
  }

  /** Detect file conflicts between messages being undone and messages being kept */
  function detect(groups: PatchGroup[], skipped: Set<MessageID>): Conflict[] {
    const result: Conflict[] = []
    const undone = new Map<string, MessageID>()
    for (const group of groups) {
      if (skipped.has(group.messageID)) continue
      for (const patch of group.patches) {
        for (const file of patch.files) {
          if (!undone.has(file)) undone.set(file, group.messageID)
        }
      }
    }
    for (const group of groups) {
      if (!skipped.has(group.messageID)) continue
      for (const patch of group.patches) {
        for (const file of patch.files) {
          const rev = undone.get(file)
          if (rev) result.push({ file, reverted: rev, kept: group.messageID })
        }
      }
    }
    return result
  }

  /** Publish diff events and persist summary — shared by all revert operations */
  async function publish(
    sessionID: SessionID,
    all: MessageV2.WithParts[],
    revert: NonNullable<Session.Info["revert"]>,
  ) {
    const range = all.filter((msg) => msg.info.id >= revert.messageID)
    const diffs = await SessionSummary.computeDiff({ messages: range })
    await Storage.write(["session_diff", sessionID], diffs)
    Bus.publish(Session.Event.Diff, { sessionID, diff: diffs })
    return Session.setRevert({
      sessionID,
      revert,
      summary: {
        additions: diffs.reduce((sum, x) => sum + x.additions, 0),
        deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
        files: diffs.length,
      },
    })
  }

  /**
   * Compute and apply the desired working-tree state for all affected files.
   *
   * For each file touched by any group in scope, walks groups in message order.
   * The LAST group touching a file determines its state:
   * - If that group is **kept** (skipped): file → group's "after" state.
   * - If that group is **undone** (not skipped): file → "origin" state (the tree
   *   before the first group in scope made any changes, i.e. groups[0].patches[0].hash).
   *
   * The "after" hash is resolved via resolveAfterHash which falls back to the next
   * patch/group's before-hash when step-finish snapshots are unavailable.
   *
   * Returns list of files that couldn't be resolved (for warning).
   */
  async function applyDesiredState(
    groups: PatchGroup[],
    skipped: Set<MessageID>,
    base: string | undefined,
  ): Promise<string[]> {
    if (!groups.length) return []

    // The "origin" is the tree state before the first group in scope made changes.
    const origin = groups[0].patches[0]?.hash

    // Collect all affected files and find the last KEPT group's after-hash for each.
    const affected = new Set<string>()
    const kept = new Map<string, { hash: string | undefined }>()

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi]
      for (let pi = 0; pi < group.patches.length; pi++) {
        for (const file of group.patches[pi].files) {
          affected.add(file)
          if (skipped.has(group.messageID)) {
            // Last kept group wins for this file
            kept.set(file, { hash: resolveAfterHash(groups, gi, pi, base) })
          }
        }
      }
    }

    // Build desired state: kept files use their after-hash, others use origin
    const desired = new Map<string, { hash: string | undefined }>()
    for (const file of affected) {
      desired.set(file, kept.get(file) ?? { hash: origin })
    }

    const warnings: string[] = []

    for (const [file, target] of desired) {
      if (target.hash) {
        // checkout handles both file presence and deletion (ls-tree + removeFile)
        await Snapshot.checkout(target.hash, file)
      } else {
        // No hash available at all — warn
        log.warn("applyDesiredState: no snapshot hash available for file", { file })
        warnings.push(file)
      }
    }

    return warnings
  }

  export async function revert(input: RevertInput) {
    SessionPrompt.assertNotBusy(input.sessionID)
    const all = await Session.messages({ sessionID: input.sessionID })
    let lastUser: MessageV2.User | undefined
    const session = await Session.get(input.sessionID)

    let revert: Session.Info["revert"]
    for (const msg of all) {
      if (msg.info.role === "user") lastUser = msg.info
      const remaining = []
      for (const part of msg.parts) {
        if (revert) break
        if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
          const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
          revert = {
            messageID: !partID && lastUser ? lastUser.id : msg.info.id,
            partID,
          }
        }
        remaining.push(part)
      }
      if (revert) break
    }

    if (!revert) return session

    const groups = collectPatches(all, revert.messageID)
    const skipped = new Set(input.skipMessages ?? [])

    if (input.skipFiles) {
      // Messages-only: no file changes, carry forward any existing snapshot
      revert.snapshot = session.revert?.snapshot
      revert.skipped = groups.map((g) => g.messageID)
    } else if (input.skipMessages?.length) {
      // Selective: use layer-based approach to compute desired final state
      revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track())
      await applyDesiredState(groups, skipped, revert.snapshot)
      if (revert.snapshot) revert.diff = await Snapshot.diff(revert.snapshot)
      revert.skipped = input.skipMessages.filter((id) => groups.some((g) => g.messageID === id))
    } else {
      // Full revert: undo all patches
      revert.snapshot = session.revert?.snapshot ?? (await Snapshot.track())
      await Snapshot.revert(groups.flatMap((g) => g.patches))
      if (revert.snapshot) revert.diff = await Snapshot.diff(revert.snapshot)
    }

    return publish(input.sessionID, all, revert)
  }

  /**
   * Undo file changes for a single assistant message that currently has its files kept.
   * Removes it from the skipped list, then recomputes the desired state for all affected
   * files using the layer-based approach to avoid clobbering other kept messages' changes.
   */
  export async function undoFiles(input: MessageFileInput) {
    SessionPrompt.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session
    const skipped = new Set(session.revert.skipped ?? [])
    if (!skipped.has(input.messageID)) return session

    const all = await Session.messages({ sessionID: input.sessionID })
    const groups = collectPatches(all, session.revert.messageID)
    const group = groups.find((g) => g.messageID === input.messageID)
    if (!group) return session

    // Take snapshot if we don't have one yet (first file operation after messages-only revert)
    if (!session.revert.snapshot) {
      session.revert.snapshot = await Snapshot.track()
    }

    // Remove from skipped, then recompute desired state for all affected files
    skipped.delete(input.messageID)
    await applyDesiredState(groups, skipped, session.revert.snapshot)

    const revert = {
      ...session.revert,
      skipped: skipped.size ? [...skipped] : undefined,
      diff: session.revert.snapshot ? await Snapshot.diff(session.revert.snapshot) : undefined,
    }

    return publish(input.sessionID, all, revert)
  }

  /**
   * Re-apply file changes for a single assistant message that currently has its files undone.
   * Adds it to the skipped list, then recomputes the desired state for all affected files
   * using the layer-based approach.
   *
   * Uses step-finish snapshots to check out files at the state after the assistant made changes.
   * When step-finish snapshots aren't available, falls back to reconstructing the after-state
   * from the next patch/group's before-hash via Snapshot.readFile + Filesystem.write.
   * Logs warnings for files that could not be resolved.
   */
  export async function keepFiles(input: MessageFileInput) {
    SessionPrompt.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session
    const skipped = new Set(session.revert.skipped ?? [])
    if (skipped.has(input.messageID)) return session

    const all = await Session.messages({ sessionID: input.sessionID })
    const groups = collectPatches(all, session.revert.messageID)
    const group = groups.find((g) => g.messageID === input.messageID)
    if (!group) return session

    // Add to skipped, then recompute desired state for all affected files
    skipped.add(input.messageID)
    const warnings = await applyDesiredState(groups, skipped, session.revert.snapshot)
    if (warnings.length) {
      log.warn("keepFiles: some files could not be restored", {
        messageID: input.messageID,
        files: warnings,
      })
    }

    const revert = {
      ...session.revert,
      skipped: [...skipped],
      diff: session.revert.snapshot ? await Snapshot.diff(session.revert.snapshot) : undefined,
    }

    return publish(input.sessionID, all, revert)
  }

  /** Check for file conflicts if the given messages were selectively skipped */
  export async function checkConflicts(input: {
    sessionID: SessionID
    messageID: MessageID
    skipMessages: MessageID[]
  }) {
    const all = await Session.messages({ sessionID: input.sessionID })
    const groups = collectPatches(all, input.messageID)
    return detect(groups, new Set(input.skipMessages))
  }

  export async function unrevert(input: { sessionID: SessionID }) {
    log.info("unreverting", input)
    SessionPrompt.assertNotBusy(input.sessionID)
    const session = await Session.get(input.sessionID)
    if (!session.revert) return session
    if (session.revert.snapshot) await Snapshot.restore(session.revert.snapshot)
    return Session.clearRevert(input.sessionID)
  }

  export async function cleanup(session: Session.Info) {
    if (!session.revert) return
    const sessionID = session.id
    const msgs = await Session.messages({ sessionID })
    const messageID = session.revert.messageID
    const preserve = [] as MessageV2.WithParts[]
    const remove = [] as MessageV2.WithParts[]
    let target: MessageV2.WithParts | undefined
    for (const msg of msgs) {
      if (msg.info.id < messageID) {
        preserve.push(msg)
        continue
      }
      if (msg.info.id > messageID) {
        remove.push(msg)
        continue
      }
      if (session.revert.partID) {
        preserve.push(msg)
        target = msg
        continue
      }
      remove.push(msg)
    }
    for (const msg of remove) {
      Database.use((db) => db.delete(MessageTable).where(eq(MessageTable.id, msg.info.id)).run())
      await Bus.publish(MessageV2.Event.Removed, { sessionID: sessionID, messageID: msg.info.id })
    }
    if (session.revert.partID && target) {
      const partID = session.revert.partID
      const removeStart = target.parts.findIndex((part) => part.id === partID)
      if (removeStart >= 0) {
        const preserveParts = target.parts.slice(0, removeStart)
        const removeParts = target.parts.slice(removeStart)
        target.parts = preserveParts
        for (const part of removeParts) {
          Database.use((db) => db.delete(PartTable).where(eq(PartTable.id, part.id)).run())
          await Bus.publish(MessageV2.Event.PartRemoved, {
            sessionID: sessionID,
            messageID: target.info.id,
            partID: part.id,
          })
        }
      }
    }
    // After removing reverted messages, unprune tool outputs that would not
    // have been pruned if prune() ran on the now-shorter conversation.
    // The original output is still in the database — the compacted timestamp
    // is just a flag that suppresses it during serialization.
    const remaining = await Session.messages({ sessionID })
    let total = 0
    let turns = 0
    const unprune = []
    outer: for (let i = remaining.length - 1; i >= 0; i--) {
      const msg = remaining[i]
      if (msg.info.role === "user") turns++
      if (msg.info.role === "assistant" && msg.info.summary) break
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j]
        if (part.type !== "tool") continue
        if (part.state.status !== "completed") continue
        if (SessionCompaction.PRUNE_PROTECTED_TOOLS.includes(part.tool)) continue
        // Parts in the last 2 user turns are unconditionally protected by
        // prune(), so any compacted parts there must always be unpruned.
        if (turns < 2) {
          if (part.state.time.compacted) unprune.push(part)
          continue
        }
        const estimate = Token.estimate(part.state.output)
        total += estimate
        if (total > SessionCompaction.PRUNE_PROTECT) break outer
        if (part.state.time.compacted) unprune.push(part)
      }
    }
    for (const part of unprune) {
      if (part.state.status === "completed") {
        part.state.time.compacted = undefined
        await Session.updatePart(part)
      }
    }
    if (unprune.length) log.info("unpruned", { count: unprune.length })

    await Session.clearRevert(sessionID)
  }
}
