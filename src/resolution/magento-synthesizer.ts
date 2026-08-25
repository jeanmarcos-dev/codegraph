/**
 * Magento DI edge synthesis.
 *
 * Magento never runs the class a PHP type hint names. `di.xml` decides it, and
 * the decision is invisible to static extraction:
 *
 *   - `<preference for type>` — a call to `ProductRepositoryInterface::getById`
 *     runs the preference's class. Without this the flow dead-ends on an
 *     interface method with an empty body.
 *   - `<plugin>` — Magento compiles an `Interceptor` subclass at build time
 *     that calls each registered `before*` / `around*` / `after*` method around
 *     the original. Nothing in the source references the plugin at all, so
 *     "what intercepts this method" is unanswerable from the call graph.
 *   - `<argument xsi:type="object">` — pins one constructor injection to a
 *     specific class, overriding the preference for that argument only, and
 *     supplies the members of every composite/pool through array items.
 *
 * Each pass is gated on BOTH ends being indexed. With `vendor/` excluded by
 * default most core targets are absent, and a synthesized edge to a class the
 * graph never saw would be a fabricated claim — silent beats wrong. Edges carry
 * `provenance:'heuristic'` and a `registeredAt` pointing at the `di.xml` line
 * an agent would otherwise have to grep for.
 */

import type { Edge, EdgeKind, Node } from '../types';
import type { ResolutionContext, UnresolvedRef } from './types';
import type { MaybeYield } from './cooperative-yield';
import { getMagentoProject } from './frameworks/magento/config';
import {
  pluginsFor,
  pluginInheritance,
  resolvePreference,
  resolveType,
  preferenceSite,
  objectArgumentsFor,
  GLOBAL_AREA,
  type MagentoConfig,
} from './frameworks/magento/di';
import {
  fqcnToQualifiedName,
  stripGeneratedSuffix,
  TEMPLATE_REF_PREFIX,
} from './frameworks/magento/names';
import { collectFrontNames } from './frameworks/magento/config-xml';
import { declaredParents } from './frameworks/magento/php-parents';
import { extractLayout, lookupTemplate } from './frameworks/magento/layout';

/** The QueryBuilder surface these passes need. */
interface MagentoQueries {
  getNodesByQualifiedNameExact(qualifiedName: string): Node[];
  getNodeById(id: string): Node | null;
  getOutgoingEdges(nodeId: string, kinds?: EdgeKind[]): Edge[];
}

const MAX_EDGES_PER_TARGET = 40;

/**
 * Stream nodes of a kind when the context supports it. `getNodesByKind`
 * materializes the whole array, which on a symbol-dense project is exactly the
 * allocation the synthesizer passes are supposed to avoid.
 */
function iterateKind(context: ResolutionContext, kind: Node['kind']): Iterable<Node> {
  return context.iterateNodesByKind ? context.iterateNodesByKind(kind) : context.getNodesByKind(kind);
}

const INTERCEPTOR_PREFIXES = ['before', 'around', 'after'] as const;

function lookupType(queries: MagentoQueries, fqcn: string): Node | null {
  return (
    queries
      .getNodesByQualifiedNameExact(fqcnToQualifiedName(fqcn))
      .find((n) => n.kind === 'class' || n.kind === 'interface') ?? null
  );
}

/**
 * The node for a Magento type name. `X\Factory` and `X\Proxy` are generated at
 * build time and never exist on disk, so they fall back to the class they stand
 * in for.
 */
function typeNode(queries: MagentoQueries, fqcn: string): Node | null {
  if (!fqcn) return null;
  const direct = lookupType(queries, fqcn);
  if (direct) return direct;
  const generated = stripGeneratedSuffix(fqcn);
  return generated ? lookupType(queries, generated.base) : null;
}

