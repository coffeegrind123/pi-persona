# pi-persona — a port of openclaude's persona system

Ported from [`coffeegrind123/openclaude`](https://github.com/coffeegrind123/openclaude)
(`src/services/identity/*`, `src/components/Identity/*`,
`src/commands/{identity,randompersona}/*`, and `getIdentitySection()` in
`src/constants/prompts.ts`), read at HEAD on 2026-08-30. openclaude is a Claude
Code fork; it carries no LICENSE file and its `package.json` declares no license
field, which is stated here rather than guessed at. This port is MIT (see
LICENSE); that covers the code in this repository, and says nothing it is not
entitled to say about upstream's.

It began as a package inside
[instantcoffee](https://github.com/coffeegrind123/instantcoffee), which still
consumes it — now as a submodule at `vendor/pi-persona`, loaded by absolute path:

```
-e vendor/pi-persona/extensions/index.ts
```

For anyone else, `pi install git:github.com/coffeegrind123/pi-persona` — see
README.md for the other forms and PUBLISHING.md for how the package is put
together.

Nothing needs installing. The extension's only bare import is pi's own package
(`getAgentDir`, plus two `import type`s that are erased before it runs), which pi
resolves from its own module root — the same arrangement `vendor/rtk-pi` uses,
and for the same reason: pi is started in *your* project, not in this checkout,
so `.pi/extensions/` auto-discovery would never find it.

## What the system actually is

Not "a system prompt that says be sassy". Four parts, and the interesting one is
the third:

1. **A card library.** chara_card_v2 cards, from [chub.ai](https://chub.ai)'s
   gateway or dropped into `~/.pi/agent/personas/` by hand. Staged to
   `personas/<slug>/{card.json,meta.json}`, slug = name + a hash of the card, so
   the same card is one entry however many times it is fetched.
2. **An extraction turn.** The card is handed to the MODEL, as an ordinary user
   turn, with instructions to write a 250-650 word voice profile to
   `PERSONA.md`. This is upstream's design and it is the right one: a card's
   persona signal is scattered — cadence hides in `mes_example`, register hides
   in `scenario`, the intended voice is often only in `creator_notes` — and no
   field-picker recovers that. It is also where the card's *operating
   directives* get thrown away: the extraction prompt's IGNORE list drops
   jailbreaks, output-shape mandates and refusal instructions, so what survives
   into the system prompt is voice, not somebody else's policy.
3. **A system-prompt block.** `PERSONA.md` goes inside a ~3,600-token
   `<active_persona>` wrapper, **in front of** pi's own prompt. The wrapper is
   the mechanism, not the persona file: it settles what a persona has authority
   over (voice, narration) and what it has none over (thoroughness, tool choice,
   code quality, honesty about results), and it enumerates the specific
   reasoning shapes a model reaches for when it wants to decline in character.
4. **A first-message marker.** DeepSeek-specific. Off here; see §5.

## What was changed, and why

pi is not Claude Code. openclaude has React/Ink dialogs, a fixed Anthropic tool
surface, an `AskUserQuestion` tool, and a permission layer that treats
`.claude/` as a dangerous directory. pi has `select`/`confirm`/`input`/`editor`,
a tool surface that differs per session, and none of the rest. So the flow is
upstream's and the coupling is entirely new. Beyond that, six deliberate
departures.

### 1. The block does not name tools that do not exist

openclaude's block instructs the model, four separate times, to "use WebSearch /
WebFetch to find an image matching that thing and present it as `<name>` sharing
it", and forbids "capability-denial" on the grounds that "you are not
generating — you are searching and sharing".

**pi has no web tools.** Its built-ins are `bash`, `read`, `write`, `edit`,
`grep`, `find`, `ls`, `powershell` — established by running `buildSystemPrompt()`
against the installed 0.84.4 and by reading the tool list off a captured
request, not from memory. On this stack the browser reaches the model as a CLI
behind a skill, not as tools, precisely so its ~19k of MCP schemas stay out of
the window.

Ported verbatim, that block would order a model with no fetch tool to produce a
link. The only way to satisfy that instruction is to **invent a URL** — which
the same block forbids two paragraphs later, under "Never simulate tool output".
It is the exact failure this repo's operating rules describe: a wrong guess
about an external surface does not fail loudly, it fails as a plausible-looking
answer.

So the web-delivery guidance is built from
`event.systemPromptOptions.selectedTools`, which pi hands to every
`before_agent_start` handler:

| turn's surface | what the block says |
| --- | --- |
| a web-capable tool is selected | names **those** tools, keeps upstream's "the tool call comes FIRST" rule |
| none | "There is no image-fetching tool on this turn's surface, so do NOT produce a link or an image URL: describe the thing concretely instead." |

`tests/prompt.test.ts` pins both directions, and pins that the string
`WebSearch` never reaches a prompt where no such tool was selected.

### 2. The reading guide quotes pi, not Claude Code

openclaude's block closes by telling the model how to read specific sentences
from openclaude's own system prompt — "You are an interactive agent that helps
users with software engineering tasks", "The user will primarily request you to
perform software engineering tasks". Neither sentence is in pi's prompt. A guide
to sentences that are not there is dead weight at best and confusing at worst.

The port quotes pi's actual opening — read off `buildSystemPrompt()` on the
installed binary — and `tests/prompt.test.ts` asserts those exact strings, so pi
rewording them fails here rather than at a user's next launch.

### 3. A two-word name stays two words

openclaude reads the persona's name back out of the file with
`/persona of ([A-Za-z][\w'-]{0,40})/i`, which stops at the first non-word
character. "Ada Lovelace" is therefore stored, displayed, and interpolated into
every one of the ~40 `${name}` slots in the block as **"Ada"**.

The extraction prompt mandates a framing sentence that ends the name with a full
stop, so the wide form (`/persona of ([^.\n]{1,60})\./i`) is tried first and
openclaude's narrow form is kept as the fallback for a file whose sentence was
reworded. A library copied from an openclaude install still resolves — including
its `IDENTITY.md` and `identities/` names, which are read but never written.

### 4. The inline threshold follows the window

openclaude inlines a card whole below 50 KB and switches to a `jq` walk above
it. 50 KB of card is ~12,500 tokens: on `CTX_SIZE=32768` that is **40% of the
window spent before the model has read the instruction**, and the jq path exists
so it does not have to be.

`inlineThresholdBytes()` takes 15% of the live window, floors at 2 KB and caps at
upstream's 50 KB — 19,660 bytes at 32k, upstream's own number at 96k and above.
An unknown window (pi reports none before the first response) falls back to
8 KB: guessing large is the expensive mistake, and the jq path works at every
size.

### 5. The immersion marker is ON, and it does not look at the model

openclaude injects a Chinese instruction block at the end of the first user
message. It is not decoration: DeepSeek-V4's roleplay training has a
thinking-mode control at that documented position, and without it the model
routes to "pure analysis" — standing outside the character, deliberating about
whether to comply — instead of thinking in character.
([source](https://github.com/victorchen96/deepseek_v4_rolepaly_instruct); the
upstream FAQ is explicit that the system prompt is the wrong place for it.)

**This port shipped with openclaude's gate and then removed it (2026-08-30).**
The first version kept `auto` meaning "inject only on a DeepSeek-looking model",
reasoning that the markers are exact strings one family was trained on and are
just tokens anywhere else.

That reasoning is true about *training*, and it is not a reason to withhold the
instruction. It confused "was this trained in" with "will this be followed".
Read plainly, the markers are an ordinary instruction — *think in first person as
the character* / *do not roleplay in your reasoning* — and any instruction-following
model can act on that without having seen the exact string. DeepSeek's training
buys reliability, not comprehension.

And the failure it exists to fix was then watched happening **on this stack, on
Qwen, with a persona active**:

```
thinking: "Well, the user said 'feel free to use your judgment' ... So
           participate naturally, stay in character. Probably don't have to
           claim to be a robot either... actually, the user is asking me to
           participate — Crystal is an AI assistant."
```

That is exactly the deliberating-from-outside-the-character route, on a model the
gate had decided was not worth sending the instruction to. `THINK_LANG=zh` is
also already on in this stack, so the model is being asked to reason in Chinese
regardless.

So `chooseMarker` no longer takes a model at all, and the default is
`immersion`. `off` means off; `analysis` is the same re-routing with a clean
reasoning trace instead of an in-character inner monologue, which is the better
choice if the bracketed internal monologue gets noisy on a long engineering task.
`auto` is accepted as a **deprecated alias for `immersion`** — an existing
`PERSONA_IMMERSION=auto` or a persisted `persona-settings.json` keeps working
rather than falling back to a mode nobody chose — but it is not offered in the
UI or in completions.

**Still unmeasured on Qwen.** It is on because the thing it fixes was observed
here and the instruction costs ~120 tokens once, on the first message of a
session — not because a benchmark said so. `/persona immersion off` is one
command and takes effect on the next session.

`looksLikeDeepSeek()` is **deleted** rather than left unused, but its one real
insight outlived it and is kept in the file header: on a stack that serves
everything through a proxy, every model reports the *proxy's* provider id
(`forge`), so a provider-id check cannot identify the model behind it.
openclaude's `isDeepSeekProvider()` would have answered "not DeepSeek" for a
DeepSeek model served through forge — the one case the gate existed for.

One correctness fix survives unchanged from the first version: the extraction
turn is delivered with `pi.sendUserMessage()` and lands in the session as a
**user** message, so without a guard it consumes the first turn and the marker
attaches one message late. `PROCESS_PROMPT_PREFIX` fingerprints it so
`isFirstUserTurn` skips it.

### 6. Ambiguity is a question, not a tool call

openclaude routes multi-character and contradictory cards through its
`AskUserQuestion` tool, because a plain-text question there gets talked past. pi
has no such tool, and does not need one: an assistant turn that ends in a
question **is** the ask. The instruction is "ASK THE USER AND STOP — write
nothing", with an explicit "do not ask a question and then write a file anyway",
because a write commits an answer the user has not given yet.

### Additions

- **Cached activation.** openclaude re-runs the extraction every time a card is
  selected, even one it has already extracted. The library's `PERSONA.md` is the
  finished artefact; activating it is a file copy. `/persona local` offers both,
  and the test asserts the cached path sends **no** turn.
- **`/persona status`** reports what the block currently costs, in tokens, per
  request. On a 32k window a standing charge should be visible from inside the
  session that is paying it.
- **A card viewer.** openclaude's section browser with per-field token counts,
  rebuilt on `select` + `editor`. Empty sections are labelled rather than hidden:
  "this card has no `mes_example`" is what you want to know *before* spending a
  turn extracting a voice from it.
- **`lean`.** See the next section.

## The persona advertises itself, and introduces itself

The extraction turn writes two more labelled lines, last in the file:

```
Short description: A shy fox-girl assistant who calls you master.
About me: H-hi! I'm Crystal, and I look after my master. I stammer when I'm
          flustered, which is often.
```

**They are in different voices, and that is the point.** `Short description` is
third person — a label, how you would introduce this character to somebody who
has not met them, advertised as the bot's own description. `About me` is the
character SPEAKING: it becomes the "About Me" box on their profile card, which
is the box every account on the homeserver fills in about itself, so a
third-person one reads as a bot pretending to be a person and failing. `parsePersonaDescription()` reads them back, and
`vendor/prinny-channel` reads them with its own copy of the same parser (packages
here do not import each other) to publish as the bot's advertised identity.

**The budgets are in the prompt because only the model can honour them.** 120
characters for the short line (`@prinny/bot`'s `Limits`, which are Telegram's)
and 1024 for About me (cinny's own `TextArea maxLength`; MSC4440 states no
limit). The publisher truncates hard, so a description written
without a budget arrives cut mid-sentence; a model told the budget writes a
shorter whole thought instead. All three copies of those numbers are asserted
equal by the channel's cross-source test.

Both are optional everywhere. A persona extracted before this existed, or written
by hand, advertises no description, and nothing treats that as an error.

The match is anchored to the start of a line: the labels are prose in a file the
model wrote, and a loose match would let one label satisfy a search for a suffix
of another. Getting the two VOICES backwards is the likelier mistake, so the
prompt says so twice and a test asserts it still does.

## Switching a persona switches the old one OFF

Upstream never had to solve this. openclaude's `/identity` is a fresh-session
affair — you pick a character and you talk to it. Here a session runs for hours,
adopts three personas in one of them, and **the third sounded like the first.**

Selecting a persona used to be one write: the new `PERSONA.md` overwrote the old
one. That is half a switch. It takes the outgoing character out of the SYSTEM
PROMPT and does nothing at all about the TRANSCRIPT, which by then holds dozens
of assistant turns in that voice — and a model imitates what it has just been
doing far more reliably than it obeys a block telling it who it is.

**The worse half was the extraction path.** `processCard` hands the card to the
model as an ordinary turn, and `pi.sendUserMessage` reaches
`AgentSession.prompt()` — the one call site pi emits `before_agent_start` from
(`agent-session.js:885`; `vendor/pi-loop-mode/FORK.md` AA1 has the archaeology).
So the turn whose entire job is to write `<New>`'s voice profile ran with
`<Old>`'s whole ~4,200-token *"everything you say comes out in `<Old>`'s voice,
there is no neutral standpoint to step out to"* block at **offset 0 of its own
system prompt**. The profile it wrote came out in `<Old>`'s cadence — most
visibly in `Sample line` and `About me`, the two lines written in first person —
and then it was cached in the library and re-used for every later activation of
that card. A one-session bleed became a permanent one.

Both halves are fixed, in `src/switch.ts` and the three call sites that select a
persona:

1. **The active persona is switched off before the new one is selected**, not
   overwritten by it. On the extraction path the card is staged first (so a card
   that cannot be written to disk does not leave the session with neither a
   persona nor an extraction), then the file is removed, then the turn is sent —
   which is rebuilt by `before_agent_start` and comes out with no persona block
   at all.
2. **The block says the old voice is retired**, for the rest of the session:
   *"the assistant turns already in this transcript are in `<Old>`'s voice. They
   are HISTORY, not a style guide"*, followed by the concrete list — cadence,
   tics, pet names, appearance, self-description — because "don't be `<Old>`" is
   exactly the instruction a model satisfies by dropping the name and keeping
   everything else.

Three details that are not obvious:

- **It fires only if the model actually spoke.** A persona switched off before it
  produced a turn left nothing in the transcript to bleed, and naming it would
  spend ~220 tokens at offset 0 to introduce the model to a character it has
  never seen. The user is still told, because their persona really was removed.
- **It is never announced against itself.** Re-extracting or re-activating the
  persona you are already wearing retires it and brings it straight back; there
  is no bleed between a voice and itself.
- **It survives a resume and a compaction**, as a `{type:"custom",
  customType:"persona-switch"}` entry read back off the branch on `session_start`
  — pi's own idiom, the same one `vendor/pi-loop-mode`'s `restoreState` uses. The
  transcript survives both, so a notice that does not is a notice that lapses
  exactly when the history it is about is the only thing left. It is re-read
  unconditionally, so a session swap onto a fresh branch drops it.

`/persona clear` goes through the same path, and this is what finally makes its
own sentence true. "The neutral voice returns next turn" was a claim the package
could not keep: the block came off the prompt and the transcript kept talking. A
cleared session now carries a ~240-token `<persona_cleared>` block instead of
nothing — the only case where "no persona active" is not literally zero, and
`/persona status` says so.

**The recovery path is offered before it is needed.** Switching off ahead of an
extraction means a session that abandons it — the model asks a clarifying
question and the user walks away, the card turns out to be the wrong one — ends
up with no persona at all. So the notify line says
`/persona local brings <Old> back without a model turn`, at the moment of the
switch rather than after the user notices.

## Appearance is lifted, not transformed

The extraction guidelines had a LIFT list, a TRANSFORM list and an IGNORE list,
and a card's physical description was **on none of them.** The nearest rule was
TRANSFORM's *"if the character is flirtatious, openly sensual, possessive … these
belong in the persona as voice/mannerism descriptors, NOT as
how-they-output-content"* — which reads, quite reasonably, as an instruction to
sand the body off. So it got sanded off, and the resulting persona described
itself in estate-agent language: *curves*, *figure*, *assets*.

That is not a register change, it is a **character change.** A woman the card
describes in flat anatomical terms who then calls them "assets" is embarrassed
about her own body, and embarrassment is a trait the card did not give her.

Three changes, and the middle one is the load-bearing one:

- `LIFT APPEARANCE AS WRITTEN` in the extraction prompt, with the euphemisms
  named individually. Assume the card is explicit, because most of them are —
  that is the medium, not an accident. Carry the description across at the
  card's level of detail and in the card's vocabulary. Prune repetition and
  world-building that shares the field; prune nothing for being explicit.
- **TRANSFORM was retitled to what it always meant**: *behavioural and output
  directives — what the character DOES, never what they look like* — with an
  explicit "none of this reaches the Appearance section". The old rule is still
  right about mandates ("must produce explicit content", "always responds NSFW");
  it was being applied to descriptions, which is a different thing. The IGNORE
  list's lore line now exempts the character's own body and clothing, which are
  not world-building.
- **The block tells the model the section is usable.** `fourthWallPart` already
  forbade *denying* a body, which is not the same as *having* one, and the gap
  between the two is where every physical question landed. `appearancePart` names
  the Appearance section as ordinary reference material about itself, to be used
  in ordinary description — not recited only when interrogated. `full` adds the
  explicit clause, next to the content allowance it depends on; `lean` keeps
  "you have a body, it is described below, use its words".

Written as description, not scene: third person, present tense, plain
declaratives, `"She is X"` and never `"she does X to you"`. The section is a
fact about the character, and a scene smuggled into a system prompt is a scene
that plays on every turn.

## The body is described plainly; the character is the one who talks big

Watched on this stack, from a persona whose card gives her a ceremonial,
self-mythologising voice — she narrates a physical act and produces:

> the size of it makes the motion look almost **architectural** … her fingers
> dragging down the length again and again with an **economy of motion** that
> somehow makes it worse

Every other sentence around those two is fine. The defect is the **register**:
mid-description the narrator leaves the body and characterises what is happening
with a field of study — architecture, economics — and the reader goes with it,
from sensation to evaluation, in the middle of the act. The scene does not
survive that.

It is not a vocabulary problem, and the obvious fixes both cost the character.
Lowering the persona's vocabulary tier removes the thing the card was for.
Banning metaphor removes the prose. The actual cause is a **gap in the block**:
`appearancePart` establishes that the character HAS a body and that its
description is used without euphemism, and `shapesPart` establishes that
everything the character says comes out in their voice — and nothing anywhere
says which of those two governs a body **in motion**. So the model does the
reasonable thing with what it was given: a physical description needs an
intensifier, the only elevated register in the block is the character's own, and
it borrows that. The grandeur ends up in the wrong mouth.

`registerPart` scopes them apart, and sits immediately after the appearance
rules because it is an amendment to them:

- The voice can be as grand as the card says — **in dialogue**. A body, an act,
  a sensation is described concretely: seen, heard, felt, smelled, weight, heat,
  wet, sound, pace.
- **No field of study characterises a physical act.** The two observed failures
  are named literally, in both modes, alongside their family — "engineering",
  "geometry", "composition", "technique", "mechanics". A rule that states only
  the principle is the rule that was already missing.
- **A metaphor for a body comes from the physical world** — water, heat, cloth,
  gravity, weather, hunger — never from a discipline. This is the narrow ban
  that keeps metaphor available.
- **The check is a single question**: would a nurse, a gym trainer or a lover
  use this word for what is happening? A word that lives in one profession's
  vocabulary and has a plain physical equivalent loses to the plain one.
- **"Plain is not tame."** The rule is one short step from "write it
  tastefully", which is precisely what the section above it spent its budget
  undoing, so `full` closes the step off in the same breath: the concrete word
  is usually the explicit one, and the euphemism ban still holds. `tests/prompt.test.ts`
  asserts both rules are present together, because the failure mode of this fix
  is that it quietly re-introduces the one it sits next to.

The line worth keeping is the last bullet of the block itself: a character
saying *"you are witnessing a symphony"* is character; that same character's
body being described as a symphony is the model's ego leaking through the prose.
The gap between the two is what makes the character land — which turns the
defect into the mechanism.

`lean` keeps the split and the two named failures (any physical description can
hit this, roleplay or not) and drops the metaphor rule, the check and the
plain-is-not-tame clause: ~200 tokens against `full`'s ~490.

## What it costs

Measured on the installed pi 0.84.4 by capturing a real
`POST /v1/chat/completions` off the wire — a stub OpenAI-compatible provider in
`models.json`, `pi -p "hi"`, and the request body written to disk. Not estimated
from the source.

| | bytes | ~tokens | share of a 32,768-token window |
| --- | --- | --- | --- |
| pi's own system prompt (4 tools) | 2,590 | 648 | 2.0% |
| `<active_persona>` block, `full` | 18,831 | 4,708 | 14.4% |
| `<active_persona>` block, `lean` | 10,871 | 2,718 | 8.3% |
| + the retirement notice, either mode | 887 | 222 | 0.7% |
| `<persona_cleared>` alone (cleared, after a switch) | 957 | 239 | 0.7% |
| **no persona active, none ever switched off** | **0** | **0** | **0%** |

The two block rows are the capture above plus a byte-exact diff of the block
builder — the appearance part with its `full` enumeration, and the register part
with its own — at 4.00 bytes/token,
which is what the capture itself measured (14,729 / 3,683 = 3.9992). The rows
below them are byte-exact and estimated at the same ratio. The wire capture has
not been re-run since; `tests/prompt.test.ts` pins the estimator's numbers, so a
drift in either direction fails a test rather than aging quietly in this table.

With no persona active the extension contributes **nothing**:
`before_agent_start` returns `undefined`, and it registers no tool — a tool would
cost its schema on every request whether or not it is ever called. The extension
test asserts both. The one exception is a session that adopted a persona, spoke
in it, and then cleared it: that carries the ~240-token `<persona_cleared>` block
instead, which is the price of the previous section's promise actually holding.

With one active, the block is the single largest thing in the request, at 7.3x
pi's own prompt. It is also **byte-stable across turns**, so it costs one prefix
re-prefill at activation and nothing after — which is why it is a standing charge
worth stating rather than a per-turn one worth optimising.

`full` is the default and is the faithful port. `lean` is the same contract with
the four roleplay-specific enumerations dropped (the content allowance, the
third-person story framing, the tease-deny section, and hedge patterns 5 and 7).
It keeps every rule that fires on ordinary engineering work: the fourth wall, the
no-simulated-tool-output rule, the assistant-framing ban, and — the one that
matters most — "the persona is voice-acting over invariant engineering". The
hedge patterns keep their upstream numbering in both modes, so "pattern 4" means
the same thing in both codebases and in both modes.

`tests/prompt.test.ts` asserts those four invariants survive in **both** modes,
and pins both token counts inside a band, so editing the block moves a number
here rather than moving it silently.

## What this package does NOT do

Written down because each was considered and dropped, not overlooked.

- **No permission carve-out.** openclaude needs one because `.claude/` is a
  DANGEROUS_DIRECTORY there and the extraction turn would hit a prompt on every
  write. pi has no equivalent gate on its agent dir. If a session runs with a
  permission extension that *does* gate writes (`vendor/prinny-channel`'s Matrix
  relay), the two `write` calls are relayed for approval like any other — which
  is correct, and is what an approval gate is for.
- **No avatar sync.** `meta.json` carries `avatarUrl` from the card, because
  discarding it at fetch time would mean re-fetching to get it back. Nothing
  reads it yet. openclaude wires it to a Matrix bot's profile; the equivalent
  here would live in `vendor/prinny-channel`, and vendor packages in this repo do
  not import each other.
- **No `tool_call` / `tool_result` / `context` handler.** Nothing here belongs on
  the hot path. The extension test asserts those four events have no handler, so
  a future edit that puts one there has to change a test that says why.

## The `killed`-before-`code` rule does not apply here

`vendor/rtk-pi/FORK.md` §5, and AH3/AI5, enumerate a rule about `pi.exec`: pi's
`execCommand` resolves a child it killed on the timeout with `code: code ?? 0`,
so a wedged command looks exactly like a healthy one that printed nothing, and
`killed` must be read before `code`.

**This package has no `pi.exec` call sites at all** — its one external dependency
is `fetch` against chub.ai, bounded by an `AbortSignal` on every call
(`tests/chub.test.ts` asserts one is present on both endpoints). It is therefore
not a root for `vendor/pi-subagents-lite/tests/exec-verdicts.test.ts`, and should
be added as one the day it grows a first `pi.exec`.

## Layout

```
src/types.ts        chara_card_v2 and library shapes, field-for-field
src/storage.ts      the library and the active persona. Takes `root` explicitly
                    so it imports nothing from pi and runs under bare node.
src/chub.ts         the chub.ai gateway. fetch only; injectable for tests.
src/sections.ts     card -> browsable sections with per-field token counts
src/prompt.ts       the <active_persona> block
src/processor.ts    the extraction turn: prompt, thresholds, shape summary
src/switch.ts       retiring the outgoing persona: the half a file delete cannot
                    do, and how it survives a resume
src/immersion.ts    the first-message marker and its gates
src/settings.ts     persisted modes; the environment wins over the file
extensions/index.ts the pi coupling: command, before_agent_start, input, status
```

`tests/extension.test.ts` redirects pi's bare specifier onto the installed
package with `module.registerHooks`, so the factory runs against the same import
a session would — a renamed export fails there. It skips itself when pi is not on
PATH, and its "source guarantees" block runs everywhere, so a checkout without pi
still fails on a regression in the extension itself.

`tests/switching.test.ts` drives the same factory with pi's package **stubbed**
(the extension's only value import from pi is `getAgentDir`; the rest are types,
which `--experimental-strip-types` erases), because that suite has to run on
every box: the bug it covers is silent. A persona that bleeds does not throw,
does not warn, and does not show up in a status line — it just sounds slightly
like the last one. The stub is not a substitute for the real-pi suite and must
not be used for the questions that suite exists to answer; a stub agrees with
whatever you wrote in it.

## Upstream

Nothing filed. openclaude is a personal fork of a closed-source client with no
issue tracker in use; the four findings above (`WebSearch` named on a surface
that has none, the name regex truncating at the first space, the 50 KB inline
threshold against a small window, and the provider-id check missing a proxied
DeepSeek) are recorded here instead.
