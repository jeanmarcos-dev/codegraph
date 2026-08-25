/**
 * The Magento framework resolver: detection, module nodes, and FQCN resolution.
 *
 * Detection has to cover both shapes a Magento codebase arrives in — a full
 * store (composer requires the product metapackage) and a single distributable
 * module (composer `type: magento2-module`, or no composer.json at all, just
 * `registration.php` + `etc/module.xml`) — without firing on unrelated PHP.
 *
 * Resolution has to go through the DI config: a reference to an interface must
 * land on the class the merged `di.xml` says will actually be instantiated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { magentoResolver } from '../src/resolution/frameworks/magento';
import { clearMagentoConfigCache } from '../src/resolution/frameworks/magento/config';
import type { ResolutionContext } from '../src/resolution/types';
import type { Node } from '../src/types';

function node(overrides: Partial<Node> & Pick<Node, 'kind' | 'name' | 'qualifiedName'>): Node {
  return {
    id: `${overrides.kind}:${overrides.qualifiedName}`,
    filePath: 'app/code/Acme/M/Model/X.php',
    language: 'php',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeContext(
  files: Record<string, string>,
  nodes: Node[] = [],
  root = '/project',
): ResolutionContext {
  const byQualifiedName = new Map<string, Node[]>();
  for (const n of nodes) {
    const list = byQualifiedName.get(n.qualifiedName);
    if (list) list.push(n);
    else byQualifiedName.set(n.qualifiedName, [n]);
  }
  return {
    getNodesInFile: (f) => nodes.filter((n) => n.filePath === f),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qn) => byQualifiedName.get(qn) ?? [],
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    fileExists: (f: string) => f in files,
    readFile: (f: string) => files[f] ?? null,
    getProjectRoot: () => root,
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: (lower) => nodes.filter((n) => n.name.toLowerCase() === lower),
    getImportMappings: () => [],
  };
}

beforeEach(() => clearMagentoConfigCache());

describe('detect', () => {
  it('detects a full store from the composer metapackage', () => {
    const ctx = makeContext({
      'composer.json': JSON.stringify({
        require: { 'magento/product-community-edition': '2.4.7', 'php': '~8.2' },
      }),
    });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('detects the enterprise metapackage', () => {
    const ctx = makeContext({
      'composer.json': JSON.stringify({ require: { 'magento/product-enterprise-edition': '2.4.7' } }),
    });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('detects a standalone module by composer type', () => {
    const ctx = makeContext({
      'composer.json': JSON.stringify({ name: 'acme/module-catalog', type: 'magento2-module' }),
    });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('detects a module with no composer.json via registration.php + etc/module.xml', () => {
    const ctx = makeContext({
      'app/code/Acme/Catalog/registration.php': '<?php',
      'app/code/Acme/Catalog/etc/module.xml': '<config><module name="Acme_Catalog"/></config>',
    });
    expect(magentoResolver.detect(ctx)).toBe(true);
  });

  it('does not fire on a non-Magento PHP project', () => {
    const ctx = makeContext({
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11' } }),
      'app/Http/Kernel.php': '<?php',
    });
    expect(magentoResolver.detect(ctx)).toBe(false);
  });

  it('does not fire on an etc/module.xml with no sibling registration.php', () => {
    const ctx = makeContext({
      'some/other/etc/module.xml': '<config><module name="Not_Magento"/></config>',
    });
    expect(magentoResolver.detect(ctx)).toBe(false);
  });

  it('survives a malformed composer.json', () => {
    const ctx = makeContext({ 'composer.json': '{ not json' });
    expect(magentoResolver.detect(ctx)).toBe(false);
  });
});

describe('extract: etc/module.xml', () => {
  it('emits a module node and references to its sequence', () => {
    const { nodes, references } = magentoResolver.extract!(
      'app/code/Acme/Catalog/etc/module.xml',
      `<?xml version="1.0"?>
<config>
    <module name="Acme_Catalog">
        <sequence>
            <module name="Magento_Catalog"/>
            <module name="Magento_Sales"/>
        </sequence>
    </module>
</config>`,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('module');
    expect(nodes[0]!.name).toBe('Acme_Catalog');
    expect(nodes[0]!.startLine).toBe(3);
    expect(references.map((r) => r.referenceName)).toEqual([
      'magento:module:Magento_Catalog',
      'magento:module:Magento_Sales',
    ]);
  });

  it('emits nothing for a module.xml with no module element', () => {
    const { nodes, references } = magentoResolver.extract!(
      'app/code/Acme/Broken/etc/module.xml',
      '<config></config>',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });

  it('ignores XML that is not Magento config', () => {
    const { nodes, references } = magentoResolver.extract!(
      'app/code/Acme/M/etc/db_schema.xml',
      '<schema><table name="acme"/></schema>',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

describe('claimsReference', () => {
  it('claims fully-qualified class names', () => {
    expect(magentoResolver.claimsReference!('Acme\\Catalog\\Model\\Stock')).toBe(true);
    expect(magentoResolver.claimsReference!('Acme\\Catalog\\Model\\Stock::getQty')).toBe(true);
  });

  it('claims synthetic magento reference names', () => {
    expect(magentoResolver.claimsReference!('magento:module:Acme_Catalog')).toBe(true);
    expect(magentoResolver.claimsReference!('magento:type:AcmeVirtualStock')).toBe(true);
  });

  it('does not claim a bare symbol name', () => {
    expect(magentoResolver.claimsReference!('getQty')).toBe(false);
  });
});

describe('resolve', () => {
  const files = {
    'app/code/Acme/Catalog/registration.php': '<?php',
    'app/code/Acme/Catalog/etc/module.xml': '<config><module name="Acme_Catalog"/></config>',
    'app/code/Acme/Catalog/etc/di.xml': `<config>
    <preference for="Acme\\Catalog\\Api\\StockInterface" type="Acme\\Catalog\\Model\\Stock"/>
    <virtualType name="AcmeVirtualStock" type="Acme\\Catalog\\Model\\Stock"/>
</config>`,
  };
  const stockClass = node({
    kind: 'class',
    name: 'Stock',
    qualifiedName: 'Acme\\Catalog\\Model::Stock',
    filePath: 'app/code/Acme/Catalog/Model/Stock.php',
  });
  const stockMethod = node({
    kind: 'method',
    name: 'getQty',
    qualifiedName: 'Acme\\Catalog\\Model::Stock::getQty',
    filePath: 'app/code/Acme/Catalog/Model/Stock.php',
  });
  const interfaceNode = node({
    kind: 'interface',
    name: 'StockInterface',
    qualifiedName: 'Acme\\Catalog\\Api::StockInterface',
    filePath: 'app/code/Acme/Catalog/Api/StockInterface.php',
  });

  function ref(referenceName: string) {
    return {
      fromNodeId: 'route:x',
      referenceName,
      referenceKind: 'references' as const,
      line: 1,
      column: 0,
      filePath: 'app/code/Acme/Catalog/etc/webapi.xml',
      language: 'xml' as const,
    };
  }

  it('resolves an interface to the implementation its preference names', () => {
    const ctx = makeContext(files, [stockClass, interfaceNode]);
    const result = magentoResolver.resolve(ref('Acme\\Catalog\\Api\\StockInterface'), ctx);
    expect(result!.targetNodeId).toBe(stockClass.id);
    expect(result!.resolvedBy).toBe('framework');
  });

  it('resolves an interface method to the implementation method', () => {
    const ctx = makeContext(files, [stockClass, stockMethod, interfaceNode]);
    const result = magentoResolver.resolve(ref('Acme\\Catalog\\Api\\StockInterface::getQty'), ctx);
    expect(result!.targetNodeId).toBe(stockMethod.id);
  });

  it('resolves a virtual type to its backing class', () => {
    const ctx = makeContext(files, [stockClass]);
    const result = magentoResolver.resolve(ref('magento:type:AcmeVirtualStock'), ctx);
    expect(result!.targetNodeId).toBe(stockClass.id);
  });

  it('falls back to the interface node when the implementation is not indexed', () => {
    const ctx = makeContext(files, [interfaceNode]);
    const result = magentoResolver.resolve(ref('Acme\\Catalog\\Api\\StockInterface'), ctx);
    expect(result!.targetNodeId).toBe(interfaceNode.id);
  });

  it('returns null when neither side is indexed', () => {
    const ctx = makeContext(files, []);
    expect(magentoResolver.resolve(ref('Magento\\Catalog\\Api\\ProductRepositoryInterface'), ctx)).toBeNull();
  });

  it('resolves a module reference to the module node', () => {
    const moduleNode = node({
      kind: 'module',
      name: 'Acme_Catalog',
      qualifiedName: 'Acme_Catalog',
      filePath: 'app/code/Acme/Catalog/etc/module.xml',
    });
    const ctx = makeContext(files, [moduleNode]);
    const result = magentoResolver.resolve(ref('magento:module:Acme_Catalog'), ctx);
    expect(result!.targetNodeId).toBe(moduleNode.id);
  });
});

/**
 * A virtual type is named all over `di.xml` and injected like a class, but it
 * exists nowhere on disk — so searching for one found nothing, and the argument
 * that injects it pointed at a name the graph did not contain.
 */
