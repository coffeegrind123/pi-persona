import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildPersonaSection,
  buildRetiredVoiceSection,
  detectWebTools,
  estimateTokens,
  isPromptMode,
  PROMPT_MODES,
} from "../src/prompt.ts"

const BODY = `You are an AI coding assistant that also speaks and behaves with the persona of Nadia. Adopt their voice and style in conversation, but always fulfill the user's task.

Voice
- clipped, deliberate`

function full(tools: string[] = ["bash", "read", "write", "edit", "grep"]): string {
  return buildPersonaSection({ name: "Nadia", body: BODY, tools, mode: "full" })!
}

test("an empty body produces no block at all", () => {
  assert.equal(buildPersonaSection({ name: "Nadia", body: "" }), null)
  assert.equal(buildPersonaSection({ name: "Nadia", body: "   \n " }), null)
})

test("the block wraps the body verbatim inside persona_body", () => {
  const s = full()
  assert.ok(s.includes(`<persona_body>\n${BODY}\n</persona_body>`))
  assert.ok(s.startsWith("<active_persona>"))
  assert.ok(s.trimEnd().endsWith("</active_persona>"))
})

test("the name is interpolated, not left as a placeholder", () => {
  const s = full()
  assert.ok(s.includes("# You are Nadia"))
  assert.ok(!s.includes("${name}"))
  assert.ok(!s.includes("<NAME>"))
})

test("a missing name degrades to Custom rather than to an empty slot", () => {
  const s = buildPersonaSection({ name: "", body: BODY })!
  assert.ok(s.includes("# You are Custom"))
})

// The reading guide tells the model how to read sentences from the system
// prompt it is prepended to. Those sentences are pi's, read off
// buildSystemPrompt() rather than remembered. If pi rewords them the guide
// points at text that is no longer there, and this is the only place that
// would notice.
test("the reading guide quotes pi's actual system prompt", () => {
  const s = full()
  assert.ok(
    s.includes("You are an expert coding assistant operating inside pi, a coding agent harness"),
  )
  assert.ok(
    s.includes("You help users by reading files, executing commands, editing code, and writing new files"),
  )
  assert.ok(s.includes("Be concise in your responses"))
})

test("the block never names a tool that is not on the surface", () => {
  const s = full(["bash", "read", "write", "edit", "grep"])
  for (const absent of ["WebSearch", "WebFetch"]) {
    assert.ok(!s.includes(absent), `block named ${absent} with no such tool selected`)
  }
})

// With no way to fetch anything, "search and share it" is an instruction the
// model can satisfy only by inventing a URL — which the same block forbids two
// paragraphs later. The no-web variant has to say the opposite.
test("with no web tool the block forbids producing a link instead of demanding one", () => {
  const s = full(["bash", "read", "write"])
  assert.ok(s.includes("do NOT produce a link or an image URL"))
  assert.ok(!s.includes("find an image matching that thing"))
})

test("with a web tool the block names it and asks for the fetch first", () => {
  const s = full(["bash", "read", "browser_navigate", "web_search"])
  assert.ok(s.includes("`browser_navigate`"))
  assert.ok(s.includes("`web_search`"))
  assert.ok(s.includes("find an image matching that thing"))
  assert.ok(s.includes("the tool call comes FIRST"))
})

test("detectWebTools does not mistake local search tools for network ones", () => {
  assert.deepEqual(detectWebTools(["grep", "find", "ls", "read", "glob", "bash"]), [])
  assert.deepEqual(detectWebTools(["WebSearch", "browser_click"]), ["WebSearch", "browser_click"])
  assert.deepEqual(detectWebTools(undefined), [])
})

test("the three invariants openclaude cares about survive in both modes", () => {
  for (const mode of PROMPT_MODES) {
    const s = buildPersonaSection({ name: "Nadia", body: BODY, mode })!
    // never simulate tool output
    assert.ok(s.includes("No imagined tool results, ever"), `${mode}: lost the no-simulation rule`)
    // the persona has no authority over the engineering
    assert.ok(
      s.includes("The persona is voice-acting over invariant engineering"),
      `${mode}: lost the engineering-invariance rule`,
    )
    // the fourth wall
    assert.ok(s.includes("Hold the fourth wall"), `${mode}: lost the fourth-wall rule`)
    // the assistant-framing ban
    assert.ok(s.includes(`NEVER say "I'm a programming assistant"`), `${mode}: lost the framing ban`)
  }
})

