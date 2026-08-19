/**
 * Magento DI edge synthesis.
 *
 * These are the edges that make the graph tell the truth about a Magento
 * codebase. Static extraction stops at the interface method; Magento actually
 * runs the preference's class, wrapped by every plugin declared on it. Each
 * pass is gated on both ends existing in the graph — with `vendor/` unindexed
 * most core targets are absent, and inventing an edge to a class we never saw
 * would be worse than leaving the flow open.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  magentoPreferenceEdges,
  magentoPluginEdges,
  magentoDiArgumentEdges,
  magentoFactoryEdges,
  magentoControllerRouteEdges,
} from '../src/resolution/magento-synthesizer';
import { clearMagentoConfigCache } from '../src/resolution/frameworks/magento/config';
import type { ResolutionContext } from '../src/resolution/types';
import type { Edge, Node } from '../src/types';

interface Fixture {
  files: Record<string, string>;
  classes: Array<{ fqcn: string; kind?: Node['kind']; methods: string[]; filePath?: string }>;
}

/**
 * Method line ranges matter for the factory pass, which attributes a
 * `->create()` callsite to the method whose range contains it. When the fixture
 * supplies the file's source, ranges come from the source itself.
 */
function methodRanges(source: string | undefined, methods: string[]): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  if (!source) return ranges;
  const lines = source.split('\n');
  const starts: Array<{ name: string; line: number }> = [];
  lines.forEach((line, index) => {
    const match = line.match(/function\s+(\w+)\s*\(/);
    if (match && methods.includes(match[1]!)) starts.push({ name: match[1]!, line: index + 1 });
  });
  starts.forEach((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]!.line - 1 : lines.length;
    ranges.set(entry.name, [entry.line, end]);
  });
  return ranges;
}

function buildGraph(fixture: Fixture) {
  const nodes: Node[] = [];
  const containsEdges: Edge[] = [];

  for (const declaration of fixture.classes) {
    const lastSeparator = declaration.fqcn.lastIndexOf('\\');
    const namespace = declaration.fqcn.slice(0, lastSeparator);
    const name = declaration.fqcn.slice(lastSeparator + 1);
    const filePath = declaration.filePath ?? `app/code/${declaration.fqcn.replace(/\\/g, '/')}.php`;
    const ranges = methodRanges(fixture.files[filePath], declaration.methods);
    const classNode: Node = {
      id: `class:${declaration.fqcn}`,
      kind: declaration.kind ?? 'class',
      name,
      qualifiedName: `${namespace}::${name}`,
      filePath,
      language: 'php',
      startLine: 1,
      endLine: 100,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    nodes.push(classNode);

    for (const method of declaration.methods) {
      const range = ranges.get(method);
      const methodNode: Node = {
        id: `method:${declaration.fqcn}::${method}`,
        kind: 'method',
        name: method,
        qualifiedName: `${namespace}::${name}::${method}`,
        filePath,
        language: 'php',
        startLine: range ? range[0] : 5,
        endLine: range ? range[1] : 10,
        startColumn: 0,
        endColumn: 0,
        updatedAt: 0,
      };
      nodes.push(methodNode);
      containsEdges.push({ source: classNode.id, target: methodNode.id, kind: 'contains', line: 5 });
    }
  }

  const byQualifiedName = new Map<string, Node[]>();
  const byId = new Map<string, Node>();
  for (const n of nodes) {
    byId.set(n.id, n);
    const list = byQualifiedName.get(n.qualifiedName);
    if (list) list.push(n);
    else byQualifiedName.set(n.qualifiedName, [n]);
  }

  const queries = {
    getNodesByQualifiedNameExact: (qn: string) => byQualifiedName.get(qn) ?? [],
    getNodeById: (id: string) => byId.get(id) ?? null,
    getOutgoingEdges: (id: string, kinds?: string[]) =>
      containsEdges.filter((e) => e.source === id && (!kinds || kinds.includes(e.kind))),
  };

  const context: ResolutionContext = {
    getNodesInFile: (f) => nodes.filter((n) => n.filePath === f),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qn) => byQualifiedName.get(qn) ?? [],
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    fileExists: (f: string) => f in fixture.files,
    readFile: (f: string) => fixture.files[f] ?? null,
    getProjectRoot: () => '/project',
    getAllFiles: () => Object.keys(fixture.files),
    getNodesByLowerName: (lower) => nodes.filter((n) => n.name.toLowerCase() === lower),
    getImportMappings: () => [],
  };

  return { queries: queries as never, context };
}

