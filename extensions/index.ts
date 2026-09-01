// persona for pi — a character persona over invariant engineering.
//
// A port of openclaude's /identity persona system (coffeegrind123/openclaude,
// src/services/identity/* and getIdentitySection() in src/constants/prompts.ts).
// See ../FORK.md for what changed and why; the short version is that openclaude
// is a Claude Code fork with React TUI dialogs and a fixed tool surface, and pi
// has neither, so the flow is the same and the coupling is entirely different.
//
// Every decision lives in ../src/*.ts, which import nothing from pi so they can
// be tested with bare node. This file is the pi coupling and nothing else — the
// same split vendor/rtk-pi uses.
//
// The window cost, measured (see FORK.md): with no persona active this
// extension contributes ZERO tokens — before_agent_start returns undefined and
// nothing is registered on the tool surface. With one active it prepends a
// block of ~4,215 tokens (`full`) or ~2,516 (`lean`) that is byte-stable across
// turns, so it costs one prefix re-prefill at activation and nothing after.
//
// One exception, and it is deliberate: a session that adopted a persona, spoke
// in it, and then switched or cleared it carries a retirement notice (~220
// tokens inside the block, ~240 as a `<persona_cleared>` block of its own). That
// is the half of a persona switch a file deletion cannot do — the transcript is
// still full of the old voice — and FORK.md's "Switching a persona switches the
// old one OFF" has the account.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename } from "node:path"

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent"

import {
  downloadCard,
  isSortMode,
  PAGE_SIZE,
  searchCharacters,
  SORT_HINT,
  SORT_MODES,
} from "../src/chub.ts"
import {
  IMMERSION_MODES,
  isImmersionMode,
  maybeAppendMarker,
  normalizeMode,
  type PriorMessage,
} from "../src/immersion.ts"
import {
  buildPersonaSection,
  buildRetiredVoiceSection,
  estimateTokens,
  isPromptMode,
  PROMPT_MODES,
} from "../src/prompt.ts"
import {
  buildProcessPrompt,
  inlineThresholdBytes,
  isProcessPrompt,
} from "../src/processor.ts"
import { loadSettings, saveSettings, type PersonaSettings } from "../src/settings.ts"
import {
  hasSpokenTurns,
  readRetiredPersona,
  shouldAnnounceRetired,
  SWITCH_ENTRY_TYPE,
} from "../src/switch.ts"
import { describeCard, flattenCardForViewer } from "../src/sections.ts"
import {
  clearActive,
  getActivePersonaName,
  getActivePersonaPath,
  invalidateNameCache,
  listLocalPersonas,
  listLooseCardJsonFiles,
  parsePersonaName,
  readActivePersona,
  readCard,
  resolveActivePersonaPath,
  stageCardForProcessing,
} from "../src/storage.ts"
import type { CharaCardV2, ChubSearchNode, SortMode } from "../src/types.ts"

const COMMAND = "persona"
const STATUS_KEY = "persona"
const NETWORK_TIMEOUT_MS = 15_000

const SUBCOMMANDS = [
  "local",
  "chub",
  "search",
  "random",
  "show",
  "status",
  "clear",
  "immersion",
  "prompt",
] as const

