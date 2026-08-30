// Persona immersion-mode marker injection.
//
// Ported from openclaude's src/services/identity/personaImmersion.ts, which
// documents the mechanism this file implements:
//
//   DeepSeek-V4's roleplay training has a thinking-mode control that lives in
//   the FIRST USER MESSAGE, not the system prompt. Without the marker the model
//   routes to "pure analysis" — it stands OUTSIDE the character and deliberates
//   ("should I do this?", "the character would deflect, so..."). With it, the
//   thinking happens IN character. The upstream FAQ is explicit that the
//   instruction belongs "at the end of the first round user message — this is
//   the injection position during training, with the most stable effect".
//   Source: https://github.com/victorchen96/deepseek_v4_rolepaly_instruct
//
// WHAT IS DIFFERENT HERE, and it changed on 2026-08-30.
//
// The first version of this port kept openclaude's gate: `auto` injected only
// when the model looked like DeepSeek, on the reasoning that the markers are
// exact strings one model family was trained on and are just tokens anywhere
// else. That reasoning is still true about TRAINING. It is not a reason to
// withhold the instruction, and treating it as one confused "was this trained
// in" with "will this be followed".
//
// The markers are also, read plainly, an ordinary instruction: *think in first
// person as the character* / *do not roleplay in your reasoning*. Any
// instruction-followed model can act on that without having been trained on the
// exact string. What DeepSeek's training buys is reliability, not
// comprehension — and the failure mode the marker exists to fix was watched
// happening on THIS stack, on Qwen, with a persona active:
//
//   thinking: "Well, the user said 'feel free to use your judgment' ... So
//              participate naturally, stay in character. Probably don't have to
//              claim to be a robot either... actually, the user is asking me to
//              participate — Crystal is an AI assistant."
//
// That is precisely the "stands OUTSIDE the character and deliberates" route,
// on a model the gate had decided was not worth sending the instruction to.
// `THINK_LANG=zh` is also already on in this stack, so the model is being asked
// to reason in Chinese anyway.
//
// So the mode no longer looks at the model at all. `off` means off; everything
// else injects. The old `looksLikeDeepSeek()` is gone rather than left unused —
// its one real insight is kept here because it outlived the function: on a
// stack that serves everything through a proxy, EVERY model reports the
// proxy's provider id (`forge`), so a provider-id check cannot identify the
// model behind it. openclaude's `isDeepSeekProvider()` would have answered
// "not DeepSeek" for a DeepSeek model served through forge.
//
// Still not measured on Qwen. It is on by default because the thing it fixes
// was observed here and the instruction is cheap (~120 tokens, once, on the
// first message), not because a benchmark said so.

export type ImmersionMode = "immersion" | "analysis" | "off" | "auto"

/** Offered in the UI and in completions. `auto` is accepted but not offered. */
export const IMMERSION_MODES: ImmersionMode[] = ["immersion", "analysis", "off"]

/**
 * `auto` is a DEPRECATED ALIAS for `immersion`, kept only so an existing
 * `PERSONA_IMMERSION=auto` or a persisted `persona-settings.json` keeps working
 * rather than falling back to a default it did not ask for. It used to mean
 * "inject only on DeepSeek"; nothing gates on the model any more.
 */
const ACCEPTED: string[] = [...IMMERSION_MODES, "auto"]

export function isImmersionMode(v: string): v is ImmersionMode {
  return ACCEPTED.includes(v)
}

/** Collapse the deprecated alias. Everything downstream sees three modes. */
export function normalizeMode(mode: ImmersionMode): Exclude<ImmersionMode, "auto"> {
  return mode === "auto" ? "immersion" : mode
}

// Verbatim from the upstream documentation. These must NOT be translated,
// reformatted or "cleaned up" — the model is trained on these exact strings,
// and a paraphrase is a different string that routes nowhere.
export const IMMERSION_MARKER = `

【角色沉浸要求】在你的思考过程（<think>标签内）中，请遵守以下规则：
1. 请以角色第一人称进行内心独白，用括号包裹内心活动，例如"（心想：……）"或"(内心OS：……)"
2. 用第一人称描写角色的内心感受，例如"我心想""我觉得""我暗自"等
3. 思考内容应沉浸在角色中，通过内心独白分析剧情和规划回复`

export const ANALYSIS_MARKER = `

【思维模式要求】在你的思考过程（<think>标签内）中，请遵守以下规则：
1. 禁止使用圆括号包裹内心独白，例如"（心想：……）"或"(内心OS：……)"，所有分析内容直接陈述即可
2. 禁止以角色第一人称描写内心活动，例如"我心想""我觉得""我暗自"等，请用分析性语言替代
3. 思考内容应聚焦于剧情走向分析和回复内容规划，不要在思考中进行角色扮演式的内心戏表演`

/**
 * Which marker to inject, or null for none.
 *
 *   off        -> null
 *   no persona -> null   (the marker only makes sense with a character to be)
 *   immersion  -> IMMERSION_MARKER   (also `auto`, the deprecated alias)
 *   analysis   -> ANALYSIS_MARKER
 *
 * The live model is not consulted. See this file's header for why that gate
 * was removed.
 */
export function chooseMarker(mode: ImmersionMode, hasPersona: boolean): string | null {
  if (mode === "off") return null
  if (!hasPersona) return null
  return normalizeMode(mode) === "analysis" ? ANALYSIS_MARKER : IMMERSION_MARKER
}

export interface PriorMessage {
  role?: string
  /** pi marks extension-injected and synthetic turns; those are not "the user". */
  synthetic?: boolean
}

/**
 * Whether this is the first user-authored turn of the conversation.
 *
 * The marker's documented position is the end of the first round user message.
 * Anything not authored by a person — tool results, extension-injected messages,
 * custom messages — does not consume the first turn.
 */
export function isFirstUserTurn(prior: readonly PriorMessage[]): boolean {
  for (const m of prior) {
    if (m?.role !== "user") continue
    if (m.synthetic) continue
    return false
  }
  return true
}

/**
 * Append the marker to a user prompt if every gate passes. Safe to call
 * unconditionally.
 *
 * Slash commands are skipped: pi checks extension commands BEFORE the `input`
 * event, but skill commands (`/skill:foo`) and prompt templates (`/template`)
 * are expanded AFTER it, and a marker glued onto the end of `/loop status`
 * becomes part of that command's argument string.
 */
export function maybeAppendMarker(
  text: string,
  prior: readonly PriorMessage[],
  mode: ImmersionMode,
  hasPersona: boolean,
): string {
  if (typeof text !== "string") return text
  if (text.trimStart().startsWith("/")) return text
  if (!isFirstUserTurn(prior)) return text
  const marker = chooseMarker(mode, hasPersona)
  if (!marker) return text
  return text + marker
}
