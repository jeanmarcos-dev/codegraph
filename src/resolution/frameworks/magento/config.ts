/**
 * Cached per-project Magento configuration.
 *
 * Both the resolver (called once per unresolved reference) and the synthesizer
 * passes need the merged `di.xml` table, and building it means reading every
 * module's config XML. Framework resolvers are otherwise stateless, so the
 * cache lives here, keyed by project root plus a cheap signature of the config
 * file set, and is rebuilt when that set changes. Resolver-pool workers each
 * build their own copy, which is fine: without `vendor/` indexed a project has
 * tens of config files, not thousands.
 */

import type { ResolutionContext } from '../../types';
import { discoverModules, sortModules, type MagentoModule } from './modules';
import { buildDiConfig, type MagentoConfig } from './di';
import { buildTemplateIndex, type TemplateIndex } from './layout';

export interface MagentoProject {
  modules: Map<string, MagentoModule>;
  config: MagentoConfig;
  /** Module paths keyed by module name, for template and controller lookups. */
  modulePaths: Map<string, string>;
  /** `Vendor_Module::path.phtml` → indexed file, theme overrides applied. */
  templates: TemplateIndex;
}

interface CacheEntry {
  signature: string;
  project: MagentoProject;
}

const cache = new Map<string, CacheEntry>();

function signatureOf(context: ResolutionContext): string {
  let count = 0;
  let hash = 0;
  for (const filePath of context.getAllFiles()) {
    if (!filePath.endsWith('.xml')) continue;
    count++;
    for (let i = 0; i < filePath.length; i++) {
      hash = (Math.imul(hash, 31) + filePath.charCodeAt(i)) | 0;
    }
  }
  return `${count}:${hash}`;
}

/** The merged Magento configuration for the context's project. */
export function getMagentoProject(context: ResolutionContext): MagentoProject {
  const root = context.getProjectRoot();
  const signature = signatureOf(context);
  const cached = cache.get(root);
  if (cached && cached.signature === signature) return cached.project;

  const modules = discoverModules(context);
  sortModules(modules);
  const modulePaths = new Map([...modules].map(([name, module]) => [name, module.path]));
  const project: MagentoProject = {
    modules,
    config: buildDiConfig(context, modules),
    modulePaths,
    templates: buildTemplateIndex(modulePaths, context.getAllFiles()),
  };
  cache.set(root, { signature, project });
  return project;
}

/** Drop cached configuration; used by tests and after a project is re-indexed. */
export function clearMagentoConfigCache(): void {
  cache.clear();
}
