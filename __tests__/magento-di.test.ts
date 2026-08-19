/**
 * di.xml parsing and merge.
 *
 * This is the file that decides what CodeGraph will claim actually runs. The
 * rules it has to reproduce are Magento's, not a simplification of them:
 *
 *  - `<preference for type>` — later module wins; preferences chain (A→B, B→C
 *    means A resolves to C).
 *  - area config is global config plus the area's own overrides, so a
 *    `frontend` preference must not leak into `adminhtml`.
 *  - `<plugin>` — accumulated, not replaced; keyed by plugin name within a
 *    target so a later module can flip `disabled="true"` on an inherited one;
 *    ordered by `sortOrder`.
 *  - `<virtualType name type>` — a configured alias for a real class, usable
 *    anywhere a class name is.
 *  - `<argument xsi:type="object">` — an explicit constructor wiring that beats
 *    the preference for that one injection point, including `<item>` entries
 *    inside an array argument (how every Magento composite/pool is wired).
 */
import { describe, it, expect } from 'vitest';
import {
  buildDiConfig,
  resolvePreference,
  resolveType,
  pluginsFor,
  objectArgumentsFor,
} from '../src/resolution/frameworks/magento/di';
import { discoverModules, sortModules } from '../src/resolution/frameworks/magento/modules';
import type { ResolutionContext } from '../src/resolution/types';

function makeContext(files: Record<string, string>): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: (f: string) => f in files,
    readFile: (f: string) => files[f] ?? null,
    getProjectRoot: () => '/project',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  };
}

function moduleXml(name: string, sequence: string[] = []): string {
  const seq = sequence.length
    ? `<sequence>${sequence.map((s) => `<module name="${s}"/>`).join('')}</sequence>`
    : '';
  return `<config><module name="${name}">${seq}</module></config>`;
}

function build(files: Record<string, string>) {
  const ctx = makeContext(files);
  const modules = discoverModules(ctx);
  sortModules(modules);
  return buildDiConfig(ctx, modules);
}

