/**
 * MageObsidian (ModernFrontend) framework resolver.
 *
 * MageObsidian replaces Magento's Luma/RequireJS frontend with Vite, Tailwind
 * and Vue while keeping Magento's layouts, blocks and templates. That leaves a
 * codebase where the PHP side is ordinary Magento — already covered by the
 * `magento` resolver — but the entire view and asset layer is invisible:
 *
 *   - templates are `.twig`, a file-level-only language with no symbols;
 *   - every cross-module import is `Vendor_Module::path`, resolved through the
 *     theme chain rather than the file system;
 *   - Vue islands are mounted by name from PHP and Twig, never imported.
 *
 * This resolver detects the stack and claims those names; the edges themselves
 * are synthesized in `resolution/mage-obsidian-synthesizer.ts`, where the whole
 * file set is visible.
 */

import type { Node } from '../../../types';
import type {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../../types';
import { getObsidianProject } from './config';
import { twigTemplateNode } from './twig';
import { lookupAsset } from './assets';
import { parseModuleSpecifier } from './names';

const COMPOSER_PREFIX = 'mage-obsidian/';
const COMPATIBILITY_FILE = 'mage_obsidian_compatibility.xml';

function detectFromComposer(context: ResolutionContext): boolean {
  const composer = context.readFile('composer.json');
  if (!composer) return false;
  try {
    const json = JSON.parse(composer) as {
      name?: string;
      require?: Record<string, string>;
      'require-dev'?: Record<string, string>;
    };
    if (typeof json.name === 'string' && json.name.startsWith(COMPOSER_PREFIX)) return true;
    const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
    return Object.keys(deps).some((dep) => dep.startsWith(COMPOSER_PREFIX));
  } catch {
    return false;
  }
}

/**
 * A module opts into MageObsidian by shipping
 * `etc/mage_obsidian_compatibility.xml`, so its presence anywhere means the
 * stack is in use — including in a project that only consumes it.
 */
function detectFromCompatibilityFile(context: ResolutionContext): boolean {
  return context.getAllFiles().some((filePath) => filePath.endsWith(`/${COMPATIBILITY_FILE}`));
}

export { TWIG_NODE_PREFIX } from './twig';

/**
 * Whether the project uses MageObsidian. Shared with the synthesis passes so
 * detection and edge emission can never disagree about it.
 */
export function usesMageObsidian(context: ResolutionContext): boolean {
  return detectFromCompatibilityFile(context) || detectFromComposer(context);
}

export const mageObsidianResolver: FrameworkResolver = {
  name: 'mage-obsidian',
  languages: ['php', 'xml', 'twig', 'typescript', 'javascript', 'vue'],

  detect(context: ResolutionContext): boolean {
    return usesMageObsidian(context);
  },

  claimsReference(name: string): boolean {
    return parseModuleSpecifier(name) !== null;
  },

  /**
   * Resolve a `Vendor_Module::path` specifier to the file the theme chain says
   * wins. Templates are handled by the Magento resolver, which already owns the
   * template index.
   */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const specifier = parseModuleSpecifier(ref.referenceName);
    if (!specifier) return null;

    const { assets } = getObsidianProject(context);
    const assetPath = lookupAsset(assets, ref.referenceName);
    if (!assetPath) return null;

    const fileNode = context.getNodesInFile(assetPath).find((n: Node) => n.kind === 'file');
    if (!fileNode) return null;
    return { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'framework' };
  },

  /**
   * Give every Twig template a node. `twig` is a file-level-only language, so
   * it produces no symbol at all — without this there is nothing for a template
   * to link from, and nothing for an `include` to land on.
   */
  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (!filePath.endsWith('.twig')) return { nodes: [], references: [] };
    return { nodes: [twigTemplateNode(filePath, content)], references: [] };
  },
};

export { getObsidianProject, clearObsidianConfigCache } from './config';
