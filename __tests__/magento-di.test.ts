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
  resolveInstanceType,
  pluginsFor,
  pluginInheritance,
  objectArgumentsFor,
} from '../src/resolution/frameworks/magento/di';
import {
  discoverModules,
  sortModules,
  readModuleConfig,
} from '../src/resolution/frameworks/magento/modules';
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
  sortModules(modules, readModuleConfig(ctx));
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

/**
 * Interception walks the class hierarchy, so a plugin declared on an abstract
 * block or a framework interface runs on every concrete class below it — the
 * store's own controller is intercepted by plugins it never names.
 */
describe('plugin inheritance', () => {
  const hierarchy = (parents: Record<string, string[]>) =>
    pluginInheritance((type: string) => parents[type] ?? []);

  const configWith = (di: string) =>
    build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>${di}</config>`,
    });

  it('collects a plugin declared on a parent class', () => {
    const config = configWith(`
    <type name="Acme\\Base">
        <plugin name="from_base" type="Acme\\Plugin\\Base"/>
    </type>`);

    const parents = hierarchy({ 'Acme\\Child': ['Acme\\Base'] });
    expect(pluginsFor(config, 'Acme\\Child', 'global', parents).map((p) => p.name)).toEqual([
      'from_base',
    ]);
    // Without a hierarchy nothing is inherited — that is the default.
    expect(pluginsFor(config, 'Acme\\Child')).toHaveLength(0);
  });

  it('collects plugins declared on an implemented interface', () => {
    const config = configWith(`
    <type name="Acme\\ThingInterface">
        <plugin name="from_interface" type="Acme\\Plugin\\Thing"/>
    </type>`);

    const parents = hierarchy({ 'Acme\\Thing': ['Acme\\ThingInterface'] });
    expect(pluginsFor(config, 'Acme\\Thing', 'global', parents).map((p) => p.name)).toEqual([
      'from_interface',
    ]);
  });

  it('lets a nearer ancestor disable what a farther one declared', () => {
    const config = configWith(`
    <type name="Acme\\ThingInterface">
        <plugin name="shared" type="Acme\\Plugin\\Thing"/>
    </type>
    <type name="Acme\\Middle">
        <plugin name="shared" disabled="true"/>
    </type>`);

    const parents = hierarchy({
      'Acme\\Middle': ['Acme\\ThingInterface'],
      'Acme\\Leaf': ['Acme\\Middle'],
    });
    expect(pluginsFor(config, 'Acme\\Middle', 'global', parents)).toHaveLength(0);
    // A disabled plugin is removed from what descendants inherit rather than
    // handed down as disabled, so the leaf cannot see it — or re-enable it.
    expect(pluginsFor(config, 'Acme\\Leaf', 'global', parents)).toHaveLength(0);
  });

  it('takes the base type of a virtual type, not the virtual type name', () => {
    const config = configWith(`
    <virtualType name="acmeVirtual" type="Acme\\Base"/>
    <type name="Acme\\Base">
        <plugin name="from_base" type="Acme\\Plugin\\Base"/>
    </type>`);

    expect(
      pluginsFor(config, 'acmeVirtual', 'global', hierarchy({})).map((p) => p.name),
    ).toEqual(['from_base']);
  });

  // Re-pointing an inherited plugin resets its order: crossing from the
  // ancestor's set into the type's own merges the mapped arrays, where
  // sortOrder is always present and therefore always overwrites.
  it('resets the order when the type re-points an inherited plugin', () => {
    const config = configWith(`
    <type name="Acme\\Base">
        <plugin name="shared" type="Acme\\Plugin\\Original" sortOrder="30"/>
    </type>
    <type name="Acme\\Child">
        <plugin name="shared" type="Acme\\Plugin\\Replacement"/>
    </type>`);

    const parents = hierarchy({ 'Acme\\Child': ['Acme\\Base'] });
    expect(pluginsFor(config, 'Acme\\Base', 'global', parents)[0]!.sortOrder).toBe(30);
    const plugins = pluginsFor(config, 'Acme\\Child', 'global', parents);
    expect(plugins).toHaveLength(1);
    expect(plugins[0]!.type).toBe('Acme\\Plugin\\Replacement');
    expect(plugins[0]!.sortOrder).toBe(0);
  });

  it('merges every relation, nearest declaration last', () => {
    const config = configWith(`
    <type name="Acme\\Base">
        <plugin name="a" type="Acme\\Plugin\\A" sortOrder="1"/>
    </type>
    <type name="Acme\\ThingInterface">
        <plugin name="b" type="Acme\\Plugin\\B" sortOrder="2"/>
    </type>
    <type name="Acme\\Child">
        <plugin name="c" type="Acme\\Plugin\\C" sortOrder="3"/>
    </type>`);

    const parents = hierarchy({ 'Acme\\Child': ['Acme\\Base', 'Acme\\ThingInterface'] });
    expect(pluginsFor(config, 'Acme\\Child', 'global', parents).map((p) => p.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('terminates on a hierarchy cycle', () => {
    const config = configWith(`
    <type name="Acme\\A">
        <plugin name="from_a" type="Acme\\Plugin\\A"/>
    </type>`);

    const parents = hierarchy({ 'Acme\\A': ['Acme\\B'], 'Acme\\B': ['Acme\\A'] });
    expect(pluginsFor(config, 'Acme\\A', 'global', parents).map((p) => p.name)).toEqual(['from_a']);
  });
});

/**
 * `ObjectManager\Config\Mapper\Dom` emits `sortOrder` for every plugin node but
 * emits `type` and `disabled` only when the attribute is present. Within one
 * scope the XML nodes merge attribute by attribute; across a scope boundary the
 * mapped arrays are merged, so the always-present key overwrites and the
 * sometimes-absent ones survive.
 */
describe('plugin attribute merge', () => {
  it('keeps an earlier disabled when a later declaration omits the attribute', () => {
    const config = build({
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
      'vendor/magento/module-catalog/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" type="Magento\\Plugin\\Original" disabled="true"/>
    </type>
</config>`,
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M', ['Magento_Catalog']),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" type="Acme\\Plugin\\Replacement"/>
    </type>
</config>`,
    });

    expect(pluginsFor(config, 'Acme\\Target')).toHaveLength(0);
  });

  it('re-enables a plugin only on an explicit disabled="false"', () => {
    const config = build({
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
      'vendor/magento/module-catalog/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" type="Magento\\Plugin\\Original" disabled="true"/>
    </type>
</config>`,
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M', ['Magento_Catalog']),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" disabled="false"/>
    </type>
</config>`,
    });

    expect(pluginsFor(config, 'Acme\\Target').map((p) => p.type)).toEqual([
      'Magento\\Plugin\\Original',
    ]);
  });

  it('resets sortOrder when an area re-declares a plugin without one', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" type="Acme\\Plugin\\Shared" sortOrder="50"/>
    </type>
</config>`,
      'app/code/Acme/M/etc/frontend/di.xml': `<config>
    <type name="Acme\\Target">
        <plugin name="shared" type="Acme\\Plugin\\Frontend"/>
    </type>
</config>`,
    });

    expect(pluginsFor(config, 'Acme\\Target', 'global')[0]!.sortOrder).toBe(50);
    expect(pluginsFor(config, 'Acme\\Target', 'frontend')[0]!.sortOrder).toBe(0);
  });
});

