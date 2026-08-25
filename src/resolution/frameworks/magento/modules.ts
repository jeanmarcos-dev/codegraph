/**
 * Magento module discovery and load order.
 *
 * Every Magento module is a directory with an `etc/module.xml` naming it
 * (`Vendor_Module`) and optionally declaring a `<sequence>` of modules it must
 * load after. That order is not cosmetic: it decides which `<preference>` wins
 * when several modules declare one for the same interface, so the whole DI
 * resolution downstream is only as correct as this ordering.
 *
 * The order Magento actually merges config in is NOT `sortBySequence`:
 * `Module\Dir\Reader::getFiles()` iterates `ModuleList::getNames()`, which is
 * `array_keys(array_filter($configData))` over `app/etc/config.php` — the
 * persisted key order, with disabled modules filtered out. So `config.php` is
 * read when present and its order is authoritative; `sortBySequence` is
 * reproduced only as the fallback for a tree that has none (a standalone module
 * repository, or a checkout that was never installed).
 *
 * `app/etc/config.php` is read by path, not through the index: `app/etc` also
 * holds `env.php`, which carries database credentials and is never read.
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

/** `app/etc/config.php`, relative to the project root. */
const MODULE_CONFIG_FILE = 'app/etc/config.php';

/**
 * The `modules` array of `app/etc/config.php`, in file order.
 *
 * Only the enabled/disabled flag and the key order are needed, so the array is
 * read with a scanner rather than a PHP parser: the file is generated, always
 * `'Vendor_Module' => 0|1` one per line inside a single `'modules' => [ … ]`.
 * Returns null when there is no such file — the caller then falls back to
 * `<sequence>` and says so.
 */
export function readModuleConfig(context: ResolutionContext): Map<string, boolean> | null {
  const content = context.readFile(MODULE_CONFIG_FILE);
  if (!content) return null;
  const block = /['"]modules['"]\s*=>\s*(?:array\s*\(|\[)([\s\S]*)/.exec(content);
  if (!block) return null;

  const entries = new Map<string, boolean>();
  const entry = /['"]([A-Za-z0-9]+_[A-Za-z0-9]+)['"]\s*=>\s*(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = entry.exec(block[1]!)) !== null) {
    entries.set(match[1]!, match[2] !== '0');
  }
  return entries.size > 0 ? entries : null;
}

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
 * Modules in load order, assigning each its `order`.
 *
 * With `app/etc/config.php` present, its key order IS the load order and a
 * module the file disables — or never lists — is dropped, matching what the
 * store really runs: a preference or plugin of a disabled module must not win a
 * merge Magento never performed. Modules on disk that the file does not mention
 * are treated as disabled, as Magento does.
 *
 * Without it, the fallback is a depth-first walk of `<sequence>` from an
 * alphabetical seed, so unrelated modules stay alphabetical and a sequence
 * cycle degrades to "some order" rather than hanging or dropping a module.
 */
export function sortModules(
  modules: Map<string, MagentoModule>,
  installed?: Map<string, boolean> | null,
): MagentoModule[] {
  if (installed) {
    const sorted: MagentoModule[] = [];
    for (const [name, enabled] of installed) {
      const module = modules.get(name);
      if (!module || !enabled) continue;
      module.order = sorted.length;
      sorted.push(module);
    }
    for (const name of [...modules.keys()]) {
      if (!installed.has(name)) modules.delete(name);
    }
    for (const [name, enabled] of installed) if (!enabled) modules.delete(name);
    return sorted;
  }
  return sortBySequence(modules);
}

function sortBySequence(modules: Map<string, MagentoModule>): MagentoModule[] {
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
