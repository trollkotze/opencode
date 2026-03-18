import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Filesystem } from "../../src/util/filesystem"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { Session } from "../../src/session"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const fwd = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/")

const MODEL = {
  providerID: ProviderID.make("opencode"),
  modelID: ModelID.make("big-pickle"),
}

function exists(file: string) {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}

async function addUser(sid: SessionID, text: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID: sid,
    agent: "default",
    model: MODEL,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: sid,
    type: "text",
    text,
  })
  return msg
}

/**
 * Add an assistant message with a patch part and a step-finish part.
 * The step-finish stores the snapshot hash after the file was written,
 * which keepFiles needs to re-apply file changes.
 */
async function addAssistant(sid: SessionID, dir: string, parent: MessageID, patch?: Snapshot.Patch) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: sid,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    parentID: parent,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: sid,
    type: "text",
    text: "done",
  })
  if (patch) {
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: sid,
      type: "patch",
      hash: patch.hash,
      files: patch.files,
    })
    // Store step-finish with current snapshot (state after file changes)
    const after = await Snapshot.track()
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: sid,
      type: "step-finish",
      reason: "end_turn",
      snapshot: after,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  }
  return msg
}

describe("session revert file restore", () => {
  test("full revert removes files, unrevert restores them", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id
        const user = await addUser(sid, "make file")

        const file = fwd(tmp.path, "note.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        expect(patch.files).toContain(file)

        await addAssistant(sid, tmp.path, user.id, patch)

        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(file)).toBe(false)

        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(file).text()).toBe("hello")

        await Session.remove(sid)
      },
    })
  })

  test("skipFiles keeps files on disk, no snapshot stored", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id
        const user = await addUser(sid, "make file")

        const file = fwd(tmp.path, "note.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)

        await addAssistant(sid, tmp.path, user.id, patch)

        await SessionRevert.revert({ sessionID: sid, messageID: user.id, skipFiles: true })
        expect(await exists(file)).toBe(true)
        const info = await Session.get(sid)
        expect(info.revert?.snapshot).toBeUndefined()

        // unrevert after messages-only: file untouched
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await exists(file)).toBe(true)

        await Session.remove(sid)
      },
    })
  })

  test("skipFiles then full revert takes fresh snapshot", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user1 = await addUser(sid, "create A")
        const fileA = fwd(tmp.path, "a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aaa")
        const patch1 = await Snapshot.patch(snap1!)
        await addAssistant(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "create B")
        const fileB = fwd(tmp.path, "b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bbb")
        const patch2 = await Snapshot.patch(snap2!)
        await addAssistant(sid, tmp.path, user2.id, patch2)

        // skipFiles first — no snapshot
        await SessionRevert.revert({ sessionID: sid, messageID: user2.id, skipFiles: true })
        expect(await exists(fileA)).toBe(true)
        expect(await exists(fileB)).toBe(true)
        let info = await Session.get(sid)
        expect(info.revert?.snapshot).toBeUndefined()

        // full revert deeper — takes fresh snapshot, undoes both
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(false)
        info = await Session.get(sid)
        expect(info.revert?.snapshot).toBeDefined()

        // unrevert restores both
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(fileA).text()).toBe("aaa")
        expect(await Bun.file(fileB).text()).toBe("bbb")

        await Session.remove(sid)
      },
    })
  })

  test("full revert then skipFiles deeper preserves snapshot", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user1 = await addUser(sid, "create A")
        const fileA = fwd(tmp.path, "a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aaa")
        const patch1 = await Snapshot.patch(snap1!)
        await addAssistant(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "create B")
        const fileB = fwd(tmp.path, "b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bbb")
        const patch2 = await Snapshot.patch(snap2!)
        await addAssistant(sid, tmp.path, user2.id, patch2)

        // full revert at user2 — removes fileB, snapshot saved
        await SessionRevert.revert({ sessionID: sid, messageID: user2.id })
        expect(await exists(fileA)).toBe(true)
        expect(await exists(fileB)).toBe(false)
        let info = await Session.get(sid)
        expect(info.revert?.snapshot).toBeDefined()
        const saved = info.revert!.snapshot

        // skipFiles deeper at user1 — fileA stays, snapshot preserved
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id, skipFiles: true })
        expect(await exists(fileA)).toBe(true)
        info = await Session.get(sid)
        expect(info.revert?.snapshot).toBe(saved)

        // unrevert restores fileB
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await exists(fileA)).toBe(true)
        expect(await Bun.file(fileB).text()).toBe("bbb")

        await Session.remove(sid)
      },
    })
  })

  test("selective revert with skipMessages", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user1 = await addUser(sid, "create A")
        const fileA = fwd(tmp.path, "a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aaa")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "create B")
        const fileB = fwd(tmp.path, "b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bbb")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // revert at user1, but skip bot2 (keep fileB)
        await SessionRevert.revert({
          sessionID: sid,
          messageID: user1.id,
          skipMessages: [bot2.id],
        })

        // fileA undone, fileB kept
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(true)

        const info = await Session.get(sid)
        expect(info.revert?.skipped).toContain(bot2.id)

        // unrevert restores fileA
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(fileA).text()).toBe("aaa")
        expect(await Bun.file(fileB).text()).toBe("bbb")

        await Session.remove(sid)
      },
    })
  })

  test("undoFiles removes files for a single skipped message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user1 = await addUser(sid, "create A")
        const fileA = fwd(tmp.path, "a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aaa")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "create B")
        const fileB = fwd(tmp.path, "b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bbb")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // skipFiles revert — both files kept, both messages skipped
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id, skipFiles: true })
        expect(await exists(fileA)).toBe(true)
        expect(await exists(fileB)).toBe(true)
        let info = await Session.get(sid)
        expect(info.revert?.skipped).toContain(bot1.id)
        expect(info.revert?.skipped).toContain(bot2.id)

        // undoFiles for bot1 — removes fileA, takes snapshot
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot1.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(true)
        info = await Session.get(sid)
        expect(info.revert?.skipped).not.toContain(bot1.id)
        expect(info.revert?.skipped).toContain(bot2.id)
        expect(info.revert?.snapshot).toBeDefined()

        // unrevert restores fileA
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(fileA).text()).toBe("aaa")
        expect(await Bun.file(fileB).text()).toBe("bbb")

        await Session.remove(sid)
      },
    })
  })

  test("keepFiles re-applies files for a single undone message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user1 = await addUser(sid, "create A")
        const fileA = fwd(tmp.path, "a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aaa")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "create B")
        const fileB = fwd(tmp.path, "b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bbb")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // full revert — both files removed
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(false)

        // keepFiles for bot2 — re-applies fileB
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot2.id })
        expect(await exists(fileA)).toBe(false)
        expect(await Bun.file(fileB).text()).toBe("bbb")
        const info = await Session.get(sid)
        expect(info.revert?.skipped).toContain(bot2.id)

        // unrevert restores fileA too
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(fileA).text()).toBe("aaa")
        expect(await Bun.file(fileB).text()).toBe("bbb")

        await Session.remove(sid)
      },
    })
  })

  test("alternating undoFiles and keepFiles toggles", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "toggle.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "content")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // full revert — file removed
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(file)).toBe(false)

        // keepFiles — file back
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })
        expect(await Bun.file(file).text()).toBe("content")

        // undoFiles — file removed again
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot.id })
        expect(await exists(file)).toBe(false)

        // keepFiles again — file back again
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })
        expect(await Bun.file(file).text()).toBe("content")

        // unrevert restores everything
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(file).text()).toBe("content")

        await Session.remove(sid)
      },
    })
  })

  test("checkConflicts detects overlapping files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        // Both assistants touch the same file
        const user1 = await addUser(sid, "create file")
        const file = fwd(tmp.path, "shared.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "v1")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "modify file")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(file, "v2")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // Check conflicts: revert bot1 but keep bot2
        const result = await SessionRevert.checkConflicts({
          sessionID: sid,
          messageID: user1.id,
          skipMessages: [bot2.id],
        })

        expect(result.length).toBeGreaterThan(0)
        expect(result[0].file).toContain("shared.txt")
        expect(result[0].reverted).toBe(bot1.id)
        expect(result[0].kept).toBe(bot2.id)

        // No conflicts when both are reverted
        const clean = await SessionRevert.checkConflicts({
          sessionID: sid,
          messageID: user1.id,
          skipMessages: [],
        })
        expect(clean.length).toBe(0)

        await Session.remove(sid)
      },
    })
  })

  test("undoFiles on non-skipped message is a no-op", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "note.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // full revert — file already undone
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(file)).toBe(false)

        // undoFiles on already-undone message — no-op
        const before = await Session.get(sid)
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot.id })
        const after = await Session.get(sid)
        expect(after.revert?.skipped).toEqual(before.revert?.skipped)

        await Session.remove(sid)
      },
    })
  })

  test("keepFiles on already-skipped message is a no-op", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "note.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // skipFiles revert — file kept
        await SessionRevert.revert({ sessionID: sid, messageID: user.id, skipFiles: true })
        expect(await exists(file)).toBe(true)

        // keepFiles on already-kept message — no-op
        const before = await Session.get(sid)
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })
        const after = await Session.get(sid)
        expect(after.revert?.skipped).toEqual(before.revert?.skipped)

        await Session.remove(sid)
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Helper: assistant WITHOUT step-finish snapshot (simulates legacy/incomplete data)
// ---------------------------------------------------------------------------
async function addAssistantNoStepFinish(sid: SessionID, dir: string, parent: MessageID, patch?: Snapshot.Patch) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: sid,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    parentID: parent,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: sid,
    type: "text",
    text: "done",
  })
  if (patch) {
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: sid,
      type: "patch",
      hash: patch.hash,
      files: patch.files,
    })
    // NO step-finish part — simulates old data or interrupted sessions
  }
  return msg
}

