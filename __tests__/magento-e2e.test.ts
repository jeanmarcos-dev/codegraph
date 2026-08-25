/**
 * Magento end-to-end: a real project on disk, indexed by CodeGraph.
 *
 * The unit tests pin each piece against a fake graph; this one proves the
 * pieces are actually wired into the pipeline — detection fires, the XML is
 * read during extraction, and the synthesis passes run and persist their edges.
 * The scenario is the one that makes Magento hard to read: a controller calls
 * an interface method, `di.xml` says a different class implements it, and a
 * plugin wraps it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { clearMagentoConfigCache } from '../src/resolution/frameworks/magento/config';
import { clearProjectConfigCache } from '../src/project-config';

function write(root: string, relative: string, content: string): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildProject(root: string): void {
  write(root, 'composer.json', JSON.stringify({ require: { 'magento/product-community-edition': '2.4.7' } }));

  write(root, 'app/code/Acme/Catalog/registration.php', '<?php\n');
  write(
    root,
    'app/code/Acme/Catalog/etc/module.xml',
    `<?xml version="1.0"?>
<config>
    <module name="Acme_Catalog">
        <sequence>
            <module name="Acme_Base"/>
        </sequence>
    </module>
</config>
`,
  );
  write(
    root,
    'app/code/Acme/Catalog/etc/di.xml',
    `<?xml version="1.0"?>
<config>
    <preference for="Acme\\Catalog\\Api\\StockInterface" type="Acme\\Catalog\\Model\\Stock"/>
    <type name="Acme\\Catalog\\Model\\Stock">
        <plugin name="acme_stock_logging" type="Acme\\Catalog\\Plugin\\StockLogger" sortOrder="10"/>
    </type>
    <type name="Acme\\Catalog\\Model\\Stock">
        <arguments>
            <argument name="writer" xsi:type="object">Acme\\Catalog\\Model\\FileWriter</argument>
        </arguments>
    </type>
</config>
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/etc/events.xml',
    `<?xml version="1.0"?>
<config>
    <event name="acme_stock_updated">
        <observer name="acme_stock_notify" instance="Acme\\Catalog\\Observer\\StockNotifier"/>
    </event>
</config>
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/Observer/StockNotifier.php',
    `<?php
namespace Acme\\Catalog\\Observer;

class StockNotifier
{
    public function execute($observer)
    {
        return null;
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/Model/StockUpdater.php',
    `<?php
namespace Acme\\Catalog\\Model;

class StockUpdater
{
    private $eventManager;

    public function update(int $productId): void
    {
        $this->eventManager->dispatch('acme_stock_updated', ['product_id' => $productId]);
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/etc/webapi.xml',
    `<?xml version="1.0"?>
<routes>
    <route url="/V1/acme/stock/:productId" method="GET">
        <service class="Acme\\Catalog\\Api\\StockInterface" method="getQty"/>
        <resources>
            <resource ref="anonymous"/>
        </resources>
    </route>
</routes>
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/etc/frontend/routes.xml',
    `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="acme_catalog" frontName="acmecatalog">
            <module name="Acme_Catalog"/>
        </route>
    </router>
</config>
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/etc/crontab.xml',
    `<?xml version="1.0"?>
<config>
    <group id="default">
        <job name="acme_stock_cleanup" instance="Acme\\Catalog\\Cron\\Cleanup" method="execute">
            <schedule>0 3 * * *</schedule>
        </job>
    </group>
</config>
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/Cron/Cleanup.php',
    `<?php
namespace Acme\\Catalog\\Cron;

class Cleanup
{
    public function execute()
    {
        return null;
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/view/frontend/layout/acmecatalog_index_view.xml',
    `<?xml version="1.0"?>
<page>
    <body>
        <referenceContainer name="content">
            <block class="Acme\\Catalog\\Block\\StockBlock" name="acme.stock.block"
                   template="Acme_Catalog::stock/view.phtml">
                <arguments>
                    <argument name="view_model" xsi:type="object">Acme\\Catalog\\ViewModel\\StockView</argument>
                </arguments>
            </block>
        </referenceContainer>
    </body>
</page>
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/Block/StockBlock.php',
    `<?php
namespace Acme\\Catalog\\Block;

class StockBlock
{
    public function getStockLabel(): string
    {
        return 'in stock';
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/ViewModel/StockView.php',
    `<?php
namespace Acme\\Catalog\\ViewModel;

class StockView
{
    public function formatQty(float $qty): string
    {
        return (string) $qty;
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/view/frontend/templates/stock/view.phtml',
    `<?php
/** @var \\Acme\\Catalog\\Block\\StockBlock $block */
?>
<div class="stock">
    <span><?= $block->getStockLabel() ?></span>
    <span><?= $viewModel->formatQty(3.0) ?></span>
