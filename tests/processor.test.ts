import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildProcessPrompt,
  EXTRACTION_PROMPT,
  FALLBACK_INLINE_BYTES,
  inlineThresholdBytes,
  isProcessPrompt,
  MAX_INLINE_BYTES,
  PROCESS_PROMPT_PREFIX,
  shapeSummary,
} from "../src/processor.ts"
import type { CharaCardV2 } from "../src/types.ts"

function card(overrides: Partial<CharaCardV2["data"]> = {}): CharaCardV2 {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Nadia",
      description: "d",
      personality: "p",
      first_mes: "f",
      mes_example: "m",
      scenario: "s",
      creator_notes: "c",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: ["g1", "g2"],
      tags: ["a", "b"],
      creator: "someone",
      character_version: "1",
      ...overrides,
    },
  }
}

const PATHS = {
  stagedCardPath: "/home/pi/.pi/agent/personas/nadia-abc123/card.json",
  libraryPersonaPath: "/home/pi/.pi/agent/personas/nadia-abc123/PERSONA.md",
  activePersonaPath: "/home/pi/.pi/agent/PERSONA.md",
  cardName: "Nadia",
}

// 50 KB of card is ~12.5k tokens. On this stack's 32,768-token window that is
// 40% of the budget spent before the model has read the instruction. The jq
// path exists so it does not have to be.
test("the inline threshold scales with the window and never exceeds upstream's cap", () => {
  assert.equal(inlineThresholdBytes(32768), 19660)
  assert.equal(inlineThresholdBytes(98304), MAX_INLINE_BYTES)
  assert.equal(inlineThresholdBytes(1_000_000), MAX_INLINE_BYTES)
  assert.ok(inlineThresholdBytes(8192) >= 2000)
})

test("an unknown window falls back small rather than guessing large", () => {
  for (const v of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(inlineThresholdBytes(v as number), FALLBACK_INLINE_BYTES)
  }
})

test("a small card is inlined and no read is asked for", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(p.includes("<staged_card>"))
  assert.ok(p.includes('"name": "Nadia"'))
  assert.ok(!p.includes("<card_shape>"))
  assert.ok(!p.includes("jq -r '.data.description'"))
})

test("a large card gets the shape summary and the jq walk, never a read", () => {
  const p = buildProcessPrompt({
    card: card({ description: "x".repeat(60_000) }),
    ...PATHS,
    contextWindow: 32768,
  })
  assert.ok(!p.includes("<staged_card>"))
  assert.ok(p.includes("<card_shape>"))
  assert.ok(p.includes("DO NOT call the `read` tool"))
  assert.ok(p.includes(`jq -r '.data.description' ${PATHS.stagedCardPath}`))
  // The whole point: the card body is not in the prompt.
  assert.ok(!p.includes("x".repeat(1000)))
})

// The processing turn only does anything if both writes happen. openclaude
// spells this out because a model that prints the persona and stops leaves the
// user with a command that appeared to work and changed nothing.
test("both write targets are named and mandatory", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(p.includes(PATHS.libraryPersonaPath))
  assert.ok(p.includes(PATHS.activePersonaPath))
  assert.ok(p.includes("The write calls are MANDATORY"))
  assert.ok(p.includes("Use the `write` tool TWICE"))
})

// pi has no AskUserQuestion tool. Telling the model to call one is how you get
// an invented call; telling it to ask and then write anyway commits an answer
// the user has not given.
test("ambiguity is routed to a plain question that writes nothing", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(!p.includes("AskUserQuestion"))
  assert.ok(p.includes("ASK THE USER AND STOP"))
  assert.ok(p.includes("Do not ask a question and then write a file anyway"))
})

// The framing sentence is what parsePersonaName reads the name out of. If the
// extraction prompt stops mandating it, every persona is called "Custom".
test("the extraction prompt mandates the framing sentence and says why", () => {
  assert.ok(EXTRACTION_PROMPT.includes("the persona of <NAME>."))
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(p.includes("The extension reads the persona's NAME back out of it"))
})

test("the prompt carries its own fingerprint so the first-turn test can skip it", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(p.startsWith(PROCESS_PROMPT_PREFIX))
  assert.ok(isProcessPrompt(p))
  assert.ok(!isProcessPrompt("what does this repo do"))
  assert.ok(!isProcessPrompt(undefined))
  assert.ok(!isProcessPrompt(42))
})