/**
 * Add an assistant message with TWO separate patch parts and TWO step-finish parts.
 * Simulates an assistant that made file changes in two separate tool-call steps.
 */
async function addAssistantMultiStep(sid: SessionID, dir: string, parent: MessageID, patches: Snapshot.Patch[]) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: sid,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    parentID: parent,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: sid,
    type: "text",
    text: "done",
  })
  for (const patch of patches) {
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: sid,
      type: "patch",
      hash: patch.hash,
      files: patch.files,
    })
    const after = await Snapshot.track()
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: sid,
      type: "step-finish",
      reason: "end_turn",
      snapshot: after,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
  }
  return msg
}

/**
 * Add an assistant message with TWO patch parts but only ONE step-finish (for the first patch).
 * Simulates partial data where the second step never got its snapshot recorded.
 */
async function addAssistantPartialStepFinish(
  sid: SessionID,
  dir: string,
  parent: MessageID,
  patches: Snapshot.Patch[],
) {
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: sid,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    parentID: parent,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: sid,
    type: "text",
    text: "done",
  })
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i]
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: sid,
      type: "patch",
      hash: patch.hash,
      files: patch.files,
    })
    // Only add step-finish for the first patch
    if (i === 0) {
      const after = await Snapshot.track()
      await Session.updatePart({
        id: PartID.ascending(),
        messageID: msg.id,
        sessionID: sid,
        type: "step-finish",
        reason: "end_turn",
        snapshot: after,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
    }
  }
  return msg
}

