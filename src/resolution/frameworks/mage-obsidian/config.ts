/**
 * Cached per-project MageObsidian configuration.
 *
 * Keyed by the ResolutionContext instance for the same reason the Magento cache
 * is: the resolver runs once per unresolved reference, so anything proportional
 * to the file count must not happen per call.
 */

import type { ResolutionContext } from '../../types';
import { getMagentoProject } from '../magento/config';
import { discoverThemes, type MagentoTheme } from './themes';
import { buildAssetIndex, type AssetIndex } from './assets';

export interface ObsidianProject {
  themes: Map<string, MagentoTheme>;
  /** `Vendor_Module::path` → indexed asset file. */
  assets: AssetIndex;
}

const cache = new WeakMap<ResolutionContext, ObsidianProject>();
const cachedContexts: ResolutionContext[] = [];

export function getObsidianProject(context: ResolutionContext): ObsidianProject {
  const cached = cache.get(context);
  if (cached) return cached;

  const files = context.getAllFiles();
  const themes = discoverThemes(files, (filePath) => context.readFile(filePath));
  const project: ObsidianProject = {
    themes,
    assets: buildAssetIndex(getMagentoProject(context).modulePaths, themes, files),
  };
  cache.set(context, project);
  cachedContexts.push(context);
  return project;
}

/** Drop cached configuration; used by tests that reuse a context object. */
export function clearObsidianConfigCache(): void {
  for (const context of cachedContexts) cache.delete(context);
  cachedContexts.length = 0;
}