const noYield = async (): Promise<void> => undefined;

function moduleFiles(name: string, di: string, sequence: string[] = []): Record<string, string> {
  const seq = sequence.length
    ? `<sequence>${sequence.map((s) => `<module name="${s}"/>`).join('')}</sequence>`
    : '';
  const dir = `app/code/${name.replace('_', '/')}`;
  return {
    [`${dir}/registration.php`]: '<?php',
    [`${dir}/etc/module.xml`]: `<config><module name="${name}">${seq}</module></config>`,
    [`${dir}/etc/di.xml`]: di,
  };
}

beforeEach(() => clearMagentoConfigCache());

describe('magentoPreferenceEdges', () => {
  it('links each interface method to the implementation the preference names', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_Catalog',
        `<config>
    <preference for="Acme\\Catalog\\Api\\StockInterface" type="Acme\\Catalog\\Model\\Stock"/>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Catalog\\Api\\StockInterface', kind: 'interface', methods: ['getQty', 'setQty'] },
        { fqcn: 'Acme\\Catalog\\Model\\Stock', methods: ['getQty', 'setQty', 'internalHelper'] },
      ],
    });

    const edges = await magentoPreferenceEdges(queries, context, noYield);
    expect(edges).toHaveLength(2);
    expect(edges[0]!.source).toBe('method:Acme\\Catalog\\Api\\StockInterface::getQty');
    expect(edges[0]!.target).toBe('method:Acme\\Catalog\\Model\\Stock::getQty');
    expect(edges[0]!.provenance).toBe('heuristic');
    expect(edges[0]!.metadata!.synthesizedBy).toBe('magento-preference');
    expect(edges[0]!.metadata!.registeredAt).toBe('app/code/Acme/Catalog/etc/di.xml:2');
  });

  it('links to the end of a preference chain, not the intermediate class', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <preference for="Acme\\Api\\FooInterface" type="Acme\\Model\\Foo"/>
    <preference for="Acme\\Model\\Foo" type="Acme\\Model\\BetterFoo"/>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Api\\FooInterface', kind: 'interface', methods: ['run'] },
        { fqcn: 'Acme\\Model\\Foo', methods: ['run'] },
        { fqcn: 'Acme\\Model\\BetterFoo', methods: ['run'] },
      ],
    });

    const edges = await magentoPreferenceEdges(queries, context, noYield);
    const fromInterface = edges.filter((e) => e.source === 'method:Acme\\Api\\FooInterface::run');
    expect(fromInterface).toHaveLength(1);
    expect(fromInterface[0]!.target).toBe('method:Acme\\Model\\BetterFoo::run');
  });

  it('emits nothing when the implementation is not indexed', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <preference for="Magento\\Catalog\\Api\\ProductRepositoryInterface" type="Magento\\Catalog\\Model\\ProductRepository"/>
</config>`,
      ),
      classes: [],
    });
    expect(await magentoPreferenceEdges(queries, context, noYield)).toHaveLength(0);
  });

  it('emits nothing for a project with no Magento modules', async () => {
    const { queries, context } = buildGraph({
      files: { 'src/index.php': '<?php' },
      classes: [{ fqcn: 'Acme\\Model\\Foo', methods: ['run'] }],
    });
    expect(await magentoPreferenceEdges(queries, context, noYield)).toHaveLength(0);
  });

  it('does not link a method the implementation does not define', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config><preference for="Acme\\Api\\FooInterface" type="Acme\\Model\\Foo"/></config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Api\\FooInterface', kind: 'interface', methods: ['run', 'onlyOnInterface'] },
        { fqcn: 'Acme\\Model\\Foo', methods: ['run'] },
      ],
    });
    const edges = await magentoPreferenceEdges(queries, context, noYield);
    expect(edges.map((e) => e.target)).toEqual(['method:Acme\\Model\\Foo::run']);
  });
});