// ===========================================================================
// 1. keepFiles WITHOUT step-finish snapshots
// ===========================================================================
describe("keepFiles without step-finish snapshots", () => {
  test("keepFiles does nothing when no step-finish snapshots exist", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "note.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistantNoStepFinish(sid, tmp.path, user.id, patch)

        // full revert — file removed
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(file)).toBe(false)

        // keepFiles — no step-finish hashes exist, so the file should NOT be restored.
        // The implementation skips patches when `!hash`, so the file stays missing.
        // The message IS still marked as "skipped" in state — which is incorrect:
        // it claims "kept" but the file is not actually on disk.
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })

        // BUG: The file should be restored if we're marking it as "kept",
        // OR the operation should fail/no-op if it can't restore.
        // Currently it marks the message as skipped but doesn't restore the file.
        const info = await Session.get(sid)
        if (info.revert?.skipped?.includes(bot.id)) {
          // If the implementation marks it as kept, the file MUST exist
          expect(await exists(file)).toBe(true)
          expect(await Bun.file(file).text()).toBe("hello")
        } else {
          // If it correctly refuses, the file stays gone and skipped is unchanged
          expect(await exists(file)).toBe(false)
        }

        await Session.remove(sid)
      },
    })
  })

  test("keepFiles with no step-finish: state and filesystem are consistent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        // Two assistants, neither has step-finish
        const user1 = await addUser(sid, "create A")
        const fileA = fwd(tmp.path, "a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aaa")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistantNoStepFinish(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "create B")
        const fileB = fwd(tmp.path, "b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bbb")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistantNoStepFinish(sid, tmp.path, user2.id, patch2)

        // full revert — both files removed
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(false)

        // try keepFiles for bot1
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot1.id })

        // Consistency check: if skipped says "kept", file must exist on disk
        const info = await Session.get(sid)
        const skipped = info.revert?.skipped ?? []
        if (skipped.includes(bot1.id)) {
          expect(await exists(fileA)).toBe(true)
        } else {
          expect(await exists(fileA)).toBe(false)
        }

        // unrevert must restore everything regardless
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(fileA).text()).toBe("aaa")
        expect(await Bun.file(fileB).text()).toBe("bbb")

        await Session.remove(sid)
      },
    })
  })
})

