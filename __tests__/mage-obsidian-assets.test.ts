/**
 * MageObsidian asset resolution.
 *
 * MageObsidian replaces Magento's legacy frontend with Vite + Vue, and every
 * cross-module import in its JS, Vue and Twig is written `Vendor_Module::path`
 * — never a relative path, because a relative import bypasses theme
 * inheritance and silently makes an override unreachable. Nothing in the file
 * system says where such a specifier points; the build engine resolves it by
 * merging module assets with the theme chain, most specific theme winning.
 *
 * These tests pin that resolution against the rules in
 * `js-package-utils/src/core/moduleResolver.ts`:
 *   - a path with no `components/` or `js/` prefix gets `components/`
 *   - module assets live under `view/frontend/web/`
 *   - theme overrides live under `<theme>/<Vendor_Module>/web/`
 *   - a theme beats the module, and a child theme beats its parent
 */
import { describe, it, expect } from 'vitest';
import {
  parseModuleSpecifier,
  normalizeAssetPath,
} from '../src/resolution/frameworks/mage-obsidian/names';
import {
  discoverThemes,
  themeChain,
} from '../src/resolution/frameworks/mage-obsidian/themes';
import { buildAssetIndex, lookupAsset } from '../src/resolution/frameworks/mage-obsidian/assets';

describe('parseModuleSpecifier', () => {
  it('splits a Vendor_Module::path specifier', () => {
    expect(parseModuleSpecifier('MageObsidian_Catalog::js/filter-drawer')).toEqual({
      moduleName: 'MageObsidian_Catalog',
      assetPath: 'js/filter-drawer',
    });
  });

  it('returns null for anything that is not a module specifier', () => {
    expect(parseModuleSpecifier('./relative/path')).toBeNull();
    expect(parseModuleSpecifier('vue')).toBeNull();
    expect(parseModuleSpecifier('lowercase_module::x')).toBeNull();
  });

  it('keeps a path that already carries an extension', () => {
    expect(parseModuleSpecifier('Magento_Review::review/stars.twig')).toEqual({
      moduleName: 'Magento_Review',
      assetPath: 'review/stars.twig',
    });
  });
});

describe('normalizeAssetPath', () => {
  it('prefixes components/ when the path targets neither components nor js', () => {
    expect(normalizeAssetPath('navigation/SearchAutocomplete')).toBe(
      'components/navigation/SearchAutocomplete',
    );
    expect(normalizeAssetPath('elements/Icon')).toBe('components/elements/Icon');
  });

  it('leaves an explicit components/ or js/ path alone', () => {
    expect(normalizeAssetPath('js/customer-data')).toBe('js/customer-data');
    expect(normalizeAssetPath('components/Foo')).toBe('components/Foo');
  });

  it('strips a known asset extension so the key matches the index', () => {
    expect(normalizeAssetPath('js/events.ts')).toBe('js/events');
    expect(normalizeAssetPath('elements/Icon.vue')).toBe('components/elements/Icon');
  });
});

function themeXml(parent?: string): string {
  return `<?xml version="1.0"?>
<theme>
    <title>Test</title>
    ${parent ? `<parent>${parent}</parent>` : ''}
</theme>`;
}

describe('discoverThemes', () => {
  const files = {
    'app/design/frontend/MageObsidian/theme-base/theme.xml': themeXml(),
    'app/design/frontend/MageObsidian/default/theme.xml': themeXml('MageObsidian/theme-base'),
    'app/design/adminhtml/Magento/backend/theme.xml': themeXml(),
  };
  const read = (f: string): string | null => files[f as keyof typeof files] ?? null;

  it('finds themes by theme.xml and records area, name and parent', () => {
    const themes = discoverThemes(Object.keys(files), read);
    const child = themes.get('MageObsidian/default')!;
    expect(child.area).toBe('frontend');
    expect(child.path).toBe('app/design/frontend/MageObsidian/default');
    expect(child.parent).toBe('MageObsidian/theme-base');
    expect(themes.get('MageObsidian/theme-base')!.parent).toBeUndefined();
  });

  it('includes themes from other areas', () => {
    expect(discoverThemes(Object.keys(files), read).has('Magento/backend')).toBe(true);
  });

  it('ignores a theme.xml that is not readable as XML', () => {
    expect(
      discoverThemes(['app/design/frontend/A/b/theme.xml'], () => 'not xml').size,
    ).toBe(1);
  });
});

