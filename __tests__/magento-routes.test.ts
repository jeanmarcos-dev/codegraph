/**
 * Entry-point config: webapi.xml, routes.xml, crontab.xml, queue_consumer.xml.
 *
 * Every one of these binds an externally-triggered entry point — a REST call, a
 * storefront URL, a schedule, a queue message — to a PHP class named only in
 * XML. Without them the handlers look like dead code: nothing in the source
 * calls them.
 *
 * The web API case matters most because its `<service class>` is nearly always
 * an interface, so the reference has to travel through the DI preference to
 * reach the class that really serves the endpoint.
 */
import { describe, it, expect } from 'vitest';
import {
  extractWebapiRoutes,
  extractFrontendRoutes,
  extractCronJobs,
  extractQueueConsumers,
} from '../src/resolution/frameworks/magento/config-xml';

describe('extractWebapiRoutes', () => {
  it('emits a route node per endpoint referencing its service method', () => {
    const { nodes, references } = extractWebapiRoutes(
      'app/code/Acme/Catalog/etc/webapi.xml',
      `<?xml version="1.0"?>
<routes>
    <route url="/V1/acme/stock/:sku" method="GET">
        <service class="Acme\\Catalog\\Api\\StockInterface" method="getQty"/>
        <resources>
            <resource ref="anonymous"/>
        </resources>
    </route>
</routes>`,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('GET /V1/acme/stock/:sku');
    expect(nodes[0]!.startLine).toBe(3);
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe('Acme\\Catalog\\Api\\StockInterface::getQty');
  });

  it('emits one node per method on the same url', () => {
    const { nodes } = extractWebapiRoutes(
      'app/code/Acme/M/etc/webapi.xml',
      `<routes>
    <route url="/V1/acme/items" method="GET">
        <service class="Acme\\Api\\ItemRepositoryInterface" method="getList"/>
    </route>
    <route url="/V1/acme/items" method="POST">
        <service class="Acme\\Api\\ItemRepositoryInterface" method="save"/>
    </route>
</routes>`,
    );
    expect(nodes.map((n) => n.name)).toEqual(['GET /V1/acme/items', 'POST /V1/acme/items']);
    expect(nodes[0]!.id).not.toBe(nodes[1]!.id);
  });

  it('ignores a route with no service', () => {
    const { nodes, references } = extractWebapiRoutes(
      'app/code/Acme/M/etc/webapi.xml',
      '<routes><route url="/V1/x" method="GET"/></routes>',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });
});

describe('extractFrontendRoutes', () => {
  it('emits a route node per front name and references the serving modules', () => {
    const { nodes, references } = extractFrontendRoutes(
      'app/code/Acme/Catalog/etc/frontend/routes.xml',
      `<?xml version="1.0"?>
<config>
    <router id="standard">
        <route id="acme_catalog" frontName="acmecatalog">
            <module name="Acme_Catalog"/>
        </route>
    </router>
</config>`,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('frontend /acmecatalog/*');
    expect(references.map((r) => r.referenceName)).toEqual(['magento:module:Acme_Catalog']);
  });

  it('labels an adminhtml route by its area', () => {
    const { nodes } = extractFrontendRoutes(
      'app/code/Acme/Catalog/etc/adminhtml/routes.xml',
      `<config>
    <router id="admin">
        <route id="acme_admin" frontName="acmeadmin">
            <module name="Acme_Catalog"/>
        </route>
    </router>
</config>`,
    );
    expect(nodes[0]!.name).toBe('adminhtml /acmeadmin/*');
  });

  it('ignores a route with no frontName', () => {
    const { nodes } = extractFrontendRoutes(
      'app/code/Acme/M/etc/frontend/routes.xml',
      '<config><router id="standard"><route id="x"/></router></config>',
    );
    expect(nodes).toHaveLength(0);
  });
});

describe('extractCronJobs', () => {
  it('emits a job node referencing the class it runs', () => {
    const { nodes, references } = extractCronJobs(
      'app/code/Acme/M/etc/crontab.xml',
      `<?xml version="1.0"?>
<config>
    <group id="default">
        <job name="acme_cleanup" instance="Acme\\M\\Cron\\Cleanup" method="execute">
            <schedule>0 3 * * *</schedule>
        </job>
    </group>
</config>`,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('cron acme_cleanup [0 3 * * *]');
    expect(references[0]!.referenceName).toBe('Acme\\M\\Cron\\Cleanup::execute');
  });

  it('names a job with no schedule element without a schedule suffix', () => {
    const { nodes } = extractCronJobs(
      'app/code/Acme/M/etc/crontab.xml',
      `<config><group id="default">
    <job name="acme_configurable" instance="Acme\\M\\Cron\\Run" method="execute"/>
</group></config>`,
    );
    expect(nodes[0]!.name).toBe('cron acme_configurable');
  });

  it('ignores a job with no instance', () => {
    const { nodes } = extractCronJobs(
      'app/code/Acme/M/etc/crontab.xml',
      '<config><group id="default"><job name="broken"/></group></config>',
    );
    expect(nodes).toHaveLength(0);
  });
});

describe('extractQueueConsumers', () => {
  it('emits a consumer node referencing its handler method', () => {
    const { nodes, references } = extractQueueConsumers(
      'app/code/Acme/M/etc/queue_consumer.xml',
      `<?xml version="1.0"?>
<config>
    <consumer name="acme.item.process" queue="acme.item" connection="amqp"
              handler="Acme\\M\\Model\\ItemConsumer::process"/>
</config>`,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('consumer acme.item.process');
    expect(references[0]!.referenceName).toBe('Acme\\M\\Model\\ItemConsumer::process');
  });

  it('ignores a consumer with no handler', () => {
    const { nodes } = extractQueueConsumers(
      'app/code/Acme/M/etc/queue_consumer.xml',
      '<config><consumer name="acme.noop" queue="q" connection="db"/></config>',
    );
    expect(nodes).toHaveLength(0);
  });
});
