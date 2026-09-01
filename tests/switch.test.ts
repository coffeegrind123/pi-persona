// The retirement bookkeeping, on its own.
//
// The mechanism this file covers is the half of a persona switch that deleting
// PERSONA.md cannot do: the transcript. See ../src/switch.ts.

import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildRetiredVoiceNotice,
  hasSpokenTurns,
  readRetiredPersona,
  shouldAnnounceRetired,
  SWITCH_ENTRY_TYPE,
} from "../src/switch.ts"

function custom(retired: string | null): unknown {
  return { type: "custom", customType: SWITCH_ENTRY_TYPE, data: { retired, at: "" } }
}

function assistant(text = "hi"): unknown {
  return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }
}

function user(text = "hi"): unknown {
  return { type: "message", message: { role: "user", content: text } }
}

test("the last switch entry on the branch wins", () => {
  assert.equal(readRetiredPersona([]), null)
  assert.equal(readRetiredPersona([custom("Kira")]), "Kira")
  assert.equal(readRetiredPersona([custom("Kira"), user(), custom("Nadia")]), "Nadia")
  // A→B→C: B is the voice the transcript is thickest in, and it is the one named.
  assert.equal(readRetiredPersona([custom("Ada"), custom("Kira")]), "Kira")
})

test("a switch entry can retire nothing", () => {
  assert.equal(readRetiredPersona([custom("Kira"), custom(null)]), null)
  assert.equal(readRetiredPersona([custom("   ")]), null)
})

test("entries that are not ours are stepped over, not misread", () => {
  const foreign = { type: "custom", customType: "loop-state", data: { retired: "NotOurs" } }
  assert.equal(readRetiredPersona([custom("Kira"), foreign]), "Kira")
  assert.equal(readRetiredPersona([foreign]), null)
  // A branch full of junk must not throw on the way through.
  assert.equal(readRetiredPersona([null, undefined, 3, "x", { type: "custom" }] as unknown[]), null)
})

// The notice is about a voice that is IN THE TRANSCRIPT. Announcing the
// retirement of a persona that never spoke costs tokens at offset 0 to
// introduce the model to a character it has never seen.
test("a session that has not spoken has nothing to retire", () => {
  assert.equal(hasSpokenTurns([]), false)
  assert.equal(hasSpokenTurns([user()]), false)
  assert.equal(hasSpokenTurns([custom("Kira")]), false)
  assert.equal(hasSpokenTurns([user(), assistant()]), true)
  assert.equal(hasSpokenTurns([null, undefined, assistant()] as unknown[]), true)
})

test("a voice is never announced against itself", () => {
  assert.equal(shouldAnnounceRetired("Kira", "Nadia"), true)
  assert.equal(shouldAnnounceRetired("Kira", null), true)
  assert.equal(shouldAnnounceRetired("Kira", "kira"), false)
  assert.equal(shouldAnnounceRetired("  Kira ", "Kira"), false)
  assert.equal(shouldAnnounceRetired(null, "Nadia"), false)
  assert.equal(shouldAnnounceRetired("", "Nadia"), false)
  assert.equal(shouldAnnounceRetired("   ", null), false)
})

test("the notice names the transcript as history and the successor as the voice", () => {
  const s = buildRetiredVoiceNotice("Kira", "Nadia")
  assert.ok(s.includes("Earlier in THIS conversation you were speaking as Kira"))
  assert.ok(s.includes("You are Nadia now, and only Nadia."))
  assert.ok(s.includes("They are HISTORY, not a style guide"))
  // The list has to be concrete: "don't be Kira" is exactly the instruction a
  // model satisfies by dropping the name and keeping everything else.
  for (const carried of ["cadence", "verbal tics", "pet names", "appearance", "self-description"]) {
    assert.ok(s.includes(carried), `the notice does not mention ${carried}`)
  }
  assert.ok(s.includes("Do not narrate the change"))
})

test("with no successor the notice says to be no one, not to be neutral-ish", () => {
  const s = buildRetiredVoiceNotice("Kira", null)
  assert.ok(s.includes("no persona, no character, no successor to Kira"))
  assert.ok(!s.includes("undefined"))
  assert.ok(!s.includes("null"))
  assert.ok(s.includes("do not sign off as Kira"))
})
