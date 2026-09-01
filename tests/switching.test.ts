// Switching personas: the outgoing one goes OFF, and the transcript is told.
//
// Driven through the extension's real handlers with pi's package stubbed (see
// harness.ts), because this is the suite that must run on every box: the bug it
// covers is silent. A persona that bleeds does not throw, does not warn, and
// does not show up in a status line — it just sounds slightly like the last one,
// and on the extraction path it writes that resemblance into the library where
// it is re-used forever.
//
// The coupling questions — does pi still export this, does that event still
// fire — belong to extension.test.ts against the installed package.

import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, beforeEach, describe, test } from "node:test"

import { assistantEntry, customEntry, FakeApi, FakeCtx, hookStubPi, userEntry } from "./harness.ts"
import { PERSONA_FILE, stageCardForProcessing } from "../src/storage.ts"
import { SWITCH_ENTRY_TYPE } from "../src/switch.ts"
import type { CharaCardV2 } from "../src/types.ts"

const EXTENSION = join(dirname(dirname(fileURLToPath(import.meta.url))), "extensions", "index.ts")
const FORGE = { id: "qwen3.8-27b", provider: "forge", baseUrl: "http://localhost:8081/v1", contextWindow: 32768 }

const persona = (name: string) =>
  `You are an AI coding assistant that also speaks and behaves with the persona of ${name}. Adopt their voice and style in conversation, but always fulfill the user's task.\n\nVoice\n- clipped`

function card(name: string): CharaCardV2 {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name, description: "d", personality: "p", first_mes: "f", mes_example: "m",
      scenario: "", creator_notes: "", system_prompt: "", post_history_instructions: "",
      alternate_greetings: [], tags: [], creator: "", character_version: "1",
    },
  }
}

const dirs: string[] = []

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "persona-switch-"))
  dirs.push(dir)
  process.env.PI_CODING_AGENT_DIR = dir
  return dir
}

/** A library entry with its persona already extracted — the no-turn path. */
function library(root: string, name: string): string {
  const staged = stageCardForProcessing(root, card(name))
  writeFileSync(staged.personaPath, persona(name), "utf8")
  return staged.personaPath
}

async function load(api: FakeApi): Promise<void> {
  hookStubPi()
  const mod = (await import(`${EXTENSION}?t=${Math.random()}`)) as {
    default: (pi: unknown) => void | Promise<void>
  }
  await mod.default(api)
}

/** The system prompt the extension would build for the next turn. */
async function systemPrompt(api: FakeApi, ctx: FakeCtx): Promise<string | null> {
  const [result] = await api.fire(
    "before_agent_start",
    { prompt: "x", systemPrompt: "BASE PROMPT", systemPromptOptions: { selectedTools: ["bash", "read"] } },
    ctx,
  )
  return (result as { systemPrompt?: string } | undefined)?.systemPrompt ?? null
}