describe('themeChain', () => {
  const files = {
    'app/design/frontend/MageObsidian/theme-base/theme.xml': themeXml(),
    'app/design/frontend/MageObsidian/default/theme.xml': themeXml('MageObsidian/theme-base'),
  };
  const themes = discoverThemes(Object.keys(files), (f) => files[f as keyof typeof files] ?? null);

  it('returns the theme and its ancestors, nearest first', () => {
    expect(themeChain(themes, 'MageObsidian/default').map((t) => t.name)).toEqual([
      'MageObsidian/default',
      'MageObsidian/theme-base',
    ]);
  });

  it('returns just the theme when it has no parent', () => {
    expect(themeChain(themes, 'MageObsidian/theme-base').map((t) => t.name)).toEqual([
      'MageObsidian/theme-base',
    ]);
  });

  it('stops on a cycle instead of looping forever', () => {
    const cyclic = {
      'app/design/frontend/A/one/theme.xml': themeXml('A/two'),
      'app/design/frontend/A/two/theme.xml': themeXml('A/one'),
    };
    const discovered = discoverThemes(Object.keys(cyclic), (f) => cyclic[f as keyof typeof cyclic] ?? null);
    expect(themeChain(discovered, 'A/one').map((t) => t.name)).toEqual(['A/one', 'A/two']);
  });

  it('returns an empty chain for an unknown theme', () => {
    expect(themeChain(themes, 'Nope/nope')).toEqual([]);
  });
});

describe('buildAssetIndex / lookupAsset', () => {
  const modulePaths = new Map([
    ['MageObsidian_Catalog', 'app/code/MageObsidian/Catalog'],
    ['MageObsidian_Storefront', 'app/code/MageObsidian/Storefront'],
  ]);

  function indexOf(files: string[]) {
    const themeFiles = {
      'app/design/frontend/MageObsidian/theme-base/theme.xml': themeXml(),
      'app/design/frontend/MageObsidian/default/theme.xml': themeXml('MageObsidian/theme-base'),
    };
    const all = [...files, ...Object.keys(themeFiles)];
    const themes = discoverThemes(all, (f) => themeFiles[f as keyof typeof themeFiles] ?? null);
    return buildAssetIndex(modulePaths, themes, all);
  }

  it('resolves a module asset under view/frontend/web', () => {
    const index = indexOf([
      'app/code/MageObsidian/Catalog/view/frontend/web/js/filter-drawer.ts',
    ]);
    expect(lookupAsset(index, 'MageObsidian_Catalog::js/filter-drawer')).toBe(
      'app/code/MageObsidian/Catalog/view/frontend/web/js/filter-drawer.ts',
    );
  });

  it('resolves a component that omits the components/ prefix', () => {
    const index = indexOf([
      'app/code/MageObsidian/Storefront/view/frontend/web/components/navigation/SearchAutocomplete.vue',
    ]);
    expect(
      lookupAsset(index, 'MageObsidian_Storefront::navigation/SearchAutocomplete'),
    ).toBe(
      'app/code/MageObsidian/Storefront/view/frontend/web/components/navigation/SearchAutocomplete.vue',
    );
  });

  it('lets a theme override the module asset', () => {
    const index = indexOf([
      'app/code/MageObsidian/Catalog/view/frontend/web/js/filter-drawer.ts',
      'app/design/frontend/MageObsidian/theme-base/MageObsidian_Catalog/web/js/filter-drawer.ts',
    ]);
    expect(lookupAsset(index, 'MageObsidian_Catalog::js/filter-drawer')).toBe(
      'app/design/frontend/MageObsidian/theme-base/MageObsidian_Catalog/web/js/filter-drawer.ts',
    );
  });

  it('lets the most specific theme win over its parent', () => {
    const index = indexOf([
      'app/code/MageObsidian/Catalog/view/frontend/web/js/filter-drawer.ts',
      'app/design/frontend/MageObsidian/theme-base/MageObsidian_Catalog/web/js/filter-drawer.ts',
      'app/design/frontend/MageObsidian/default/MageObsidian_Catalog/web/js/filter-drawer.ts',
    ]);
    expect(lookupAsset(index, 'MageObsidian_Catalog::js/filter-drawer')).toBe(
      'app/design/frontend/MageObsidian/default/MageObsidian_Catalog/web/js/filter-drawer.ts',
    );
  });

  it('indexes every allowed extension', () => {
    const index = indexOf([
      'app/code/MageObsidian/Catalog/view/frontend/web/js/a.js',
      'app/code/MageObsidian/Catalog/view/frontend/web/js/b.cjs',
      'app/code/MageObsidian/Catalog/view/frontend/web/components/C.vue',
    ]);
    expect(lookupAsset(index, 'MageObsidian_Catalog::js/a')).toContain('a.js');
    expect(lookupAsset(index, 'MageObsidian_Catalog::js/b')).toContain('b.cjs');
    expect(lookupAsset(index, 'MageObsidian_Catalog::C')).toContain('C.vue');
  });

  it('ignores files that are not build assets', () => {
    const index = indexOf([
      'app/code/MageObsidian/Catalog/view/frontend/web/css/style.css',
      'app/code/MageObsidian/Catalog/view/frontend/templates/x.twig',
    ]);
    expect(lookupAsset(index, 'MageObsidian_Catalog::css/style')).toBeNull();
  });

  it('returns null for a specifier nothing provides', () => {
    expect(lookupAsset(indexOf([]), 'MageObsidian_Catalog::js/missing')).toBeNull();
  });
});
