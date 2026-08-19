/**
 * The `Vendor_Module::path` → file index.
 *
 * Reproduces `js-package-utils/src/core/moduleResolver.ts`: module assets under
 * `view/frontend/web/` are merged with each theme's `<theme>/<Vendor_Module>/web/`
 * overrides, walking the theme chain from the root down so the most specific
 * theme wins — and themes as a whole win over the module.
 *
 * Built once per project rather than per lookup: a storefront has thousands of
 * assets and the resolver runs per reference.
 */

import type { MagentoTheme } from './themes';
import { themeChain, leafThemes } from './themes';
import { isAssetFile, normalizeAssetPath, parseModuleSpecifier } from './names';

/** `Vendor_Module/normalized/path` → indexed file. */
export type AssetIndex = Map<string, string>;

const MODULE_WEB_PATH = 'view/frontend/web/';
const THEME_MODULE_WEB_PATH = 'web/';

function stripExtension(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  return dot < 0 ? filePath : filePath.slice(0, dot);
}

function indexKey(moduleName: string, assetPath: string): string {
  return `${moduleName}/${normalizeAssetPath(assetPath)}`;
}

/**
 * Index every build asset by the specifier that reaches it. Later writes win,
 * so entries are added in precedence order: modules first, then each theme
 * chain from its root down.
 */
export function buildAssetIndex(
  modulePaths: Map<string, string>,
  themes: Map<string, MagentoTheme>,
  files: string[],
): AssetIndex {
  const index: AssetIndex = new Map();
  const assets = files.filter(isAssetFile);

  const modulesByPathLength = [...modulePaths].sort((a, b) => b[1].length - a[1].length);
  for (const filePath of assets) {
    const owner = modulesByPathLength.find(
      ([, modulePath]) => modulePath === '' || filePath.startsWith(`${modulePath}/`),
    );
    if (!owner) continue;
    const [moduleName, modulePath] = owner;
    const within = modulePath === '' ? filePath : filePath.slice(modulePath.length + 1);
    if (!within.startsWith(MODULE_WEB_PATH)) continue;
    index.set(indexKey(moduleName, stripExtension(within.slice(MODULE_WEB_PATH.length))), filePath);
  }

  for (const leaf of leafThemes(themes)) {
    for (const theme of themeChain(themes, leaf.name).reverse()) {
      for (const filePath of assets) {
        if (!filePath.startsWith(`${theme.path}/`)) continue;
        const within = filePath.slice(theme.path.length + 1);
        const separator = within.indexOf('/');
        if (separator < 0) continue;
        const moduleName = within.slice(0, separator);
        const rest = within.slice(separator + 1);
        if (!rest.startsWith(THEME_MODULE_WEB_PATH)) continue;
        index.set(
          indexKey(moduleName, stripExtension(rest.slice(THEME_MODULE_WEB_PATH.length))),
          filePath,
        );
      }
    }
  }

  return index;
}

/** The file a `Vendor_Module::path` specifier resolves to, or null. */
export function lookupAsset(index: AssetIndex, specifier: string): string | null {
  const parsed = parseModuleSpecifier(specifier);
  if (!parsed) return null;
  return index.get(indexKey(parsed.moduleName, parsed.assetPath)) ?? null;
}
