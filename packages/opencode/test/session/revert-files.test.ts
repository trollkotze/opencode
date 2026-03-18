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
