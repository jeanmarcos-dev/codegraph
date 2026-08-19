/**
 * Magento module discovery and load order.
 *
 * Every Magento module is a directory with an `etc/module.xml` naming it
 * (`Vendor_Module`) and optionally declaring a `<sequence>` of modules it must
 * load after. That order is not cosmetic: it decides which `<preference>` wins
 * when several modules declare one for the same interface, so the whole DI
 * resolution downstream is only as correct as this ordering.
 *
 * Magento's own `ModuleList\Loader::sortBySequence` is a depth-first walk over
 * an alphabetically-keyed module list, which is what `sortModules` reproduces —
 * including tolerating a sequence entry naming a module that isn't present
 * (normal here: with `vendor/` unindexed, most sequence targets are absent).
 */

import type { ResolutionContext } from '../../types';
import { parseXml, findAll, attr } from './xml';

export interface MagentoModule {
  /** `Vendor_Module`. */
  name: string;
  /** Module root, relative to the project root (the parent of `etc/`). */
  path: string;
  /** Module names declared in `<sequence>`; may name modules that aren't indexed. */
  sequence: string[];
  /** Load-order index, assigned by `sortModules`. */
  order: number;
}

/**
 * A module is normally a subdirectory, but a distributable module developed as
 * its own repository puts `etc/module.xml` at the root — so the leading slash
 * has to be optional everywhere a Magento path is matched.
 */
const MODULE_XML_RE = /(^|\/)etc\/module\.xml$/;

/** Every module with an `etc/module.xml` in the indexed file set, keyed by name. */
export function discoverModules(context: ResolutionContext): Map<string, MagentoModule> {
  const modules = new Map<string, MagentoModule>();

  for (const filePath of context.getAllFiles()) {
    const moduleXmlMatch = filePath.match(MODULE_XML_RE);
    if (!moduleXmlMatch) continue;
    const content = context.readFile(filePath);
    if (!content) continue;

    const root = parseXml(content);
    if (!root) continue;
    const moduleEl = root.name === 'module' ? root : findAll(root, 'module')[0];
    const name = moduleEl && attr(moduleEl, 'name');
    if (!name) continue;

    const sequence = findAll(moduleEl!, 'module')
      .map((m) => attr(m, 'name'))
      .filter((n): n is string => !!n && n !== name);

    modules.set(name, {
      name,
      path: filePath.slice(0, filePath.length - moduleXmlMatch[0].length),
      sequence,
      order: 0,
    });
  }

  return modules;
}

/**
 * Modules in load order, assigning each its `order`. Depth-first over
 * `<sequence>` from an alphabetical seed, so unrelated modules stay
 * alphabetical and a sequence cycle degrades to "some order" rather than
 * hanging or dropping a module.
 */
export function sortModules(modules: Map<string, MagentoModule>): MagentoModule[] {
  const sorted: MagentoModule[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (name: string): void => {
    if (state.has(name)) return;
    const module = modules.get(name);
    if (!module) return;
    state.set(name, 'visiting');
    for (const dep of module.sequence) {
      if (state.get(dep) !== 'visiting') visit(dep);
    }
    state.set(name, 'done');
    module.order = sorted.length;
    sorted.push(module);
  };

  for (const name of [...modules.keys()].sort()) visit(name);
  return sorted;
}

/** The module owning `filePath`, or null when it belongs to none. */
export function moduleOf(
  filePath: string,
  modules: Map<string, MagentoModule>,
): MagentoModule | null {
  let best: MagentoModule | null = null;
  for (const module of modules.values()) {
    const owns =
      module.path === ''
        ? true
        : filePath === module.path || filePath.startsWith(`${module.path}/`);
    if (!owns) continue;
    if (!best || module.path.length > best.path.length) best = module;
  }
  return best;
}

/** `filePath` relative to its module root. */
export function pathWithinModule(filePath: string, module: MagentoModule): string {
  return module.path === '' ? filePath : filePath.slice(module.path.length + 1);
}
