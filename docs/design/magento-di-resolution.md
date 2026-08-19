# Magento 2 / Adobe Commerce support

**Status:** implemented (resolver + 7 synthesis passes).
**Audience:** anyone extending or debugging the Magento integration.

## The problem

Magento is the extreme case of the dynamic-dispatch problem this repo's
[playbook](./dynamic-dispatch-coverage-playbook.md) is about: almost nothing that
decides *what code runs* is written in PHP. It is written in XML, in a dozen
dialects, and merged at runtime by the object manager.

Before this work, indexing a Magento project produced a graph that was wrong in a
specific and misleading way — not incomplete, but confidently pointing at code
that never executes:

| Question an agent asks | What the graph said |
|---|---|
| What runs when I call `ProductRepositoryInterface::getById`? | The interface's empty method body. The `<preference>` naming the real class is invisible. |
| What intercepts `Product::getPrice`? | Nothing. Plugins are compiled into a generated `Interceptor` subclass; no source references them. |
| What does `$this->itemFactory->create()` build? | Nothing. `ItemFactory` is generated at build time and exists on no disk. |
| Which observers run on `sales_order_place_after`? | Nothing. The event is a string on both sides. |
| What serves `GET /V1/products/:sku`? | Nothing. `webapi.xml` names an interface. |
| Which block feeds `view.phtml`? | Nothing. `.phtml` was not even a recognised extension. |

## The core: reproducing Magento's config merge

Everything else depends on getting this right, because the answer to "which class
runs" is a function of module load order, not of the XML alone.

`frameworks/magento/modules.ts` discovers modules (`etc/module.xml` next to
`registration.php`) and orders them the way `ModuleList\Loader::sortBySequence`
does: a depth-first walk over `<sequence>` from an alphabetical seed. Sequence
entries naming modules that are not indexed are skipped, and cycles degrade to
"some order" instead of hanging.

`frameworks/magento/di.ts` then merges every `di.xml` in that order — all global
files first, then each area's — reproducing four rules:

1. **`<preference>`** — later module wins, and preferences chain (`A→B`, `B→C`
   resolves `A` to `C`).
2. **Area layering** — `etc/frontend/di.xml` is global config *plus* the area's
   overrides. A frontend preference must never be reported for adminhtml.
3. **`<plugin>`** — accumulated across modules and keyed by plugin *name* within
   a target, which is how a later module flips `disabled="true"` on an inherited
   plugin or re-points it; ordered by `sortOrder`. A re-declaration that omits
   `sortOrder` inherits the earlier one; an explicit `sortOrder="0"` does not.
4. **`<virtualType>`** — a configured alias usable anywhere a class name is,
   including as a plugin target and as an injected argument.

The merged table is cached per project root in `frameworks/magento/config.ts`,
keyed by a signature of the XML file set so it rebuilds when that set changes.

## What gets into the graph

**The resolver** (`frameworks/magento/index.ts`, registered in
`frameworks/index.ts`) detects the project, turns Magento XML into nodes and
references during extraction, and resolves a type name to the node the DI config
says will really be used.

Detection covers a full store (composer metapackage), a distributable module
(`type: magento2-module`), and a module with no `composer.json` at all
(`registration.php` beside `etc/module.xml`) — requiring both files so an
unrelated `etc/module.xml` cannot trigger it.

References that name no declared symbol — FQCNs, virtual-type names, and the
synthetic `magento:module:` / `magento:type:` / `magento:template:` forms — are
claimed through `claimsReference`, without which `resolveOne`'s name pre-filter
drops them before `resolve()` runs. This is the same trap documented for Drupal
and Rails.

**Seven synthesis passes** (`resolution/magento-synthesizer.ts`, registered in
`SYNTH_PASSES`, gated on `php` *and* `xml`):

| Pass | Edge | `synthesizedBy` |
|---|---|---|
| preference | interface method → the method that really runs | `magento-preference` |
| plugin | intercepted method → each `before`/`around`/`after` wrapping it | `magento-plugin` |
| di-argument | constructor → the class configuration injects (array items included) | `magento-di-argument` |
| factory | calling method → the class `->create()` builds | `magento-factory` |
| event dispatch | `dispatch('name')` site → the event node | `magento-event` |
| controller route | front name → the action classes serving it | `magento-controller` |
| template | `.phtml` → the block / view-model methods it calls | `magento-template` |