function ownMethodsOf(queries: MagentoQueries, typeId: string): Map<string, Node> {
  const methods = new Map<string, Node>();
  for (const edge of queries.getOutgoingEdges(typeId, ['contains'])) {
    const node = queries.getNodeById(edge.target);
    if (node && node.kind === 'method' && !methods.has(node.name)) methods.set(node.name, node);
  }
  return methods;
}

const MAX_INHERITANCE_DEPTH = 6;

/**
 * A type's methods including the ones it inherits.
 *
 * Magento leans on inheritance heavily — every `SearchResults` implementation
 * gets `getItems` from a framework base class, most models extend
 * `AbstractModel` — so matching only self-declared methods misses the majority
 * of preference targets. A method the type declares itself always wins over an
 * inherited one of the same name, which is the method that actually runs.
 */
function methodsOf(queries: MagentoQueries, typeId: string): Map<string, Node> {
  const methods = ownMethodsOf(queries, typeId);
  const seen = new Set<string>([typeId]);
  let frontier = [typeId];

  for (let depth = 0; depth < MAX_INHERITANCE_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of queries.getOutgoingEdges(id, ['extends', 'implements'])) {
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        const supertype = queries.getNodeById(edge.target);
        if (!supertype || (supertype.kind !== 'class' && supertype.kind !== 'interface')) continue;
        next.push(supertype.id);
        for (const [name, method] of ownMethodsOf(queries, supertype.id)) {
          if (!methods.has(name)) methods.set(name, method);
        }
      }
    }
    frontier = next;
  }

  return methods;
}

function magentoEdge(
  source: Node,
  target: Node,
  synthesizedBy: string,
  via: string,
  registeredAt: string,
): Edge {
  return {
    source: source.id,
    target: target.id,
    kind: 'calls',
    line: source.startLine,
    provenance: 'heuristic',
    metadata: { synthesizedBy, via, registeredAt },
  };
}

/** Every area declared in the merged config, global first. */
function areasOf(config: MagentoConfig): string[] {
  const areas = new Set<string>([GLOBAL_AREA]);
  for (const map of [config.preferences, config.plugins, config.objectArguments, config.virtualTypes]) {
    for (const area of map.keys()) areas.add(area);
  }
  return [...areas];
}

/**
 * `<preference>` — interface method → the method that actually runs.
 *
 * Deliberately per-method rather than type-level: it is the method edge that
 * lets a trace continue through the interface into real code.
 */
