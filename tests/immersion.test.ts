import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ANALYSIS_MARKER,
  chooseMarker,
  IMMERSION_MARKER,
  IMMERSION_MODES,
  isFirstUserTurn,
  isImmersionMode,
  maybeAppendMarker,
  normalizeMode,
} from "../src/immersion.ts"

// These strings are the mechanism. A paraphrase, a translation or a "cleanup"
// is a different string, and a different string routes nowhere.
test("the markers are byte-exact", () => {
  assert.ok(IMMERSION_MARKER.startsWith("\n\n【角色沉浸要求】"))
  assert.ok(IMMERSION_MARKER.includes("请以角色第一人称进行内心独白"))
  assert.ok(ANALYSIS_MARKER.startsWith("\n\n【思维模式要求】"))
  assert.ok(ANALYSIS_MARKER.includes("禁止以角色第一人称描写内心活动"))
  assert.notEqual(IMMERSION_MARKER, ANALYSIS_MARKER)
})

// The gate this port shipped with, removed 2026-08-30. Nothing consults the
// model any more: the markers are also an ordinary instruction, and the
// deliberating-from-outside-the-character failure they fix was watched on Qwen.
test("no mode consults the model", () => {
  assert.equal(chooseMarker.length, 2, "chooseMarker still takes a model argument")
  assert.equal(maybeAppendMarker.length, 4, "maybeAppendMarker still takes a model argument")
})

test("immersion is what a persona gets by default", () => {
  assert.equal(chooseMarker("immersion", true), IMMERSION_MARKER)
  assert.equal(chooseMarker("analysis", true), ANALYSIS_MARKER)
})

// Kept working rather than kept meaningful: an existing PERSONA_IMMERSION=auto,
// or a persona-settings.json written before the change, must not silently fall
// back to a mode nobody chose.
test("auto is accepted and means immersion", () => {
  assert.ok(isImmersionMode("auto"))
  assert.equal(normalizeMode("auto"), "immersion")
  assert.equal(chooseMarker("auto", true), IMMERSION_MARKER)
})

test("auto is not offered as a choice, only accepted", () => {
  assert.deepEqual(IMMERSION_MODES, ["immersion", "analysis", "off"])
  assert.ok(!IMMERSION_MODES.includes("auto" as never))
})

test("off and no-persona both suppress every mode", () => {
  for (const mode of [...IMMERSION_MODES, "auto" as const]) {
    assert.equal(chooseMarker(mode, false), null, `${mode} fired with no persona`)
  }
  assert.equal(chooseMarker("off", true), null)
})

test("isFirstUserTurn ignores assistant turns and tool traffic", () => {
  assert.ok(isFirstUserTurn([]))
  assert.ok(isFirstUserTurn([{ role: "assistant" }, { role: "tool" }]))
  assert.ok(!isFirstUserTurn([{ role: "assistant" }, { role: "user" }]))
})

// The extraction turn is delivered with sendUserMessage() and lands as a user
// message. Without the synthetic flag it consumes the first turn, and the marker
// then attaches to the user's SECOND message — later than the position the whole
// mechanism is documented against.
test("a synthetic user message does not consume the first turn", () => {
  assert.ok(isFirstUserTurn([{ role: "user", synthetic: true }]))
  assert.ok(!isFirstUserTurn([{ role: "user", synthetic: true }, { role: "user" }]))
})

test("the marker lands at the END of the first user message", () => {
  const out = maybeAppendMarker("do the thing", [], "immersion", true)
  assert.ok(out.startsWith("do the thing"))
  assert.ok(out.endsWith(IMMERSION_MARKER))
})

test("nothing is appended past the first turn", () => {
  const out = maybeAppendMarker("second", [{ role: "user" }], "immersion", true)
  assert.equal(out, "second")
})

// pi checks EXTENSION commands before the input event, but skill commands and
// prompt templates are expanded after it. A marker glued onto `/loop status`
// becomes part of that command's argument string.
test("slash commands are left alone", () => {
  for (const cmd of ["/loop status", "  /skill:foo", "/persona"]) {
    assert.equal(maybeAppendMarker(cmd, [], "immersion", true), cmd)
  }
})

test("a non-string prompt passes through untouched", () => {
  const weird = { not: "a string" } as unknown as string
  assert.equal(maybeAppendMarker(weird, [], "immersion", true), weird)
})

test("isImmersionMode rejects anything that is not a mode", () => {
  assert.ok(isImmersionMode("immersion"))
  assert.ok(isImmersionMode("analysis"))
  assert.ok(isImmersionMode("off"))
  assert.ok(isImmersionMode("auto"), "the deprecated alias must keep loading")
  assert.ok(!isImmersionMode("on"))
  assert.ok(!isImmersionMode("deepseek"))
  assert.ok(!isImmersionMode(""))
})