Every edge is `provenance: 'heuristic'` and carries `registeredAt` — the
`di.xml`, `events.xml` or layout line an agent would otherwise grep for.

**Method matching follows inheritance.** Magento leans on inheritance heavily —
every `SearchResults` implementation gets `getItems` from a framework base
class, most models extend `AbstractModel` — so matching only self-declared
methods misses a large share of preference targets. Supertypes are walked to a
bounded depth, and a method the type declares itself always wins over an
inherited one of the same name, since that is the method that actually runs.

Measured on a Magento core subset (Store, Catalog, CatalogInventory, Customer,
Directory, Eav + `Magento\Framework`; 5,540 files): **192 of 224 preferences
(85%)** link to the class their `type` names, up from 72% when only
self-declared methods were matched. Of the 32 that do not, 27 are the `__call`
frontier described below and 5 name a class outside the indexed subset.

Synthetic nodes reuse existing kinds: `module` per Magento module (with edges to
its `<sequence>` dependencies), `route` for web-API endpoints, front names, cron
jobs and queue consumers, `component` for layout blocks and UI components, and
`function` for events. No change to `NODE_KINDS`, so the native kernel's wire
contract is untouched.

## The deliberate limits

**Both ends must be indexed.** Every pass drops an edge whose target class is not
in the graph. With `vendor/` excluded by default, most plugins on core classes
therefore produce no edge at all. This is the "silent beats wrong" rule from the
playbook: a synthesized edge to a class we never read would be a fabricated
claim. The plugin class itself stays indexed and searchable either way.

**`vendor/` is not indexed by default** and `codegraph.json`'s `include` cannot
override that — `ScopeIgnore.ignores` never resurfaces a built-in default-ignored
directory. Projects that want core coverage need a `.gitignore` negation
(`!vendor/`), which pulls in every Composer package, not just Magento's. A repo
like `magento/magento2` that keeps its modules under `app/code` has the whole
core indexed with no special handling.

**Recommended `codegraph.json`** for a store, to keep generated and static output
out of the graph:

```json
{
  "exclude": [
    "app/etc/**",
    "generated/**",
    "var/**",
    "pub/static/**",
    "pub/media/**",
    "pub/errors/**",
    "dev/tests/**",
    "dev/tools/**",
    "setup/**",
    "lib/web/**",
    "**/Test/Mftf/**"
  ]
}
```

This matters more than it looks. A store installed from the Magento
distribution (rather than cloned) carries no `.gitignore`, so only the built-in
default ignores apply and everything above lands in the graph. Measured on a
2.4.7 install with one custom module: **15,837 files scanned, 187 of them the
store’s own code** — 1.2%. The same tree with these exclusions scans **199**.

Two entries are about correctness rather than noise:

- `app/etc` — `env.php` holds credentials and `config.php` is a module list,
  not code.
- `generated` — these are the `Interceptor`, `Factory` and `Proxy` classes
  Magento writes at runtime, which is exactly what the passes above synthesize
  from `di.xml`. Indexing them puts a second, competing definition of every
  intercepted class in the graph.

MFTF is worth calling out separately: those XML files are functional-test
fixtures, never store behaviour, and on the `magento/magento2` development
repository they are **6,360 of the 9,749 XML files** — two thirds of the XML in
the graph, contributing nothing to any question about how the store works.

**Where to run `init`.** The indexed root must be the Magento root — the
directory holding `composer.json`, `app/` and `bin/magento`. Docker-based dev
setups often keep several checkouts side by side under a project directory and
rotate a symlink (`current_source`, `htdocs`, …) at the active one; that
project directory is not a Magento root, and its `.gitignore` usually hides the
checkouts. Index each checkout, not the directory above them.

## Validation: Magento's own compiled metadata

`setup:di:compile` writes the fully merged, area-resolved configuration to
`generated/metadata/`. That is what the runtime reads, so it is ground truth for
everything on this page:

| File | Carries |
|---|---|
| `<area>.php` | `preferences`, `instanceTypes` (virtual types), `arguments` |
| `primary\|global\|<area>\|plugin-list.php` | plugins, in three slots: direct declarations, per-type chains after inheritance, processed |

`__tests__/magento-oracle.test.ts` compares our merge against it. Point
`CODEGRAPH_MAGENTO_ORACLE` at a compiled Magento root:

```bash
CODEGRAPH_MAGENTO_ORACLE=/path/to/store npx vitest run __tests__/magento-oracle.test.ts
```

It skips cleanly when the variable is unset, when the project was never
compiled, or when `php` is absent, and it reads every `di.xml` on disk —
`vendor/` included — because what is under test is the merge, not which modules
a project chooses to index.

**It refuses to run against a stale oracle.** If `generated/metadata` predates
the newest `di.xml`, the comparisons are skipped and a dedicated test fails
saying so. A disagreement with stale ground truth says nothing about our code,
and "fixing" ourselves to match it would introduce the exact bug the harness
exists to catch.

Two of the comparisons deserve reading carefully. **Declared** plugins measure
the merge. **Inherited** plugins measure the per-type chain Magento resolves
through parent classes, interfaces and virtual-type bases — which we do not walk
yet, so that number is a tracked gap, not a passing grade.

Measured on two stores:

| | Adobe Commerce 2.4.7, 805 modules | Magento 2.4.7 vanilla |
|---|---|---|
| Preferences | 1676/1888 · 88.8% | 1202/1414 · 85.0% |
| Virtual types | 803/899 · 89.3% | 693/810 · 85.6% |
| Plugins, declared | 99.0–99.4% per area | 99.8% per area |
| Plugins, inherited | 45.8–69.5% per area | 53.9–75.5% per area |

The residue is understood, not mysterious:

- **The `primary` scope.** `app/etc/di.xml` loads before every module's, and a
  stock one carries ~228 preferences (`DateTimeInterface`, the Redis session
  handlers, the ACL cache). `moduleOf()` returns nothing for a file outside a
  module, so we drop all of them. That is most of the preference gap.
- **Disabled modules.** Load order comes from `app/etc/config.php`:
  `ModuleList::getNames()` is `array_keys(array_filter($configData))`, and that
  filter drops disabled modules. We reproduce `sortBySequence()` instead, which
  `Module\Dir\Reader::getFiles()` never calls, and we cannot tell which modules
  are off. On the store with 30 disabled modules that costs 5 wrong preference
  winners and ~35 plugins per area that Magento never runs; the vanilla install,
  where nothing is disabled, reports zero extra plugins — which is what pins the
  diagnosis.
- **Inheritance.** `pluginsFor` matches the target name exactly, so a plugin
  declared on an abstract block or a framework interface never reaches the
  concrete class.

An `X => X\Interceptor` entry in the compiled preference map is interception
routing, not a declared preference — the harness folds it away, and we must
never emit one.

## Frontier

- **Interceptor chains between plugins.** Plugin ordering is modelled
  (`sortOrder`) but an `around` plugin calling `$proceed()` into the next plugin
  is not an edge; each plugin links to the intercepted method directly.
- **`extension_attributes.xml`** — generated getters/setters on the extension
  attribute interfaces.
- **GraphQL resolvers** — `schema.graphqls` `@resolver(class:)` directives are
  not read (the file is not XML, and `.graphqls` is not an indexed extension).
- **`$this->_view`, `getLayout()->createBlock()`** — blocks created
  programmatically rather than through layout XML.
- **UI component `component` fields** — the JS side of a UI component
  (`Magento_Ui/js/grid/listing`) is a RequireJS path, not linked to its file.
- **Magic `__call` getters and setters.** `AttributeInterface::getAttributeCode`
  has no implementation anywhere: `DataObject::__call` turns it into
  `getData('attribute_code')` at runtime. There is no method node to link to, so
  these preferences resolve at the type level only. This is the same
  metaprogramming frontier as ActiveRecord dynamic finders and Spring Data JPA
  derived queries.
- **`db_schema.xml`, `system.xml`, `acl.xml`** — configuration with no code
  target, deliberately skipped.