describe('preferences', () => {
  it('maps an interface to its configured implementation', () => {
    const config = build({
      'app/code/Acme/Catalog/etc/module.xml': moduleXml('Acme_Catalog'),
      'app/code/Acme/Catalog/etc/di.xml': `<config>
    <preference for="Acme\\Catalog\\Api\\StockInterface" type="Acme\\Catalog\\Model\\Stock"/>
</config>`,
    });

    expect(resolvePreference(config, 'Acme\\Catalog\\Api\\StockInterface')).toBe(
      'Acme\\Catalog\\Model\\Stock',
    );
  });

  it('tolerates a leading backslash on either side', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <preference for="\\Acme\\Api\\FooInterface" type="\\Acme\\Model\\Foo"/>
</config>`,
    });
    expect(resolvePreference(config, 'Acme\\Api\\FooInterface')).toBe('Acme\\Model\\Foo');
  });

  it('follows a preference chain to the final implementation', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <preference for="Acme\\Api\\FooInterface" type="Acme\\Model\\Foo"/>
    <preference for="Acme\\Model\\Foo" type="Acme\\Model\\BetterFoo"/>
</config>`,
    });
    expect(resolvePreference(config, 'Acme\\Api\\FooInterface')).toBe('Acme\\Model\\BetterFoo');
  });

  it('does not loop forever on a circular preference', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <preference for="A" type="B"/>
    <preference for="B" type="A"/>
</config>`,
    });
    expect(['A', 'B']).toContain(resolvePreference(config, 'A'));
  });

  it('lets the module that loads later win', () => {
    const config = build({
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
      'vendor/magento/module-catalog/etc/di.xml': `<config>
    <preference for="Magento\\Catalog\\Api\\ProductRepositoryInterface" type="Magento\\Catalog\\Model\\ProductRepository"/>
</config>`,
      'app/code/Acme/Catalog/etc/module.xml': moduleXml('Acme_Catalog', ['Magento_Catalog']),
      'app/code/Acme/Catalog/etc/di.xml': `<config>
    <preference for="Magento\\Catalog\\Api\\ProductRepositoryInterface" type="Acme\\Catalog\\Model\\ProductRepository"/>
</config>`,
    });

    expect(resolvePreference(config, 'Magento\\Catalog\\Api\\ProductRepositoryInterface')).toBe(
      'Acme\\Catalog\\Model\\ProductRepository',
    );
  });

  it('keeps the core preference when the overriding module does not sequence after it', () => {
    const config = build({
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
      'vendor/magento/module-catalog/etc/di.xml': `<config>
    <preference for="Magento\\Catalog\\Api\\Repo" type="Magento\\Catalog\\Model\\Repo"/>
</config>`,
      'app/code/Acme/Catalog/etc/module.xml': moduleXml('Acme_Catalog'),
      'app/code/Acme/Catalog/etc/di.xml': `<config>
    <preference for="Magento\\Catalog\\Api\\Repo" type="Acme\\Catalog\\Model\\Repo"/>
</config>`,
    });

    expect(resolvePreference(config, 'Magento\\Catalog\\Api\\Repo')).toBe(
      'Magento\\Catalog\\Model\\Repo',
    );
  });

  it('applies an area preference over the global one only inside that area', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <preference for="Acme\\Api\\RendererInterface" type="Acme\\Model\\DefaultRenderer"/>
</config>`,
      'app/code/Acme/M/etc/frontend/di.xml': `<config>
    <preference for="Acme\\Api\\RendererInterface" type="Acme\\Model\\FrontendRenderer"/>
</config>`,
    });

    expect(resolvePreference(config, 'Acme\\Api\\RendererInterface', 'frontend')).toBe(
      'Acme\\Model\\FrontendRenderer',
    );
    expect(resolvePreference(config, 'Acme\\Api\\RendererInterface', 'adminhtml')).toBe(
      'Acme\\Model\\DefaultRenderer',
    );
    expect(resolvePreference(config, 'Acme\\Api\\RendererInterface')).toBe(
      'Acme\\Model\\DefaultRenderer',
    );
  });

  it('returns the name unchanged when nothing declares a preference', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
    });
    expect(resolvePreference(config, 'Acme\\Model\\Concrete')).toBe('Acme\\Model\\Concrete');
  });

  it('records where the winning preference was declared', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <preference for="Acme\\Api\\FooInterface" type="Acme\\Model\\Foo"/>
</config>`,
    });
    const declaration = config.preferences.get('global')!.get('Acme\\Api\\FooInterface')!;
    expect(declaration.filePath).toBe('app/code/Acme/M/etc/di.xml');
    expect(declaration.line).toBe(2);
  });
});

describe('virtual types', () => {
  it('resolves a virtual type to its concrete class', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <virtualType name="AcmeSpecialLogger" type="Acme\\Log\\Logger"/>
</config>`,
    });
    expect(resolveType(config, 'AcmeSpecialLogger')).toBe('Acme\\Log\\Logger');
  });

  it('follows a virtual type built on another virtual type', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <virtualType name="BaseVirtual" type="Acme\\Log\\Logger"/>
    <virtualType name="DerivedVirtual" type="BaseVirtual"/>
</config>`,
    });
    expect(resolveType(config, 'DerivedVirtual')).toBe('Acme\\Log\\Logger');
  });

  it('applies the preference of the class a virtual type points at', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <preference for="Acme\\Api\\LoggerInterface" type="Acme\\Log\\Logger"/>
    <virtualType name="AcmeVirtualLogger" type="Acme\\Api\\LoggerInterface"/>
</config>`,
    });
    expect(resolveType(config, 'AcmeVirtualLogger')).toBe('Acme\\Log\\Logger');
  });
});

