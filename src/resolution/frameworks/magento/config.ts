/**
 * Cached per-project Magento configuration.
 *
 * Both the resolver and the synthesizer passes need the merged `di.xml` table,
 * and building it means reading every module's config XML plus indexing every
 * template. Framework resolvers are otherwise stateless, so the cache lives
 * here.
 *
 * It is keyed by the ResolutionContext INSTANCE, which is what makes lookups
 * O(1). `resolve()` runs once per unresolved reference — hundreds of thousands
 * of times on a full Magento store — so any per-call work proportional to the
 * file count blocks the resolver's thread for the whole index. A context is
 * created per resolver run, so a re-index gets a fresh entry and stale
 * configuration can never be served.
 */

import type { ResolutionContext } from '../../types';
import { loadMagentoInheritPlugins } from '../../../project-config';
import { discoverModules, sortModules, readModuleConfig, type MagentoModule } from './modules';
import { buildDiConfig, type MagentoConfig } from './di';
import { buildTemplateIndex, type TemplateIndex } from './layout';

export interface MagentoProject {
  modules: Map<string, MagentoModule>;
  config: MagentoConfig;
  /** Module paths keyed by module name, for template and controller lookups. */
  modulePaths: Map<string, string>;
  /** `Vendor_Module::path.phtml` → indexed file, theme overrides applied. */
  templates: TemplateIndex;
  /** `magento.inheritPlugins` from the project's `codegraph.json`. */
  inheritPlugins: boolean;
}

const cache = new WeakMap<ResolutionContext, MagentoProject>();

/**
 * Contexts handed out since the last reset. A WeakMap cannot be cleared, and
 * tests reuse a context object across cases with different file sets, so the
 * entries are dropped explicitly.
 */
const cachedContexts: ResolutionContext[] = [];

/** The merged Magento configuration for the context's project. */
export function getMagentoProject(context: ResolutionContext): MagentoProject {
  const cached = cache.get(context);
  if (cached) return cached;

  const modules = discoverModules(context);
  sortModules(modules, readModuleConfig(context));
  const modulePaths = new Map([...modules].map(([name, module]) => [name, module.path]));
  const project: MagentoProject = {
    modules,
    config: buildDiConfig(context, modules),
    modulePaths,
    templates: buildTemplateIndex(modulePaths, context.getAllFiles()),
    inheritPlugins: loadMagentoInheritPlugins(context.getProjectRoot()),
  };
  cache.set(context, project);
  cachedContexts.push(context);
  return project;
}

/** Drop cached configuration; used by tests that reuse a context object. */
export function clearMagentoConfigCache(): void {
  for (const context of cachedContexts) cache.delete(context);
  cachedContexts.length = 0;
}