export async function magentoPreferenceEdges(
  queries: MagentoQueries,
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const { modules, config } = getMagentoProject(context);
  if (modules.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const area of areasOf(config)) {
    const declared = config.preferences.get(area);
    if (!declared) continue;

    for (const name of declared.keys()) {
      await onYield();
      const implementation = resolvePreference(config, name, area);
      if (implementation === name) continue;

      const abstractNode = typeNode(queries, name);
      const concreteNode = typeNode(queries, implementation);
      if (!abstractNode || !concreteNode || abstractNode.id === concreteNode.id) continue;

      const site = preferenceSite(config, name, area);
      const registeredAt = site ? `${site.filePath}:${site.line}` : '';
      const concreteMethods = methodsOf(queries, concreteNode.id);

      let added = 0;
      for (const [methodName, abstractMethod] of methodsOf(queries, abstractNode.id)) {
        if (added >= MAX_EDGES_PER_TARGET) break;
        const concreteMethod = concreteMethods.get(methodName);
        if (!concreteMethod || concreteMethod.id === abstractMethod.id) continue;
        const key = `${abstractMethod.id}>${concreteMethod.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(
          magentoEdge(abstractMethod, concreteMethod, 'magento-preference', methodName, registeredAt),
        );
        added++;
      }
    }
  }

  return edges;
}

/** `beforeGetPrice` → `getPrice`; null when the method is not an interceptor. */
function interceptedMethodName(pluginMethod: string): string | null {
  for (const prefix of INTERCEPTOR_PREFIXES) {
    if (!pluginMethod.startsWith(prefix) || pluginMethod.length <= prefix.length) continue;
    const rest = pluginMethod.slice(prefix.length);
    if (rest[0] !== rest[0]!.toUpperCase()) continue;
    return rest[0]!.toLowerCase() + rest.slice(1);
  }
  return null;
}

/** A node's Magento FQCN — the qualified name with its last `::` back to `\`. */
function fqcnOf(node: Node): string {
  return node.qualifiedName.replace(/::(?=[^:]*$)/, '\\');
}

/**
 * Every type the plugin pass has to ask about.
 *
 * Interception runs down the hierarchy, so a class inherits the plugins of its
 * ancestors — but asking that of every indexed class is wasted work on a store
 * where almost nothing is intercepted. Only a type that has a declared target
 * somewhere above it can gain anything, so the walk happens once here and the
 * per-area loop stays on that set.
 */
function pluginCandidates(
  context: ResolutionContext,
  config: MagentoConfig,
  parentsOf: (type: string) => string[],
): Set<string> {
  const declared = new Set<string>();
  for (const byTarget of config.plugins.values()) for (const target of byTarget.keys()) declared.add(target);

  const candidates = new Set<string>(declared);
  const verdicts = new Map<string, boolean>();

  const inherits = (type: string): boolean => {
    const known = verdicts.get(type);
    if (known !== undefined) return known;
    verdicts.set(type, false); // cycle guard, replaced below
    const answer = parentsOf(type).some((parent) => declared.has(parent) || inherits(parent));
    verdicts.set(type, answer);
    return answer;
  };

  for (const kind of ['class', 'interface'] as const) {
    for (const node of iterateKind(context, kind)) {
      const fqcn = fqcnOf(node);
      if (!candidates.has(fqcn) && inherits(fqcn)) candidates.add(fqcn);
    }
  }
  return candidates;
}

/**
 * `<plugin>` — intercepted method → each plugin method wrapping it.
 *
 * A plugin declared on an interface also wraps whatever the preference
 * resolves that interface to, so both target nodes are linked when both are
 * indexed. Unless `magento.inheritPlugins` is turned off, a type also collects
 * the plugins its ancestors declare — `storeCheck` on
 * `Magento\Framework\App\Action\Action` really does run on every controller.
 */
export async function magentoPluginEdges(
  queries: MagentoQueries,
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const { modules, config, inheritPlugins } = getMagentoProject(context);
  if (modules.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  // Parents from the graph, unioned with the ones the class DECLARES. The graph
  // only carries an `extends`/`implements` edge when both ends are indexed, and
  // a store's classes routinely implement a core interface that lives in the
  // unindexed `vendor/` tree — while the `<plugin>` on that interface is
  // declared right there in `app/code`. Inheritance matches on names, so the
  // declared name is all that was missing.
  const parentCache = new Map<string, string[]>();
  const parentsOf = (type: string): string[] => {
    const cached = parentCache.get(type);
    if (cached) return cached;
    parentCache.set(type, []);

    const node = typeNode(queries, type);
    if (!node) return [];
    const parents = queries
      .getOutgoingEdges(node.id, ['extends', 'implements'])
      .map((edge) => queries.getNodeById(edge.target))
      .filter((n): n is Node => n !== null && (n.kind === 'class' || n.kind === 'interface'))
      .map(fqcnOf);

    if (node.filePath.endsWith('.php')) {
      const source = context.readFile(node.filePath);
      if (source) {
        for (const declared of declaredParents(source, node.name)) {
          if (!parents.includes(declared)) parents.push(declared);
        }
      }
    }
    parentCache.set(type, parents);
    return parents;
  };
  const inheritance = inheritPlugins ? pluginInheritance(parentsOf) : undefined;
  const targets = inheritance
    ? pluginCandidates(context, config, parentsOf)
    : null;

  for (const area of areasOf(config)) {
    const byTarget = config.plugins.get(area);
    if (!byTarget) continue;

    for (const target of targets ?? byTarget.keys()) {
      await onYield();
      const plugins = pluginsFor(config, target, area, inheritance);
      if (plugins.length === 0) continue;

      const targetNames = new Set<string>([target, resolveType(config, target, area)]);
      const targetNodes = [...targetNames]
        .map((name) => typeNode(queries, name))
        .filter((n): n is Node => n !== null);
      if (targetNodes.length === 0) continue;

      for (const plugin of plugins) {
        const pluginNode = typeNode(queries, resolveType(config, plugin.type, area));
        if (!pluginNode) continue;
        const registeredAt = `${plugin.filePath}:${plugin.line}`;

        for (const [pluginMethodName, pluginMethod] of methodsOf(queries, pluginNode.id)) {
          const interceptedName = interceptedMethodName(pluginMethodName);
          if (!interceptedName) continue;

          for (const targetNode of targetNodes) {
            const intercepted = methodsOf(queries, targetNode.id).get(interceptedName);
            if (!intercepted) continue;
            const key = `${intercepted.id}>${pluginMethod.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push(
              magentoEdge(intercepted, pluginMethod, 'magento-plugin', plugin.name, registeredAt),
            );
          }
        }
      }
    }
  }

  return edges;
}