describe('plugins', () => {
  it('collects plugins declared on a type', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Magento\\Catalog\\Model\\Product">
        <plugin name="acme_price" type="Acme\\M\\Plugin\\PricePlugin" sortOrder="10"/>
    </type>
</config>`,
    });

    const plugins = pluginsFor(config, 'Magento\\Catalog\\Model\\Product');
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.type).toBe('Acme\\M\\Plugin\\PricePlugin');
    expect(plugins[0]!.sortOrder).toBe(10);
    expect(plugins[0]!.filePath).toBe('app/code/Acme/M/etc/di.xml');
    expect(plugins[0]!.line).toBe(3);
  });

  it('orders plugins by sortOrder, defaulting to zero', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Model\\Target">
        <plugin name="late" type="Acme\\Plugin\\Late" sortOrder="100"/>
        <plugin name="early" type="Acme\\Plugin\\Early" sortOrder="1"/>
        <plugin name="unset" type="Acme\\Plugin\\Unset"/>
    </type>
</config>`,
    });

    expect(pluginsFor(config, 'Acme\\Model\\Target').map((p) => p.name)).toEqual([
      'unset',
      'early',
      'late',
    ]);
  });

  it('lets a later module disable an inherited plugin by name', () => {
    const config = build({
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
      'vendor/magento/module-catalog/etc/di.xml': `<config>
    <type name="Magento\\Catalog\\Model\\Product">
        <plugin name="core_price" type="Magento\\Catalog\\Plugin\\Price"/>
    </type>
</config>`,
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M', ['Magento_Catalog']),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Magento\\Catalog\\Model\\Product">
        <plugin name="core_price" disabled="true"/>
    </type>
</config>`,
    });

    expect(pluginsFor(config, 'Magento\\Catalog\\Model\\Product')).toHaveLength(0);
  });

  it('lets a later module re-enable and re-point a plugin of the same name', () => {
    const config = build({
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
      'vendor/magento/module-catalog/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" type="Magento\\Plugin\\Original" sortOrder="5"/>
    </type>
</config>`,
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M', ['Magento_Catalog']),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" type="Acme\\Plugin\\Replacement"/>
    </type>
</config>`,
    });

    const plugins = pluginsFor(config, 'Acme\\Target');
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.type).toBe('Acme\\Plugin\\Replacement');
    expect(plugins[0]!.sortOrder).toBe(5);
  });

  it('adds area plugins on top of global ones without leaking across areas', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="everywhere" type="Acme\\Plugin\\Everywhere"/>
    </type>
</config>`,
      'app/code/Acme/M/etc/adminhtml/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="admin_only" type="Acme\\Plugin\\AdminOnly"/>
    </type>
</config>`,
    });

    expect(pluginsFor(config, 'Acme\\Target', 'adminhtml').map((p) => p.name).sort()).toEqual([
      'admin_only',
      'everywhere',
    ]);
    expect(pluginsFor(config, 'Acme\\Target', 'frontend').map((p) => p.name)).toEqual([
      'everywhere',
    ]);
    expect(pluginsFor(config, 'Acme\\Target').map((p) => p.name)).toEqual(['everywhere']);
  });

  it('collects plugins declared on a virtual type', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <virtualType name="AcmeVirtual" type="Acme\\Model\\Base">
        <plugin name="v" type="Acme\\Plugin\\OnVirtual"/>
    </virtualType>
</config>`,
    });
    expect(pluginsFor(config, 'AcmeVirtual').map((p) => p.type)).toEqual(['Acme\\Plugin\\OnVirtual']);
  });
});

