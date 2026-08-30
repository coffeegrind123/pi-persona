import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { DEFAULT_SETTINGS, loadSettings, saveSettings, settingsPath } from "../src/settings.ts"

function root(): string {
  return mkdtempSync(join(tmpdir(), "persona-settings-"))
}

// A fresh install gets the marker and the full block. Both are pinned rather
// than merely asserted: they are what a persona session actually behaves like,
// and a silent revert of either would present as "the persona got weaker".
test("the defaults are immersion and the full block", () => {
  const r = root()
  assert.deepEqual(loadSettings(r, {}), DEFAULT_SETTINGS)
  assert.equal(DEFAULT_SETTINGS.immersionMode, "immersion")
  assert.equal(DEFAULT_SETTINGS.promptMode, "full")
  rmSync(r, { recursive: true, force: true })
})

test("settings round-trip through the file", () => {
  const r = root()
  saveSettings(r, { immersionMode: "analysis", promptMode: "lean" })
  assert.deepEqual(loadSettings(r, {}), { immersionMode: "analysis", promptMode: "lean" })
  rmSync(r, { recursive: true, force: true })
})

// A corrupt settings file must not be the reason a session has no persona.
test("an unparseable file degrades to defaults instead of throwing", () => {
  const r = root()
  writeFileSync(settingsPath(r), "{ not json", "utf8")
  assert.deepEqual(loadSettings(r, {}), DEFAULT_SETTINGS)
  rmSync(r, { recursive: true, force: true })
})

test("unknown values in the file are ignored, known ones beside them are kept", () => {
  const r = root()
  writeFileSync(
    settingsPath(r),
    JSON.stringify({ immersionMode: "loud", promptMode: "lean", extra: 1 }),
    "utf8",
  )
  assert.deepEqual(loadSettings(r, {}), { immersionMode: "immersion", promptMode: "lean" })
  rmSync(r, { recursive: true, force: true })
})

// A settings file written before 2026-08-30 says "auto", which used to mean
// "only on DeepSeek" and now means "immersion". It must keep loading rather
// than fall back to a default nobody chose.
test("a persisted auto still loads, and now means immersion", () => {
  const r = root()
  writeFileSync(settingsPath(r), JSON.stringify({ immersionMode: "auto", promptMode: "full" }), "utf8")
  assert.equal(loadSettings(r, {}).immersionMode, "auto")
  assert.equal(loadSettings(r, { PERSONA_IMMERSION: "auto" }).immersionMode, "auto")
  rmSync(r, { recursive: true, force: true })
})

// The rest of this stack is driven from .env for one launch at a time; a knob
// that can only be set by editing persisted state is a knob that outlives the
// experiment it was set for.
test("the environment wins over the file", () => {
  const r = root()
  saveSettings(r, { immersionMode: "off", promptMode: "full" })
  const s = loadSettings(r, { PERSONA_IMMERSION: "immersion", PERSONA_PROMPT_MODE: "lean" })
  assert.deepEqual(s, { immersionMode: "immersion", promptMode: "lean" })
  // and does not rewrite the file
  assert.deepEqual(loadSettings(r, {}), { immersionMode: "off", promptMode: "full" })
  rmSync(r, { recursive: true, force: true })
})

test("a nonsense environment value is ignored rather than obeyed", () => {
  const r = root()
  const s = loadSettings(r, { PERSONA_IMMERSION: "yes", PERSONA_PROMPT_MODE: "big" })
  assert.deepEqual(s, DEFAULT_SETTINGS)
  rmSync(r, { recursive: true, force: true })
})