describe('magentoPluginEdges', () => {
  it('links an intercepted method to the plugin methods that wrap it', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <type name="Acme\\Catalog\\Model\\Product">
        <plugin name="acme_price" type="Acme\\M\\Plugin\\PricePlugin" sortOrder="10"/>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Catalog\\Model\\Product', methods: ['getPrice', 'getName', 'save'] },
        {
          fqcn: 'Acme\\M\\Plugin\\PricePlugin',
          methods: ['afterGetPrice', 'beforeSave', 'aroundGetName'],
        },
      ],
    });

    const edges = await magentoPluginEdges(queries, context, noYield);
    const pairs = edges.map((e) => `${e.source} -> ${e.target}`);
    expect(pairs).toContain(
      'method:Acme\\Catalog\\Model\\Product::getPrice -> method:Acme\\M\\Plugin\\PricePlugin::afterGetPrice',
    );
    expect(pairs).toContain(
      'method:Acme\\Catalog\\Model\\Product::save -> method:Acme\\M\\Plugin\\PricePlugin::beforeSave',
    );
    expect(pairs).toContain(
      'method:Acme\\Catalog\\Model\\Product::getName -> method:Acme\\M\\Plugin\\PricePlugin::aroundGetName',
    );
    expect(edges[0]!.metadata!.synthesizedBy).toBe('magento-plugin');
  });

  it('records the di.xml declaration site and the plugin sort order', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <type name="Acme\\Model\\Target">
        <plugin name="acme" type="Acme\\Plugin\\P" sortOrder="42"/>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Model\\Target', methods: ['execute'] },
        { fqcn: 'Acme\\Plugin\\P', methods: ['beforeExecute'] },
      ],
    });

    const edges = await magentoPluginEdges(queries, context, noYield);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.metadata!.registeredAt).toBe('app/code/Acme/M/etc/di.xml:3');
    expect(edges[0]!.metadata!.via).toBe('acme');
  });

  it('does not link a disabled plugin', async () => {
    const files = {
      ...moduleFiles(
        'Magento_Catalog',
        `<config>
    <type name="Acme\\Model\\Target">
        <plugin name="core" type="Acme\\Plugin\\P"/>
    </type>
</config>`,
      ),
      ...moduleFiles(
        'Acme_M',
        `<config>
    <type name="Acme\\Model\\Target">
        <plugin name="core" disabled="true"/>
    </type>
</config>`,
        ['Magento_Catalog'],
      ),
    };
    const { queries, context } = buildGraph({
      files,
      classes: [
        { fqcn: 'Acme\\Model\\Target', methods: ['execute'] },
        { fqcn: 'Acme\\Plugin\\P', methods: ['beforeExecute'] },
      ],
    });

    expect(await magentoPluginEdges(queries, context, noYield)).toHaveLength(0);
  });

  it('applies a plugin declared on an interface to the implementation as well', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <preference for="Acme\\Api\\StockInterface" type="Acme\\Model\\Stock"/>
    <type name="Acme\\Api\\StockInterface">
        <plugin name="acme" type="Acme\\Plugin\\StockPlugin"/>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Api\\StockInterface', kind: 'interface', methods: ['getQty'] },
        { fqcn: 'Acme\\Model\\Stock', methods: ['getQty'] },
        { fqcn: 'Acme\\Plugin\\StockPlugin', methods: ['afterGetQty'] },
      ],
    });

    const targets = (await magentoPluginEdges(queries, context, noYield)).map((e) => e.source);
    expect(targets).toContain('method:Acme\\Api\\StockInterface::getQty');
    expect(targets).toContain('method:Acme\\Model\\Stock::getQty');
  });

  it('resolves a plugin declared on a virtual type to the backing class', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <virtualType name="AcmeVirtualTarget" type="Acme\\Model\\Target"/>
    <type name="AcmeVirtualTarget">
        <plugin name="acme" type="Acme\\Plugin\\P"/>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Model\\Target', methods: ['execute'] },
        { fqcn: 'Acme\\Plugin\\P', methods: ['aroundExecute'] },
      ],
    });

    const edges = await magentoPluginEdges(queries, context, noYield);
    expect(edges.map((e) => e.source)).toEqual(['method:Acme\\Model\\Target::execute']);
  });

  it('ignores plugin methods that are not interceptors', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <type name="Acme\\Model\\Target">
        <plugin name="acme" type="Acme\\Plugin\\P"/>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Model\\Target', methods: ['execute', 'helper'] },
        { fqcn: 'Acme\\Plugin\\P', methods: ['__construct', 'helper', 'beforeExecute'] },
      ],
    });

    const edges = await magentoPluginEdges(queries, context, noYield);
    expect(edges.map((e) => e.target)).toEqual(['method:Acme\\Plugin\\P::beforeExecute']);
  });

  it('emits nothing when the intercepted class is not indexed', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <type name="Magento\\Catalog\\Model\\Product">
        <plugin name="acme" type="Acme\\Plugin\\P"/>
    </type>
</config>`,
      ),
      classes: [{ fqcn: 'Acme\\Plugin\\P', methods: ['afterGetPrice'] }],
    });
    expect(await magentoPluginEdges(queries, context, noYield)).toHaveLength(0);
  });
});

describe('magentoDiArgumentEdges', () => {
  it('links a constructor to the class di.xml injects into it', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <type name="Acme\\Model\\Consumer">
        <arguments>
            <argument name="logger" xsi:type="object">Acme\\Log\\SpecialLogger</argument>
        </arguments>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Model\\Consumer', methods: ['__construct', 'run'] },
        { fqcn: 'Acme\\Log\\SpecialLogger', methods: ['__construct', 'info'] },
      ],
    });

    const edges = await magentoDiArgumentEdges(queries, context, noYield);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe('method:Acme\\Model\\Consumer::__construct');
    expect(edges[0]!.target).toBe('method:Acme\\Log\\SpecialLogger::__construct');
    expect(edges[0]!.metadata!.synthesizedBy).toBe('magento-di-argument');
    expect(edges[0]!.metadata!.via).toBe('logger');
  });

  it('links every member of an array argument, which is how composites are wired', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <type name="Acme\\Model\\Pool">
        <arguments>
            <argument name="handlers" xsi:type="array">
                <item name="first" xsi:type="object">Acme\\Handler\\First</item>
                <item name="second" xsi:type="object">Acme\\Handler\\Second</item>
            </argument>
        </arguments>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Model\\Pool', methods: ['__construct'] },
        { fqcn: 'Acme\\Handler\\First', methods: ['__construct'] },
        { fqcn: 'Acme\\Handler\\Second', methods: ['__construct'] },
      ],
    });

    const edges = await magentoDiArgumentEdges(queries, context, noYield);
    expect(edges.map((e) => e.target).sort()).toEqual([
      'method:Acme\\Handler\\First::__construct',
      'method:Acme\\Handler\\Second::__construct',
    ]);
  });

  it('falls back to the class node when the injected class has no constructor', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <type name="Acme\\Model\\Consumer">
        <arguments>
            <argument name="plain" xsi:type="object">Acme\\Model\\Plain</argument>
        </arguments>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Model\\Consumer', methods: ['__construct'] },
        { fqcn: 'Acme\\Model\\Plain', methods: [] },
      ],
    });

    const edges = await magentoDiArgumentEdges(queries, context, noYield);
    expect(edges[0]!.target).toBe('class:Acme\\Model\\Plain');
  });

  it('resolves an injected virtual type to its backing class', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <virtualType name="AcmeVirtualLogger" type="Acme\\Log\\Logger"/>
    <type name="Acme\\Model\\Consumer">
        <arguments>
            <argument name="logger" xsi:type="object">AcmeVirtualLogger</argument>
        </arguments>
    </type>
</config>`,
      ),
      classes: [
        { fqcn: 'Acme\\Model\\Consumer', methods: ['__construct'] },
        { fqcn: 'Acme\\Log\\Logger', methods: ['__construct'] },
      ],
    });

    const edges = await magentoDiArgumentEdges(queries, context, noYield);
    expect(edges[0]!.target).toBe('method:Acme\\Log\\Logger::__construct');
  });

  it('emits nothing when the injected class is not indexed', async () => {
    const { queries, context } = buildGraph({
      files: moduleFiles(
        'Acme_M',
        `<config>
    <type name="Acme\\Model\\Consumer">
        <arguments>
            <argument name="logger" xsi:type="object">Magento\\Framework\\Logger\\Monolog</argument>
        </arguments>
    </type>
</config>`,
      ),
      classes: [{ fqcn: 'Acme\\Model\\Consumer', methods: ['__construct'] }],
    });
    expect(await magentoDiArgumentEdges(queries, context, noYield)).toHaveLength(0);
  });
});