// ===========================================================================
// 2. File deletions and absent-in-snapshot cases for keepFiles
// ===========================================================================
describe("keepFiles with file deletions and absent paths", () => {
  test("keepFiles restores a file that was deleted by the assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        // Pre-create a file and commit it so it exists in git
        const file = fwd(tmp.path, "existing.txt")
        await Filesystem.write(file, "original")
        const snap0 = await Snapshot.track()
        expect(snap0).toBeTruthy()

        const user = await addUser(sid, "delete the file")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()

        // The assistant "deletes" the file
        await fs.unlink(file)
        expect(await exists(file)).toBe(false)

        const patch = await Snapshot.patch(snap!)
        // The patch should record the file as changed (deleted)
        expect(patch.files).toContain(file)

        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // Full revert — should restore the file (since it existed before the assistant deleted it)
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(file)).toBe(true)
        expect(await Bun.file(file).text()).toBe("original")

        // keepFiles for bot — should re-apply the deletion
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })

        // The file should be gone again (the assistant's action was to delete it)
        // checkout uses step-finish snapshot where the file was deleted,
        // but SnapshotService.checkout is just `git checkout hash -- file` which
        // will fail if the file doesn't exist in that tree — it won't delete the file.
        const info = await Session.get(sid)
        if (info.revert?.skipped?.includes(bot.id)) {
          // If marked as kept, the deletion should have been re-applied
          expect(await exists(file)).toBe(false)
        }

        await Session.remove(sid)
      },
    })
  })

  test("undoFiles correctly restores a file that was created and later deleted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        // Assistant creates file in step 1
        const user1 = await addUser(sid, "create file")
        const file = fwd(tmp.path, "ephemeral.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "created")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        // Assistant deletes same file in step 2
        const user2 = await addUser(sid, "delete the file")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await fs.unlink(file)
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        expect(await exists(file)).toBe(false)

        // skipFiles revert — both kept, file stays deleted
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id, skipFiles: true })
        expect(await exists(file)).toBe(false)

        // undoFiles for bot2 — should restore the file to the state before bot2 (i.e. "created")
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot2.id })
        expect(await exists(file)).toBe(true)
        expect(await Bun.file(file).text()).toBe("created")

        await Session.remove(sid)
      },
    })
  })

  test("keepFiles handles file modification (not just creation)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        // Create initial file and snapshot it
        const file = fwd(tmp.path, "config.txt")
        await Filesystem.write(file, "v1")
        const snap0 = await Snapshot.track()
        expect(snap0).toBeTruthy()

        // Assistant modifies the file
        const user = await addUser(sid, "update config")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "v2-modified")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // Full revert — file goes back to v1
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await Bun.file(file).text()).toBe("v1")

        // keepFiles — re-apply modification
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })
        expect(await Bun.file(file).text()).toBe("v2-modified")

        // undoFiles — back to v1
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot.id })
        expect(await Bun.file(file).text()).toBe("v1")

        // unrevert — back to v2
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(file).text()).toBe("v2-modified")

        await Session.remove(sid)
      },
    })
  })
})

