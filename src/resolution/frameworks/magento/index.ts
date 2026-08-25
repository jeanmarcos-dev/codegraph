/**
 * Magento 2 / Adobe Commerce framework resolver.
 *
 * Magento decides what runs in XML, not in PHP: `di.xml` swaps interfaces for
 * implementations and wraps methods with plugins, `events.xml` binds observers
 * to string event names, `webapi.xml` and `routes.xml` bind URLs to service
 * classes, and layout XML binds block classes to `.phtml` templates. A
 * tree-sitter pass sees none of it, so this resolver reads the configuration
 * and the synthesizer passes in `resolution/magento-synthesizer.ts` turn it
 * into edges.
 *
 * This file owns detection, the config-driven `resolve()`, and the per-file
 * `extract()` that turns Magento XML into nodes and references.
 */

import type { Node } from '../../../types';
import type {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../../types';
import { parseXml, findAll, findChildren, attr } from './xml';
import {
  extractEvents,
  extractWebapiRoutes,
  extractFrontendRoutes,
  extractCronJobs,
  extractQueueConsumers,
} from './config-xml';
import { extractLayout, extractUiComponent, lookupTemplate } from './layout';
import { getMagentoProject } from './config';
import { resolveType } from './di';
import {
  fqcnToQualifiedName,
  looksLikeFqcn,
  stripGeneratedSuffix,
  MODULE_REF_PREFIX,
  TYPE_REF_PREFIX,
  TEMPLATE_REF_PREFIX,
} from './names';

const COMPOSER_MARKERS = [
  'magento/product-community-edition',
  'magento/product-enterprise-edition',
  'magento/magento2-base',
  'magento/framework',
];

const COMPOSER_TYPES = ['magento2-module', 'magento2-theme', 'magento2-language', 'magento2-component'];

/** Config files live at `etc/<file>.xml` or, per area, `etc/<area>/<file>.xml`. */
const CONFIG_XML_RE = {
  module: /(^|\/)etc\/module\.xml$/,
  di: /(^|\/)etc\/(?:\w+\/)?di\.xml$/,
  events: /(^|\/)etc\/(?:\w+\/)?events\.xml$/,
  webapi: /(^|\/)etc\/(?:\w+\/)?webapi\.xml$/,
  routes: /(^|\/)etc\/(?:\w+\/)?routes\.xml$/,
  crontab: /(^|\/)etc\/(?:\w+\/)?crontab\.xml$/,
  queueConsumer: /(^|\/)etc\/(?:\w+\/)?queue_consumer\.xml$/,
};

function detectFromComposer(context: ResolutionContext): boolean {
  const composer = context.readFile('composer.json');
  if (!composer) return false;
  try {
    const json = JSON.parse(composer) as {
      type?: string;
      require?: Record<string, string>;
      'require-dev'?: Record<string, string>;
    };
    if (typeof json.type === 'string' && COMPOSER_TYPES.includes(json.type)) return true;
    const deps = { ...json.require, ...(json['require-dev'] ?? {}) };
    return Object.keys(deps).some((dep) => COMPOSER_MARKERS.includes(dep));
  } catch {
    return false;
  }
}

/**
 * A Magento module is a directory holding both `registration.php` and
 * `etc/module.xml`. Requiring both keeps an unrelated `etc/module.xml` from
 * triggering the whole resolver.
 */
function detectFromModuleLayout(context: ResolutionContext): boolean {
  for (const filePath of context.getAllFiles()) {
    const match = filePath.match(CONFIG_XML_RE.module);
    if (!match) continue;
    const moduleRoot = filePath.slice(0, filePath.length - match[0].length);
    const registration = moduleRoot ? `${moduleRoot}/registration.php` : 'registration.php';
    if (context.fileExists(registration)) return true;
  }
  return false;
}

/**
 * `<virtualType>` — a configured alias for a real class.
 *
 * A virtual type is named all over `di.xml` and injected like a class, but it
 * exists nowhere on disk, so searching for one found nothing and the argument
 * that injects it pointed at a name the graph did not contain. Each gets a
 * `type_alias` node referencing the type it configures — the same shape a
 * language-level alias gets.
 */
function virtualTypeNodes(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedRef[] } {
  const root = parseXml(content);
  if (!root) return { nodes: [], references: [] };

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];
  for (const virtualType of findChildren(root, 'virtualType')) {
    const name = attr(virtualType, 'name');
    if (!name) continue;
    const node: Node = {
      id: `magento-virtualtype:${filePath}:${virtualType.line}:${name}`,
      kind: 'type_alias',
      name,
      qualifiedName: name,
      filePath,
      startLine: virtualType.line,
      endLine: virtualType.line,
      startColumn: 0,
      endColumn: 0,
      language: 'xml',
      updatedAt: Date.now(),
    };
    nodes.push(node);

    const base = attr(virtualType, 'type');
    if (base) {
      references.push({
        fromNodeId: node.id,
        referenceName: base,
        referenceKind: 'references',
        line: virtualType.line,
        column: 0,
        filePath,
        language: 'xml',
      });
    }
  }
  return { nodes, references };
}

