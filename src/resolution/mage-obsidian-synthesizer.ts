/**
 * MageObsidian edge synthesis.
 *
 * The PHP half of a MageObsidian project is ordinary Magento. The frontend half
 * is not connected to anything as far as static extraction is concerned:
 *
 *   - **`Vendor_Module::path` imports.** Every cross-module import in JS, Vue and
 *     Twig uses this scheme (a relative import would bypass theme inheritance and
 *     silently break overrides). It names no file on disk — the build resolves it
 *     through the theme chain — so today it yields nothing.
 *   - **Twig templates.** `.twig` is a file-level-only language, so a template's
 *     block methods, includes, islands and script entries are all invisible.
 *   - **Vue islands.** `render_vue('Vendor_Module::Component')` mounts a component
 *     that nothing ever imports.
 *
 * Every pass is gated on both ends being indexed, and on the project actually
 * using the stack.
 */

import type { Edge, EdgeKind, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { getObsidianProject } from './frameworks/mage-obsidian/config';
import { usesMageObsidian } from './frameworks/mage-obsidian';
import { lookupAsset } from './frameworks/mage-obsidian/assets';
import { extractTwigReferences, TWIG_NODE_PREFIX } from './frameworks/mage-obsidian/twig';
import { getMagentoProject } from './frameworks/magento/config';
import { lookupTemplate } from './frameworks/magento/layout';
import { templateClassBindings } from './magento-synthesizer';
import { fqcnToQualifiedName } from './frameworks/magento/names';

const MAX_EDGES_PER_FILE = 60;

/** The QueryBuilder surface the Twig pass needs to reach a block's methods. */
interface MagentoQueries {
  getNodesByQualifiedNameExact(qualifiedName: string): Node[];
  getNodeById(id: string): Node | null;
  getOutgoingEdges(nodeId: string, kinds?: EdgeKind[]): Edge[];
}

/**
 * The method `block.foo()` runs, looked up on the classes layout XML binds to
 * the template. Inherited methods count — a block usually gets most of its API
 * from `AbstractBlock`.
 */
function blockMethod(
  queries: MagentoQueries,
  classNames: Set<string> | undefined,
  methodName: string,
): Node | null {
  if (!classNames) return null;
  for (const className of classNames) {
    const classNode = queries
      .getNodesByQualifiedNameExact(fqcnToQualifiedName(className))
      .find((n) => n.kind === 'class' || n.kind === 'interface');
    if (!classNode) continue;

    const seen = new Set<string>([classNode.id]);
    let frontier = [classNode.id];
    for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of queries.getOutgoingEdges(id, ['contains'])) {
          const node = queries.getNodeById(edge.target);
          if (node && node.kind === 'method' && node.name === methodName) return node;
        }
        for (const edge of queries.getOutgoingEdges(id, ['extends', 'implements'])) {
          if (seen.has(edge.target)) continue;
          seen.add(edge.target);
          next.push(edge.target);
        }
      }
      frontier = next;
    }
  }
  return null;
}

const JS_EXTENSIONS = ['.js', '.ts', '.mjs', '.cjs', '.vue'];

/**
 * The node standing for a file. A Twig template has no `file` node — the
 * language extracts no symbols — so it is represented by the template node the
 * resolver emits instead.
 */
function fileNode(context: ResolutionContext, filePath: string): Node | null {
  const nodes = context.getNodesInFile(filePath);
  if (filePath.endsWith('.twig')) {
    return nodes.find((n) => n.id.startsWith(TWIG_NODE_PREFIX)) ?? null;
  }
  return nodes.find((n) => n.kind === 'file') ?? null;
}

function obsidianEdge(
  source: Node,
  target: Node,
  synthesizedBy: string,
  via: string,
  line: number,
  filePath: string,
): Edge {
  return {
    source: source.id,
    target: target.id,
    kind: 'calls',
    line,
    provenance: 'heuristic',
    metadata: { synthesizedBy, via, registeredAt: `${filePath}:${line}` },
  };
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

const IMPORT_RE = /\bfrom\s*['"]([A-Z][A-Za-z0-9]*_[A-Za-z0-9]+::[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([A-Z][A-Za-z0-9]*_[A-Za-z0-9]+::[^'"]+)['"]\s*\)/g;

/**
 * `import … from "Vendor_Module::path"` → the file the theme chain resolves it
 * to. This is the edge that makes the JS side a graph at all.
 */