// ===========================================================================
// 3. Multi-step assistant messages (multiple patches + step-finishes)
// ===========================================================================
describe("multi-step assistant messages", () => {
  test("keepFiles restores all files from a multi-step assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create two files")

        // Step 1: create file A
        const fileA = fwd(tmp.path, "step1.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "step1-content")
        const patch1 = await Snapshot.patch(snap1!)

        // Step 2: create file B
        const fileB = fwd(tmp.path, "step2.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "step2-content")
        const patch2 = await Snapshot.patch(snap2!)

        // Single assistant with two patches
        const bot = await addAssistantMultiStep(sid, tmp.path, user.id, [patch1, patch2])

        // Full revert — both files removed
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(false)

        // keepFiles — should restore BOTH files
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })
        expect(await exists(fileA)).toBe(true)
        expect(await Bun.file(fileA).text()).toBe("step1-content")
        expect(await exists(fileB)).toBe(true)
        expect(await Bun.file(fileB).text()).toBe("step2-content")

        // undoFiles — both removed again
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(false)

        await Session.remove(sid)
      },
    })
  })

  test("keepFiles with partial step-finish: only restores files with available snapshots", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create two files")

        // Step 1: create file A
        const fileA = fwd(tmp.path, "partial1.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "p1")
        const patch1 = await Snapshot.patch(snap1!)

        // Step 2: create file B
        const fileB = fwd(tmp.path, "partial2.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "p2")
        const patch2 = await Snapshot.patch(snap2!)

        // Assistant with step-finish only for patch1, not patch2
        const bot = await addAssistantPartialStepFinish(sid, tmp.path, user.id, [patch1, patch2])

        // Full revert — both files removed
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(false)

        // keepFiles — patch1 has a step-finish so fileA can be restored,
        // patch2 has no step-finish so fileB cannot be restored.
        // The message is marked "kept" but fileB is missing.
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })

        const info = await Session.get(sid)
        if (info.revert?.skipped?.includes(bot.id)) {
          // Marked as "kept" — fileA should exist
          expect(await exists(fileA)).toBe(true)
          expect(await Bun.file(fileA).text()).toBe("p1")
          // BUG: fileB is NOT restored because after[1] is undefined,
          // but the message is still marked as "kept", which is misleading.
          // Either BOTH files should be restored, or the operation should fail.
          expect(await exists(fileB)).toBe(true)
          expect(await Bun.file(fileB).text()).toBe("p2")
        }

        await Session.remove(sid)
      },
    })
  })

  test("undoFiles reverts all patches from a multi-step assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create two files")

        const fileA = fwd(tmp.path, "multi-a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aa")
        const patch1 = await Snapshot.patch(snap1!)

        const fileB = fwd(tmp.path, "multi-b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bb")
        const patch2 = await Snapshot.patch(snap2!)

        const bot = await addAssistantMultiStep(sid, tmp.path, user.id, [patch1, patch2])

        // skipFiles revert — both files kept
        await SessionRevert.revert({ sessionID: sid, messageID: user.id, skipFiles: true })
        expect(await exists(fileA)).toBe(true)
        expect(await exists(fileB)).toBe(true)

        // undoFiles should revert ALL patches for this assistant (both steps)
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(false)

        await Session.remove(sid)
      },
    })
  })

  test("multi-step: step-finish snapshot alignment with patches", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "modify files in sequence")

        // Step 1: create file, write v1
        const file = fwd(tmp.path, "evolving.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "v1")
        const patch1 = await Snapshot.patch(snap1!)

        // Step 2: modify same file to v2
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(file, "v2")
        const patch2 = await Snapshot.patch(snap2!)

        const bot = await addAssistantMultiStep(sid, tmp.path, user.id, [patch1, patch2])

        // Full revert
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(file)).toBe(false)

        // keepFiles should restore to the FINAL state (v2), not an intermediate state
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot.id })
        expect(await exists(file)).toBe(true)
        // The last step-finish snapshot should have v2
        expect(await Bun.file(file).text()).toBe("v2")

        await Session.remove(sid)
      },
    })
  })
})