describe('object arguments', () => {
  it('records an explicit constructor injection', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Model\\Consumer">
        <arguments>
            <argument name="logger" xsi:type="object">Acme\\Log\\SpecialLogger</argument>
        </arguments>
    </type>
</config>`,
    });

    const args = objectArgumentsFor(config, 'Acme\\Model\\Consumer');
    expect(args).toHaveLength(1);
    expect(args[0]!.name).toBe('logger');
    expect(args[0]!.value).toBe('Acme\\Log\\SpecialLogger');
    expect(args[0]!.line).toBe(4);
  });

  it('records every object item of an array argument', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Model\\Pool">
        <arguments>
            <argument name="handlers" xsi:type="array">
                <item name="first" xsi:type="object">Acme\\Handler\\First</item>
                <item name="second" xsi:type="object">Acme\\Handler\\Second</item>
                <item name="label" xsi:type="string">not a class</item>
            </argument>
        </arguments>
    </type>
</config>`,
    });

    const args = objectArgumentsFor(config, 'Acme\\Model\\Pool');
    expect(args.map((a) => a.value)).toEqual(['Acme\\Handler\\First', 'Acme\\Handler\\Second']);
    expect(args.map((a) => a.itemName)).toEqual(['first', 'second']);
    expect(args.every((a) => a.name === 'handlers')).toBe(true);
  });

  it('ignores non-object argument types', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Model\\Consumer">
        <arguments>
            <argument name="size" xsi:type="number">10</argument>
            <argument name="label" xsi:type="string">Acme\\Not\\AClass</argument>
        </arguments>
    </type>
</config>`,
    });
    expect(objectArgumentsFor(config, 'Acme\\Model\\Consumer')).toHaveLength(0);
  });

  it('records arguments declared on a virtual type', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <virtualType name="AcmeVirtualPool" type="Acme\\Model\\Pool">
        <arguments>
            <argument name="handlers" xsi:type="array">
                <item name="a" xsi:type="object">Acme\\Handler\\A</item>
            </argument>
        </arguments>
    </virtualType>
</config>`,
    });
    expect(objectArgumentsFor(config, 'AcmeVirtualPool').map((a) => a.value)).toEqual([
      'Acme\\Handler\\A',
    ]);
  });
});

describe('robustness', () => {
  it('skips a di.xml that is not readable as XML without failing the build', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': 'this is not xml at all',
      'app/code/Acme/N/etc/module.xml': moduleXml('Acme_N'),
      'app/code/Acme/N/etc/di.xml': `<config><preference for="A" type="B"/></config>`,
    });
    expect(resolvePreference(config, 'A')).toBe('B');
  });

  it('ignores a di.xml that belongs to no discovered module', () => {
    const config = build({
      'some/stray/etc/di.xml': `<config><preference for="A" type="B"/></config>`,
    });
    expect(resolvePreference(config, 'A')).toBe('A');
  });
});

describe('sortOrder edge cases', () => {
  it('keeps an explicit sortOrder of zero instead of inheriting the earlier one', () => {
    const config = build({
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
      'vendor/magento/module-catalog/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" type="Magento\\Plugin\\Original" sortOrder="50"/>
    </type>
</config>`,
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M', ['Magento_Catalog']),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" sortOrder="0"/>
    </type>
</config>`,
    });

    expect(pluginsFor(config, 'Acme\\Target')[0]!.sortOrder).toBe(0);
  });

  it('attributes a di.xml to the innermost module when modules nest', () => {
    const config = build({
      'app/code/Acme/Outer/etc/module.xml': moduleXml('Acme_Outer'),
      'app/code/Acme/Outer/etc/di.xml': `<config><preference for="A" type="Outer"/></config>`,
      'app/code/Acme/Outer/nested/Inner/etc/module.xml': moduleXml('Acme_Inner', ['Acme_Outer']),
      'app/code/Acme/Outer/nested/Inner/etc/di.xml': `<config><preference for="A" type="Inner"/></config>`,
    });
    expect(resolvePreference(config, 'A')).toBe('Inner');
  });
});

describe('a module that is the repository root', () => {
  it('merges the di.xml of a module whose etc/ sits at the root', () => {
    const config = build({
      'registration.php': '<?php',
      'etc/module.xml': moduleXml('Cucuru_Payment'),
      'etc/di.xml': `<config>
    <preference for="Cucuru\\Payment\\Api\\GatewayInterface" type="Cucuru\\Payment\\Model\\Gateway"/>
</config>`,
    });
    expect(resolvePreference(config, 'Cucuru\\Payment\\Api\\GatewayInterface')).toBe(
      'Cucuru\\Payment\\Model\\Gateway',
    );
  });

  it('reads an area di.xml at the root as that area', () => {
    const config = build({
      'registration.php': '<?php',
      'etc/module.xml': moduleXml('Cucuru_Payment'),
      'etc/di.xml': '<config><preference for="A" type="Global"/></config>',
      'etc/frontend/di.xml': '<config><preference for="A" type="Frontend"/></config>',
    });
    expect(resolvePreference(config, 'A', 'frontend')).toBe('Frontend');
    expect(resolvePreference(config, 'A')).toBe('Global');
  });
});
