/**
 * Magento theme discovery and inheritance chain.
 *
 * A theme is a directory under `app/design/<area>/<Vendor>/<theme>` holding a
 * `theme.xml` that may name a `<parent>`. MageObsidian resolves every frontend
 * asset through that chain — nearest theme first — so an override in a child
 * theme wins over its parent and over the module's own copy.
 */

import { parseXml, findAll } from '../magento/xml';

export interface MagentoTheme {
  /** `Vendor/theme`, the name `<parent>` references. */
  name: string;
  /** Theme root relative to the project root. */
  path: string;
  /** `frontend`, `adminhtml`, … */
  area: string;
  /** Parent theme name, when the theme declares one. */
  parent?: string;
}

const THEME_XML_RE = /^app\/design\/([^/]+)\/([^/]+)\/([^/]+)\/theme\.xml$/;

const MAX_CHAIN = 16;

/** Every theme with a `theme.xml`, keyed by `Vendor/theme`. */
export function discoverThemes(
  files: string[],
  readFile: (filePath: string) => string | null,
): Map<string, MagentoTheme> {
  const themes = new Map<string, MagentoTheme>();

  for (const filePath of files) {
    const match = filePath.match(THEME_XML_RE);
    if (!match) continue;
    const [, area, vendor, theme] = match;
    const name = `${vendor}/${theme}`;

    let parent: string | undefined;
    const content = readFile(filePath);
    if (content) {
      const root = parseXml(content);
      const declared = root && findAll(root, 'parent')[0]?.text.trim();
      if (declared) parent = declared;
    }

    themes.set(name, {
      name,
      path: filePath.slice(0, -'/theme.xml'.length),
      area: area!,
      parent,
    });
  }

  return themes;
}

/** The theme and every ancestor it inherits from, nearest first. */
export function themeChain(
  themes: Map<string, MagentoTheme>,
  themeName: string,
): MagentoTheme[] {
  const chain: MagentoTheme[] = [];
  const seen = new Set<string>();
  let name: string | undefined = themeName;

  for (let depth = 0; depth < MAX_CHAIN && name; depth++) {
    const theme = themes.get(name);
    if (!theme || seen.has(name)) break;
    seen.add(name);
    chain.push(theme);
    name = theme.parent;
  }

  return chain;
}

/** Themes with no child, i.e. the ones a storefront actually runs. */
export function leafThemes(themes: Map<string, MagentoTheme>): MagentoTheme[] {
  const parents = new Set(
    [...themes.values()].map((theme) => theme.parent).filter((p): p is string => !!p),
  );
  return [...themes.values()].filter((theme) => !parents.has(theme.name));
}