// ===========================================================================
// 4. Overlapping-file selective behavior (conflict-ignored clobber)
// ===========================================================================
describe("overlapping files: selective revert with conflicts", () => {
  test("selective revert with overlapping files: kept message overwrites reverted state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const file = fwd(tmp.path, "shared.txt")

        // bot1 creates the file with "v1"
        const user1 = await addUser(sid, "create file")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "v1")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        // bot2 modifies the same file to "v2"
        const user2 = await addUser(sid, "modify file")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(file, "v2")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // Selective revert: undo bot1 (reverts file to pre-v1), keep bot2
        // This is a conflict: bot1's revert removes the file entirely (didn't exist before),
        // but bot2 wants it kept at "v2".
        await SessionRevert.revert({
          sessionID: sid,
          messageID: user1.id,
          skipMessages: [bot2.id],
        })

        // After selective revert with conflicting files, the file state is ambiguous.
        // The revert first undoes bot1's patches (non-skipped), which removes the file.
        // Then bot2's patches are skipped (not reverted), meaning they aren't re-applied.
        // So the file ends up GONE even though bot2 was marked as "kept".
        const info = await Session.get(sid)
        expect(info.revert?.skipped).toContain(bot2.id)

        // The kept message claims bot2's files are kept, but on disk the file is gone
        // because Snapshot.revert for bot1 checked out the pre-bot1 state of the file.
        // This is the clobber bug: "kept" doesn't mean the files are actually present.
        if (await exists(file)) {
          // If the implementation properly handles conflicts, the file should have bot2's content
          expect(await Bun.file(file).text()).toBe("v2")
        } else {
          // BUG: File was clobbered by reverting bot1, even though bot2 is "kept"
          // The implementation should either prevent this or re-apply bot2's changes
          expect(await exists(file)).toBe(true) // This assertion will FAIL, exposing the bug
        }

        await Session.remove(sid)
      },
    })
  })

  test("undoFiles on conflicting file clobbers kept message's changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const file = fwd(tmp.path, "conflict.txt")

        // bot1 creates file
        const user1 = await addUser(sid, "create file")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "v1")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        // bot2 modifies same file
        const user2 = await addUser(sid, "modify file")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(file, "v2")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // skipFiles revert — both files kept
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id, skipFiles: true })
        expect(await Bun.file(file).text()).toBe("v2")

        // undoFiles for bot1 — reverts to pre-bot1 state (file didn't exist)
        // This clobbers bot2's changes even though bot2 is still "kept"
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot1.id })

        const info = await Session.get(sid)
        expect(info.revert?.skipped).toContain(bot2.id) // bot2 is still "kept"

        // BUG: bot2 is marked as kept but the file is gone because
        // undoFiles for bot1 reverted the file to its pre-bot1 state (absent).
        // The file should still contain "v2" if bot2 is marked as "kept".
        expect(await exists(file)).toBe(true)
        if (await exists(file)) {
          expect(await Bun.file(file).text()).toBe("v2")
        }

        await Session.remove(sid)
      },
    })
  })

  test("keepFiles on conflicting file overrides previously undone message's revert", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const file = fwd(tmp.path, "conflict.txt")

        // bot1 creates file with "v1"
        const user1 = await addUser(sid, "create file")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "v1")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        // bot2 modifies same file to "v2"
        const user2 = await addUser(sid, "modify file")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(file, "v2")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // Full revert — file gone
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id })
        expect(await exists(file)).toBe(false)

        // keepFiles for bot1 — restores to "v1"
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot1.id })
        expect(await Bun.file(file).text()).toBe("v1")

        // keepFiles for bot2 — should restore to "v2" (bot2's after-state)
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot2.id })
        expect(await Bun.file(file).text()).toBe("v2")

        // Now undo bot1 — bot1 created the file, so reverting should go to "no file".
        // But bot2 is still kept and has the file at "v2". The file should remain as "v2".
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot1.id })
        // BUG: undoFiles will revert bot1's patch, checking out pre-bot1 state where file
        // didn't exist, clobbering bot2's kept "v2".
        expect(await exists(file)).toBe(true)
        expect(await Bun.file(file).text()).toBe("v2")

        await Session.remove(sid)
      },
    })
  })

  test("three assistants touching same file: selective keep/undo ordering", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const file = fwd(tmp.path, "triple.txt")

        // bot1: create file with "v1"
        const user1 = await addUser(sid, "step 1")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "v1")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        // bot2: modify to "v2"
        const user2 = await addUser(sid, "step 2")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(file, "v2")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // bot3: modify to "v3"
        const user3 = await addUser(sid, "step 3")
        const snap3 = await Snapshot.track()
        expect(snap3).toBeTruthy()
        await Filesystem.write(file, "v3")
        const patch3 = await Snapshot.patch(snap3!)
        const bot3 = await addAssistant(sid, tmp.path, user3.id, patch3)

        // Full revert — file gone
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id })
        expect(await exists(file)).toBe(false)

        // Keep only bot2 — file should be "v2"
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot2.id })
        expect(await Bun.file(file).text()).toBe("v2")

        // Also keep bot3 — file should be "v3" (last kept version wins)
        await SessionRevert.keepFiles({ sessionID: sid, messageID: bot3.id })
        expect(await Bun.file(file).text()).toBe("v3")

        // Undo bot2 — bot3 is still kept at "v3", so file should stay "v3"
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot2.id })
        expect(await exists(file)).toBe(true)
        expect(await Bun.file(file).text()).toBe("v3")

        // Undo bot3 — nothing kept, file should be gone
        await SessionRevert.undoFiles({ sessionID: sid, messageID: bot3.id })
        expect(await exists(file)).toBe(false)

        await Session.remove(sid)
      },
    })
  })

  test("checkConflicts: multiple files, only some overlap", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const shared = fwd(tmp.path, "shared.txt")
        const only1 = fwd(tmp.path, "only1.txt")
        const only2 = fwd(tmp.path, "only2.txt")

        // bot1 touches shared.txt and only1.txt
        const user1 = await addUser(sid, "step 1")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(shared, "s1")
        await Filesystem.write(only1, "o1")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        // bot2 touches shared.txt and only2.txt
        const user2 = await addUser(sid, "step 2")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(shared, "s2")
        await Filesystem.write(only2, "o2")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // Check conflicts: keep bot2
        const result = await SessionRevert.checkConflicts({
          sessionID: sid,
          messageID: user1.id,
          skipMessages: [bot2.id],
        })

        // Should flag shared.txt but NOT only1.txt or only2.txt
        const files = result.map((c) => c.file)
        expect(files.some((f) => f.includes("shared.txt"))).toBe(true)
        expect(files.some((f) => f.includes("only1.txt"))).toBe(false)
        expect(files.some((f) => f.includes("only2.txt"))).toBe(false)

        // Conflicts should be exactly 1 (shared.txt)
        expect(result.length).toBe(1)

        await Session.remove(sid)
      },
    })
  })

  test("checkConflicts: keeping all messages reports zero conflicts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const file = fwd(tmp.path, "shared.txt")

        const user1 = await addUser(sid, "step 1")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "v1")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "step 2")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(file, "v2")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        // Skip both (keep all) — no conflicts since nothing is being undone
        const result = await SessionRevert.checkConflicts({
          sessionID: sid,
          messageID: user1.id,
          skipMessages: [bot1.id, bot2.id],
        })
        expect(result.length).toBe(0)

        await Session.remove(sid)
      },
    })
  })
})