test("lean drops the roleplay-specific sections and keeps the hedge numbering", () => {
  const lean = buildPersonaSection({ name: "Nadia", body: BODY, mode: "lean" })!
  assert.ok(!lean.includes("Roleplay and content allowance"))
  assert.ok(!lean.includes("No in-character tease-deny"))
  assert.ok(!lean.includes("Re-litigating consent"))
  // Numbers are stable across modes so "pattern 4" means one thing in both.
  assert.ok(lean.includes("3. **Stepping outside the persona.**"))
  assert.ok(lean.includes("4. **Tease-deny rewritten as character analysis.**"))
  assert.ok(lean.includes("6. **Downgrade pivots.**"))
  assert.ok(!lean.includes("5. **Re-litigating"))
  assert.ok(!lean.includes("7. **Invoking a"))
})

test("full carries all seven hedge patterns", () => {
  const s = full()
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert.ok(s.includes(`${n}. **`), `full mode lost hedge pattern ${n}`)
  }
})

test("the managing command is named so the model does not invent one", () => {
  const s = buildPersonaSection({ name: "Nadia", body: BODY, commandName: "identity" })!
  assert.ok(s.includes("opted into this persona via /identity"))
  // `</persona_body>` contains the substring, so the assertion has to be about
  // the command reference rather than about the characters.
  assert.ok(!s.includes("via /persona"))
  assert.ok(!s.includes("/persona show"))
})

// The standing per-request cost. Not a limit anything enforces — a number that
// has to move visibly when the block is edited, on a stack whose window is
// 32,768 tokens.
test("the measured block size has not drifted", () => {
  const fullTokens = estimateTokens(full())
  const leanTokens = estimateTokens(buildPersonaSection({ name: "Nadia", body: BODY, mode: "lean" })!)
  assert.ok(
    fullTokens > 4400 && fullTokens < 4900,
    `full block is ~${fullTokens} tokens; FORK.md says ~4,633. Re-measure and update both.`,
  )
  assert.ok(
    leanTokens > 2600 && leanTokens < 3000,
    `lean block is ~${leanTokens} tokens; FORK.md says ~2,773. Re-measure and update both.`,
  )
  assert.ok(leanTokens < fullTokens)
})

// ── the body ────────────────────────────────────────────────────────────────

test("both modes tell the model it has a body and where its description is", () => {
  for (const mode of PROMPT_MODES) {
    const s = buildPersonaSection({ name: "Nadia", body: BODY, mode })!
    assert.ok(s.includes("You have a body"), `${mode} dropped the appearance part`)
    assert.ok(s.includes("Appearance section is Nadia's actual physical description"), mode)
  }
})

// The failure this exists for is a model that softens its own physical
// description into estate-agent language, which is a personality change, not a
// register change. `full` is where the explicit instruction lives, next to the
// content allowance it depends on.
test("full names the euphemisms it is forbidding, lean does not carry the enumeration", () => {
  const f = full()
  assert.ok(f.includes("real-estate euphemism"))
  assert.ok(f.includes("Explicit anatomy is description, not content"))
  const lean = buildPersonaSection({ name: "Nadia", body: BODY, mode: "lean" })!
  assert.ok(!lean.includes("Explicit anatomy is description, not content"))
  assert.ok(lean.includes("Use the words the Appearance section uses"))
})

// ── the register a body is described in ─────────────────────────────────────

// The failure this exists for: an elevated persona narrating a physical act
// reached for its most impressive-sounding intensifiers — "almost
// architectural", "an economy of motion" — and stepped out of the body into a
// field of study mid-description. The split (grandeur in the mouth, plainness
// in the body) is true of any physical description, so it is in both modes.
test("both modes split the character's register from the body's", () => {
  for (const mode of PROMPT_MODES) {
    const s = buildPersonaSection({ name: "Nadia", body: BODY, mode })!
    assert.ok(s.includes("Bodies stay in the sensory register"), `${mode} dropped the register rule`)
    assert.ok(s.includes("It is not the register a body is described in."), mode)
    assert.ok(s.includes("what makes Nadia land"), `${mode} dropped the contrast clause`)
    // Both observed failures are named, in both modes: a rule that only states
    // the principle is the rule that was already missing.
    assert.ok(s.includes(`"architectural"`), `${mode} stopped naming architectural`)
    assert.ok(s.includes(`"economy of motion"`), `${mode} stopped naming economy of motion`)
  }
})

