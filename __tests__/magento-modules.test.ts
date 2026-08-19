/**
 * Magento module discovery and load order.
 *
 * Which class Magento actually instantiates depends on module load order: when
 * two modules declare a `<preference>` for the same interface, the one loaded
 * LATER wins. Load order comes from `<sequence>` in `etc/module.xml` — a module
 * listing another in its sequence loads after it, which is precisely why a
 * custom module that wants to override Magento_Catalog declares it there.
 * Getting this wrong means confidently reporting the wrong implementation, so
 * the ordering is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { discoverModules, sortModules, moduleOf } from '../src/resolution/frameworks/magento/modules';
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
  return `<?xml version="1.0"?>
<config>
    <module name="${name}">${seq}</module>
</config>`;
}

describe('discoverModules', () => {
  it('finds modules by etc/module.xml and records their directory', () => {
    const ctx = makeContext({
      'app/code/Acme/Catalog/etc/module.xml': moduleXml('Acme_Catalog'),
      'app/code/Acme/Catalog/registration.php': '<?php',
      'app/code/Other/Thing/etc/module.xml': moduleXml('Other_Thing'),
    });

    const modules = discoverModules(ctx);
    expect([...modules.keys()].sort()).toEqual(['Acme_Catalog', 'Other_Thing']);
    expect(modules.get('Acme_Catalog')!.path).toBe('app/code/Acme/Catalog');
  });

  it('records declared sequence dependencies', () => {
    const ctx = makeContext({
      'app/code/Acme/Catalog/etc/module.xml': moduleXml('Acme_Catalog', [
        'Magento_Catalog',
        'Magento_Sales',
      ]),
    });
    expect(discoverModules(ctx).get('Acme_Catalog')!.sequence).toEqual([
      'Magento_Catalog',
      'Magento_Sales',
    ]);
  });

  it('ignores an etc/module.xml with no module element', () => {
    const ctx = makeContext({
      'app/code/Acme/Broken/etc/module.xml': '<?xml version="1.0"?><config></config>',
    });
    expect(discoverModules(ctx).size).toBe(0);
  });

  it('finds modules living under vendor when that tree is indexed', () => {
    const ctx = makeContext({
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
    });
    expect(discoverModules(ctx).get('Magento_Catalog')!.path).toBe('vendor/magento/module-catalog');
  });
});

describe('sortModules', () => {
  it('places a module after every module in its sequence', () => {
    const ctx = makeContext({
      'app/code/Acme/Override/etc/module.xml': moduleXml('Acme_Override', ['Magento_Catalog']),
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
    });

    const order = sortModules(discoverModules(ctx)).map((m) => m.name);
    expect(order.indexOf('Magento_Catalog')).toBeLessThan(order.indexOf('Acme_Override'));
  });

  it('resolves a transitive sequence chain', () => {
    const ctx = makeContext({
      'app/code/A/M/etc/module.xml': moduleXml('A_M', ['B_M']),
      'app/code/B/M/etc/module.xml': moduleXml('B_M', ['C_M']),
      'app/code/C/M/etc/module.xml': moduleXml('C_M'),
    });
    expect(sortModules(discoverModules(ctx)).map((m) => m.name)).toEqual(['C_M', 'B_M', 'A_M']);
  });

  it('is alphabetical between modules with no sequence relation', () => {
    const ctx = makeContext({
      'app/code/Z/M/etc/module.xml': moduleXml('Z_M'),
      'app/code/A/M/etc/module.xml': moduleXml('A_M'),
      'app/code/M/M/etc/module.xml': moduleXml('M_M'),
    });
    expect(sortModules(discoverModules(ctx)).map((m) => m.name)).toEqual(['A_M', 'M_M', 'Z_M']);
  });

  it('does not hang or drop modules on a sequence cycle', () => {
    const ctx = makeContext({
      'app/code/A/M/etc/module.xml': moduleXml('A_M', ['B_M']),
      'app/code/B/M/etc/module.xml': moduleXml('B_M', ['A_M']),
    });
    expect(sortModules(discoverModules(ctx)).map((m) => m.name).sort()).toEqual(['A_M', 'B_M']);
  });

  it('ignores a sequence entry for a module that is not indexed', () => {
    const ctx = makeContext({
      'app/code/Acme/M/etc/module.xml': moduleXml('Acme_M', ['Magento_NotIndexed']),
    });
    expect(sortModules(discoverModules(ctx)).map((m) => m.name)).toEqual(['Acme_M']);
  });

  it('assigns each module its load-order index', () => {
    const ctx = makeContext({
      'app/code/Acme/Override/etc/module.xml': moduleXml('Acme_Override', ['Magento_Catalog']),
      'vendor/magento/module-catalog/etc/module.xml': moduleXml('Magento_Catalog'),
    });
    const modules = discoverModules(ctx);
    sortModules(modules);
    expect(modules.get('Magento_Catalog')!.order).toBe(0);
    expect(modules.get('Acme_Override')!.order).toBe(1);
  });
});

describe('moduleOf', () => {
  const ctx = makeContext({
    'app/code/Acme/Catalog/etc/module.xml': moduleXml('Acme_Catalog'),
    'app/code/Acme/Cat/etc/module.xml': moduleXml('Acme_Cat'),
  });
  const modules = discoverModules(ctx);

  it('maps a file path back to the module that owns it', () => {
    expect(moduleOf('app/code/Acme/Catalog/etc/di.xml', modules)!.name).toBe('Acme_Catalog');
    expect(moduleOf('app/code/Acme/Catalog/Model/Foo.php', modules)!.name).toBe('Acme_Catalog');
  });

  it('does not match on a shared path prefix', () => {
    expect(moduleOf('app/code/Acme/Cat/Model/Foo.php', modules)!.name).toBe('Acme_Cat');
  });

  it('returns null for a file outside every module', () => {
    expect(moduleOf('pub/index.php', modules)).toBeNull();
  });
});

describe('a module that is the repository root', () => {
  const rootModule = {
    'registration.php': '<?php',
    'etc/module.xml': moduleXml('Cucuru_Payment'),
    'etc/di.xml': '<config><preference for="A" type="B"/></config>',
    'Model/Payment.php': '<?php',
  };

  it('discovers a module whose etc/ sits at the repository root', () => {
    const modules = discoverModules(makeContext(rootModule));
    expect([...modules.keys()]).toEqual(['Cucuru_Payment']);
    expect(modules.get('Cucuru_Payment')!.path).toBe('');
  });

  it('maps every root-relative file back to that module', () => {
    const modules = discoverModules(makeContext(rootModule));
    expect(moduleOf('etc/di.xml', modules)!.name).toBe('Cucuru_Payment');
    expect(moduleOf('Model/Payment.php', modules)!.name).toBe('Cucuru_Payment');
  });
});
