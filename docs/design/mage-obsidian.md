# MageObsidian (ModernFrontend) support

**Status:** implemented (resolver + 4 synthesis passes).
**Audience:** anyone extending or debugging the MageObsidian integration.
**Related:** [`magento-di-resolution.md`](./magento-di-resolution.md) — the PHP half of
a MageObsidian project is ordinary Magento and is covered there.

## The problem

[MageObsidian](https://github.com/mage-obsidian) replaces Magento's legacy
frontend (Luma/Blank, LESS, RequireJS) with Vite, TailwindCSS and Vue, while
still building on Magento's native layouts, blocks and templates. A store using
it writes ordinary Magento PHP — and a frontend that CodeGraph could not see at
all:

| Question | What the graph said |
|---|---|
| What does this template render? | Nothing. `.twig` is a file-level-only language: no grammar, no symbols, not even a file node. |
| Where does `import … from "Vendor_Module::path"` go? | Nothing. It names no path on disk; the build resolves it through the theme chain. |
| What mounts this Vue component? | Nothing. Islands are mounted by name from PHP and Twig, never imported. |
| Which block backs `block.getFoo()` in a template? | Nothing — the same problem `.phtml` had, in a language with no parser. |

The `Vendor_Module::path` scheme is not a style choice: a relative import
bypasses theme inheritance, so an override silently stops being reachable, and
the build's `unresolvedModuleGuard` rejects one. Every cross-module import is
written this way, which is exactly why none of them were in the graph.

## Resolution rules

Reproduced from `js-package-utils/src/core/moduleResolver.ts`, which is what the
Vite build actually runs:

1. **Specifier shape** — `Vendor_Module::path`. A path targeting neither
   `components/` nor `js/` gets `components/` prepended, and a build extension
   (`.js`, `.vue`, `.cjs`, `.ts`) is dropped, so the same asset is reachable
   written either way.
2. **Module assets** live under `<module>/view/frontend/web/`.
3. **Theme overrides** live under `<theme>/<Vendor_Module>/web/`.
4. **Precedence** — themes beat the module, and a child theme beats its parent.
   The chain comes from `theme.xml`'s `<parent>`, walked nearest-first and
   cycle-guarded.

Templates follow Magento's own rule and reuse the Magento template index, which
now covers `.twig` alongside `.phtml`.

## What gets into the graph

**The resolver** (`frameworks/mage-obsidian/`) detects the stack — any module
shipping `etc/mage_obsidian_compatibility.xml`, or a composer dependency on
`mage-obsidian/*` — claims `Vendor_Module::path` names through
`claimsReference`, and gives every `.twig` file a node. That node matters: with
no symbols of its own, a template would otherwise have nothing to link from and
nothing for an `include` to land on.

**Four synthesis passes** (`resolution/mage-obsidian-synthesizer.ts`):

| Pass | Edge | `synthesizedBy` |
|---|---|---|
| import | JS/Vue file → the asset its specifier resolves to | `obsidian-import` |
| twig include | template → the template it includes, extends or embeds | `obsidian-twig-include` |
| twig island | template → the Vue component `render_vue` mounts | `obsidian-island` |
| twig script | template → the JS entry `script()` pulls | `obsidian-twig-script` |
| twig block | template → the block/view-model method `block.getFoo()` runs | `obsidian-twig-block` |
| contract | JS reader → the PHP constant that defines the key | `obsidian-contract` |

The block pass reuses `templateClassBindings` from the Magento synthesizer: the
same layout XML that binds a `.phtml` to its block class binds a `.twig` to
its, so there is one implementation of that rule rather than two.

## Measured

On the real MageObsidian source (5 framework/storefront modules plus the two
themes, 3,973 files, indexed in 530ms):

| Channel | Edges |
|---|---|
| `obsidian-import` | 118 |
| `obsidian-twig-include` | 59 |
| `obsidian-twig-script` | 41 |
| `obsidian-island` | 9 |
| `obsidian-twig-block` | 4 |

Plus 149 Twig template nodes where there were none.

Import coverage is **complete**: 37 distinct specifiers across 118 call sites in
the source, 37 and 118 resolved. Islands and includes were spot-checked against
the source (`search-form.twig → SearchAutocomplete.vue`,
`BundlePrice.vue → ModernFrontend/js/events.ts`).

## The deliberate limits

**Both ends must be indexed**, as everywhere else in this repo. Two consequences
are worth stating because they explain low numbers rather than a defect:

- **Block methods.** The measured subset holds 520 `block.`/`viewModel.` calls
  but only 4 edges, because most templates are backed by *Magento core* block
  classes and the subset has no `vendor/`. With the core indexed the same pass
  resolves them; with it excluded the flow honestly stops.
- **The contract.** The JS half of the PHP↔JS contract lives in the
  `mage-obsidian` npm package — `node_modules`, which is default-ignored — so a
  consuming store sees no `obsidian-contract` edges. The pass pays off for
  someone developing the framework itself, where both halves are in the tree.

## Frontier

- **JS interceptors.** MageObsidian ports Magento's plugin system to JavaScript
  (`before`/`around`/`after` with `sortOrder`, declared in `module.config.ts`,
  applied through virtual `\0interceptor:<path>` modules). The mechanism is a
  direct analogue of the `magento-plugin` pass, but no module in the framework
  declares one today, so a pass would synthesize nothing. Worth adding when the
  feature starts being used.
- **Chained view-model calls.** `{% set form = block.getSearchForm() %}` followed
  by `form.getActionUrl()` — the second call resolves against whatever the first
  returned, which needs return-type inference through Twig variables.
- **Theme-scoped resolution.** The index resolves a specifier through every leaf
  theme's chain, most-specific-wins. A store running two themes that override the
  same asset differently gets the last one indexed; distinguishing them would
  need per-theme edges.
- **`theme.config.js` / `module.config.ts` keys.** Unknown keys are silently
  ignored by the build, so a typo is a no-op — a lint-style check, not a graph
  edge.