function moduleNodes(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
  const root = parseXml(content);
  if (!root) return { nodes: [], references: [] };
  const moduleEl = root.name === 'module' ? root : findAll(root, 'module')[0];
  const name = moduleEl && attr(moduleEl, 'name');
  if (!moduleEl || !name) return { nodes: [], references: [] };

  const moduleNode: Node = {
    id: `magento-module:${name}`,
    kind: 'module',
    name,
    qualifiedName: name,
    filePath,
    startLine: moduleEl.line,
    endLine: moduleEl.line,
    startColumn: 0,
    endColumn: 0,
    language: 'xml',
    updatedAt: Date.now(),
  };

  const references: UnresolvedRef[] = [];
  for (const dependency of findAll(moduleEl, 'module')) {
    const dependencyName = attr(dependency, 'name');
    if (!dependencyName || dependencyName === name) continue;
    references.push({
      fromNodeId: moduleNode.id,
      referenceName: `${MODULE_REF_PREFIX}${dependencyName}`,
      referenceKind: 'references',
      line: dependency.line,
      column: 0,
      filePath,
      language: 'xml',
    });
  }

  return { nodes: [moduleNode], references };
}

/** The node for a Magento type name, after preferences and virtual types. */
function resolveTypeNode(
  context: ResolutionContext,
  fqcn: string,
  methodName?: string,
): Node | null {
  const { config } = getMagentoProject(context);
  const resolved = resolveType(config, fqcn);
  const candidates = [resolved, fqcn.replace(/^\\+/, '')];
  const generated = stripGeneratedSuffix(resolved);
  if (generated) candidates.push(resolveType(config, generated.base));

  for (const candidate of candidates) {
    const qualifiedName = fqcnToQualifiedName(candidate);
    if (methodName) {
      const method = context
        .getNodesByQualifiedName(`${qualifiedName}::${methodName}`)
        .find((n) => n.kind === 'method');
      if (method) return method;
    }
    const type = context
      .getNodesByQualifiedName(qualifiedName)
      .find((n) => n.kind === 'class' || n.kind === 'interface');
    if (type) return type;
  }

  return null;
}

export const magentoResolver: FrameworkResolver = {
  name: 'magento',
  languages: ['php', 'xml'],

  detect(context: ResolutionContext): boolean {
    return detectFromComposer(context) || detectFromModuleLayout(context);
  },

  claimsReference(name: string): boolean {
    return (
      name.startsWith(MODULE_REF_PREFIX) ||
      name.startsWith(TYPE_REF_PREFIX) ||
      name.startsWith(TEMPLATE_REF_PREFIX) ||
      looksLikeFqcn(name)
    );
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;

    if (name.startsWith(MODULE_REF_PREFIX)) {
      const moduleName = name.slice(MODULE_REF_PREFIX.length);
      const moduleNode = context
        .getNodesByQualifiedName(moduleName)
        .find((n) => n.kind === 'module');
      return moduleNode
        ? { original: ref, targetNodeId: moduleNode.id, confidence: 0.95, resolvedBy: 'framework' }
        : null;
    }

    if (name.startsWith(TEMPLATE_REF_PREFIX)) {
      const { templates } = getMagentoProject(context);
      const templatePath = lookupTemplate(templates, name.slice(TEMPLATE_REF_PREFIX.length));
      if (!templatePath) return null;
      const fileNode = context.getNodesInFile(templatePath).find((n) => n.kind === 'file');
      return fileNode
        ? { original: ref, targetNodeId: fileNode.id, confidence: 0.9, resolvedBy: 'framework' }
        : null;
    }

    const typeName = name.startsWith(TYPE_REF_PREFIX) ? name.slice(TYPE_REF_PREFIX.length) : name;
    if (typeName === name && !looksLikeFqcn(typeName)) return null;

    const methodSeparator = typeName.lastIndexOf('::');
    const fqcn = methodSeparator >= 0 ? typeName.slice(0, methodSeparator) : typeName;
    const methodName = methodSeparator >= 0 ? typeName.slice(methodSeparator + 2) : undefined;

    const target = resolveTypeNode(context, fqcn, methodName);
    if (!target) return null;
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: target.kind === 'method' ? 0.95 : 0.9,
      resolvedBy: 'framework',
    };
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedRef[] } {
    if (!filePath.endsWith('.xml')) return { nodes: [], references: [] };
    if (CONFIG_XML_RE.module.test(filePath)) return moduleNodes(filePath, content);
    if (CONFIG_XML_RE.events.test(filePath)) return extractEvents(filePath, content);
    if (CONFIG_XML_RE.webapi.test(filePath)) return extractWebapiRoutes(filePath, content);
    if (CONFIG_XML_RE.routes.test(filePath)) return extractFrontendRoutes(filePath, content);
    if (CONFIG_XML_RE.crontab.test(filePath)) return extractCronJobs(filePath, content);
    if (CONFIG_XML_RE.queueConsumer.test(filePath)) return extractQueueConsumers(filePath, content);
    if (CONFIG_XML_RE.di.test(filePath)) return virtualTypeNodes(filePath, content);

    const layout = extractLayout(filePath, content);
    if (layout.nodes.length > 0) return layout;
    return extractUiComponent(filePath, content);
  },
};

export { getMagentoProject, clearMagentoConfigCache } from './config';
