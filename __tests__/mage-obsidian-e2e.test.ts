/**
 * MageObsidian end-to-end: a project using the stack, indexed by CodeGraph.
 *
 * The scenario is what a store team actually writes: a module that opts into
 * MageObsidian, a Twig template that mounts a Vue island and includes another
 * template, a JS entry importing a sibling module by specifier, and a theme
 * that overrides one of those files. None of those links exist on disk — they
 * are resolved by the Vite build through the theme chain.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { clearMagentoConfigCache } from '../src/resolution/frameworks/magento/config';
import { clearObsidianConfigCache } from '../src/resolution/frameworks/mage-obsidian/config';

function write(root: string, relative: string, content: string): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildProject(root: string): void {
  write(root, 'composer.json', JSON.stringify({
    require: {
      'magento/product-community-edition': '2.4.7',
      'mage-obsidian/module-modern-frontend': '^1.0',
    },
  }));

  write(root, 'app/code/Acme/Storefront/registration.php', '<?php\n');
  write(
    root,
    'app/code/Acme/Storefront/etc/module.xml',
    '<?xml version="1.0"?>\n<config>\n    <module name="Acme_Storefront"/>\n</config>\n',
  );
  write(
    root,
    'app/code/Acme/Storefront/etc/mage_obsidian_compatibility.xml',
    '<?xml version="1.0"?>\n<config>\n    <features>\n        <compatibility>true</compatibility>\n    </features>\n</config>\n',
  );

  write(root, 'app/code/Acme/Catalog/registration.php', '<?php\n');
  write(
    root,
    'app/code/Acme/Catalog/etc/module.xml',
    '<?xml version="1.0"?>\n<config>\n    <module name="Acme_Catalog"/>\n</config>\n',
  );

  write(
    root,
    'app/code/Acme/Storefront/view/frontend/templates/search-form.twig',
    `{#
  Header quick search. Mounts the island; falls back to the partial.
#}
{% set form = block.getSearchForm() %}
{% include 'Acme_Storefront::search/initial.twig' with { block: block } only %}
{{ render_vue('Acme_Storefront::navigation/SearchAutocomplete', { url: form.getActionUrl() }) }}
{{ script('Acme_Catalog::js/catalog-events') }}
`,
  );

  write(
    root,
    'app/code/Acme/Storefront/view/frontend/templates/search/initial.twig',
    '<form role="search"></form>\n',
  );

  write(
    root,
    'app/code/Acme/Storefront/view/frontend/layout/default.xml',
    `<?xml version="1.0"?>
<page>
    <body>
        <referenceContainer name="header">
            <block class="Acme\\Storefront\\Block\\SearchForm" name="acme.search.form"
                   template="Acme_Storefront::search-form.twig"/>
        </referenceContainer>
    </body>
</page>
`,
  );

  write(
    root,
    'app/code/Acme/Storefront/Block/SearchForm.php',
    `<?php
namespace Acme\\Storefront\\Block;

class SearchForm
{
    public function getSearchForm()
    {
        return $this;
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Storefront/view/frontend/web/components/navigation/SearchAutocomplete.vue',
    `<script setup lang="ts">
import { track } from "Acme_Catalog::js/catalog-events";

defineProps<{ url: string }>();
</script>

<template>
    <div class="search"></div>
</template>
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/view/frontend/web/js/catalog-events.ts',
    `export function track(name: string): void {
    console.log(name);
}
`,
  );

  write(
    root,
    'app/code/Acme/Storefront/Api/Data/ConfigInterface.php',
    `<?php
namespace Acme\\Storefront\\Api\\Data;

interface ConfigInterface
{
    public const string VUE_COMPONENTS_PATH = 'components';
    public const array ALLOWED_EXTENSIONS = ['js', 'vue', 'ts'];
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/view/frontend/web/js/config-reader.js',
    `import { getMagentoConfig } from "Acme_Catalog::js/catalog-events";

export function allowed() {
    return getMagentoConfig().ALLOWED_EXTENSIONS;
}
`,
  );

  write(
    root,
    'app/design/frontend/Acme/theme-base/theme.xml',
    '<?xml version="1.0"?>\n<theme>\n    <title>Base</title>\n</theme>\n',
  );
  write(
    root,
    'app/design/frontend/Acme/shop/theme.xml',
    '<?xml version="1.0"?>\n<theme>\n    <title>Shop</title>\n    <parent>Acme/theme-base</parent>\n</theme>\n',
  );

  write(
    root,
    'app/design/frontend/Acme/shop/Acme_Catalog/web/js/catalog-events.ts',
    `export function track(name: string): void {
    console.log("themed", name);
}
`,
  );
}

describe('MageObsidian end-to-end', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    clearMagentoConfigCache();
    clearObsidianConfigCache();
  });

  it('links Twig to its island, its include and its script entry', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-obsidian-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const templates = cg.getNodesByKind('component');
    const template = templates.find((n) => n.filePath.endsWith('templates/search-form.twig'));
    const partial = templates.find((n) => n.filePath.endsWith('templates/search/initial.twig'));
    const island = cg
      .getNodesByKind('file')
      .find((n) => n.filePath.endsWith('SearchAutocomplete.vue'));
    expect(template, 'the twig template is indexed').toBeDefined();
    expect(partial, 'the included partial is indexed').toBeDefined();
    expect(island, 'the vue island is indexed').toBeDefined();

    const out = cg.getOutgoingEdges(template!.id);
    expect(
      out.some((e) => e.target === partial!.id && e.metadata?.synthesizedBy === 'obsidian-twig-include'),
      'template includes the partial',
    ).toBe(true);
    expect(
      out.some((e) => e.target === island!.id && e.metadata?.synthesizedBy === 'obsidian-island'),
      'template mounts the Vue island',
    ).toBe(true);
    expect(
      out.some((e) => e.metadata?.synthesizedBy === 'obsidian-twig-script'),
      'template pulls a script entry',
    ).toBe(true);

    const getSearchForm = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'getSearchForm' && n.filePath.endsWith('Block/SearchForm.php'));
    expect(
      out.some(
        (e) => e.target === getSearchForm!.id && e.metadata?.synthesizedBy === 'obsidian-twig-block',
      ),
      'block.getSearchForm() reaches the block class layout XML binds',
    ).toBe(true);

    cg.close();
  }, 60_000);

  it('resolves a Vendor_Module import to the theme override, not the module file', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-obsidian-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const files = cg.getNodesByKind('file');
    const island = files.find((n) => n.filePath.endsWith('SearchAutocomplete.vue'));
    const moduleAsset = files.find((n) =>
      n.filePath.endsWith('Acme/Catalog/view/frontend/web/js/catalog-events.ts'),
    );
    const themeAsset = files.find((n) =>
      n.filePath.endsWith('Acme/shop/Acme_Catalog/web/js/catalog-events.ts'),
    );
    expect(themeAsset, 'the theme override is indexed').toBeDefined();

    const importEdge = cg
      .getOutgoingEdges(island!.id)
      .find((e) => e.metadata?.synthesizedBy === 'obsidian-import');
    expect(importEdge, 'the specifier import produced an edge').toBeDefined();
    expect(importEdge!.target).toBe(themeAsset!.id);
    expect(importEdge!.target).not.toBe(moduleAsset!.id);
    expect(importEdge!.metadata!.via).toBe('Acme_Catalog::js/catalog-events');

    cg.close();
  }, 60_000);

  it('links a JS reader of the contract to the PHP constant that defines it', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-obsidian-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const reader = cg
      .getNodesByKind('file')
      .find((n) => n.filePath.endsWith('js/config-reader.js'));
    const constant = cg
      .getNodesByKind('constant')
      .find((n) => n.name === 'ALLOWED_EXTENSIONS');
    expect(reader, 'the JS reader is indexed').toBeDefined();
    expect(constant, 'the PHP constant is indexed').toBeDefined();

    const contractEdge = cg
      .getOutgoingEdges(reader!.id)
      .find((e) => e.target === constant!.id && e.metadata?.synthesizedBy === 'obsidian-contract');
    expect(contractEdge, 'the JS side links to the PHP constant').toBeDefined();
    expect(contractEdge!.metadata!.via).toBe('ALLOWED_EXTENSIONS');

    cg.close();
  }, 60_000);

  it('emits no obsidian edges for a plain Magento project', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-obsidian-'));
    buildProject(tmpDir);
    fs.rmSync(path.join(tmpDir, 'app/code/Acme/Storefront/etc/mage_obsidian_compatibility.xml'));
    write(tmpDir, 'composer.json', JSON.stringify({
      require: { 'magento/product-community-edition': '2.4.7' },
    }));

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const obsidianTemplates = cg
      .getNodesByKind('component')
      .filter((n) => n.filePath.endsWith('.twig'));
    expect(obsidianTemplates, 'no twig template nodes without the stack').toHaveLength(0);

    const island = cg
      .getNodesByKind('file')
      .find((n) => n.filePath.endsWith('SearchAutocomplete.vue'));
    const obsidianEdges = cg
      .getOutgoingEdges(island!.id)
      .filter((e) => String(e.metadata?.synthesizedBy ?? '').startsWith('obsidian-'));
    expect(obsidianEdges).toHaveLength(0);

    cg.close();
  }, 60_000);
});
