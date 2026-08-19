/**
 * Layout XML, templates and UI components.
 *
 * A `.phtml` template calls `$block->getFoo()` and `$viewModel->bar()` on
 * objects it never declares. What supplies them is a layout XML file elsewhere
 * in the module — or a theme file overriding it — which names the block class
 * and the template in the same element. Without reading it, block classes and
 * view models have no callers at all and a template has no visible source of
 * data.
 *
 * Template references are emitted with a `magento:template:` prefix and
 * resolved later, because turning `Vendor_Module::path/file.phtml` into a real
 * path needs the module list and the file set, which per-file extraction does
 * not have.
 */

import type { Node } from '../../../types';
import type { UnresolvedRef } from '../../types';
import { parseXml, findAll, findChildren, attr, type XmlElement } from './xml';
import { normalizeClassName } from './di';
import { TEMPLATE_REF_PREFIX, shortClassName } from './names';
import type { XmlExtraction } from './config-xml';

const EMPTY: XmlExtraction = { nodes: [], references: [] };

const LAYOUT_PATH_RE = /(^|\/)view\/\w+\/layout(?:_override)?\/.+\.xml$|\/\w+_\w+\/layout\/.+\.xml$/;
const UI_COMPONENT_PATH_RE = /(^|\/)view\/\w+\/ui_component\/[^/]+\.xml$/;

function reference(
  fromNodeId: string,
  referenceName: string,
  filePath: string,
  line: number,
): UnresolvedRef {
  return {
    fromNodeId,
    referenceName,
    referenceKind: 'references',
    line,
    column: 0,
    filePath,
    language: 'xml',
  };
}