test("the command name reaches the prompt", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768, commandName: "identity" })
  assert.ok(p.startsWith(`${PROCESS_PROMPT_PREFIX}identity.`))
  assert.ok(p.includes("/identity show"))
})

test("the shape summary reports lengths, not contents", () => {
  const s = shapeSummary(card({ description: "y".repeat(500) }))
  assert.ok(s.includes("description: 500 chars"))
  assert.ok(!s.includes("y".repeat(50)))
  assert.ok(s.includes("alternate_greetings: 2 entries"))
  assert.ok(s.includes("character_book.entries: 0"))
  assert.ok(s.includes("extensions.depth_prompt: absent"))
})

test("the extraction guidelines still separate voice from content mandates", () => {
  assert.ok(EXTRACTION_PROMPT.includes("The output is an *identity*, not a content policy"))
  assert.ok(EXTRACTION_PROMPT.includes("IGNORE (do not surface"))
  assert.ok(EXTRACTION_PROMPT.includes("Operating directives"))
})

// ── the appearance section ──────────────────────────────────────────────────
//
// The persona is USED: the assistant wearing it describes itself, moves,
// dresses, gets looked at. Before this, appearance was not in the LIFT list at
// all and the card's physical description was reachable only through the
// "TRANSFORM sensual content into voice descriptors" rule — which reads, quite
// reasonably, as an instruction to sand it off.

test("the guidelines ask for appearance, at the card's own level of detail", () => {
  assert.ok(EXTRACTION_PROMPT.includes("LIFT APPEARANCE AS WRITTEN"))
  assert.ok(EXTRACTION_PROMPT.includes("Physical appearance, at the card's own level of detail"))
  // The output format has to carry it too, or the guideline describes a section
  // the reference structure never asks the model to write.
  assert.ok(EXTRACTION_PROMPT.includes("  - Appearance — 4-8 bullets"))
  assert.ok(EXTRACTION_PROMPT.includes("\nAppearance\n- <build, height"))
})

test("euphemism is named as the failure, not left to be inferred", () => {
  for (const word of ["Curves", "assets", "ample", "well-endowed"]) {
    assert.ok(EXTRACTION_PROMPT.includes(word), `${word} is not named as a forbidden euphemism`)
  }
  assert.ok(EXTRACTION_PROMPT.includes("Do NOT drop a feature for being explicit"))
  assert.ok(EXTRACTION_PROMPT.includes("Assume the card is explicit about the body"))
})

// The old TRANSFORM rule is still right about DIRECTIVES and was being applied
// to descriptions. Both halves have to be visible or the correction is lost.
test("transform still covers directives, and explicitly stops at appearance", () => {
  assert.ok(EXTRACTION_PROMPT.includes("TRANSFORM (don't echo verbatim) BEHAVIOURAL and OUTPUT directives"))
  assert.ok(EXTRACTION_PROMPT.includes("None of this reaches the Appearance section"))
  assert.ok(
    EXTRACTION_PROMPT.includes(
      "The character's OWN body, face and clothing are not world-building",
    ),
    "the IGNORE list's lore line has to exempt the character's own body",
  )
})

test("appearance is described, never played out", () => {
  assert.ok(EXTRACTION_PROMPT.includes("third person, present tense, plain declaratives"))
  assert.ok(EXTRACTION_PROMPT.includes('"She is X" — never "she does X to you"'))
})

// ── the outgoing persona ────────────────────────────────────────────────────

test("a retired persona is named at the top of the extraction turn", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768, retiredPersona: "Kira" })
  assert.ok(p.includes("you were speaking as Kira"))
  assert.ok(p.includes("It is history, not a source."))
  // The two first-person lines are where a leftover voice actually survives.
  assert.ok(p.includes("`Sample line` and `About me`"))
  // The fingerprint the immersion marker skips on must still be the first thing
  // in the string, or the extraction turn starts eating the first user turn.
  assert.ok(p.startsWith(PROCESS_PROMPT_PREFIX))
  assert.ok(p.indexOf("you were speaking as Kira") < p.indexOf("<staged_card>"))
})

test("with nothing retired the extraction turn says nothing about it", () => {
  for (const retiredPersona of [undefined, null, "", "   "]) {
    const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768, retiredPersona })
    assert.ok(!p.includes("BEFORE YOU START"), `${JSON.stringify(retiredPersona)} produced a notice`)
    assert.ok(!p.includes("undefined"))
  }
})
