/**
 * `di.xml` parsing and merge — the table that says what Magento actually runs.
 *
 * Magento never instantiates the class a type hint names. It resolves it
 * through the merged object-manager configuration:
 *
 *   1. `<preference for type>` replaces an interface (or class) with another
 *      class. Declarations are merged in module load order, so the module that
 *      loads LAST wins, and preferences chain.
 *   2. `<virtualType name type>` declares a configured alias — a real class
 *      plus its own constructor arguments, usable anywhere a class name is.
 *   3. `<plugin>` registers a before/around/after interceptor on a type. Plugins
 *      accumulate across modules keyed by plugin NAME, which is how a later
 *      module disables (`disabled="true"`) or re-points an inherited one, and
 *      run ordered by `sortOrder`.
 *   4. `<argument xsi:type="object">` pins one constructor injection point to a
 *      specific class, overriding the preference for that argument only. Array
 *      arguments carry `<item xsi:type="object">` entries — how every Magento
 *      composite/pool gets its members.
 *
 * Area config (`etc/frontend/di.xml`, `etc/adminhtml/di.xml`, …) is global
 * config plus that area's overrides, so a frontend preference must never be
 * reported for adminhtml. Everything here is derived from the file set alone,
 * so it works the same on a full store and on a single standalone module.
 */

import type { ResolutionContext } from '../../types';
import { parseXml, findAll, findChildren, attr, type XmlElement } from './xml';
import { moduleOf, pathWithinModule, type MagentoModule } from './modules';

export const GLOBAL_AREA = 'global';

/** Areas Magento loads `etc/<area>/di.xml` for. */
export const DI_AREAS = [
  'frontend',
  'adminhtml',
  'webapi_rest',
  'webapi_soap',
  'graphql',
  'crontab',
  'cron',
  'admin',
] as const;

export interface DeclarationSite {
  filePath: string;
  line: number;
  area: string;
}

export interface MagentoPreference extends DeclarationSite {
  for: string;
  type: string;
}

export interface MagentoVirtualType extends DeclarationSite {
  name: string;
  type: string;
}

export interface MagentoPlugin extends DeclarationSite {
  /** Plugin name within the target — the key later modules use to override it. */
  name: string;
  /** Target the plugin is declared on. */
  target: string;
  /** Plugin class FQCN. */
  type: string;
  sortOrder: number;
  disabled: boolean;
}

/**
 * A plugin as declared, before merging. `sortOrder` stays undefined when the
 * declaration omits it, so a later re-declaration inherits the earlier order
 * instead of silently resetting it to zero.
 */
interface PluginDeclaration extends Omit<MagentoPlugin, 'sortOrder'> {
  sortOrder?: number;
}

export interface MagentoObjectArgument extends DeclarationSite {
  /** Target type the argument is declared on. */
  target: string;
  /** Constructor argument name. */
  name: string;
  /** Class or virtual-type name being injected. */
  value: string;
  /** Key of the `<item>` inside an array argument, when the value came from one. */
  itemName?: string;
}

export interface MagentoConfig {
  /** area → interface/class → winning preference. */
  preferences: Map<string, Map<string, MagentoPreference>>;
  /** area → virtual type name → declaration. */
  virtualTypes: Map<string, Map<string, MagentoVirtualType>>;
  /** area → target → plugin name → declaration. */
  plugins: Map<string, Map<string, Map<string, PluginDeclaration>>>;
  /** area → target → object arguments. */
  objectArguments: Map<string, Map<string, MagentoObjectArgument[]>>;
}

/** Strip the leading backslash Magento config uses inconsistently. */
export function normalizeClassName(name: string): string {
  return name.replace(/^\\+/, '').trim();
}

function emptyConfig(): MagentoConfig {
  return {
    preferences: new Map(),
    virtualTypes: new Map(),
    plugins: new Map(),
    objectArguments: new Map(),
  };
}

function areaMap<T>(outer: Map<string, Map<string, T>>, area: string): Map<string, T> {
  let inner = outer.get(area);
  if (!inner) {
    inner = new Map();
    outer.set(area, inner);
  }
  return inner;
}

/** The area a di.xml path belongs to: `etc/di.xml` is global, `etc/<area>/di.xml` is that area. */
export function areaOfDiFile(filePath: string, modulePath: string): string | null {
  const relative = pathWithinModule(filePath, { name: '', path: modulePath, sequence: [], order: 0 });
  if (relative === 'etc/di.xml') return GLOBAL_AREA;
  const match = relative.match(/^etc\/([\w]+)\/di\.xml$/);
  return match ? match[1]! : null;
}

