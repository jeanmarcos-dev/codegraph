/**
 * Layout XML and templates.
 *
 * The view layer is where Magento is least readable: a `.phtml` template calls
 * `$block->getFoo()` and `$viewModel->bar()` on objects it never declares, and
 * the only thing that says which classes those are is a layout XML file
 * somewhere else in the module — or in a theme overriding it. Block classes and
 * view models therefore look like dead code, and a template gives no clue where
 * its data comes from.
 */
import { describe, it, expect } from 'vitest';
import { extractLayout, extractUiComponent, resolveTemplatePath } from '../src/resolution/frameworks/magento/layout';

describe('extractLayout', () => {
  it('emits a block node referencing its class, template and view model', () => {
    const { nodes, references } = extractLayout(
      'app/code/Acme/Catalog/view/frontend/layout/catalog_product_view.xml',
      `<?xml version="1.0"?>
<page>
    <body>
        <referenceContainer name="content">
            <block class="Acme\\Catalog\\Block\\ProductView" name="acme.product.view"
                   template="Acme_Catalog::product/view.phtml">
                <arguments>
                    <argument name="view_model" xsi:type="object">Acme\\Catalog\\ViewModel\\Price</argument>
                </arguments>
            </block>
        </referenceContainer>
    </body>
</page>`,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('component');
    expect(nodes[0]!.name).toBe('acme.product.view');
    expect(nodes[0]!.startLine).toBe(5);

    const names = references.map((r) => r.referenceName);
    expect(names).toContain('Acme\\Catalog\\Block\\ProductView');
    expect(names).toContain('magento:template:Acme_Catalog::product/view.phtml');
    expect(names).toContain('Acme\\Catalog\\ViewModel\\Price');
  });

  it('names an anonymous block by its class', () => {
    const { nodes } = extractLayout(
      'app/code/Acme/M/view/frontend/layout/default.xml',
      '<page><body><block class="Acme\\M\\Block\\Anon"/></body></page>',
    );
    expect(nodes[0]!.name).toBe('Anon');
  });

  it('picks up a template set through a setTemplate action on an existing block', () => {
    const { references } = extractLayout(
      'app/code/Acme/M/view/frontend/layout/default.xml',
      `<page><body>
    <referenceBlock name="existing.block">
        <action method="setTemplate">
            <argument name="template" xsi:type="string">Acme_M::custom.phtml</argument>
        </action>
    </referenceBlock>
</body></page>`,
    );
    expect(references.map((r) => r.referenceName)).toContain('magento:template:Acme_M::custom.phtml');
  });

  it('emits nothing for a block with neither class nor template', () => {
    const { nodes, references } = extractLayout(
      'app/code/Acme/M/view/frontend/layout/default.xml',
      '<page><body><block name="nothing.here"/></body></page>',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });

  it('ignores XML that is not a layout file', () => {
    const { nodes } = extractLayout(
      'app/code/Acme/M/etc/di.xml',
      '<config><preference for="A" type="B"/></config>',
    );
    expect(nodes).toHaveLength(0);
  });
});

describe('resolveTemplatePath', () => {
  const modules = new Map([
    ['Acme_Catalog', 'app/code/Acme/Catalog'],
    ['Magento_Catalog', 'vendor/magento/module-catalog'],
  ]);

  it('resolves a module-qualified template to the module view directory', () => {
    const files = ['app/code/Acme/Catalog/view/frontend/templates/product/view.phtml'];
    expect(resolveTemplatePath('Acme_Catalog::product/view.phtml', modules, files)).toBe(files[0]);
  });

  it('prefers a theme override over the module template', () => {
    const files = [
      'app/code/Acme/Catalog/view/frontend/templates/product/view.phtml',
      'app/design/frontend/Acme/luma-child/Acme_Catalog/templates/product/view.phtml',
    ];
    expect(resolveTemplatePath('Acme_Catalog::product/view.phtml', modules, files)).toBe(files[1]);
  });

  it('falls back to the base view directory when the area directory has none', () => {
    const files = ['app/code/Acme/Catalog/view/base/templates/product/view.phtml'];
    expect(resolveTemplatePath('Acme_Catalog::product/view.phtml', modules, files)).toBe(files[0]);
  });

  it('returns null when the template file is not indexed', () => {
    expect(resolveTemplatePath('Magento_Catalog::product/list.phtml', modules, [])).toBeNull();
  });

  it('returns null for a template of an unknown module', () => {
    expect(resolveTemplatePath('Unknown_Module::x.phtml', modules, ['a.phtml'])).toBeNull();
  });
});

describe('extractUiComponent', () => {
  it('references the data provider and column classes a listing declares', () => {
    const { nodes, references } = extractUiComponent(
      'app/code/Acme/Catalog/view/adminhtml/ui_component/acme_item_listing.xml',
      `<?xml version="1.0"?>
<listing>
    <dataSource name="acme_item_listing_data_source">
        <argument name="dataProvider" xsi:type="configurableObject">
            <argument name="class" xsi:type="string">Acme\\Catalog\\Ui\\DataProvider\\ItemProvider</argument>
        </argument>
    </dataSource>
    <columns name="acme_item_columns">
        <column name="status" class="Acme\\Catalog\\Ui\\Component\\Listing\\Column\\Status"/>
    </columns>
</listing>`,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('component');
    expect(nodes[0]!.name).toBe('acme_item_listing');

    const names = references.map((r) => r.referenceName);
    expect(names).toContain('Acme\\Catalog\\Ui\\DataProvider\\ItemProvider');
    expect(names).toContain('Acme\\Catalog\\Ui\\Component\\Listing\\Column\\Status');
  });

  it('ignores non-class string arguments', () => {
    const { references } = extractUiComponent(
      'app/code/Acme/M/view/adminhtml/ui_component/x.xml',
      `<listing>
    <argument name="data" xsi:type="array">
        <item name="label" xsi:type="string">Some Label</item>
    </argument>
</listing>`,
    );
    expect(references).toHaveLength(0);
  });

  it('emits nothing when no classes are referenced', () => {
    const { nodes, references } = extractUiComponent(
      'app/code/Acme/M/view/adminhtml/ui_component/empty.xml',
      '<listing></listing>',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

describe('twig templates', () => {
  const modules = new Map([['MageObsidian_Storefront', 'app/code/MageObsidian/Storefront']]);

  it('resolves a .twig template the same way as a .phtml one', () => {
    const files = ['app/code/MageObsidian/Storefront/view/frontend/templates/header.twig'];
    expect(resolveTemplatePath('MageObsidian_Storefront::header.twig', modules, files)).toBe(
      files[0],
    );
  });

  it('prefers a theme override of a twig template', () => {
    const files = [
      'app/code/MageObsidian/Storefront/view/frontend/templates/header.twig',
      'app/design/frontend/MageObsidian/default/MageObsidian_Storefront/templates/header.twig',
    ];
    expect(resolveTemplatePath('MageObsidian_Storefront::header.twig', modules, files)).toBe(
      files[1],
    );
  });
});
