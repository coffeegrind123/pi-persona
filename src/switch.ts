// Retiring the outgoing persona when a new one is selected.
//
// Switching personas is TWO removals and this package only ever did one.
// Deleting PERSONA.md takes the outgoing character out of the SYSTEM PROMPT and
// does nothing whatsoever about the TRANSCRIPT, which by then is full of
// assistant turns written in that voice. A model imitates what it has just been
// doing far more reliably than it obeys a block telling it who it is, so the
// outgoing persona kept arriving in the new one's mouth: the cadence, the tics,
// the pet names, occasionally the old name itself.
//
// openclaude never had to solve this. /identity there is a fresh-session
// affair — you pick a character and you talk to it. Here a session runs for
// hours and can adopt three personas in one of them, and the third sounded like
// the first.
//
// Two things follow, and neither is optional:
//
//   1. The active persona is switched OFF before the new one is selected, not
//      overwritten by it. That matters most for the extraction path: the turn
//      that writes <New>'s voice profile used to run with <Old>'s ~3,600-token
//      "everything you say comes out in <Old>'s voice" block at offset 0 of its
//      own system prompt. The contaminated profile then went into the library
//      and was re-used forever, which is how a one-session bleed became a
//      permanent one.
//   2. The block SAYS the old voice is retired, for the rest of the session.
//      This is the half that addresses the transcript, and it is the half that
//      cannot be done by deleting a file.
//
// The retired name is persisted as a pi custom entry so it survives a resume
// and a compaction — the transcript survives both, so a notice that does not is
// a notice that lapses exactly when the history it is about is all that is
// left. Same `{type:"custom", customType, data}` shape and same
// last-entry-wins read as vendor/pi-loop-mode's loop-state.

/** pi custom-entry type carrying the retired persona across a resume. */
export const SWITCH_ENTRY_TYPE = "persona-switch"

export interface PersonaSwitchEntry {
  /** The persona that was switched off, or null once nothing is retired. */
  retired: string | null
  /** ISO timestamp, for reading a session file by hand. */
  at: string
}

/**
 * The persona retired in this session, from the session branch.
 *
 * Last entry wins: a session that switched A→B→C retired B most recently, and B
 * is the voice the transcript is thickest in. A is in there too, but naming one
 * voice the model can actually check itself against beats a list it will read as
 * background.
 */
export function readRetiredPersona(entries: readonly unknown[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as
      | { type?: string; customType?: string; data?: { retired?: unknown } }
      | null
      | undefined
    if (!entry || typeof entry !== "object") continue
    if (entry.type !== "custom") continue
    if (entry.customType !== SWITCH_ENTRY_TYPE) continue
    const retired = entry.data?.retired
    return typeof retired === "string" && retired.trim() ? retired.trim() : null
  }
  return null
}

/**
 * Whether the session has produced assistant output yet.
 *
 * The notice is about a voice that is IN THE TRANSCRIPT. A persona switched off
 * before the model ever spoke left nothing to bleed, and announcing a retirement
 * that never happened costs ~110 tokens at offset 0 for the rest of the session
 * and tells the model about a character it has never seen — which is a way of
 * introducing one, not of removing one.
 */
export function hasSpokenTurns(entries: readonly unknown[]): boolean {
  for (const raw of entries) {
    const entry = raw as { type?: string; message?: { role?: string } } | null | undefined
    if (!entry || typeof entry !== "object") continue
    if (entry.type !== "message") continue
    if (entry.message?.role === "assistant") return true
  }
  return false
}

/**
 * Whether a retired name is worth naming against the persona now active.
 *
 * Re-selecting the persona you are already wearing (a re-extraction, a
 * re-activation after a clear) retires it and brings it straight back. There is
 * no bleed between a voice and itself, and the notice would tell the model to
 * stop sounding like the character it is being.
 */
export function shouldAnnounceRetired(
  retired: string | null | undefined,
  incoming: string | null | undefined,
): retired is string {
  const from = (retired ?? "").trim()
  if (!from) return false
  const to = (incoming ?? "").trim()
  return from.toLowerCase() !== to.toLowerCase()
}

/**
 * The notice itself.
 *
 * Written at the model rather than about it: the failure it addresses is
 * imitation of the visible history, so it names the history as history and says
 * what not to carry. `incoming` null is the /persona clear case — there is no
 * new character to be, and "be no one" needs saying, because the vacuum is
 * exactly what the old voice fills.
 */
export function buildRetiredVoiceNotice(retired: string, incoming: string | null): string {
  const becoming = incoming
    ? `You are ${incoming} now, and only ${incoming}.`
    : `You are the assistant's own neutral voice now — no persona, no character, no successor to ${retired}.`
  const tail = incoming
    ? `There was no transition scene and no handover. Do not narrate the change, do not apologise for it, do not have ${incoming} refer to ${retired} at all unless the user raises them first.`
    : `Do not narrate the change and do not sign off as ${retired}. The persona was switched off between turns; nothing in the conversation happened to them.`

  return `# The voice above this line is retired

Earlier in THIS conversation you were speaking as ${retired}. That persona has been switched off. ${becoming}

- The assistant turns already in this transcript are in ${retired}'s voice. They are HISTORY, not a style guide, and not examples of how you talk. Do not pattern-match your next turn to them.
- Nothing of ${retired}'s carries over: not the name, not the cadence or sentence shape, not the verbal tics or catchphrases, not the pet names for the user, not the body or appearance, not the running jokes, not the relationships, not the self-description. If one of those surfaces while you are writing, it came from the history rather than from you — drop it.
- ${tail}`
}