</div>
`,
  );

  write(root, 'app/code/Acme/Base/registration.php', '<?php\n');
  write(
    root,
    'app/code/Acme/Base/etc/module.xml',
    '<?xml version="1.0"?>\n<config>\n    <module name="Acme_Base"/>\n</config>\n',
  );

  write(
    root,
    'app/code/Acme/Catalog/Api/StockInterface.php',
    `<?php
namespace Acme\\Catalog\\Api;

interface StockInterface
{
    public function getQty(int $productId): float;
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/Model/Stock.php',
    `<?php
namespace Acme\\Catalog\\Model;

use Acme\\Catalog\\Api\\StockInterface;

class Stock implements StockInterface
{
    private $writer;

    public function __construct(FileWriter $writer)
    {
        $this->writer = $writer;
    }

    public function getQty(int $productId): float
    {
        return 42.0;
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/Model/FileWriter.php',
    `<?php
namespace Acme\\Catalog\\Model;

class FileWriter
{
    public function __construct()
    {
    }

    public function write(string $line): void
    {
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/Plugin/StockLogger.php',
    `<?php
namespace Acme\\Catalog\\Plugin;

class StockLogger
{
    public function afterGetQty($subject, $result)
    {
        return $result;
    }
}
`,
  );

  write(
    root,
    'app/code/Acme/Catalog/Controller/Index/View.php',
    `<?php
namespace Acme\\Catalog\\Controller\\Index;

use Acme\\Catalog\\Api\\StockInterface;

class View
{
    private StockInterface $stock;

    public function __construct(StockInterface $stock)
    {
        $this->stock = $stock;
    }

    public function execute()
    {
        return $this->stock->getQty(1);
    }
}
`,
  );
}

/**
 * A distributable module developed as its own repository: `registration.php` and
 * `etc/` sit at the repo root, with no `app/code` prefix on any path.
 */
function buildStandaloneModule(root: string): void {
  write(root, 'composer.json', JSON.stringify({ name: 'acme/module-payment', type: 'magento2-module' }));
  write(root, 'registration.php', '<?php\n');
  write(root, 'etc/module.xml', '<?xml version="1.0"?>\n<config>\n    <module name="Acme_Payment"/>\n</config>\n');
  write(
    root,
    'etc/di.xml',
    `<?xml version="1.0"?>
<config>
    <preference for="Acme\\Payment\\Api\\GatewayInterface" type="Acme\\Payment\\Model\\Gateway"/>
    <type name="Acme\\Payment\\Model\\Gateway">
        <plugin name="acme_gateway_log" type="Acme\\Payment\\Plugin\\GatewayLogger"/>
    </type>
</config>
`,
  );
  write(
    root,
    'Api/GatewayInterface.php',
    `<?php
namespace Acme\\Payment\\Api;

interface GatewayInterface
{
    public function charge(float $amount): bool;
}
`,
  );
  write(
    root,
    'Model/Gateway.php',
    `<?php
namespace Acme\\Payment\\Model;

use Acme\\Payment\\Api\\GatewayInterface;

class Gateway implements GatewayInterface
{
    public function charge(float $amount): bool
    {
        return true;
    }
}
`,
  );
  write(
    root,
    'Plugin/GatewayLogger.php',
    `<?php
namespace Acme\\Payment\\Plugin;

class GatewayLogger
{
    public function beforeCharge($subject, float $amount)
    {
        return [$amount];
    }
}
`,
  );
}

describe('Magento standalone module (repository root)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    clearMagentoConfigCache();
  });

  it('resolves preferences and plugins when the module is the repository root', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-mod-'));
    buildStandaloneModule(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(
      cg.getNodesByKind('module').some((n) => n.name === 'Acme_Payment'),
      'the root module is indexed',
    ).toBe(true);

    const methods = cg.getNodesByKind('method');
    const interfaceCharge = methods.find(
      (n) => n.name === 'charge' && n.filePath.endsWith('Api/GatewayInterface.php'),
    );
    const modelCharge = methods.find(
      (n) => n.name === 'charge' && n.filePath.endsWith('Model/Gateway.php'),
    );
    const beforeCharge = methods.find((n) => n.name === 'beforeCharge');

    expect(
      cg
        .getOutgoingEdges(interfaceCharge!.id)
        .some((e) => e.target === modelCharge!.id && e.metadata?.synthesizedBy === 'magento-preference'),
    ).toBe(true);
    expect(
      cg
        .getOutgoingEdges(modelCharge!.id)
        .some((e) => e.target === beforeCharge!.id && e.metadata?.synthesizedBy === 'magento-plugin'),
    ).toBe(true);

    cg.close();
  }, 60_000);
});

