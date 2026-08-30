# Publishing this as a pi package

Read off `docs/packages.md` in the installed pi (0.84.4), not from memory. Where
this file says "verified", it means the claim was checked against that file or
against the running binary.

## What makes a directory a pi package

Either a `pi` manifest in `package.json`, or convention directories. This
package uses the manifest, because the manifest is explicit about which file is
the entry point and the convention would load anything that appeared in
`extensions/` later:

```json
{
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions/index.ts"] }
}
```

Convention directories, used only when there is no `pi` key: `extensions/`
(`.ts` and `.js`), `skills/` (recursive `SKILL.md` folders plus top-level `.md`),
`prompts/` (`.md`), `themes/` (`.json`).

`keywords` must contain **`pi-package`**. That is what the gallery at
<https://pi.dev/packages> lists on, and it is the whole of the "publishing"
step for discoverability — there is no registration, no submission, no review.

## Two distribution channels, and why this one is git

`pi install` accepts three source types:

| source | form | where it lands |
| --- | --- | --- |
| npm | `npm:pi-persona@1.0.0` | `~/.pi/agent/npm/` (or `.pi/npm/` with `-l`) |
| git | `git:github.com/coffeegrind123/pi-persona@v1.0.0` | `~/.pi/agent/git/<host>/<path>` |
| local | `/abs/path` or `./rel/path` | nowhere — referenced in place, not copied |

**git is the primary channel here** and npm is optional, for one reason that is
specific to this package: it is a single TypeScript file plus a `src/` of pure
modules, with no build step and no dependencies. An npm tarball would carry the
identical bytes and add a release ritual. The git form pins to a **tag or
commit**, which is the same guarantee a version gives, and `pi update
--extensions` explicitly does *not* move a pinned ref — it only reconciles an
existing clone to the ref already configured.

If it is ever published to npm as well, both can coexist: pi's dedup identity is
the package *name* for npm and the *repository URL without ref* for git, so the
two are distinct entries and a user could end up with both. Prefer one.

## The rules that actually bite

- **`private: true` blocks `npm publish`.** It was in this package's manifest
  while it lived inside another repo, which was correct there and wrong here.
  Removed.
- **pi's own packages go in `peerDependencies` with `"*"`, and must not be
  bundled.** Verified against `docs/packages.md`: `@earendil-works/pi-ai`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui` and `typebox` are bundled by pi itself. A version
  range narrower than `"*"` there is a false constraint — pi resolves these from
  its own module root, so the range is never what decides.
- **Runtime dependencies go in `dependencies`, not `devDependencies`.** pi
  installs packages with `npm install --omit=dev`, so a `devDependency` is
  simply absent at runtime. This package has neither, which is the easiest
  version of the rule to obey.
- **Another pi package as a dependency must be bundled** (`dependencies` +
  `bundledDependencies`) and referenced through `node_modules/` paths in the
  manifest. Not applicable here, and worth not discovering later.
- **`files`** decides the npm tarball. `tests/` is deliberately out: it is the
  thing a contributor runs, not something an installed copy needs, and it is
  most of the byte count.

## Releasing

```bash
# 1. the gate, in full — the extension suite must actually run, not skip
npm run lint && npm test        # needs pi on PATH, or the coupling suite skips

# 2. tag it. The tag IS the release for the git channel.
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0

# 3. optional: GitHub release notes
gh release create v1.0.0 --notes "..."

# 4. optional: npm, only if the npm channel is wanted
npm publish --access public
```

`pi install git:github.com/coffeegrind123/pi-persona@v1.0.0` resolves that tag
immediately; there is nothing to wait for and nothing to invalidate.

## Consuming it from another repo

Three ways, and they are not interchangeable:

- **`pi install`** — for a user who wants the extension. Writes `packages` into
  `~/.pi/agent/settings.json` (or `.pi/settings.json` with `-l`), and pi installs
  anything missing on startup once the project is trusted.
- **A git submodule plus `pi -e <abs path>`** — for a repo that wants the source
  in its own tree, pinned to a commit its own history records. This is how
  [instantcoffee](https://github.com/coffeegrind123/instantcoffee) consumes it:
  `vendor/pi-persona`, loaded by absolute path so the same code runs whatever
  directory pi was started in, and so the pin travels with the checkout rather
  than living in a user-global install that the next `pi update` could replace.
- **`pi -e git:...`** — for trying it once. Installs to a temp directory for that
  run only.

## What is NOT required

Checked, because each is a plausible assumption that would have cost time:

- No build step. pi loads extensions through [jiti](https://github.com/unjs/jiti),
  so TypeScript runs without compilation. There is no `dist/`, no `tsc`, no
  `prepublishOnly`.
- No `main` / `exports` in `package.json`. Nothing imports this package as a
  library; pi reads the `pi` manifest.
- No submission anywhere. The gallery lists on the `pi-package` keyword.