/**
 * `<argument xsi:type="object">` — constructor → the class configuration wires
 * into it. Targets the injected class's own constructor when it has one, so
 * the edge lands on executable code rather than a type declaration.
 */
export async function magentoDiArgumentEdges(
  queries: MagentoQueries,
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const { modules, config } = getMagentoProject(context);
  if (modules.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const area of areasOf(config)) {
    const byTarget = config.objectArguments.get(area);
    if (!byTarget) continue;

    for (const target of byTarget.keys()) {
      await onYield();
      const targetNode = typeNode(queries, resolveType(config, target, area));
      if (!targetNode) continue;
      const constructor = methodsOf(queries, targetNode.id).get('__construct');
      if (!constructor) continue;

      let added = 0;
      for (const argument of objectArgumentsFor(config, target, area)) {
        if (added >= MAX_EDGES_PER_TARGET) break;
        const injectedNode = typeNode(queries, resolveType(config, argument.value, area));
        if (!injectedNode) continue;
        const destination = methodsOf(queries, injectedNode.id).get('__construct') ?? injectedNode;
        if (destination.id === constructor.id) continue;
        const key = `${constructor.id}>${destination.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(
          magentoEdge(
            constructor,
            destination,
            'magento-di-argument',
            argument.itemName ? `${argument.name}.${argument.itemName}` : argument.name,
            `${argument.filePath}:${argument.line}`,
          ),
        );
        added++;
      }
    }
  }

  return edges;
}

/**
 * `XFactory::create()` — the calling method → the class that gets created.
 *
 * Magento generates a `<Class>Factory` at build time for every type asked for
 * one, so `$this->itemFactory->create()` calls a method on a class that exists
 * nowhere on disk. Extraction leaves the callsite unresolved and object
 * creation — a large share of what Magento code does — is missing from the
 * graph entirely.
 *
 * The property's factory type comes from the constructor signature or a typed
 * property declaration, resolved through the file's `use` statements. Gated on
 * the created class being indexed, so a factory for a core class emits nothing
 * rather than a guess.
 */
const USE_STATEMENT_RE = /^[ \t]*use[ \t]+([\w\\]+)(?:[ \t]+as[ \t]+(\w+))?[ \t]*;/gm;
const FACTORY_DECLARATION_RE = /(\\?[\w\\]*Factory)\s+\$(\w+)/g;
const FACTORY_ASSIGNMENT_RE = /\$this->(\w+)\s*=\s*\$(\w+)\s*;/g;
const FACTORY_CREATE_RE = /\$this->(\w+)\s*->\s*create\s*\(/g;

function useMap(source: string): Map<string, string> {
  const aliases = new Map<string, string>();
  USE_STATEMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = USE_STATEMENT_RE.exec(source)) !== null) {
    const fqcn = match[1]!;
    const alias = match[2] ?? fqcn.slice(fqcn.lastIndexOf('\\') + 1);
    aliases.set(alias, fqcn);
  }
  return aliases;
}

function expandClassName(name: string, aliases: Map<string, string>, namespace: string): string {
  if (name.startsWith('\\')) return name.slice(1);
  const head = name.includes('\\') ? name.slice(0, name.indexOf('\\')) : name;
  const alias = aliases.get(head);
  if (alias) return name.includes('\\') ? `${alias}${name.slice(head.length)}` : alias;
  return namespace ? `${namespace}\\${name}` : name;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function enclosingMethod(nodesInFile: Node[], line: number): Node | null {
  let best: Node | null = null;
  for (const node of nodesInFile) {
    if (node.kind !== 'method' && node.kind !== 'function') continue;
    if (line < node.startLine || line > node.endLine) continue;
    if (!best || node.startLine > best.startLine) best = node;
  }
  return best;
}

export async function magentoFactoryEdges(
  queries: MagentoQueries,
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const { modules, config } = getMagentoProject(context);
  if (modules.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const filePath of context.getAllFiles()) {
    if (!filePath.endsWith('.php') && !filePath.endsWith('.phtml')) continue;
    await onYield();

    const source = context.readFile(filePath);
    if (!source || !source.includes('Factory')) continue;
    if (!FACTORY_CREATE_RE.test(source)) continue;
    FACTORY_CREATE_RE.lastIndex = 0;

    const aliases = useMap(source);
    const namespace = source.match(/^[ \t]*namespace[ \t]+([\w\\]+)[ \t]*;/m)?.[1] ?? '';

    const factoryOfProperty = new Map<string, string>();
    FACTORY_DECLARATION_RE.lastIndex = 0;
    let declaration: RegExpExecArray | null;
    while ((declaration = FACTORY_DECLARATION_RE.exec(source)) !== null) {
      factoryOfProperty.set(declaration[2]!, expandClassName(declaration[1]!, aliases, namespace));
    }
    FACTORY_ASSIGNMENT_RE.lastIndex = 0;
    let assignment: RegExpExecArray | null;
    while ((assignment = FACTORY_ASSIGNMENT_RE.exec(source)) !== null) {
      const factory = factoryOfProperty.get(assignment[2]!);
      if (factory) factoryOfProperty.set(assignment[1]!, factory);
    }
    if (factoryOfProperty.size === 0) continue;

    const nodesInFile = context.getNodesInFile(filePath);
    let callsite: RegExpExecArray | null;
    while ((callsite = FACTORY_CREATE_RE.exec(source)) !== null) {
      const factory = factoryOfProperty.get(callsite[1]!);
      if (!factory) continue;
      const generated = stripGeneratedSuffix(factory);
      if (!generated || generated.kind !== 'factory') continue;

      const createdNode = typeNode(queries, resolveType(config, generated.base));
      if (!createdNode) continue;

      const line = lineOf(source, callsite.index);
      const caller = enclosingMethod(nodesInFile, line);
      if (!caller) continue;

      const destination = methodsOf(queries, createdNode.id).get('__construct') ?? createdNode;
      const key = `${caller.id}>${destination.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(
        magentoEdge(caller, destination, 'magento-factory', callsite[1]!, `${filePath}:${line}`),
      );
    }
  }

  return edges;
}

/**
 * `$eventManager->dispatch('name')` — the dispatching method → the event node.
 *
 * The observer side is already linked (the event node references each
 * observer's method), so this closes the other half of the flow whenever the
 * code that fires the event is inside the index. Core events fired from
 * `vendor/magento` stay unlinked on this side by design; their event node still
 * answers which observers run.
 */
const EVENT_DISPATCH_RE = /->\s*dispatch\s*\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/g;

export async function magentoEventDispatchEdges(
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const { modules } = getMagentoProject(context);
  if (modules.size === 0) return [];

  const eventNodes = new Map<string, Node[]>();
  for (const node of iterateKind(context, 'function')) {
    if (node.language !== 'xml' || !node.qualifiedName.includes('::event:')) continue;
    const list = eventNodes.get(node.name);
    if (list) list.push(node);
    else eventNodes.set(node.name, [node]);
  }
  if (eventNodes.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const filePath of context.getAllFiles()) {
    if (!filePath.endsWith('.php')) continue;
    await onYield();
    const source = context.readFile(filePath);
    if (!source || !source.includes('dispatch')) continue;

    const nodesInFile = context.getNodesInFile(filePath);
    EVENT_DISPATCH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EVENT_DISPATCH_RE.exec(source)) !== null) {
      const targets = eventNodes.get(match[1]!.toLowerCase());
      if (!targets) continue;
      const line = lineOf(source, match.index);
      const dispatcher = enclosingMethod(nodesInFile, line);
      if (!dispatcher) continue;

      for (const target of targets) {
        const key = `${dispatcher.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          source: dispatcher.id,
          target: target.id,
          kind: 'calls',
          line,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'magento-event',
            via: match[1]!,
            registeredAt: `${target.filePath}:${target.startLine}`,
          },
        });
      }
    }
  }

  return edges;
}

/**
 * `routes.xml` front name → the controller actions that serve it.
 *
 * Magento maps a URL to a class by convention, not by configuration:
 * `/<frontName>/<path>/<action>` runs `execute()` on
 * `<Module>/Controller/<Path>/<Action>.php`. The front name is the only part
 * written down, so nothing links the URL prefix to the action classes — they
 * read as uncalled code. This pairs the two using the module ownership the
 * route declares, and puts the full URL path in the edge so the action's
 * callers show what actually reaches it.
 */
const CONTROLLER_DIR_RE = /(^|\/)Controller\//;

export async function magentoControllerRouteEdges(
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const { modules } = getMagentoProject(context);
  if (modules.size === 0) return [];

  const frontNames = collectFrontNames(context.getAllFiles(), (f) => context.readFile(f));
  if (frontNames.length === 0) return [];

  const routeNodes = new Map<string, Node>();
  for (const node of iterateKind(context, 'route')) {
    if (node.id.startsWith('magento-route:')) routeNodes.set(node.id, node);
  }

  const controllerFiles = context
    .getAllFiles()
    .filter((f) => f.endsWith('.php') && CONTROLLER_DIR_RE.test(f));

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const route of frontNames) {
    await onYield();
    const routeNode = routeNodes.get(`magento-route:${route.filePath}:${route.line}:${route.frontName}`);
    if (!routeNode) continue;

    for (const moduleName of route.modules) {
      const module = modules.get(moduleName);
      if (!module) continue;
      const controllerRoot = module.path ? `${module.path}/Controller/` : 'Controller/';

      let added = 0;
      for (const filePath of controllerFiles) {
        if (added >= MAX_EDGES_PER_TARGET) break;
        if (!filePath.startsWith(controllerRoot)) continue;

        const execute = context
          .getNodesInFile(filePath)
          .find((n) => n.kind === 'method' && n.name === 'execute');
        if (!execute) continue;

        const key = `${routeNode.id}>${execute.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const actionPath = filePath
          .slice(controllerRoot.length, -'.php'.length)
          .toLowerCase();
        edges.push({
          source: routeNode.id,
          target: execute.id,
          kind: 'calls',
          line: routeNode.startLine,
          provenance: 'heuristic',
          metadata: {
            synthesizedBy: 'magento-controller',
            via: `${route.frontName}/${actionPath}`,
            registeredAt: `${route.filePath}:${route.line}`,
          },
        });
        added++;
      }
    }
  }

  return edges;
}


/**
 * Template file → the classes layout XML binds to it (the block class plus any
 * view models). This is what makes a template's `$block->getFoo()` resolvable,
 * and it is shared with the MageObsidian passes because a Twig template is
 * bound by exactly the same layout XML.
 */
export async function templateClassBindings(
  context: ResolutionContext,
  templates: Map<string, string>,
  onYield: MaybeYield,
): Promise<Map<string, Set<string>>> {
  const layoutFiles = new Set<string>();
  for (const block of iterateKind(context, 'component')) {
    if (block.id.startsWith('magento-block:')) layoutFiles.add(block.filePath);
  }

  const boundClasses = new Map<string, Set<string>>();
  for (const layoutPath of layoutFiles) {
    await onYield();
    const layout = context.readFile(layoutPath);
    if (!layout) continue;

    const byBlock = new Map<string, UnresolvedRef[]>();
    for (const reference of extractLayout(layoutPath, layout).references) {
      const list = byBlock.get(reference.fromNodeId);
      if (list) list.push(reference);
      else byBlock.set(reference.fromNodeId, [reference]);
    }

    for (const references of byBlock.values()) {
      const templateRef = references.find((r) => r.referenceName.startsWith(TEMPLATE_REF_PREFIX));
      if (!templateRef) continue;
      const templatePath = lookupTemplate(
        templates,
        templateRef.referenceName.slice(TEMPLATE_REF_PREFIX.length),
      );
      if (!templatePath) continue;

      let classes = boundClasses.get(templatePath);
      if (!classes) {
        classes = new Set();
        boundClasses.set(templatePath, classes);
      }
      for (const reference of references) {
        if (reference.referenceName.startsWith('magento:')) continue;
        classes.add(reference.referenceName);
      }
    }
  }

  return boundClasses;
}

/**
 * `.phtml` template → the block and view-model methods it calls.
 *
 * A template's `$block->getFoo()` names a method on a class the template never
 * mentions: layout XML supplies it. Both halves are known here — the layout
 * block node references its class and its template — so the callsites can be
 * bound to real methods, giving the block class its callers and the template
 * its data source.
 */
const BLOCK_CALL_RE = /\$(block|viewModel|view_model)\s*->\s*(\w+)\s*\(/g;

export async function magentoTemplateEdges(
  queries: MagentoQueries,
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const { modules, config, templates } = getMagentoProject(context);
  if (modules.size === 0) return [];

  const boundClasses = await templateClassBindings(context, templates, onYield);
  if (boundClasses.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const [templatePath, classNames] of boundClasses) {
    await onYield();
    const source = context.readFile(templatePath);
    if (!source) continue;

    const templateNode = context.getNodesInFile(templatePath).find((n) => n.kind === 'file');
    if (!templateNode) continue;

    const methodsByName = new Map<string, Node>();
    for (const className of classNames) {
      const classNode = typeNode(queries, resolveType(config, className));
      if (!classNode) continue;
      for (const [methodName, method] of methodsOf(queries, classNode.id)) {
        if (!methodsByName.has(methodName)) methodsByName.set(methodName, method);
      }
    }
    if (methodsByName.size === 0) continue;

    BLOCK_CALL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let added = 0;
    while ((match = BLOCK_CALL_RE.exec(source)) !== null && added < MAX_EDGES_PER_TARGET) {
      const method = methodsByName.get(match[2]!);
      if (!method) continue;
      const key = `${templateNode.id}>${method.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = lineOf(source, match.index);
      edges.push({
        source: templateNode.id,
        target: method.id,
        kind: 'calls',
        line,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'magento-template',
          via: match[2]!,
          registeredAt: `${templatePath}:${line}`,
        },
      });
      added++;
    }
  }

  return edges;
}
