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
  providerID: ProviderID.make("openai"),
  modelID: ModelID.make("gpt-4"),
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
  }
  return msg
}

describe("session revert file restore", () => {
  test("revert restores file changes after unrevert", async () => {
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

  test("revert can skip files then restore with files", async () => {
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

        // messages-only revert: file stays, no snapshot stored
        await SessionRevert.revert({ sessionID: sid, messageID: user.id, skipFiles: true })
        expect(await exists(file)).toBe(true)
        const info = await Session.get(sid)
        expect(info.revert).toBeDefined()
        expect(info.revert?.snapshot).toBeUndefined()

        // unrevert after messages-only: file still there
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await exists(file)).toBe(true)

        // full revert: file removed
        await SessionRevert.revert({ sessionID: sid, messageID: user.id })
        expect(await exists(file)).toBe(false)

        // unrevert restores file
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(file).text()).toBe("hello")

        await Session.remove(sid)
      },
    })
  })

  test("revert with files then deeper skipFiles preserves snapshot", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id

        // turn 1: user asks, assistant creates fileA
        const user1 = await addUser(sid, "create A")
        const fileA = fwd(tmp.path, "a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aaa")
        const patch1 = await Snapshot.patch(snap1!)
        await addAssistant(sid, tmp.path, user1.id, patch1)

        // turn 2: user asks, assistant creates fileB
        const user2 = await addUser(sid, "create B")
        const fileB = fwd(tmp.path, "b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bbb")
        const patch2 = await Snapshot.patch(snap2!)
        await addAssistant(sid, tmp.path, user2.id, patch2)

        expect(await exists(fileA)).toBe(true)
        expect(await exists(fileB)).toBe(true)

        // first revert at user2 WITH file undo — removes fileB, snapshot saved
        await SessionRevert.revert({ sessionID: sid, messageID: user2.id })
        expect(await exists(fileA)).toBe(true)
        expect(await exists(fileB)).toBe(false)
        let info = await Session.get(sid)
        expect(info.revert?.snapshot).toBeDefined()
        const saved = info.revert!.snapshot

        // second revert deeper at user1 with skipFiles — fileA stays, snapshot preserved
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id, skipFiles: true })
        expect(await exists(fileA)).toBe(true)
        info = await Session.get(sid)
        expect(info.revert?.snapshot).toBe(saved)

        // unrevert restores snapshot — fileB comes back
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await exists(fileA)).toBe(true)
        expect(await Bun.file(fileB).text()).toBe("bbb")

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

        // turn 1
        const user1 = await addUser(sid, "create A")
        const fileA = fwd(tmp.path, "a.txt")
        const snap1 = await Snapshot.track()
        expect(snap1).toBeTruthy()
        await Filesystem.write(fileA, "aaa")
        const patch1 = await Snapshot.patch(snap1!)
        await addAssistant(sid, tmp.path, user1.id, patch1)

        // turn 2
        const user2 = await addUser(sid, "create B")
        const fileB = fwd(tmp.path, "b.txt")
        const snap2 = await Snapshot.track()
        expect(snap2).toBeTruthy()
        await Filesystem.write(fileB, "bbb")
        const patch2 = await Snapshot.patch(snap2!)
        await addAssistant(sid, tmp.path, user2.id, patch2)

        // first revert at user2 with skipFiles — no snapshot
        await SessionRevert.revert({ sessionID: sid, messageID: user2.id, skipFiles: true })
        expect(await exists(fileA)).toBe(true)
        expect(await exists(fileB)).toBe(true)
        let info = await Session.get(sid)
        expect(info.revert?.snapshot).toBeUndefined()

        // second revert deeper at user1 WITH files — takes fresh snapshot, reverts both
        await SessionRevert.revert({ sessionID: sid, messageID: user1.id })
        expect(await exists(fileA)).toBe(false)
        expect(await exists(fileB)).toBe(false)
        info = await Session.get(sid)
        expect(info.revert?.snapshot).toBeDefined()

        // unrevert restores both files
        await SessionRevert.unrevert({ sessionID: sid })
        expect(await Bun.file(fileA).text()).toBe("aaa")
        expect(await Bun.file(fileB).text()).toBe("bbb")

        await Session.remove(sid)
      },
    })
  })
})