// ===========================================================================
// 5. API/TUI integration: route-level tests for new endpoints
// ===========================================================================
describe("API routes for undo-files, keep-files, check-conflicts", () => {
  test("POST undo-files/:messageID returns updated session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "api-test.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // skipFiles revert — file kept
        await SessionRevert.revert({ sessionID: sid, messageID: user.id, skipFiles: true })
        expect(await exists(file)).toBe(true)
        let info = await Session.get(sid)
        expect(info.revert?.skipped).toContain(bot.id)

        // Call undoFiles directly (simulating the route handler)
        const result = await SessionRevert.undoFiles({
          sessionID: sid,
          messageID: bot.id,
        })

        // Should return a valid session with updated revert state
        expect(result).toBeDefined()
        expect(result.id).toBe(sid)
        expect(result.revert).toBeDefined()
        expect(result.revert?.skipped ?? []).not.toContain(bot.id)
        expect(await exists(file)).toBe(false)

        await Session.remove(sid)
      },
    })
  })

  test("POST keep-files/:messageID returns updated session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "api-test.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // full revert — file removed
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(file)).toBe(false)

        // Call keepFiles directly
        const result = await SessionRevert.keepFiles({
          sessionID: sid,
          messageID: bot.id,
        })

        expect(result).toBeDefined()
        expect(result.id).toBe(sid)
        expect(result.revert?.skipped).toContain(bot.id)
        expect(await exists(file)).toBe(true)
        expect(await Bun.file(file).text()).toBe("hello")

        await Session.remove(sid)
      },
    })
  })

  test("POST check-conflicts returns conflict list", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const file = fwd(tmp.path, "api-shared.txt")

        const user1 = await addUser(sid, "create")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(file, "v1")
        const patch1 = await Snapshot.patch(snap1!)
        const bot1 = await addAssistant(sid, tmp.path, user1.id, patch1)

        const user2 = await addUser(sid, "modify")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(file, "v2")
        const patch2 = await Snapshot.patch(snap2!)
        const bot2 = await addAssistant(sid, tmp.path, user2.id, patch2)

        const result = await SessionRevert.checkConflicts({
          sessionID: sid,
          messageID: user1.id,
          skipMessages: [bot2.id],
        })

        // Validate response structure
        expect(Array.isArray(result)).toBe(true)
        expect(result.length).toBe(1)
        expect(result[0]).toHaveProperty("file")
        expect(result[0]).toHaveProperty("reverted")
        expect(result[0]).toHaveProperty("kept")
        expect(result[0].file).toContain("api-shared.txt")
        expect(typeof result[0].reverted).toBe("string")
        expect(typeof result[0].kept).toBe("string")

        await Session.remove(sid)
      },
    })
  })

  test("undoFiles without active revert returns session unchanged", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "noop.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // No revert active — undoFiles should be no-op
        const result = await SessionRevert.undoFiles({
          sessionID: sid,
          messageID: bot.id,
        })
        expect(result.revert).toBeUndefined()
        expect(await Bun.file(file).text()).toBe("hello")

        await Session.remove(sid)
      },
    })
  })

  test("keepFiles without active revert returns session unchanged", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "noop.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // No revert active — keepFiles should be no-op
        const result = await SessionRevert.keepFiles({
          sessionID: sid,
          messageID: bot.id,
        })
        expect(result.revert).toBeUndefined()
        expect(await Bun.file(file).text()).toBe("hello")

        await Session.remove(sid)
      },
    })
  })

  test("undoFiles/keepFiles with invalid messageID is a no-op", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        const user = await addUser(sid, "create file")
        const file = fwd(tmp.path, "noop.txt")
        const snap = await Snapshot.track()
        expect(snap).toBeTruthy()
        await Filesystem.write(file, "hello")
        const patch = await Snapshot.patch(snap!)
        const bot = await addAssistant(sid, tmp.path, user.id, patch)

        // Set up a revert
        await SessionRevert.revert({ sessionID: sid, messageID: user.id, skipFiles: true })

        const bogus = MessageID.make("msg_000000000000nonexistent")
        const before = await Session.get(sid)

        // undoFiles with bogus ID
        const r1 = await SessionRevert.undoFiles({ sessionID: sid, messageID: bogus })
        expect(r1.revert?.skipped).toEqual(before.revert?.skipped)

        // keepFiles with bogus ID
        const r2 = await SessionRevert.keepFiles({ sessionID: sid, messageID: bogus })
        expect(r2.revert?.skipped).toEqual(before.revert?.skipped)

        await Session.remove(sid)
      },
    })
  })
})