/**
 * `app/etc/config.php` — the real load order.
 *
 * `Module\Dir\Reader::getFiles()` iterates `ModuleList::getNames()`, which is
 * `array_keys(array_filter($configData))`: the persisted key order of
 * `config.php`, with disabled modules filtered out. Reproducing
 * `sortBySequence()` instead — which that path never calls — puts the wrong
 * module last, and counting a disabled module as active lets it win a merge
 * Magento never performed.
 */
describe('module load order from config.php', () => {
  const configPhp = (entries: Record<string, number>) =>
    `<?php\nreturn [\n    'modules' => [\n${Object.entries(entries)
      .map(([name, on]) => `        '${name}' => ${on}`)
      .join(',\n')}\n    ]\n];\n`;

  const project = (entries: Record<string, number> | null, extra: Record<string, string> = {}) => {
    const files: Record<string, string> = {
      'app/code/Acme/First/etc/module.xml': moduleXml('Acme_First'),
      'app/code/Acme/Second/etc/module.xml': moduleXml('Acme_Second'),
      ...extra,
    };
    if (entries) files['app/etc/config.php'] = configPhp(entries);
    return files;
  };

  const orderOf = (files: Record<string, string>) => {
    const ctx = makeContext(files);
    const modules = discoverModules(ctx);
    return sortModules(modules, readModuleConfig(ctx)).map((m) => m.name);
  };

  it('follows the key order of config.php, not the alphabetical sequence walk', () => {
    expect(orderOf(project({ Acme_Second: 1, Acme_First: 1 }))).toEqual([
      'Acme_Second',
      'Acme_First',
    ]);
  });

  it('drops a module config.php disables', () => {
    expect(orderOf(project({ Acme_First: 1, Acme_Second: 0 }))).toEqual(['Acme_First']);
  });

  it('drops a module on disk that config.php never lists', () => {
    expect(orderOf(project({ Acme_First: 1 }))).toEqual(['Acme_First']);
  });

  it('falls back to the sequence walk when there is no config.php', () => {
    expect(orderOf(project(null))).toEqual(['Acme_First', 'Acme_Second']);
  });

  it('reads the legacy array() syntax', () => {
    const files = project(null);
    files['app/etc/config.php'] = "<?php\nreturn array(\n 'modules' => array(\n 'Acme_Second' => 1,\n 'Acme_First' => 1,\n )\n);\n";
    expect(orderOf(files)).toEqual(['Acme_Second', 'Acme_First']);
  });

  it('ignores a preference declared by a disabled module', () => {
    const config = build(
      project({ Acme_First: 1, Acme_Second: 0 }, {
        'app/code/Acme/First/etc/di.xml':
          '<config><preference for="Acme\\ThingInterface" type="Acme\\First\\Thing"/></config>',
        'app/code/Acme/Second/etc/di.xml':
          '<config><preference for="Acme\\ThingInterface" type="Acme\\Second\\Thing"/></config>',
      }),
    );
    expect(resolvePreference(config, 'Acme\\ThingInterface')).toBe('Acme\\First\\Thing');
  });
});