function collectObjectArguments(
  owner: XmlElement,
  target: string,
  site: Omit<DeclarationSite, 'line'>,
): MagentoObjectArgument[] {
  const out: MagentoObjectArgument[] = [];
  for (const argumentsEl of findChildren(owner, 'arguments')) {
    for (const argument of findChildren(argumentsEl, 'argument')) {
      const name = attr(argument, 'name');
      if (!name) continue;
      const xsiType = attr(argument, 'xsi:type');
      if (xsiType === 'object') {
        const value = normalizeClassName(argument.text);
        if (value) out.push({ ...site, line: argument.line, target, name, value });
        continue;
      }
      for (const item of findAll(argument, 'item')) {
        if (attr(item, 'xsi:type') !== 'object') continue;
        const value = normalizeClassName(item.text);
        if (!value) continue;
        out.push({
          ...site,
          line: item.line,
          target,
          name,
          value,
          itemName: attr(item, 'name'),
        });
      }
    }
  }
  return out;
}

function collectPlugins(
  owner: XmlElement,
  target: string,
  site: Omit<DeclarationSite, 'line'>,
): PluginDeclaration[] {
  const out: PluginDeclaration[] = [];
  for (const plugin of findChildren(owner, 'plugin')) {
    const name = attr(plugin, 'name');
    if (!name) continue;
    const rawSortOrder = attr(plugin, 'sortOrder');
    const sortOrder = rawSortOrder === undefined ? undefined : Number(rawSortOrder);
    out.push({
      ...site,
      line: plugin.line,
      target,
      name,
      type: normalizeClassName(attr(plugin, 'type') ?? ''),
      sortOrder: sortOrder !== undefined && Number.isFinite(sortOrder) ? sortOrder : undefined,
      disabled: attr(plugin, 'disabled') === 'true',
    });
  }
  return out;
}

function mergeDiFile(
  config: MagentoConfig,
  content: string,
  filePath: string,
  area: string,
): void {
  const root = parseXml(content);
  if (!root) return;
  const site = { filePath, area };

  for (const preference of findChildren(root, 'preference')) {
    const forName = attr(preference, 'for');
    const type = attr(preference, 'type');
    if (!forName || !type) continue;
    areaMap(config.preferences, area).set(normalizeClassName(forName), {
      ...site,
      line: preference.line,
      for: normalizeClassName(forName),
      type: normalizeClassName(type),
    });
  }

  for (const virtualType of findChildren(root, 'virtualType')) {
    const name = attr(virtualType, 'name');
    if (!name) continue;
    const type = attr(virtualType, 'type');
    if (type) {
      areaMap(config.virtualTypes, area).set(normalizeClassName(name), {
        ...site,
        line: virtualType.line,
        name: normalizeClassName(name),
        type: normalizeClassName(type),
      });
    }
    mergeTargetBody(config, virtualType, normalizeClassName(name), site);
  }

  for (const type of findChildren(root, 'type')) {
    const name = attr(type, 'name');
    if (!name) continue;
    mergeTargetBody(config, type, normalizeClassName(name), site);
  }
}

function mergeTargetBody(
  config: MagentoConfig,
  owner: XmlElement,
  target: string,
  site: Omit<DeclarationSite, 'line'>,
): void {
  const byTarget = areaMap(config.plugins, site.area);
  for (const plugin of collectPlugins(owner, target, site)) {
    let byName = byTarget.get(target);
    if (!byName) {
      byName = new Map();
      byTarget.set(target, byName);
    }
    const existing = byName.get(plugin.name);
    byName.set(
      plugin.name,
      existing
        ? {
            ...existing,
            type: plugin.type || existing.type,
            sortOrder: plugin.sortOrder ?? existing.sortOrder,
            disabled: plugin.disabled,
            filePath: plugin.filePath,
            line: plugin.line,
          }
        : plugin,
    );
  }

  const args = collectObjectArguments(owner, target, site);
  if (args.length === 0) return;
  const argsByTarget = areaMap(config.objectArguments, site.area);
  const existing = argsByTarget.get(target);
  if (existing) existing.push(...args);
  else argsByTarget.set(target, args);
}

/**
 * Read every module's `di.xml` in load order and merge it into one config.
 * Global files are merged first across all modules, then each area's files, so
 * area config layers on top of global exactly as Magento loads it.
 */
export function buildDiConfig(
  context: ResolutionContext,
  modules: Map<string, MagentoModule>,
): MagentoConfig {
  const config = emptyConfig();

  const diFiles: Array<{ filePath: string; area: string; order: number }> = [];
  for (const filePath of context.getAllFiles()) {
    if (!/(^|\/)di\.xml$/.test(filePath)) continue;
    const owner = moduleOf(filePath, modules);
    if (!owner) continue;
    const area = areaOfDiFile(filePath, owner.path);
    if (!area) continue;
    diFiles.push({ filePath, area, order: owner.order });
  }

  const merge = (predicate: (area: string) => boolean): void => {
    for (const file of diFiles.filter((f) => predicate(f.area)).sort((a, b) => a.order - b.order)) {
      const content = context.readFile(file.filePath);
      if (content) mergeDiFile(config, content, file.filePath, file.area);
    }
  };

  merge((area) => area === GLOBAL_AREA);
  for (const area of DI_AREAS) merge((a) => a === area);

  return config;
}