export default function personaExtension(pi: ExtensionAPI) {
  // Resolved once. getAgentDir() honours pi's own ENV_AGENT_DIR, so a session
  // pointed at a different agent home gets that home's library — which is the
  // point of Dockerfile.pi giving each pi session a home of its own.
  const root = getAgentDir()
  let settings: PersonaSettings = loadSettings(root)

  /**
   * A persona this session switched off, and had already spoken in.
   *
   * Restored from the session branch on every `session_start`, so a resumed or
   * compacted session keeps the notice: the transcript survives both, and a
   * notice that lapses exactly when the history it is about is the only thing
   * left is the wrong way round. See ../src/switch.ts.
   */
  let retiredPersona: string | null = null

  /**
   * The session's entries, preferring the BRANCH.
   *
   * `getBranch()` is the active conversation path — the one pi replays and the
   * one custom entries are read back off (vendor/pi-loop-mode's `restoreState`
   * is the same call). `getEntries()` is the fallback for a pi that predates it
   * and for the test harness; both are wrapped because either can throw on a
   * context that has been invalidated by a session swap.
   */
  function sessionEntries(ctx: ExtensionContext): readonly unknown[] {
    const sm = ctx.sessionManager as unknown as {
      getBranch?: () => unknown[]
      getEntries?: () => unknown[]
    }
    try {
      const branch = sm?.getBranch?.()
      if (Array.isArray(branch)) return branch
    } catch {
      /* fall through to getEntries */
    }
    try {
      return sm?.getEntries?.() ?? []
    } catch {
      return []
    }
  }

  /**
   * Switch the current persona OFF, and remember whose voice the transcript is
   * now carrying.
   *
   * Every path that selects a new persona goes through this first — activation
   * from the library, extraction from a card, and `/persona clear`. Switching
   * off is not the same as overwriting: the extraction path in particular used
   * to run the turn that writes <New>'s voice profile with <Old>'s whole
   * `<active_persona>` block at offset 0 of its system prompt, and the
   * contaminated profile was then cached in the library and re-used for every
   * later activation of that card. See ../src/switch.ts for the full account.
   *
   * `removed` and `retired` are separate answers to separate questions: a
   * persona file whose framing sentence cannot be parsed is still a persona that
   * was switched off, and reporting it as "there was no active persona" would be
   * a lie told by a regex.
   */
  function retireActive(ctx: ExtensionContext): { removed: boolean; retired: string | null } {
    const outgoing = getActivePersonaName(root)
    const removed = clearActive(root)
    if (!removed || !outgoing) return { removed, retired: null }
    // Recorded only when the model has actually spoken. A persona switched off
    // before it ever produced a turn left nothing in the transcript to bleed,
    // and naming it would spend ~220 tokens at offset 0 for the rest of the
    // session introducing the model to a character it has never seen. The USER
    // is still told — their persona really was removed.
    if (!hasSpokenTurns(sessionEntries(ctx))) return { removed, retired: outgoing }
    retiredPersona = outgoing
    try {
      pi.appendEntry(SWITCH_ENTRY_TYPE, { retired: outgoing, at: new Date().toISOString() })
    } catch (err) {
      // The in-memory copy still carries the session; only a resume loses it.
      console.warn("[persona] could not persist the persona switch", err)
    }
    return { removed, retired: outgoing }
  }

  // ── status line ──────────────────────────────────────────────────────────
  // The one visible sign that a persona is on. Without it a session that
  // adopted a persona three compactions ago looks exactly like one that did
  // not, and the model's voice is the only evidence.
  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return
    const name = getActivePersonaName(root)
    ctx.ui.setStatus(STATUS_KEY, name ? `✦ ${name}` : undefined)
  }

  pi.on("session_start", async (_event, ctx) => {
    settings = loadSettings(root)
    // Per SESSION, and this module is per PROCESS: a swap must not carry the
    // previous session's retirement into a branch that never had that voice in
    // it. Read unconditionally, so an empty branch clears it.
    retiredPersona = readRetiredPersona(sessionEntries(ctx))
    refreshStatus(ctx)
  })

  // ── the system-prompt block ──────────────────────────────────────────────
  // Prepended, not appended. openclaude places the persona FIRST for a measured
  // reason it writes down next to the call site: the harness intro otherwise
  // anchors the model on "neutral coding assistant" and the persona is read as
  // decoration on top of that. pi hands us the whole built prompt, so first
  // means concatenating in front of it.
  pi.on("before_agent_start", async event => {
    try {
      const body = readActivePersona(root)
      if (!body) {
        // No persona, but this session HAD one and spoke in it. The block is off
        // the prompt; the transcript is not, and "the neutral voice returns next
        // turn" is only true if something says so. ~240 tokens, byte-stable for
        // the rest of the session, and nothing at all in a session that never
        // adopted one.
        const cleared = buildRetiredVoiceSection(retiredPersona)
        if (!cleared) return undefined
        return { systemPrompt: `${cleared}\n\n${event.systemPrompt}` }
      }
      const name = parsePersonaName(body) ?? "Custom"
      const section = buildPersonaSection({
        name,
        body,
        // pi's own view of what is on the surface this turn. The block names
        // real tools or omits the guidance that would need one; see
        // ../src/prompt.ts.
        tools: event.systemPromptOptions?.selectedTools,
        mode: settings.promptMode,
        commandName: COMMAND,
        // Suppressed by buildPersonaSection when it matches `name` — re-selecting
        // the persona you are already wearing retires it and brings it straight
        // back, and there is no bleed between a voice and itself.
        retired: retiredPersona,
      })
      if (!section) return undefined
      return { systemPrompt: `${section}\n\n${event.systemPrompt}` }
    } catch (err) {
      // Fail open. A persona that cannot be built must not be the reason a turn
      // does not run — the session degrades to a normal one, loudly enough to
      // find in a log and quietly enough not to eat the turn.
      console.warn("[persona] could not build the persona block; running without it", err)
      return undefined
    }
  })

  // ── the immersion marker ─────────────────────────────────────────────────
  // Off unless asked for, on anything that is not DeepSeek. See ../src/immersion.ts.
  pi.on("input", async (event, ctx) => {
    try {
      if (event.source === "extension") return { action: "continue" as const }
      if (settings.immersionMode === "off") return { action: "continue" as const }
      const hasPersona = resolveActivePersonaPath(root) !== null
      if (!hasPersona) return { action: "continue" as const }

      const prior = priorUserMessages(ctx)
      const next = maybeAppendMarker(event.text, prior, settings.immersionMode, hasPersona)
      if (next === event.text) return { action: "continue" as const }
      return { action: "transform" as const, text: next }
    } catch (err) {
      console.warn("[persona] immersion marker skipped", err)
      return { action: "continue" as const }
    }
  })

  /**
   * Prior user-authored messages, in session order.
   *
   * The extraction turn is delivered with sendUserMessage() and therefore lands
   * as a user message; it is marked synthetic so it does not consume the first
   * turn the marker is documented to attach to.
   */
  function priorUserMessages(ctx: ExtensionContext): PriorMessage[] {
    const out: PriorMessage[] = []
    let entries: readonly unknown[] = []
    try {
      entries = ctx.sessionManager.getEntries()
    } catch {
      return out
    }
    for (const raw of entries) {
      const e = raw as { type?: string; message?: { role?: string; content?: unknown } }
      if (e?.type !== "message") continue
      const role = e.message?.role
      if (role !== "user") continue
      out.push({ role: "user", synthetic: isProcessPrompt(messageText(e.message?.content)) })
    }
    return out
  }

  function messageText(content: unknown): string {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    for (const part of content) {
      const p = part as { type?: string; text?: unknown }
      if (p?.type === "text" && typeof p.text === "string") return p.text
    }
    return ""
  }

  // ── activation ───────────────────────────────────────────────────────────

  /**
   * Copy a library persona straight to the active slot. No model turn.
   *
   * The outgoing persona is switched off first rather than overwritten. The
   * file write is the same either way; what `retireActive` adds is the record
   * of whose voice the transcript is carrying, which is the half of the switch
   * a file write cannot do.
   */
  function activateCached(
    ctx: ExtensionContext,
    personaPath: string,
  ): { name: string; retired: string | null } {
    const body = readFileSync(personaPath, "utf8")
    const { retired } = retireActive(ctx)
    writeFileSync(getActivePersonaPath(root), body, "utf8")
    invalidateNameCache()
    return { name: parsePersonaName(body) ?? "Custom", retired }
  }

  /**
   * Add "and here is what happened to the one you had" to a notify line.
   *
   * The recovery half is not a nicety. Switching off before an EXTRACTION means
   * a session that abandons it — the model asks a clarifying question and the
   * user walks away, the card turns out to be the wrong one — ends up with no
   * persona at all. Re-activating from the library costs no model turn, and the
   * user has to be told that before they need it rather than after.
   */
  function withSwitchNote(head: string, retired: string | null, incoming: string): string {
    if (!retired || retired.toLowerCase() === incoming.toLowerCase()) return head
    return `${head}\nSwitched ${retired} off first so their voice does not bleed into ${incoming}. /${COMMAND} local brings ${retired} back without a model turn.`
  }

  /**
   * Hand the card to the model as an ordinary turn, which extracts the persona
   * and writes both copies. openclaude's design, and the reason a persona reads
   * like a voice profile rather than a dump of card fields.
   */
  function processCard(
    ctx: ExtensionContext,
    card: CharaCardV2,
    source: { sourceUrl?: string; projectId?: number; avatarUrl?: string },
  ): void {
    // Staged FIRST: everything here that can throw does so before the active
    // persona is touched, so a card that cannot be written to disk does not
    // leave the session with no persona and no extraction either.
    const staged = stageCardForProcessing(root, card, source)
    // Then switched off, BEFORE the turn is built or sent. `sendUserMessage`
    // reaches `AgentSession.prompt()`, which is the one call site pi emits
    // `before_agent_start` from — so the extraction turn's system prompt is
    // rebuilt, and with the file gone it is rebuilt without the outgoing
    // persona's block. That is the whole point: this turn writes a PERSISTENT
    // artefact, and a profile written under <Old>'s "everything you say comes
    // out in <Old>'s voice" is cached in the library and re-used forever.
    const { retired } = retireActive(ctx)
    const contextWindow = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow ?? null
    const prompt = buildProcessPrompt({
      card,
      stagedCardPath: staged.cardPath,
      libraryPersonaPath: staged.personaPath,
      activePersonaPath: getActivePersonaPath(root),
      cardName: card.data.name,
      contextWindow,
      commandName: COMMAND,
      // The session's standing retirement, not just this call's: a persona
      // switched off five turns ago is still the voice the transcript is full
      // of. Suppressed when it IS this card — a re-extraction retires the
      // persona and brings it straight back, and telling the model not to sound
      // like the character it is extracting is the opposite of the instruction.
      retiredPersona: shouldAnnounceRetired(retiredPersona, card.data.name)
        ? retiredPersona
        : null,
    })
    const size = JSON.stringify(card, null, 2).length
    const threshold = inlineThresholdBytes(contextWindow)
    refreshStatus(ctx)
    ctx.ui.notify(
      withSwitchNote(
        `Extracting ${card.data.name} (${size} B card, ${size > threshold ? "jq walk" : "inlined"})…`,
        retired,
        card.data.name,
      ),
      "info",
    )
    pi.sendUserMessage(prompt)
  }

  // ── pickers ──────────────────────────────────────────────────────────────

  const BACK = "← back"
  const CANCEL_HINT = "Esc cancels"

  async function pickLocal(ctx: ExtensionContext): Promise<void> {
    const entries = listLocalPersonas(root)
    const loose = listLooseCardJsonFiles(root)
    if (entries.length === 0 && loose.length === 0) {
      ctx.ui.notify(
        `No personas yet. Drop a chara_card_v2 card.json into ${getActivePersonaPath(root).replace(/PERSONA\.md$/, "personas/")} or use /${COMMAND} chub.`,
        "warning",
      )
      return
    }
    const labels: string[] = []
    const actions: Array<() => Promise<void> | void> = []
    for (const e of entries) {
      const name = e.meta?.originalName ?? e.slug
      const mark = e.isActive ? "● " : "  "
      const cached = e.personaPath ? "extracted" : "card only"
      labels.push(`${mark}${name} — ${cached}`)
      actions.push(async () => {
        if (e.personaPath) {
          const choice = await ctx.ui.select(`${name}`, [
            "Activate the extracted persona (no model turn)",
            "Re-extract from the card (costs a turn)",
            "View the card",
            BACK,
          ])
          if (!choice || choice === BACK) return
          if (choice.startsWith("Activate")) {
            const { name: activated, retired } = activateCached(ctx, e.personaPath!)
            refreshStatus(ctx)
            ctx.ui.notify(
              withSwitchNote(
                `Active persona: ${activated}. It takes effect next turn.`,
                retired,
                activated,
              ),
              "info",
            )
            return
          }
          if (choice.startsWith("View")) {
            await viewCard(ctx, readCard(e.cardPath))
            return
          }
        }
        processCard(ctx, readCard(e.cardPath), {
          sourceUrl: e.meta?.sourceUrl,
          projectId: e.meta?.projectId,
          avatarUrl: e.meta?.avatarUrl,
        })
      })
    }
    for (const path of loose) {
      labels.push(`  ${basename(path)} — loose card.json`)
      actions.push(() => processCard(ctx, readCard(path), {}))
    }
    labels.push(BACK)
    actions.push(() => {})

    const picked = await ctx.ui.select(`Local persona library — ${CANCEL_HINT}`, labels)
    if (!picked) return
    const idx = labels.indexOf(picked)
    if (idx < 0 || picked === BACK) return
    await actions[idx]!()
  }

  async function pickSort(ctx: ExtensionContext): Promise<SortMode | null> {
    const labels = SORT_MODES.map(s => `${s} — ${SORT_HINT[s]}`)
    labels.push(BACK)
    const picked = await ctx.ui.select(`chub.ai — sort — ${CANCEL_HINT}`, labels)
    if (!picked || picked === BACK) return null
    const sort = picked.split(" — ")[0] ?? ""
    return isSortMode(sort) ? sort : null
  }

  async function browseChub(
    ctx: ExtensionContext,
    sort: SortMode,
    search?: string,
  ): Promise<void> {
    let page = 1
    for (;;) {
      ctx.ui.setStatus(STATUS_KEY, `chub.ai — fetching page ${page}…`)
      let nodes: ChubSearchNode[]
      try {
        const res = await searchCharacters({
          sort,
          page,
          search,
          signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
        })
        nodes = res.data.nodes ?? []
      } catch (err) {
        refreshStatus(ctx)
        ctx.ui.notify(`chub.ai search failed: ${message(err)}`, "error")
        return
      }
      refreshStatus(ctx)
      if (nodes.length === 0) {
        ctx.ui.notify(page === 1 ? "chub.ai returned nothing for that." : "No more results.", "warning")
        if (page === 1) return
        page -= 1
        continue
      }

      const labels = nodes.map(n => {
        const tagline = (n.tagline || n.description || "").replace(/\s+/g, " ").slice(0, 60)
        return `${n.name} — ★${n.starCount} · ${n.nTokens} tok${tagline ? ` · ${tagline}` : ""}`
      })
      if (nodes.length === PAGE_SIZE) labels.push("→ next page")
      if (page > 1) labels.push("← previous page")
      labels.push(BACK)

      const picked = await ctx.ui.select(
        `chub.ai · ${search ? `search "${search}"` : sort} · page ${page} — ${CANCEL_HINT}`,
        labels,
      )
      if (!picked || picked === BACK) return
      if (picked === "→ next page") {
        page += 1
        continue
      }
      if (picked === "← previous page") {
        page -= 1
        continue
      }
      const node = nodes[labels.indexOf(picked)]
      if (!node) return

      ctx.ui.setStatus(STATUS_KEY, `chub.ai — downloading ${node.name}…`)
      let card: CharaCardV2
      try {
        card = await downloadCard(node.id, AbortSignal.timeout(NETWORK_TIMEOUT_MS))
      } catch (err) {
        refreshStatus(ctx)
        ctx.ui.notify(`Could not download ${node.name}: ${message(err)}`, "error")
        continue
      }
      refreshStatus(ctx)
      const accepted = await viewCard(ctx, card)
      if (accepted) {
        processCard(ctx, card, {
          sourceUrl: `https://chub.ai/characters/${node.id}`,
          projectId: node.id,
          avatarUrl: node.avatar_url || node.max_res_url || undefined,
        })
        return
      }
    }
  }

  /**
   * The card viewer. openclaude renders this as a React pane with a section
   * list and a detail view; pi's dialog vocabulary is select + editor, so the
   * section list is a select and each section opens in the editor, which is the
   * only dialog here that scrolls. Empty sections are labelled rather than
   * hidden — "this card has no mes_example" is the kind of thing you want to
   * see before spending a turn extracting from it.
   *
   * Returns true when the user accepted the card.
   */
  async function viewCard(ctx: ExtensionContext, card: CharaCardV2): Promise<boolean> {
    const sections = flattenCardForViewer(card)
    for (;;) {
      const labels = [`✓ Use this card — ${describeCard(card)}`]
      for (const s of sections) {
        labels.push(
          s.isEmpty
            ? `  ${s.name} — (empty)`
            : `  ${s.name} — ${s.kind}, ~${s.tokenCount} tok`,
        )
      }
      labels.push(BACK)
      const picked = await ctx.ui.select(`${card.data.name} — ${CANCEL_HINT}`, labels)
      if (!picked || picked === BACK) return false
      if (picked.startsWith("✓ Use this card")) return true
      const section = sections[labels.indexOf(picked) - 1]
      if (!section) continue
      if (section.isEmpty) {
        ctx.ui.notify(`${section.name} is empty on this card.`, "info")
        continue
      }
      await ctx.ui.editor(`${card.data.name} · ${section.name}`, section.content)
    }
  }

  async function pickRandom(ctx: ExtensionContext): Promise<void> {
    // 'random' sort plus a random page, for variety. Upstream's shape, including
    // the fall back to page 1 when the deep page comes back empty.
    ctx.ui.setStatus(STATUS_KEY, "chub.ai — fetching a random persona…")
    try {
      const page = 1 + Math.floor(Math.random() * 15)
      let nodes = (
        await searchCharacters({ sort: "random", page, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
      ).data.nodes
      if (!nodes || nodes.length === 0) {
        nodes = (
          await searchCharacters({ sort: "random", page: 1, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
        ).data.nodes
      }
      refreshStatus(ctx)
      if (!nodes || nodes.length === 0) {
        ctx.ui.notify("chub.ai returned no personas right now — try again in a moment.", "warning")
        return
      }
      const node = nodes[Math.floor(Math.random() * nodes.length)]!
      const card = await downloadCard(node.id, AbortSignal.timeout(NETWORK_TIMEOUT_MS))
      processCard(ctx, card, {
        sourceUrl: `https://chub.ai/characters/${node.id}`,
        projectId: node.id,
        avatarUrl: node.avatar_url || node.max_res_url || undefined,
      })
    } catch (err) {
      refreshStatus(ctx)
      ctx.ui.notify(`Could not fetch a random persona: ${message(err)}`, "error")
    }
  }

  // ── status, show, settings ───────────────────────────────────────────────

  function statusLines(ctx: ExtensionContext): string[] {
    const name = getActivePersonaName(root)
    const body = readActivePersona(root)
    const lines: string[] = []
    lines.push(name ? `Active persona: ${name}` : "Active persona: none")
    if (body) {
      const section = buildPersonaSection({
        name: name ?? "Custom",
        body,
        tools: undefined,
        mode: settings.promptMode,
        commandName: COMMAND,
      })
      if (section) {
        lines.push(
          `Block: ${settings.promptMode}, ~${estimateTokens(section)} tokens of every request`,
        )
      }
      lines.push(`File: ${resolveActivePersonaPath(root)}`)
    } else if (retiredPersona) {
      const cleared = buildRetiredVoiceSection(retiredPersona)
      lines.push(
        `Block: retirement notice only, ~${cleared ? estimateTokens(cleared) : 0} tokens. ` +
          `Prompt mode is '${settings.promptMode}' when a persona is active.`,
      )
    } else {
      lines.push(`Block: none (0 tokens). Prompt mode is '${settings.promptMode}' when one is active.`)
    }
    if (retiredPersona) {
      lines.push(
        retiredPersona.toLowerCase() === (name ?? "").toLowerCase()
          ? `Retired this session: ${retiredPersona} (re-selected, so the notice is suppressed)`
          : `Retired this session: ${retiredPersona} — the block tells the model not to fall back into that voice`,
      )
    }
    const marker = normalizeMode(settings.immersionMode)
    lines.push(
      `Immersion: ${marker}${settings.immersionMode === "auto" ? " (via the deprecated `auto` alias)" : ""}` +
        (marker === "off" ? "" : " — appended to the first user message of a session"),
    )
    lines.push(`Library: ${listLocalPersonas(root).length} extracted, ${listLooseCardJsonFiles(root).length} loose card.json`)
    return lines
  }

  async function settingsMenu(ctx: ExtensionContext): Promise<void> {
    const picked = await ctx.ui.select(`/${COMMAND} settings — ${CANCEL_HINT}`, [
      `Prompt block: ${settings.promptMode}`,
      `Immersion marker: ${settings.immersionMode}`,
      BACK,
    ])
    if (!picked || picked === BACK) return
    if (picked.startsWith("Prompt block")) {
      const mode = await ctx.ui.select("Persona prompt block", [...PROMPT_MODES, BACK])
      if (!mode || mode === BACK || !isPromptMode(mode)) return
      settings = { ...settings, promptMode: mode }
      saveSettings(root, settings)
      ctx.ui.notify(`Persona block: ${mode}.`, "info")
      return
    }
    const mode = await ctx.ui.select("Immersion marker", [...IMMERSION_MODES, BACK])
    if (!mode || mode === BACK || !isImmersionMode(mode)) return
    settings = { ...settings, immersionMode: mode }
    saveSettings(root, settings)
    ctx.ui.notify(`Immersion marker: ${mode}.`, "info")
  }

  async function mainMenu(ctx: ExtensionContext): Promise<void> {
    const hasActive = resolveActivePersonaPath(root) !== null
    const options = [
      "Local library",
      "chub.ai — browse",
      "chub.ai — search",
      "chub.ai — random",
      "Status",
      "Settings",
    ]
    if (hasActive) {
      options.splice(4, 0, "Show the active persona")
      options.push("Clear the active persona")
    }
    const picked = await ctx.ui.select(`/${COMMAND} — ${CANCEL_HINT}`, options)
    if (!picked) return
    switch (picked) {
      case "Local library":
        return pickLocal(ctx)
      case "chub.ai — browse": {
        const sort = await pickSort(ctx)
        if (sort) await browseChub(ctx, sort)
        return
      }
      case "chub.ai — search": {
        const q = (await ctx.ui.input("chub.ai search", "character name or keyword"))?.trim()
        if (q) await browseChub(ctx, "trending", q)
        return
      }
      case "chub.ai — random":
        return pickRandom(ctx)
      case "Show the active persona":
        return showActive(ctx)
      case "Status":
        ctx.ui.notify(statusLines(ctx).join("\n"), "info")
        return
      case "Settings":
        return settingsMenu(ctx)
      case "Clear the active persona": {
        ctx.ui.notify(clearedText(retireActive(ctx)), "info")
        refreshStatus(ctx)
        return
      }
    }
  }

  /**
   * What /persona clear says.
   *
   * "The neutral voice returns next turn" was a claim this package could not
   * keep: the block came off the system prompt and the transcript kept talking
   * in the persona. It is true now, and the sentence says which mechanism makes
   * it true, because a retirement notice appearing in the system prompt of a
   * session with no persona is otherwise a surprise.
   */
  function clearedText({ removed, retired }: { removed: boolean; retired: string | null }): string {
    if (!removed) return "There was no active persona."
    if (!retired) return "Cleared. The neutral voice returns next turn."
    return `Cleared. ${retired} is switched off, and the block that says so keeps the neutral voice from sliding back into them for the rest of this session.`
  }

  async function showActive(ctx: ExtensionContext): Promise<void> {
    const body = readActivePersona(root)
    if (!body) {
      ctx.ui.notify("No active persona.", "warning")
      return
    }
    await ctx.ui.editor(`Active persona — ${getActivePersonaName(root) ?? "Custom"}`, body)
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  // ── the command ──────────────────────────────────────────────────────────

  pi.registerCommand(COMMAND, {
    description: "Adopt a character persona for the assistant voice (local library or chub.ai)",
    getArgumentCompletions: prefix => {
      const p = prefix.trim()
      const [head, ...rest] = p.split(/\s+/)
      if (head === "immersion" && rest.length <= 1) {
        return IMMERSION_MODES.filter(m => m.startsWith(rest[0] ?? "")).map(m => ({
          value: `immersion ${m}`,
          label: `immersion ${m}`,
        }))
      }
      if (head === "prompt" && rest.length <= 1) {
        return PROMPT_MODES.filter(m => m.startsWith(rest[0] ?? "")).map(m => ({
          value: `prompt ${m}`,
          label: `prompt ${m}`,
        }))
      }
      if (head === "chub" && rest.length <= 1) {
        return SORT_MODES.filter(m => m.startsWith(rest[0] ?? "")).map(m => ({
          value: `chub ${m}`,
          label: `chub ${m} — ${SORT_HINT[m]}`,
        }))
      }
      if (rest.length > 0) return null
      return SUBCOMMANDS.filter(s => s.startsWith(head ?? "")).map(s => ({ value: s, label: s }))
    },
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim()
      const [sub, ...rest] = trimmed ? trimmed.split(/\s+/) : []
      const tail = rest.join(" ")

      // Non-interactive modes (-p / --json) have no dialogs. Everything that
      // does not need one still answers; everything that does says so rather
      // than hanging on a prompt nobody can see.
      if (!ctx.hasUI && sub !== "status" && sub !== "clear") {
        console.log(statusLines(ctx).join("\n"))
        return
      }

      try {
        switch (sub) {
          case undefined:
          case "":
            return await mainMenu(ctx)
          case "local":
            return await pickLocal(ctx)
          case "chub": {
            const sort = tail && isSortMode(tail) ? tail : await pickSort(ctx)
            if (sort) await browseChub(ctx, sort)
            return
          }
          case "search": {
            const q = tail || (await ctx.ui.input("chub.ai search", "character name or keyword"))?.trim()
            if (q) await browseChub(ctx, "trending", q)
            return
          }
          case "random":
            return await pickRandom(ctx)
          case "show":
            return await showActive(ctx)
          case "status": {
            const text = statusLines(ctx).join("\n")
            if (ctx.hasUI) ctx.ui.notify(text, "info")
            else console.log(text)
            return
          }
          case "clear": {
            const text = clearedText(retireActive(ctx))
            refreshStatus(ctx)
            if (ctx.hasUI) ctx.ui.notify(text, "info")
            else console.log(text)
            return
          }
          case "immersion": {
            if (!tail) {
              ctx.ui.notify(`Immersion marker: ${settings.immersionMode}`, "info")
              return
            }
            if (!isImmersionMode(tail)) {
              ctx.ui.notify(`Not a mode: ${tail}. One of ${IMMERSION_MODES.join(", ")}.`, "error")
              return
            }
            settings = { ...settings, immersionMode: tail }
            saveSettings(root, settings)
            ctx.ui.notify(`Immersion marker: ${tail}.`, "info")
            return
          }
          case "prompt": {
            if (!tail) {
              ctx.ui.notify(`Persona block: ${settings.promptMode}`, "info")
              return
            }
            if (!isPromptMode(tail)) {
              ctx.ui.notify(`Not a mode: ${tail}. One of ${PROMPT_MODES.join(", ")}.`, "error")
              return
            }
            settings = { ...settings, promptMode: tail }
            saveSettings(root, settings)
            ctx.ui.notify(`Persona block: ${tail}.`, "info")
            return
          }
          default:
            ctx.ui.notify(
              `Unknown: /${COMMAND} ${sub}. One of ${SUBCOMMANDS.join(", ")}, or /${COMMAND} on its own.`,
              "error",
            )
            return
        }
      } catch (err) {
        // A slash command that throws takes the dialog down with it and says
        // nothing useful. Everything here is reported in place.
        ctx.ui.notify(`/${COMMAND} failed: ${message(err)}`, "error")
      }
    },
  })

  // A persona written by the model lands on disk between turns, so the status
  // line has to notice the file rather than the command. Cheap: one stat, once
  // per settled agent run.
  pi.on("agent_settled", async (_event, ctx) => {
    refreshStatus(ctx)
  })

  // pi's own PI_CODING_AGENT_DIR can point at a home that has not been created
  // yet (Dockerfile.pi gives each pi session a home of its own). Said once at
  // load rather than as an exception per turn.
  if (!existsSync(root)) {
    console.warn(`[persona] agent dir ${root} does not exist yet — the library will be created on first use`)
  }
}