describe('Magento end-to-end', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    clearMagentoConfigCache();
  });

  it('links the interface method to the preference implementation and its plugin', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const interfaceGetQty = methods.find(
      (n) => n.name === 'getQty' && n.filePath.endsWith('Api/StockInterface.php'),
    );
    const modelGetQty = methods.find(
      (n) => n.name === 'getQty' && n.filePath.endsWith('Model/Stock.php'),
    );
    const afterGetQty = methods.find((n) => n.name === 'afterGetQty');
    expect(interfaceGetQty).toBeDefined();
    expect(modelGetQty).toBeDefined();
    expect(afterGetQty).toBeDefined();

    const fromInterface = cg.getOutgoingEdges(interfaceGetQty!.id);
    const preferenceEdge = fromInterface.find(
      (e) => e.target === modelGetQty!.id && e.metadata?.synthesizedBy === 'magento-preference',
    );
    expect(preferenceEdge, 'interface method links to the preference implementation').toBeDefined();
    expect(preferenceEdge!.metadata!.registeredAt).toContain('etc/di.xml:');

    const fromModel = cg.getOutgoingEdges(modelGetQty!.id);
    const pluginEdge = fromModel.find(
      (e) => e.target === afterGetQty!.id && e.metadata?.synthesizedBy === 'magento-plugin',
    );
    expect(pluginEdge, 'intercepted method links to its plugin').toBeDefined();
    expect(pluginEdge!.metadata!.via).toBe('acme_stock_logging');

    cg.close();
  }, 60_000);

  it('links a constructor to the class di.xml injects into it', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const stockConstructor = methods.find(
      (n) => n.name === '__construct' && n.filePath.endsWith('Model/Stock.php'),
    );
    const writerConstructor = methods.find(
      (n) => n.name === '__construct' && n.filePath.endsWith('Model/FileWriter.php'),
    );

    const injection = cg
      .getOutgoingEdges(stockConstructor!.id)
      .find((e) => e.target === writerConstructor!.id && e.metadata?.synthesizedBy === 'magento-di-argument');
    expect(injection).toBeDefined();
    expect(injection!.metadata!.via).toBe('writer');

    cg.close();
  }, 60_000);

  it('links a dispatch site to the event node and the event to its observer', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const eventNode = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'acme_stock_updated' && n.language === 'xml');
    expect(eventNode, 'the event has a node of its own').toBeDefined();

    const observerExecute = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'execute' && n.filePath.endsWith('Observer/StockNotifier.php'));
    expect(observerExecute).toBeDefined();

    const toObserver = cg
      .getOutgoingEdges(eventNode!.id)
      .find((e) => e.target === observerExecute!.id);
    expect(toObserver, 'event links to its observer').toBeDefined();

    const updateMethod = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'update' && n.filePath.endsWith('Model/StockUpdater.php'));
    const fromDispatch = cg
      .getOutgoingEdges(updateMethod!.id)
      .find((e) => e.target === eventNode!.id && e.metadata?.synthesizedBy === 'magento-event');
    expect(fromDispatch, 'dispatch site links to the event').toBeDefined();

    cg.close();
  }, 60_000);

  it('links a web API route through the preference to the implementation method', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const route = cg
      .getNodesByKind('route')
      .find((n) => n.name === 'GET /V1/acme/stock/:productId');
    expect(route, 'the web API endpoint is a route node').toBeDefined();

    const modelGetQty = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'getQty' && n.filePath.endsWith('Model/Stock.php'));
    const served = cg.getOutgoingEdges(route!.id).some((e) => e.target === modelGetQty!.id);
    expect(served, 'the route reaches the class the preference names').toBe(true);

    cg.close();
  }, 60_000);

  it('links a front name to the controller actions that serve it, and a cron job to its class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const routes = cg.getNodesByKind('route');
    const frontRoute = routes.find((n) => n.name === 'frontend /acmecatalog/*');
    expect(frontRoute).toBeDefined();

    const controllerExecute = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'execute' && n.filePath.endsWith('Controller/Index/View.php'));
    const controllerEdge = cg
      .getOutgoingEdges(frontRoute!.id)
      .find((e) => e.target === controllerExecute!.id);
    expect(controllerEdge, 'front name reaches its controller action').toBeDefined();
    expect(controllerEdge!.metadata!.via).toBe('acmecatalog/index/view');

    const cronJob = routes.find((n) => n.name === 'cron acme_stock_cleanup [0 3 * * *]');
    expect(cronJob).toBeDefined();
    const cronExecute = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'execute' && n.filePath.endsWith('Cron/Cleanup.php'));
    expect(cg.getOutgoingEdges(cronJob!.id).some((e) => e.target === cronExecute!.id)).toBe(true);

    cg.close();
  }, 60_000);

  it('links a layout block to its class and template, and the template to the methods it calls', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const blockNode = cg.getNodesByKind('component').find((n) => n.name === 'acme.stock.block');
    expect(blockNode, 'the layout block is a node').toBeDefined();

    const blockClass = cg
      .getNodesByKind('class')
      .find((n) => n.name === 'StockBlock');
    const templateFile = cg
      .getNodesByKind('file')
      .find((n) => n.filePath.endsWith('templates/stock/view.phtml'));
    expect(templateFile, 'the .phtml template is indexed').toBeDefined();

    const blockEdges = cg.getOutgoingEdges(blockNode!.id);
    expect(blockEdges.some((e) => e.target === blockClass!.id), 'block links to its class').toBe(true);
    expect(
      blockEdges.some((e) => e.target === templateFile!.id),
      'block links to its template file',
    ).toBe(true);

    const getStockLabel = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'getStockLabel');
    const formatQty = cg.getNodesByKind('method').find((n) => n.name === 'formatQty');
    const fromTemplate = cg.getOutgoingEdges(templateFile!.id);
    expect(
      fromTemplate.some(
        (e) => e.target === getStockLabel!.id && e.metadata?.synthesizedBy === 'magento-template',
      ),
      'template links to the block method it calls',
    ).toBe(true);
    expect(
      fromTemplate.some((e) => e.target === formatQty!.id),
      'template links to the view model method it calls',
    ).toBe(true);

    cg.close();
  }, 60_000);

  it('indexes modules as nodes and links a module to its sequence dependency', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildProject(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const modules = cg.getNodesByKind('module');
    const catalog = modules.find((n) => n.name === 'Acme_Catalog');
    const base = modules.find((n) => n.name === 'Acme_Base');
    expect(catalog).toBeDefined();
    expect(base).toBeDefined();

    const sequenceEdge = cg.getOutgoingEdges(catalog!.id).find((e) => e.target === base!.id);
    expect(sequenceEdge).toBeDefined();

    cg.close();
  }, 60_000);
});