describe('magentoFactoryEdges', () => {
  function factoryFixture(source: string, classes: Fixture['classes']) {
    const filePath = 'app/code/Acme/M/Model/Consumer.php';
    const built = buildGraph({
      files: {
        ...moduleFiles('Acme_M', '<config/>'),
        [filePath]: source,
      },
      classes,
    });
    return { ...built, filePath };
  }

  it('links a method calling $this->xFactory->create() to the created class', async () => {
    const source = `<?php
namespace Acme\\M\\Model;

use Acme\\M\\Api\\Data\\ItemInterfaceFactory;

class Consumer
{
    private $itemFactory;

    public function __construct(ItemInterfaceFactory $itemFactory)
    {
        $this->itemFactory = $itemFactory;
    }

    public function build()
    {
        $item = $this->itemFactory->create();
        return $item;
    }
}
`;
    const { queries, context, filePath } = factoryFixture(source, [
      {
        fqcn: 'Acme\\M\\Model\\Consumer',
        filePath: 'app/code/Acme/M/Model/Consumer.php',
        methods: ['__construct', 'build'],
      },
      { fqcn: 'Acme\\M\\Api\\Data\\ItemInterface', kind: 'interface', methods: ['getId'] },
    ]);

    const edges = await magentoFactoryEdges(queries, context, noYield);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe('method:Acme\\M\\Model\\Consumer::build');
    expect(edges[0]!.target).toBe('class:Acme\\M\\Api\\Data\\ItemInterface');
    expect(edges[0]!.metadata!.synthesizedBy).toBe('magento-factory');
    expect(edges[0]!.metadata!.registeredAt).toContain(filePath);
  });

  it('targets the created class constructor when it has one', async () => {
    const source = `<?php
namespace Acme\\M\\Model;

class Consumer
{
    public function __construct(private \\Acme\\M\\Model\\ItemFactory $itemFactory)
    {
    }

    public function build()
    {
        return $this->itemFactory->create(['a' => 1]);
    }
}
`;
    const { queries, context } = factoryFixture(source, [
      {
        fqcn: 'Acme\\M\\Model\\Consumer',
        filePath: 'app/code/Acme/M/Model/Consumer.php',
        methods: ['__construct', 'build'],
      },
      { fqcn: 'Acme\\M\\Model\\Item', methods: ['__construct', 'getId'] },
    ]);

    const edges = await magentoFactoryEdges(queries, context, noYield);
    expect(edges.map((e) => e.target)).toEqual(['method:Acme\\M\\Model\\Item::__construct']);
  });

  it('resolves a factory declared as a typed property', async () => {
    const source = `<?php
namespace Acme\\M\\Model;

use Acme\\M\\Model\\ItemFactory;

class Consumer
{
    private ItemFactory $itemFactory;

    public function build()
    {
        return $this->itemFactory->create();
    }
}
`;
    const { queries, context } = factoryFixture(source, [
      {
        fqcn: 'Acme\\M\\Model\\Consumer',
        filePath: 'app/code/Acme/M/Model/Consumer.php',
        methods: ['build'],
      },
      { fqcn: 'Acme\\M\\Model\\Item', methods: [] },
    ]);

    expect((await magentoFactoryEdges(queries, context, noYield)).map((e) => e.target)).toEqual([
      'class:Acme\\M\\Model\\Item',
    ]);
  });

  it('emits nothing when the created class is not indexed', async () => {
    const source = `<?php
namespace Acme\\M\\Model;

class Consumer
{
    public function __construct(\\Magento\\Catalog\\Api\\Data\\ProductInterfaceFactory $productFactory)
    {
    }

    public function build()
    {
        return $this->productFactory->create();
    }
}
`;
    const { queries, context } = factoryFixture(source, [
      {
        fqcn: 'Acme\\M\\Model\\Consumer',
        filePath: 'app/code/Acme/M/Model/Consumer.php',
        methods: ['__construct', 'build'],
      },
    ]);
    expect(await magentoFactoryEdges(queries, context, noYield)).toHaveLength(0);
  });

  it('does not treat a non-factory property as a factory', async () => {
    const source = `<?php
namespace Acme\\M\\Model;

class Consumer
{
    public function __construct(\\Acme\\M\\Model\\Item $item)
    {
    }

    public function build()
    {
        return $this->item->create();
    }
}
`;
    const { queries, context } = factoryFixture(source, [
      {
        fqcn: 'Acme\\M\\Model\\Consumer',
        filePath: 'app/code/Acme/M/Model/Consumer.php',
        methods: ['__construct', 'build'],
      },
      { fqcn: 'Acme\\M\\Model\\Item', methods: ['create'] },
    ]);
    expect(await magentoFactoryEdges(queries, context, noYield)).toHaveLength(0);
  });
});

