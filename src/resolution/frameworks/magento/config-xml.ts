/**
 * Magento's behavioural config XML: events, web API routes, frontend routes,
 * cron jobs and queue consumers.
 *
 * Each of these binds a name to a PHP class the source never references, so
 * without reading them the graph has no path from an event, URL, schedule or
 * queue message to the code that handles it.
 */

import type { Node } from '../../../types';
import type { UnresolvedRef } from '../../types';
import { parseXml, findAll, attr } from './xml';
import { MODULE_REF_PREFIX } from './names';

export interface XmlExtraction {
  nodes: Node[];
  references: UnresolvedRef[];
}

const EMPTY: XmlExtraction = { nodes: [], references: [] };

function syntheticNode(
  kind: Node['kind'],
  id: string,
  name: string,
  qualifiedName: string,
  filePath: string,
  line: number,
): Node {
  return {
    id,
    kind,
    name,
    qualifiedName,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn: 0,
    language: 'xml',
    updatedAt: Date.now(),
  };
}

function classReference(
  fromNodeId: string,
  target: string,
  filePath: string,
  line: number,
): UnresolvedRef {
  return {
    fromNodeId,
    referenceName: target,
    referenceKind: 'references',
    line,
    column: 0,
    filePath,
    language: 'xml',
  };
}

/**
 * `etc/events.xml` → one node per event, referencing each observer's method.
 *
 * The event gets its own node because the `dispatch()` that fires it normally
 * lives in `vendor/magento`, outside the default index — the node is what makes
 * "which observers run on this event" answerable anyway.
 */
export function extractEvents(filePath: string, content: string): XmlExtraction {
  const root = parseXml(content);
  if (!root) return EMPTY;

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  for (const event of findAll(root, 'event')) {
    const name = attr(event, 'name');
    if (!name) continue;

    const observers = findAll(event, 'observer').filter(
      (observer) => attr(observer, 'disabled') !== 'true' && attr(observer, 'instance'),
    );
    if (observers.length === 0) continue;

    const eventNode = syntheticNode(
      'function',
      `magento-event:${filePath}:${event.line}:${name}`,
      name,
      `${filePath}::event:${name}`,
      filePath,
      event.line,
    );
    nodes.push(eventNode);

    for (const observer of observers) {
      const instance = attr(observer, 'instance')!;
      const method = attr(observer, 'method') ?? 'execute';
      references.push(
        classReference(eventNode.id, `${instance}::${method}`, filePath, observer.line),
      );
    }
  }

  return { nodes, references };
}

/** The area segment of an `etc/<area>/<file>.xml` path, or `global`. */
export function areaOfConfigFile(filePath: string): string {
  return filePath.match(/(?:^|\/)etc\/(\w+)\/[\w.]+\.xml$/)?.[1] ?? 'global';
}

/**
 * `etc/webapi.xml` → one route node per endpoint.
 *
 * The `<service class>` is almost always an interface, so the reference is
 * emitted as `Class::method` and travels through the DI preference on the way
 * to the implementation that really serves the call.
 */
export function extractWebapiRoutes(filePath: string, content: string): XmlExtraction {
  const root = parseXml(content);
  if (!root) return EMPTY;

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  for (const route of findAll(root, 'route')) {
    const url = attr(route, 'url');
    const method = attr(route, 'method');
    if (!url || !method) continue;

    const service = findAll(route, 'service')[0];
    const serviceClass = service && attr(service, 'class');
    const serviceMethod = service && attr(service, 'method');
    if (!serviceClass || !serviceMethod) continue;

    const name = `${method.toUpperCase()} ${url}`;
    const routeNode = syntheticNode(
      'route',
      `magento-webapi:${filePath}:${route.line}:${method}:${url}`,
      name,
      `${filePath}::route:${method}:${url}`,
      filePath,
      route.line,
    );
    nodes.push(routeNode);
    references.push(
      classReference(routeNode.id, `${serviceClass}::${serviceMethod}`, filePath, service.line),
    );
  }

  return { nodes, references };
}

