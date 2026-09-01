// Load the real extension factory with pi's module resolvable.
//
// The extension's only bare import is pi's own package, which pi resolves from
// its own module root at runtime. Node resolving it from a checkout is a
// different question: bare specifiers walk node_modules up from the importing
// file, and there is none. `module.registerHooks` redirects that one specifier
// at the installed package, so the load test drives the SAME import a session
// would — a renamed export fails here rather than at a user's next launch.
//
// Resolved from the `pi` binary on PATH, for the reason vendor/rtk-pi's
// version-probe suite spells out: an absolute path is true of one box and of
// nowhere else, and it took CI down for nine days.

import { existsSync, realpathSync } from "node:fs"
import { registerHooks } from "node:module"
import { delimiter, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

export const PI_SPECIFIER = "@earendil-works/pi-coding-agent"

export function findPiIndex(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const bin = join(dir, "pi")
    if (!existsSync(bin)) continue
    try {
      const cli = realpathSync(bin) // .../dist/cli.js
      const index = join(dirname(cli), "index.js")
      if (existsSync(index)) return index
    } catch {
      // an unreadable PATH entry is not this test's problem
    }
  }
  const legacy = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"
  return existsSync(legacy) ? legacy : null
}

/**
 * A minimal stand-in for pi's package.
 *
 * The extension's only VALUE import from pi is `getAgentDir`; everything else it
 * takes is a type, and `--experimental-strip-types` erases those. So on a box
 * with no pi installed the extension's own logic is still exercisable, and the
 * switching suite runs everywhere rather than skipping exactly where the
 * behaviour is easiest to break.
 *
 * This does NOT replace the real-pi suite and must not be used for the
 * questions that suite exists to answer — a renamed pi export, a handler
 * signature that changed, an event that no longer fires. A stub agrees with
 * whatever you wrote in it, which is the entire reason `extension.test.ts`
 * loads the installed package instead.
 */
const STUB_SOURCE = `export function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ?? "/tmp/pi-persona-no-agent-dir"
}
`
const STUB_URL = `data:text/javascript,${encodeURIComponent(STUB_SOURCE)}`

let hooked = false
let target: string | null = null

function ensureHook(): void {
  if (hooked) return
  hooked = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === PI_SPECIFIER && target) return { url: target, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}

export function hookPiResolution(piIndex: string): void {
  target = pathToFileURL(piIndex).href
  ensureHook()
}

/**
 * Point pi's specifier at {@link STUB_SOURCE}.
 *
 * Per PROCESS: node's test runner gives each FILE its own process, and the two
 * hooks share one `target`, so a suite that stubs and a suite that does not must
 * not live in the same file.
 */
export function hookStubPi(): void {
  target = STUB_URL
  ensureHook()
}

// ── a recording stand-in for ExtensionAPI ────────────────────────────────────

export interface RecordedCommand {
  name: string
  description?: string
  getArgumentCompletions?: (prefix: string) => unknown
  handler: (args: string, ctx: unknown) => Promise<void>
}

export class FakeApi {
  handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
  commands = new Map<string, RecordedCommand>()
  tools: unknown[] = []
  shortcuts: string[] = []
  sentUserMessages: string[] = []
  sentMessages: unknown[] = []
  /** Every `pi.appendEntry(customType, data)` this session made, in order. */
  appended: Array<{ customType: string; data: unknown }> = []

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }

  registerCommand(name: string, options: Omit<RecordedCommand, "name">): void {
    this.commands.set(name, { name, ...options })
  }

  registerTool(tool: unknown): void {
    this.tools.push(tool)
  }

  registerShortcut(id: string): void {
    this.shortcuts.push(id)
  }

  registerFlag(): void {}
  getFlag(): undefined {
    return undefined
  }

  sendUserMessage(content: string): void {
    this.sentUserMessages.push(content)
  }

  sendMessage(message: unknown): void {
    this.sentMessages.push(message)
  }

  appendEntry(customType: string, data: unknown): void {
    this.appended.push({ customType, data })
  }
  setSessionName(): void {}
  getSessionName(): undefined {
    return undefined
  }

  async fire(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
    const out: unknown[] = []
    for (const h of this.handlers.get(event) ?? []) out.push(await h(payload, ctx))
    return out
  }
}

export interface FakeCtxOptions {
  entries?: unknown[]
  /** The branch, when it differs from `entries`. Defaults to `entries`. */
  branch?: unknown[]
  model?: { id?: string; provider?: string; baseUrl?: string; contextWindow?: number }
  contextWindow?: number
  hasUI?: boolean
  selects?: string[]
  inputs?: string[]
}

export class FakeCtx {
  statuses: Array<string | undefined> = []
  notifications: Array<{ text: string; type?: string }> = []
  editorCalls: Array<{ title: string; body: string }> = []
  selectPrompts: Array<{ title: string; options: string[] }> = []
  private selects: string[]
  private inputs: string[]

  hasUI: boolean
  mode = "tui"
  cwd = process.cwd()
  model: FakeCtxOptions["model"]
  sessionManager: { getEntries: () => unknown[]; getBranch: () => unknown[] }

  private opts: FakeCtxOptions

  constructor(opts: FakeCtxOptions = {}) {
    this.opts = opts
    this.hasUI = opts.hasUI ?? true
    this.model = opts.model
    this.selects = [...(opts.selects ?? [])]
    this.inputs = [...(opts.inputs ?? [])]
    const entries = opts.entries ?? []
    // The extension reads the BRANCH for its custom entries (pi's own idiom) and
    // falls back to getEntries; both are here so either path is exercised.
    const branch = opts.branch ?? entries
    this.sessionManager = { getEntries: () => entries, getBranch: () => branch }
  }

  ui = {
    setStatus: (_key: string, value?: string) => {
      this.statuses.push(value)
    },
    notify: (text: string, type?: string) => {
      this.notifications.push({ text, type })
    },
    select: async (title: string, options: string[]) => {
      this.selectPrompts.push({ title, options })
      return this.selects.shift()
    },
    confirm: async () => true,
    input: async () => this.inputs.shift(),
    editor: async (title: string, body: string) => {
      this.editorCalls.push({ title, body })
      return body
    },
    setWidget: () => {},
  }

  getContextUsage() {
    const w = this.opts.contextWindow
    return w ? { tokens: null, contextWindow: w, percent: null } : undefined
  }

  isIdle(): boolean {
    return true
  }
  isProjectTrusted(): boolean {
    return true
  }
  getSystemPrompt(): string {
    return "base"
  }
}

export function userEntry(text: string): unknown {
  return { type: "message", id: "x", parentId: null, timestamp: "", message: { role: "user", content: text } }
}

/** A pi custom entry, the shape `pi.appendEntry` writes and the branch replays. */
export function customEntry(customType: string, data: unknown): unknown {
  return { type: "custom", id: "c", parentId: null, timestamp: "", customType, data }
}

export function assistantEntry(text: string): unknown {
  return {
    type: "message",
    id: "y",
    parentId: null,
    timestamp: "",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }
}