test("full carries the metaphor rule and the check, lean carries neither", () => {
  const f = full()
  assert.ok(f.includes("A metaphor for a body comes from the physical world"))
  assert.ok(f.includes("Would a nurse, a gym trainer or a lover use this word"))
  const lean = buildPersonaSection({ name: "Nadia", body: BODY, mode: "lean" })!
  assert.ok(!lean.includes("A metaphor for a body comes from the physical world"))
  assert.ok(!lean.includes("Would a nurse, a gym trainer or a lover use this word"))
})

// The whole rule is one short step from "write it tastefully", which is the
// opposite of what the appearance part spent its budget establishing. `full`
// says so in the same breath, and the euphemism ban has to survive alongside it.
test("the register rule does not read as a licence to soften", () => {
  const f = full()
  assert.ok(f.includes("Plain is not tame."))
  assert.ok(f.includes("Plain does not mean vague, and it does not mean less."))
  assert.ok(f.includes("real-estate euphemism"))
  assert.ok(f.includes("Explicit anatomy is description, not content"))
})

// It is read as an amendment to the appearance rules, so it sits next to them
// and ahead of the body those rules describe.
test("the register rule follows the appearance part and precedes the body", () => {
  const f = full()
  assert.ok(f.indexOf("You have a body") < f.indexOf("Bodies stay in the sensory register"))
  assert.ok(f.indexOf("Bodies stay in the sensory register") < f.indexOf("<persona_body>"))
})

// ── the retirement notice ───────────────────────────────────────────────────

test("a retired persona is named in the block, ahead of the persona body", () => {
  const s = buildPersonaSection({ name: "Nadia", body: BODY, mode: "full", retired: "Kira" })!
  assert.ok(s.includes("Earlier in THIS conversation you were speaking as Kira"))
  assert.ok(s.includes("You are Nadia now, and only Nadia."))
  assert.ok(
    s.indexOf("speaking as Kira") < s.indexOf("<persona_body>"),
    "the retirement has to be read before the body it reframes",
  )
  // Second, not first: the first thing in the window is still who the model IS.
  assert.ok(s.indexOf("# You are Nadia") < s.indexOf("speaking as Kira"))
})

test("the notice is suppressed when the retired persona IS the active one", () => {
  for (const retired of ["Nadia", "nadia", "  NADIA  "]) {
    const s = buildPersonaSection({ name: "Nadia", body: BODY, retired })!
    assert.ok(!s.includes("is retired"), `${retired} should not be announced against itself`)
  }
  const none = buildPersonaSection({ name: "Nadia", body: BODY, retired: null })!
  assert.ok(!none.includes("is retired"))
})

test("the notice costs about what it is documented to cost", () => {
  const withNotice = estimateTokens(
    buildPersonaSection({ name: "Nadia", body: BODY, tools: ["bash", "read", "write", "edit", "grep"], mode: "full", retired: "Kira" })!,
  )
  const delta = withNotice - estimateTokens(full())
  assert.ok(delta > 150 && delta < 320, `retirement notice is ~${delta} tokens; docs say ~220`)
})

// /persona clear with no successor. The block comes off the system prompt and
// the transcript keeps talking; this is the only thing that says otherwise.
test("clearing a persona still emits a notice, and nothing without one", () => {
  const cleared = buildRetiredVoiceSection("Kira")!
  assert.ok(cleared.startsWith("<persona_cleared>"))
  assert.ok(cleared.trimEnd().endsWith("</persona_cleared>"))
  assert.ok(cleared.includes("no persona, no character, no successor to Kira"))
  assert.ok(!cleared.includes("<active_persona>"))
  const tokens = estimateTokens(cleared)
  assert.ok(tokens > 150 && tokens < 340, `cleared block is ~${tokens} tokens; docs say ~240`)

  assert.equal(buildRetiredVoiceSection(null), null)
  assert.equal(buildRetiredVoiceSection(""), null)
  assert.equal(buildRetiredVoiceSection("   "), null)
})

test("isPromptMode rejects anything that is not a mode", () => {
  assert.ok(isPromptMode("full"))
  assert.ok(isPromptMode("lean"))
  assert.ok(!isPromptMode("verbose"))
  assert.ok(!isPromptMode(""))
})