function componentNode(
  id: string,
  name: string,
  qualifiedName: string,
  filePath: string,
  line: number,
): Node {
  return {
    id,
    kind: 'component',
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

/** `<argument name="X" xsi:type="object">Class</argument>` values under an element. */
function objectArguments(owner: XmlElement): Array<{ value: string; line: number }> {
  const out: Array<{ value: string; line: number }> = [];
  for (const argumentsEl of findChildren(owner, 'arguments')) {
    for (const argument of findChildren(argumentsEl, 'argument')) {
      if (attr(argument, 'xsi:type') !== 'object') continue;
      const value = normalizeClassName(argument.text);
      if (value) out.push({ value, line: argument.line });
    }
  }
  return out;
}

/** Template set through `<action method="setTemplate">` on a referenced block. */
function actionTemplate(owner: XmlElement): { value: string; line: number } | null {
  for (const action of findChildren(owner, 'action')) {
    if (attr(action, 'method') !== 'setTemplate') continue;
    for (const argument of findAll(action, 'argument')) {
      if (attr(argument, 'name') !== 'template') continue;
      const value = argument.text.trim();
      if (value) return { value, line: argument.line };
    }
  }
  return null;
}

/** `view/<area>/layout/*.xml` → one node per block, linked to class, template and view models. */
export function extractLayout(filePath: string, content: string): XmlExtraction {
  if (!LAYOUT_PATH_RE.test(filePath)) return EMPTY;
  const root = parseXml(content);
  if (!root) return EMPTY;

  const nodes: Node[] = [];
  const references: UnresolvedRef[] = [];

  const addBlock = (element: XmlElement, requireTarget: boolean): void => {
    const className = attr(element, 'class');
    const template = attr(element, 'template');
    const setTemplate = actionTemplate(element);
    const viewModels = objectArguments(element);
    if (requireTarget && !className && !template && !setTemplate && viewModels.length === 0) return;

    const name = attr(element, 'name') ?? (className ? shortClassName(className) : null);
    if (!name) return;

    const node = componentNode(
      `magento-block:${filePath}:${element.line}:${name}`,
      name,
      `${filePath}::block:${name}`,
      filePath,
      element.line,
    );
    nodes.push(node);

    if (className) {
      references.push(reference(node.id, normalizeClassName(className), filePath, element.line));
    }
    if (template) {
      references.push(
        reference(node.id, `${TEMPLATE_REF_PREFIX}${template}`, filePath, element.line),
      );
    }
    if (setTemplate) {
      references.push(
        reference(node.id, `${TEMPLATE_REF_PREFIX}${setTemplate.value}`, filePath, setTemplate.line),
      );
    }
    for (const viewModel of viewModels) {
      references.push(reference(node.id, viewModel.value, filePath, viewModel.line));
    }
  };

  for (const block of findAll(root, 'block')) addBlock(block, true);
  for (const referenceBlock of findAll(root, 'referenceBlock')) addBlock(referenceBlock, true);

  return { nodes, references };
}

/** `Vendor_Module::path/file.phtml` → the indexed file that renders it. */
export type TemplateIndex = Map<string, string>;

/**
 * `.twig` is here because MageObsidian registers a Twig engine alongside
 * `.phtml`; a module or theme running it declares its templates the same way.
 */
const TEMPLATE_EXTENSIONS = ['.phtml', '.twig'];

const THEME_TEMPLATE_RE = /^app\/design\/[^/]+\/[^/]+\/[^/]+\/(\w+_\w+)\/templates\/(.+)$/;
const MODULE_TEMPLATE_RE = /^view\/[^/]+\/templates\/(.+)$/;

/**
 * Index every `.phtml` by its `Vendor_Module::relative/path` id.
 *
 * Built once per project: resolving each template by scanning the file list
 * would be O(templates × files), and a store has thousands of both. A theme
 * override wins over the module's own copy — Magento's resolution order, and
 * the override is the file that actually renders.
 */
export function buildTemplateIndex(
  modulePaths: Map<string, string>,
  files: string[],
): TemplateIndex {
  const byPathLength = [...modulePaths].sort((a, b) => b[1].length - a[1].length);
  const index: TemplateIndex = new Map();
  const overrides = new Set<string>();

  for (const filePath of files) {
    if (!TEMPLATE_EXTENSIONS.some((ext) => filePath.endsWith(ext))) continue;

    const theme = filePath.match(THEME_TEMPLATE_RE);
    if (theme) {
      const key = `${theme[1]!}::${theme[2]!}`;
      index.set(key, filePath);
      overrides.add(key);
      continue;
    }

    const owner = byPathLength.find(
      ([, path]) => path === '' || filePath.startsWith(`${path}/`),
    );
    if (!owner) continue;
    const withinModule = owner[1] === '' ? filePath : filePath.slice(owner[1].length + 1);
    const relative = withinModule.match(MODULE_TEMPLATE_RE);
    if (!relative) continue;
    const key = `${owner[0]}::${relative[1]!}`;
    if (!overrides.has(key)) index.set(key, filePath);
  }

  return index;
}

/** Look a template id up in a prebuilt index. */
export function lookupTemplate(index: TemplateIndex, templateId: string): string | null {
  const separator = templateId.indexOf('::');
  if (separator < 0) return null;
  const key = `${templateId.slice(0, separator).trim()}::${templateId.slice(separator + 2).trim()}`;
  return index.get(key) ?? null;
}

/** Resolve one template id without a prebuilt index; prefer the index on hot paths. */
export function resolveTemplatePath(
  templateId: string,
  modulePaths: Map<string, string>,
  files: string[],
): string | null {
  const separator = templateId.indexOf('::');
  if (separator < 0) return null;
  if (!modulePaths.has(templateId.slice(0, separator).trim())) return null;
  return lookupTemplate(buildTemplateIndex(modulePaths, files), templateId);
}

const UI_CLASS_RE = /^[A-Z][\w]*(\\[A-Z][\w]*)+$/;

/** `view/<area>/ui_component/*.xml` → one node per component, linked to the PHP classes it wires. */
export function extractUiComponent(filePath: string, content: string): XmlExtraction {
  if (!UI_COMPONENT_PATH_RE.test(filePath)) return EMPTY;
  const root = parseXml(content);
  if (!root) return EMPTY;

  const name = filePath.slice(filePath.lastIndexOf('/') + 1, -'.xml'.length);
  const node = componentNode(
    `magento-ui:${filePath}:${root.line}:${name}`,
    name,
    `${filePath}::ui:${name}`,
    filePath,
    root.line,
  );

  const references: UnresolvedRef[] = [];
  const seen = new Set<string>();
  const addClass = (value: string | undefined, line: number): void => {
    if (!value) return;
    const className = normalizeClassName(value);
    if (!UI_CLASS_RE.test(className) || seen.has(className)) return;
    seen.add(className);
    references.push(reference(node.id, className, filePath, line));
  };

  const walk = (element: XmlElement): void => {
    addClass(element.attrs.class, element.line);
    if (element.name === 'argument' && attr(element, 'name') === 'class') {
      addClass(element.text, element.line);
    }
    if (element.name === 'item' && attr(element, 'name') === 'class') {
      addClass(element.text, element.line);
    }
    for (const child of element.children) walk(child);
  };
  walk(root);

  if (references.length === 0) return EMPTY;
  return { nodes: [node], references };
}