/**
 * `etc/<area>/routes.xml` → one node per front name.
 *
 * A front name is a URL prefix served by whichever modules declare it; the
 * actual action classes are found by convention under each module's
 * `Controller/` directory, which the `magento-controller` synthesis pass links
 * because it can see the whole file set.
 */
export function extractFrontendRoutes(filePath: string, content: string): XmlExtraction {
  const root = parseXml(content);
  if (!root) return EMPTY;

  const area = areaOfConfigFile(filePath);
  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  for (const route of findAll(root, 'route')) {
    const frontName = attr(route, 'frontName');
    if (!frontName) continue;

    const routeNode = syntheticNode(
      'route',
      `magento-route:${filePath}:${route.line}:${frontName}`,
      `${area} /${frontName}/*`,
      `${filePath}::route:${frontName}`,
      filePath,
      route.line,
    );
    nodes.push(routeNode);

    for (const module of findAll(route, 'module')) {
      const moduleName = attr(module, 'name');
      if (!moduleName) continue;
      references.push(
        classReference(routeNode.id, `${MODULE_REF_PREFIX}${moduleName}`, filePath, module.line),
      );
    }
  }

  return { nodes, references };
}

/** `etc/crontab.xml` → one node per scheduled job, referencing the class it runs. */
export function extractCronJobs(filePath: string, content: string): XmlExtraction {
  const root = parseXml(content);
  if (!root) return EMPTY;

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  for (const job of findAll(root, 'job')) {
    const name = attr(job, 'name');
    const instance = attr(job, 'instance');
    if (!name || !instance) continue;
    const method = attr(job, 'method') ?? 'execute';
    const schedule = findAll(job, 'schedule')[0]?.text;

    const jobNode = syntheticNode(
      'route',
      `magento-cron:${filePath}:${job.line}:${name}`,
      schedule ? `cron ${name} [${schedule}]` : `cron ${name}`,
      `${filePath}::cron:${name}`,
      filePath,
      job.line,
    );
    nodes.push(jobNode);
    references.push(classReference(jobNode.id, `${instance}::${method}`, filePath, job.line));
  }

  return { nodes, references };
}

/** `etc/queue_consumer.xml` → one node per consumer, referencing its handler. */
export function extractQueueConsumers(filePath: string, content: string): XmlExtraction {
  const root = parseXml(content);
  if (!root) return EMPTY;

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  for (const consumer of findAll(root, 'consumer')) {
    const name = attr(consumer, 'name');
    const handler = attr(consumer, 'handler');
    if (!name || !handler) continue;

    const consumerNode = syntheticNode(
      'route',
      `magento-consumer:${filePath}:${consumer.line}:${name}`,
      `consumer ${name}`,
      `${filePath}::consumer:${name}`,
      filePath,
      consumer.line,
    );
    nodes.push(consumerNode);
    references.push(classReference(consumerNode.id, handler, filePath, consumer.line));
  }

  return { nodes, references };
}

export interface FrontNameRoute {
  area: string;
  frontName: string;
  modules: string[];
  filePath: string;
  line: number;
}

/** Every front name declared by any `etc/<area>/routes.xml` in the project. */
export function collectFrontNames(
  files: string[],
  readFile: (filePath: string) => string | null,
): FrontNameRoute[] {
  const out: FrontNameRoute[] = [];
  for (const filePath of files) {
    if (!/(^|\/)etc\/(?:\w+\/)?routes\.xml$/.test(filePath)) continue;
    const content = readFile(filePath);
    if (!content) continue;
    const root = parseXml(content);
    if (!root) continue;

    for (const route of findAll(root, 'route')) {
      const frontName = attr(route, 'frontName');
      if (!frontName) continue;
      out.push({
        area: areaOfConfigFile(filePath),
        frontName,
        modules: findAll(route, 'module')
          .map((m) => attr(m, 'name'))
          .filter((n): n is string => !!n),
        filePath,
        line: route.line,
      });
    }
  }
  return out;
}