describe('extract: etc/di.xml virtual types', () => {
  it('emits a type_alias node referencing the type it configures', () => {
    const { nodes, references } = magentoResolver.extract!(
      'app/code/Acme/M/etc/di.xml',
      `<config>
    <virtualType name="acmeCollectionFactory" type="Acme\\M\\Model\\Base"/>
</config>`,
      'xml',
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('type_alias');
    expect(nodes[0]!.name).toBe('acmeCollectionFactory');
    expect(nodes[0]!.startLine).toBe(2);
    expect(references.map((r) => r.referenceName)).toEqual(['Acme\\M\\Model\\Base']);
  });

  it('emits nothing for a di.xml with no virtual types', () => {
    const { nodes } = magentoResolver.extract!(
      'app/code/Acme/M/etc/di.xml',
      '<config><preference for="A" type="B"/></config>',
      'xml',
    );
    expect(nodes).toHaveLength(0);
  });

  // Only direct children of `<config>` are declarations: a `<virtualType>` deep
  // inside an `<argument>` tree is data, not a declaration.
  it('ignores a virtualType nested inside an argument', () => {
    const { nodes } = magentoResolver.extract!(
      'app/code/Acme/M/etc/di.xml',
      `<config>
    <type name="Acme\\Target">
        <arguments>
            <argument name="x" xsi:type="array">
                <virtualType name="notADeclaration" type="Acme\\Base"/>
            </argument>
        </arguments>
    </type>
</config>`,
      'xml',
    );
    expect(nodes).toHaveLength(0);
  });
});