/**
 * `app/etc/di.xml` is the `primary` scope, loaded before every module's — it is
 * where a stock install binds `DateTimeInterface`, the Redis session handlers
 * and the ACL cache. It belongs to no module, so the module-owned walk skips it
 * and it has to be read by path. `env.php` sits in the same directory and is
 * never read: it carries database credentials.
 */
describe('primary scope (app/etc/di.xml)', () => {
  it('applies a preference no module overrides', () => {
    const config = build({
      'app/etc/di.xml': '<config><preference for="DateTimeInterface" type="DateTime"/></config>',
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
    });
    expect(resolvePreference(config, 'DateTimeInterface')).toBe('DateTime');
  });

  it('loses to a module that declares the same preference', () => {
    const config = build({
      'app/etc/di.xml':
        '<config><preference for="Acme\\ThingInterface" type="Acme\\Primary\\Thing"/></config>',
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml':
        '<config><preference for="Acme\\ThingInterface" type="Acme\\M\\Thing"/></config>',
    });
    expect(resolvePreference(config, 'Acme\\ThingInterface')).toBe('Acme\\M\\Thing');
  });

  it('contributes plugins and virtual types too', () => {
    const config = build({
      'app/etc/di.xml': `<config>
    <virtualType name="primaryVirtual" type="Acme\\Base"/>
    <type name="Acme\\Target">
        <plugin name="from_primary" type="Acme\\Plugin\\Primary"/>
    </type>
</config>`,
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
    });
    expect(resolveInstanceType(config, 'primaryVirtual')).toBe('Acme\\Base');
    expect(pluginsFor(config, 'Acme\\Target').map((p) => p.name)).toEqual(['from_primary']);
  });

  it('never reads env.php', () => {
    const reads: string[] = [];
    const files: Record<string, string> = {
      'app/etc/di.xml': '<config/>',
      'app/etc/env.php': "<?php return ['db' => ['password' => 'secret']];",
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
    };
    const ctx = makeContext(files);
    const spied: ResolutionContext = {
      ...ctx,
      readFile: (f: string) => {
        reads.push(f);
        return ctx.readFile(f);
      },
    };
    const modules = discoverModules(spied);
    sortModules(modules, readModuleConfig(spied));
    buildDiConfig(spied, modules);
    expect(reads).not.toContain('app/etc/env.php');
  });
});

/**
 * `getOriginalInstanceType` — a virtual type's `type` is routinely another
 * virtual type, and what Magento instantiates is the class at the end of that
 * chain. Preferences are deliberately NOT followed here: a virtual type
 * resolves to the class it configures, and only then would a preference on that
 * class apply.
 */
describe('resolveInstanceType', () => {
  it('walks a chain of virtual types to the real class', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <virtualType name="outer" type="middle"/>
    <virtualType name="middle" type="Acme\\Real"/>
</config>`,
    });
    expect(resolveInstanceType(config, 'outer')).toBe('Acme\\Real');
  });

  it('ignores preferences on the class it lands on', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <virtualType name="alias" type="Acme\\ThingInterface"/>
    <preference for="Acme\\ThingInterface" type="Acme\\Thing"/>
</config>`,
    });
    expect(resolveInstanceType(config, 'alias')).toBe('Acme\\ThingInterface');
    expect(resolveType(config, 'alias')).toBe('Acme\\Thing');
  });

  it('returns a plain class unchanged and terminates on a cycle', () => {
    const config = build({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M'),
      'app/code/Acme/M/etc/di.xml': `<config>
    <virtualType name="a" type="b"/>
    <virtualType name="b" type="a"/>
</config>`,
    });
    expect(resolveInstanceType(config, 'Acme\\Plain')).toBe('Acme\\Plain');
    expect(resolveInstanceType(config, 'a')).toBe('b');
  });
});