/**
 * Interception runs down the hierarchy, so a plugin on a base class also wraps
 * the subclass that overrides the intercepted method. This is only visible when
 * both ends are indexed — on a store that leaves `vendor/` out, the plugins it
 * declares target core classes and nothing propagates.
 */
describe('Magento plugin inheritance', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    clearMagentoConfigCache();
    clearProjectConfigCache();
  });

  function buildHierarchy(root: string): void {
    write(root, 'composer.json', JSON.stringify({ require: { 'magento/product-community-edition': '2.4.7' } }));
    write(root, 'app/code/Acme/M/registration.php', '<?php\n');
    write(
      root,
      'app/code/Acme/M/etc/module.xml',
      '<?xml version="1.0"?>\n<config><module name="Acme_M"/></config>\n',
    );
    write(
      root,
      'app/code/Acme/M/etc/di.xml',
      `<?xml version="1.0"?>
<config>
    <type name="Acme\\M\\Model\\Base">
        <plugin name="acme_base" type="Acme\\M\\Plugin\\BasePlugin"/>
    </type>
</config>
`,
    );
    write(
      root,
      'app/code/Acme/M/Model/Base.php',
      '<?php\nnamespace Acme\\M\\Model;\n\nclass Base\n{\n    public function save() { return 1; }\n}\n',
    );
    write(
      root,
      'app/code/Acme/M/Model/Child.php',
      '<?php\nnamespace Acme\\M\\Model;\n\nclass Child extends Base\n{\n    public function save() { return 2; }\n}\n',
    );
    write(
      root,
      'app/code/Acme/M/Plugin/BasePlugin.php',
      '<?php\nnamespace Acme\\M\\Plugin;\n\nclass BasePlugin\n{\n    public function beforeSave($subject) { return null; }\n}\n',
    );
  }

  const interceptedClasses = (cg: CodeGraph): string[] => {
    const plugin = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'beforeSave' && n.filePath.endsWith('Plugin/BasePlugin.php'));
    return cg
      .getNodesByKind('method')
      .filter((n) => n.name === 'save')
      .filter((n) =>
        cg
          .getOutgoingEdges(n.id)
          .some((e) => e.target === plugin!.id && e.metadata?.synthesizedBy === 'magento-plugin'),
      )
      .map((n) => path.basename(n.filePath));
  };

  it('wraps the subclass that overrides an intercepted method', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildHierarchy(tmpDir);

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(interceptedClasses(cg).sort()).toEqual(['Base.php', 'Child.php']);

    cg.close();
  }, 60_000);

  // The case a real store hits: the plugin targets a Magento core interface that
  // `vendor/` exclusion leaves out of the index, and the store's own class
  // implements it. The interface has no node, so the graph carries no
  // `implements` edge — the parent name has to come from the source.
  it('wraps a class whose intercepted ancestor is not indexed', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    write(tmpDir, 'composer.json', JSON.stringify({ require: { 'magento/product-community-edition': '2.4.7' } }));
    write(tmpDir, 'app/code/Acme/M/registration.php', '<?php\n');
    write(
      tmpDir,
      'app/code/Acme/M/etc/module.xml',
      '<?xml version="1.0"?>\n<config><module name="Acme_M"/></config>\n',
    );
    write(
      tmpDir,
      'app/code/Acme/M/etc/di.xml',
      `<?xml version="1.0"?>
<config>
    <type name="Magento\\Catalog\\Api\\ProductRepositoryInterface">
        <plugin name="acme_on_core" type="Acme\\M\\Plugin\\CorePlugin"/>
    </type>
</config>
`,
    );
    write(
      tmpDir,
      'app/code/Acme/M/Model/Repo.php',
      `<?php
namespace Acme\\M\\Model;

use Magento\\Catalog\\Api\\ProductRepositoryInterface;

class Repo implements ProductRepositoryInterface
{
    public function save($product) { return $product; }
}
`,
    );
    write(
      tmpDir,
      'app/code/Acme/M/Plugin/CorePlugin.php',
      `<?php
namespace Acme\\M\\Plugin;

class CorePlugin
{
    public function beforeSave($subject, $product) { return [$product]; }
}
`,
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const save = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'save' && n.filePath.endsWith('Model/Repo.php'));
    const plugin = cg
      .getNodesByKind('method')
      .find((n) => n.name === 'beforeSave' && n.filePath.endsWith('Plugin/CorePlugin.php'));
    expect(save, 'the store class is indexed').toBeDefined();

    expect(
      cg
        .getOutgoingEdges(save!.id)
        .some((e) => e.target === plugin!.id && e.metadata?.synthesizedBy === 'magento-plugin'),
      'the plugin on the unindexed interface reaches the class implementing it',
    ).toBe(true);

    cg.close();
  }, 60_000);

  it('reports only the declaring class when the project turns inheritance off', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-magento-'));
    buildHierarchy(tmpDir);
    write(tmpDir, 'codegraph.json', JSON.stringify({ magento: { inheritPlugins: false } }));

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(interceptedClasses(cg)).toEqual(['Base.php']);

    cg.close();
  }, 60_000);
});