export async function mageObsidianImportEdges(
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  if (!usesMageObsidian(context)) return [];
  const { assets } = getObsidianProject(context);
  if (assets.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const filePath of context.getAllFiles()) {
    if (!JS_EXTENSIONS.some((ext) => filePath.endsWith(ext))) continue;
    await onYield();

    const source = context.readFile(filePath);
    if (!source || !source.includes('::')) continue;
    const from = fileNode(context, filePath);
    if (!from) continue;

    let added = 0;
    for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null && added < MAX_EDGES_PER_FILE) {
        const specifier = match[1]!;
        const resolved = lookupAsset(assets, specifier);
        if (!resolved || resolved === filePath) continue;
        const target = fileNode(context, resolved);
        if (!target) continue;
        const key = `${from.id}>${target.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push(
          obsidianEdge(from, target, 'obsidian-import', specifier, lineOf(source, match.index), filePath),
        );
        added++;
      }
    }
  }

  return edges;
}

/**
 * Twig templates → what they reach: other templates, Vue islands, JS entries,
 * and the block or view-model methods they call.
 *
 * The block side reuses the Magento layout binding: layout XML says which class
 * backs the template, and that is what `block.getFoo()` resolves against.
 */
export async function mageObsidianTwigEdges(
  queries: MagentoQueries,
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  if (!usesMageObsidian(context)) return [];
  const { assets } = getObsidianProject(context);
  const { templates } = getMagentoProject(context);
  const boundClasses = await templateClassBindings(context, templates, onYield);

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const filePath of context.getAllFiles()) {
    if (!filePath.endsWith('.twig')) continue;
    await onYield();

    const source = context.readFile(filePath);
    if (!source) continue;
    const from = fileNode(context, filePath);
    if (!from) continue;

    let added = 0;
    for (const reference of extractTwigReferences(source)) {
      if (added >= MAX_EDGES_PER_FILE) break;

      let resolvedPath: string | null = null;
      let channel: string;
      switch (reference.kind) {
        case 'template':
          resolvedPath = lookupTemplate(templates, reference.value);
          channel = 'obsidian-twig-include';
          break;
        case 'component':
          resolvedPath = lookupAsset(assets, reference.value);
          channel = 'obsidian-island';
          break;
        case 'script':
          resolvedPath = lookupAsset(assets, reference.value);
          channel = 'obsidian-twig-script';
          break;
        case 'block-method': {
          const method = blockMethod(queries, boundClasses.get(filePath), reference.value);
          if (!method) continue;
          const key = `${from.id}>${method.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push(
            obsidianEdge(from, method, 'obsidian-twig-block', reference.value, reference.line, filePath),
          );
          added++;
          continue;
        }
        default:
          continue;
      }
      if (!resolvedPath || resolvedPath === filePath) continue;

      const target = fileNode(context, resolvedPath);
      if (!target) continue;
      const key = `${from.id}>${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(
        obsidianEdge(from, target, channel, reference.value, reference.line, filePath),
      );
      added++;
    }
  }

  return edges;
}

/**
 * The PHP ↔ JS contract.
 *
 * MageObsidian's two halves never call each other: PHP writes
 * `mage_obsidian_frontend_modules.json` from the constants on `ConfigInterface`,
 * and the JS build reads it back. The project's own documentation calls these
 * "the two ends of the same wire" and warns that changing one side without the
 * other breaks the build — yet nothing in either language references the other,
 * so "what breaks if I rename this constant" is unanswerable from the graph.
 *
 * Bridge it on the one thing both sides spell identically: the constant name.
 * A PHP constant declared on a `ConfigInterface` is linked to the JS/TS files
 * that read a property of that name off the resolved config. Gated on the name
 * being distinctive (screaming snake case) so ordinary identifiers cannot pair.
 */
const CONFIG_INTERFACE_RE = /(?:interface|class)\s+\w*Config\w*\b/;
const PHP_CONST_RE = /\bconst\s+(?:\w+\s+)?([A-Z][A-Z0-9_]{3,})\s*=/g;

export async function mageObsidianContractEdges(
  context: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  if (!usesMageObsidian(context)) return [];

  const constants = new Map<string, Node>();
  for (const filePath of context.getAllFiles()) {
    if (!filePath.endsWith('.php') || !filePath.includes('Config')) continue;
    await onYield();
    const source = context.readFile(filePath);
    if (!source || !CONFIG_INTERFACE_RE.test(source)) continue;

    const nodesInFile = context.getNodesInFile(filePath);
    PHP_CONST_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PHP_CONST_RE.exec(source)) !== null) {
      const name = match[1]!;
      const node = nodesInFile.find((n) => n.kind === 'constant' && n.name === name);
      if (node && !constants.has(name)) constants.set(name, node);
    }
  }
  if (constants.size === 0) return [];

  const edges: Edge[] = [];
  const seen = new Set<string>();

  for (const filePath of context.getAllFiles()) {
    if (!filePath.endsWith('.ts') && !filePath.endsWith('.js')) continue;
    await onYield();
    const source = context.readFile(filePath);
    if (!source) continue;
    const from = fileNode(context, filePath);
    if (!from) continue;

    let added = 0;
    for (const [name, constant] of constants) {
      if (added >= MAX_EDGES_PER_FILE) break;
      const index = source.indexOf(`.${name}`);
      if (index < 0) continue;
      const key = `${from.id}>${constant.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(
        obsidianEdge(from, constant, 'obsidian-contract', name, lineOf(source, index), filePath),
      );
      added++;
    }
  }

  return edges;
}