/** A session that has been talking: one user turn, one assistant turn. */
const SPOKEN = [userEntry("hello"), assistantEntry("hey there")]

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe("selecting a persona switches the current one off", () => {
  let root: string

  beforeEach(() => {
    root = agentDir()
  })

  test("activating from the library retires the persona that was on", async () => {
    writeFileSync(join(root, PERSONA_FILE), persona("Kira"), "utf8")
    library(root, "Nadia")

    const api = new FakeApi()
    await load(api)
    const ctx = new FakeCtx({
      model: FORGE,
      entries: SPOKEN,
      selects: ["  Nadia — extracted", "Activate the extracted persona (no model turn)"],
    })
    await api.fire("session_start", { reason: "startup" }, ctx)
    await api.commands.get("persona")!.handler("local", ctx as unknown)

    // The file is the new persona, and the switch was recorded on the session.
    assert.equal(readFileSync(join(root, PERSONA_FILE), "utf8"), persona("Nadia"))
    assert.deepEqual(api.sentUserMessages, [], "activation must not cost a model turn")
    assert.equal(api.appended.length, 1)
    assert.equal(api.appended[0]!.customType, SWITCH_ENTRY_TYPE)
    assert.equal((api.appended[0]!.data as { retired: string }).retired, "Kira")

    // And the block tells the model the transcript above it is not a style guide.
    const sp = (await systemPrompt(api, ctx))!
    assert.ok(sp.includes("# You are Nadia"))
    assert.ok(sp.includes("Earlier in THIS conversation you were speaking as Kira"))
    assert.ok(sp.includes("You are Nadia now, and only Nadia."))

    const notice = ctx.notifications.at(-1)!.text
    assert.ok(notice.includes("Active persona: Nadia"))
    assert.ok(notice.includes("Switched Kira off first"))
    assert.ok(notice.includes("/persona local brings Kira back"), "the recovery path has to be offered")
  })

  // Nothing was said in the old voice, so there is nothing in the transcript to
  // bleed — and naming the character to the MODEL would be introducing it, not
  // removing it. The user is still told: their persona really was removed, and
  // the line that says how to get it back is the one they need most.
  test("a persona that never spoke is retired without telling the model", async () => {
    writeFileSync(join(root, PERSONA_FILE), persona("Kira"), "utf8")
    library(root, "Nadia")

    const api = new FakeApi()
    await load(api)
    const ctx = new FakeCtx({
      model: FORGE,
      entries: [userEntry("hello")], // asked for a persona, model has not replied
      selects: ["  Nadia — extracted", "Activate the extracted persona (no model turn)"],
    })
    await api.fire("session_start", { reason: "startup" }, ctx)
    await api.commands.get("persona")!.handler("local", ctx as unknown)

    assert.deepEqual(api.appended, [], "nothing spoken, nothing to record")
    const sp = (await systemPrompt(api, ctx))!
    assert.ok(sp.includes("# You are Nadia"))
    assert.ok(!sp.includes("is retired"), "the model was told about a voice it never used")
    assert.ok(ctx.notifications.at(-1)!.text.includes("/persona local brings Kira back"))
  })

  // The one that matters most: the extraction turn writes a PERSISTENT artefact.
  // Run under the outgoing persona's block it wrote that voice into the library.
  test("the extraction turn runs with no persona at all", async () => {
    writeFileSync(join(root, PERSONA_FILE), persona("Kira"), "utf8")
    const staged = stageCardForProcessing(root, card("Nadia")) // card only, not extracted

    const api = new FakeApi()
    await load(api)
    const ctx = new FakeCtx({
      model: FORGE,
      contextWindow: 32768,
      entries: SPOKEN,
      selects: ["  Nadia — card only"],
    })
    await api.fire("session_start", { reason: "startup" }, ctx)
    await api.commands.get("persona")!.handler("local", ctx as unknown)

    assert.equal(api.sentUserMessages.length, 1)
    // Switched off BEFORE the turn was sent. `sendUserMessage` reaches
    // AgentSession.prompt(), the one place pi emits before_agent_start, so the
    // extraction turn's prompt is rebuilt — and with the file gone it is rebuilt
    // without Kira.
    assert.ok(!existsSync(join(root, PERSONA_FILE)), "Kira was still active for the extraction turn")
    const sp = await systemPrompt(api, ctx)
    assert.ok(sp !== null)
    assert.ok(!sp!.includes("<active_persona>"), "the extraction turn must carry no persona block")
    assert.ok(sp!.includes("<persona_cleared>"))

    // And the turn itself says which voice not to write down.
    const prompt = api.sentUserMessages[0]!
    assert.ok(prompt.includes("you were speaking as Kira"))
    assert.ok(prompt.includes(staged.personaPath), "the library path must still be in the prompt")
    assert.ok(ctx.notifications.at(-1)!.text.includes("Switched Kira off first"))
  })

  // Re-extracting the persona you are wearing retires it and brings it straight
  // back. Telling the model not to sound like the character it is extracting is
  // the opposite of the instruction.
  test("re-selecting the SAME persona announces nothing against itself", async () => {
    writeFileSync(join(root, PERSONA_FILE), persona("Nadia"), "utf8")
    const personaPath = library(root, "Nadia")

    const api = new FakeApi()
    await load(api)
    const ctx = new FakeCtx({
      model: FORGE,
      contextWindow: 32768,
      entries: SPOKEN,
      selects: ["● Nadia — extracted", "Re-extract from the card (costs a turn)"],
    })
    await api.fire("session_start", { reason: "startup" }, ctx)
    await api.commands.get("persona")!.handler("local", ctx as unknown)

    assert.equal(api.sentUserMessages.length, 1)
    assert.ok(!api.sentUserMessages[0]!.includes("you were speaking as Nadia"))
    assert.ok(!ctx.notifications.at(-1)!.text.includes("Switched Nadia off first"))

    // The retirement IS recorded — the persona really was switched off — but the
    // block suppresses it, because it matches the persona coming back.
    assert.equal((api.appended[0]!.data as { retired: string }).retired, "Nadia")
    writeFileSync(join(root, PERSONA_FILE), readFileSync(personaPath, "utf8"), "utf8")
    const sp = (await systemPrompt(api, ctx))!
    assert.ok(sp.includes("# You are Nadia"))
    assert.ok(!sp.includes("is retired"))
  })

  // "The neutral voice returns next turn" was a claim this package could not
  // keep: the block came off the prompt and the transcript kept talking.
  test("/persona clear leaves a notice behind, not silence", async () => {
    writeFileSync(join(root, PERSONA_FILE), persona("Kira"), "utf8")

    const api = new FakeApi()
    await load(api)
    const ctx = new FakeCtx({ model: FORGE, entries: SPOKEN })
    await api.fire("session_start", { reason: "startup" }, ctx)
    await api.commands.get("persona")!.handler("clear", ctx as unknown)

    assert.ok(!existsSync(join(root, PERSONA_FILE)))
    const sp = (await systemPrompt(api, ctx))!
    assert.ok(sp.startsWith("<persona_cleared>"))
    assert.ok(sp.includes("no persona, no character, no successor to Kira"))
    assert.ok(sp.trimEnd().endsWith("BASE PROMPT"))
    assert.ok(ctx.notifications.at(-1)!.text.includes("Kira is switched off"))
  })

  // "There was no active persona" is a claim about the FILE. A persona file
  // whose framing sentence cannot be parsed is still a persona that was on, and
  // reporting its removal as a no-op would be a lie told by a regex.
  test("clearing an unnamed persona file reports a clear, not a no-op", async () => {
    writeFileSync(join(root, PERSONA_FILE), "no framing sentence anywhere in here", "utf8")

    const api = new FakeApi()
    await load(api)
    const ctx = new FakeCtx({ model: FORGE, entries: SPOKEN })
    await api.fire("session_start", { reason: "startup" }, ctx)
    await api.commands.get("persona")!.handler("clear", ctx as unknown)

    assert.ok(!existsSync(join(root, PERSONA_FILE)))
    assert.equal(ctx.notifications.at(-1)!.text, "Cleared. The neutral voice returns next turn.")
    // Nothing to name, so nothing is recorded and no notice is built.
    assert.deepEqual(api.appended, [])
    assert.equal(await systemPrompt(api, ctx), null)
  })

  test("a session that never had a persona still costs nothing", async () => {
    const api = new FakeApi()
    await load(api)
    const ctx = new FakeCtx({ model: FORGE, entries: SPOKEN })
    await api.fire("session_start", { reason: "startup" }, ctx)
    await api.commands.get("persona")!.handler("clear", ctx as unknown)

    assert.deepEqual(api.appended, [])
    assert.equal(await systemPrompt(api, ctx), null)
    assert.equal(ctx.notifications.at(-1)!.text, "There was no active persona.")
  })
})