describe('magentoControllerRouteEdges', () => {
  function routeFixture(modulePrefix: string) {
    const prefix = modulePrefix ? `${modulePrefix}/` : '';
    const controllerPath = `${prefix}Controller/Alias/Create.php`;
    const files: Record<string, string> = {
      [`${prefix}registration.php`]: '<?php',
      [`${prefix}etc/module.xml`]: '<config><module name="Acme_Payment"/></config>',
      [`${prefix}etc/frontend/routes.xml`]: `<config>
    <router id="standard">
        <route id="acme" frontName="acmepay">
            <module name="Acme_Payment"/>
        </route>
    </router>
</config>`,
      [controllerPath]: '<?php',
    };
    return { files, controllerPath };
  }

  function withRouteNode(files: Record<string, string>, controllerPath: string) {
    const built = buildGraph({
      files,
      classes: [
        { fqcn: 'Acme\\Payment\\Controller\\Alias\\Create', filePath: controllerPath, methods: ['execute'] },
      ],
    });
    const routesFile = Object.keys(files).find((f) => f.endsWith('routes.xml'))!;
    const routeNode: Node = {
      id: `magento-route:${routesFile}:3:acmepay`,
      kind: 'route',
      name: 'frontend /acmepay/*',
      qualifiedName: `${routesFile}::route:acmepay`,
      filePath: routesFile,
      language: 'xml',
      startLine: 3,
      endLine: 3,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const baseGetNodesByKind = built.context.getNodesByKind;
    built.context.getNodesByKind = (kind) =>
      kind === 'route' ? [routeNode] : baseGetNodesByKind(kind);
    return { ...built, routeNode };
  }

  it('links a front name to the controller actions of the serving module', async () => {
    const { files, controllerPath } = routeFixture('app/code/Acme/Payment');
    const { context, routeNode } = withRouteNode(files, controllerPath);

    const edges = await magentoControllerRouteEdges(context, noYield);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe(routeNode.id);
    expect(edges[0]!.target).toBe('method:Acme\\Payment\\Controller\\Alias\\Create::execute');
    expect(edges[0]!.metadata!.via).toBe('acmepay/alias/create');
  });

  it('works when the module is the repository root', async () => {
    const { files, controllerPath } = routeFixture('');
    const { context } = withRouteNode(files, controllerPath);

    const edges = await magentoControllerRouteEdges(context, noYield);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.metadata!.via).toBe('acmepay/alias/create');
  });
});