const MAX_CHAIN = 16;

function preferenceEntry(
  config: MagentoConfig,
  name: string,
  area: string,
): MagentoPreference | undefined {
  return (
    (area !== GLOBAL_AREA ? config.preferences.get(area)?.get(name) : undefined) ??
    config.preferences.get(GLOBAL_AREA)?.get(name)
  );
}

/**
 * The class Magento instantiates for `name` in `area`, following the
 * preference chain. Returns `name` itself when nothing overrides it.
 */
export function resolvePreference(
  config: MagentoConfig,
  name: string,
  area: string = GLOBAL_AREA,
): string {
  let current = normalizeClassName(name);
  const seen = new Set<string>([current]);
  for (let i = 0; i < MAX_CHAIN; i++) {
    const next = preferenceEntry(config, current, area)?.type;
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

/** The declaration site of the preference that wins for `name`, when there is one. */
export function preferenceSite(
  config: MagentoConfig,
  name: string,
  area: string = GLOBAL_AREA,
): MagentoPreference | undefined {
  return preferenceEntry(config, normalizeClassName(name), area);
}

function virtualTypeEntry(
  config: MagentoConfig,
  name: string,
  area: string,
): MagentoVirtualType | undefined {
  return (
    (area !== GLOBAL_AREA ? config.virtualTypes.get(area)?.get(name) : undefined) ??
    config.virtualTypes.get(GLOBAL_AREA)?.get(name)
  );
}

/**
 * The concrete class behind any Magento type name: unwraps virtual types and
 * applies preferences, in either order, until it reaches a real class name.
 */
export function resolveType(
  config: MagentoConfig,
  name: string,
  area: string = GLOBAL_AREA,
): string {
  let current = normalizeClassName(name);
  const seen = new Set<string>([current]);
  for (let i = 0; i < MAX_CHAIN; i++) {
    const virtual = virtualTypeEntry(config, current, area)?.type;
    const next = virtual ?? preferenceEntry(config, current, area)?.type;
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

/** Whether `name` is a declared virtual type rather than a real class. */
export function isVirtualType(
  config: MagentoConfig,
  name: string,
  area: string = GLOBAL_AREA,
): boolean {
  return virtualTypeEntry(config, normalizeClassName(name), area) !== undefined;
}

/**
 * Active plugins on `target` in `area`, ordered by `sortOrder`. Global and area
 * declarations are merged by plugin name, and disabled ones are dropped.
 */
export function pluginsFor(
  config: MagentoConfig,
  target: string,
  area: string = GLOBAL_AREA,
): MagentoPlugin[] {
  const name = normalizeClassName(target);
  const merged = new Map<string, PluginDeclaration>();
  for (const plugin of config.plugins.get(GLOBAL_AREA)?.get(name)?.values() ?? []) {
    merged.set(plugin.name, plugin);
  }
  if (area !== GLOBAL_AREA) {
    for (const plugin of config.plugins.get(area)?.get(name)?.values() ?? []) {
      const existing = merged.get(plugin.name);
      merged.set(plugin.name, existing ? { ...existing, ...plugin } : plugin);
    }
  }
  return [...merged.values()]
    .filter((p) => !p.disabled && p.type)
    .map((p) => ({ ...p, sortOrder: p.sortOrder ?? 0 }))
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** Object-typed constructor arguments configured for `target` in `area`. */
export function objectArgumentsFor(
  config: MagentoConfig,
  target: string,
  area: string = GLOBAL_AREA,
): MagentoObjectArgument[] {
  const name = normalizeClassName(target);
  const out = [...(config.objectArguments.get(GLOBAL_AREA)?.get(name) ?? [])];
  if (area !== GLOBAL_AREA) out.push(...(config.objectArguments.get(area)?.get(name) ?? []));
  return out;
}

/** Every target that has plugins declared on it, across all areas. */
export function pluginTargets(config: MagentoConfig): string[] {
  const targets = new Set<string>();
  for (const byTarget of config.plugins.values()) {
    for (const target of byTarget.keys()) targets.add(target);
  }
  return [...targets];
}

/** Every interface/class with a preference, across all areas. */
export function preferenceKeys(config: MagentoConfig): Array<{ area: string; name: string }> {
  const out: Array<{ area: string; name: string }> = [];
  for (const [area, byName] of config.preferences) {
    for (const name of byName.keys()) out.push({ area, name });
  }
  return out;
}