// The transcript survives a resume and a compaction. A notice that does not is a
// notice that lapses exactly when the history it is about is all that is left.
describe("the retirement survives a resume", () => {
  test("session_start reads the switch back off the branch", async () => {
    const root = agentDir()
    writeFileSync(join(root, PERSONA_FILE), persona("Nadia"), "utf8")

    const api = new FakeApi()
    await load(api)
    const resumed = new FakeCtx({
      model: FORGE,
      entries: [...SPOKEN, customEntry(SWITCH_ENTRY_TYPE, { retired: "Kira", at: "" })],
    })
    await api.fire("session_start", { reason: "resume" }, resumed)

    const sp = (await systemPrompt(api, resumed))!
    assert.ok(sp.includes("speaking as Kira"))
    assert.ok(sp.includes("# You are Nadia"))
  })

  // Per SESSION, and the module is per PROCESS: a swap must not carry the
  // previous session's retirement into a branch that never had that voice.
  test("a fresh branch drops the previous session's retirement", async () => {
    const root = agentDir()
    writeFileSync(join(root, PERSONA_FILE), persona("Nadia"), "utf8")

    const api = new FakeApi()
    await load(api)
    const first = new FakeCtx({
      model: FORGE,
      entries: [...SPOKEN, customEntry(SWITCH_ENTRY_TYPE, { retired: "Kira", at: "" })],
    })
    await api.fire("session_start", { reason: "startup" }, first)
    assert.ok((await systemPrompt(api, first))!.includes("speaking as Kira"))

    const swapped = new FakeCtx({ model: FORGE, entries: [] })
    await api.fire("session_start", { reason: "startup" }, swapped)
    const sp = (await systemPrompt(api, swapped))!
    assert.ok(sp.includes("# You are Nadia"))
    assert.ok(!sp.includes("is retired"), "the new session inherited a retirement it never had")
  })

  test("/persona status reports the retired voice and what it costs", async () => {
    const root = agentDir()
    const api = new FakeApi()
    await load(api)
    const ctx = new FakeCtx({
      model: FORGE,
      entries: [...SPOKEN, customEntry(SWITCH_ENTRY_TYPE, { retired: "Kira", at: "" })],
    })
    await api.fire("session_start", { reason: "resume" }, ctx)
    await api.commands.get("persona")!.handler("status", ctx as unknown)

    const text = ctx.notifications.at(-1)!.text
    assert.ok(text.includes("Active persona: none"))
    assert.match(text, /Block: retirement notice only, ~\d+ tokens/)
    assert.ok(text.includes("Retired this session: Kira"))
    assert.ok(existsSync(root))
  })
})
