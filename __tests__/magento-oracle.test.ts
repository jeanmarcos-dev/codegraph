/**
 * Magento DI resolution, checked against Magento's own compiled metadata.
 *
 * `setup:di:compile` writes the fully merged, area-resolved configuration to
 * `generated/metadata/`: `<area>.php` carries the preference and virtualType
 * maps, and `primary|global|<area>|plugin-list.php` carries the plugin map in
 * three slots — direct declarations, the per-type chains after inheritance, and
 * the processed form. That is what the runtime actually uses, so it is ground
 * truth: where this disagrees with us, we are wrong.
 *
 * Point `CODEGRAPH_MAGENTO_ORACLE` at a compiled Magento root to run it. The
 * suite skips when the variable is unset, when the project was never compiled,
 * or when `php` is not on PATH — none of which are failures.
 *
 * The comparison deliberately reads every `di.xml` on disk, `vendor/` included,
 * rather than an indexed file set. What is under test is the merge, not which
 * modules a project chooses to index.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import {
  discoverModules,
  sortModules,
  readModuleConfig,
} from '../src/resolution/frameworks/magento/modules';
import {
  buildDiConfig,
  resolvePreference,
  resolveInstanceType,
  pluginsFor,
  pluginInheritance,
} from '../src/resolution/frameworks/magento/di';
import type { ResolutionContext } from '../src/resolution/types';

const ORACLE_ROOT = process.env.CODEGRAPH_MAGENTO_ORACLE;

/** Trees that hold no module configuration and are expensive to walk. */
const SKIP_ROOTS = new Set([
  'var', 'pub', 'generated', 'node_modules', '.git', 'dev', 'setup', '.pnpm-store',
]);

const CONFIG_FILES = new Set(['di.xml', 'module.xml', 'registration.php', 'config.php']);

function hasPhp(): boolean {
  try {
    execFileSync('php', ['-v'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function metadataDir(): string | null {
  if (!ORACLE_ROOT) return null;
  const dir = path.join(ORACLE_ROOT, 'generated', 'metadata');
  return fs.existsSync(dir) && hasPhp() ? dir : null;
}

const META = metadataDir();

interface ConfigFile {
  relative: string;
  mtimeMs: number;
}

function walkConfig(root: string, dir = root, relative = '', out: ConfigFile[] = []): ConfigFile[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (relative === '' && SKIP_ROOTS.has(entry.name)) continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkConfig(root, full, rel, out);
    else if (CONFIG_FILES.has(entry.name)) out.push({ relative: rel, mtimeMs: fs.statSync(full).mtimeMs });
  }
  return out;
}

function diskContext(root: string, files: ConfigFile[]): ResolutionContext {
  const names = files.map((f) => f.relative);
  return {
    getAllFiles: () => names,
    readFile: (file: string) => {
      try {
        return fs.readFileSync(path.join(root, file), 'utf8');
      } catch {
        return null;
      }
    },
    fileExists: (file: string) => fs.existsSync(path.join(root, file)),
  } as unknown as ResolutionContext;
}

function readPhpArray(script: string): unknown {
  const out = execFileSync('php', ['-r', script], { maxBuffer: 1 << 30, encoding: 'utf8' });
  return JSON.parse(out);
}

/** `\Foo\Bar` and `Foo\Bar` are the same class. */
const normalize = (name: string | null | undefined): string => (name ?? '').replace(/^\\+/, '');

/**
 * The compiled maps name the generated interceptor subclass wherever a type has
 * plugins. That class is a runtime artifact of interception, not a different
 * resolution, so it is folded back onto the class it wraps.
 */
const stripInterceptor = (name: string | null | undefined): string =>
  normalize(name).replace(/\\Interceptor$/, '');

/**
 * The class hierarchy, read straight from the source tree.
 *
 * Interception walks a type's ancestors, so measuring inherited plugins needs
 * the parent chain and nothing else. Composer's generated PSR-4 map places a
 * class in a file exactly, and the declaration always sits in the first few KB,
 * so a targeted read of the ~1k types the oracle names is enough — no parser,
 * and no walk of the 76k PHP files in `vendor/`.
 */
function hierarchyFor(root: string): (type: string) => string[] {
  const psr4 = readPhpArray(
    `$m = require ${JSON.stringify(path.join(root, 'vendor/composer/autoload_psr4.php'))}; echo json_encode($m);`,
  ) as Record<string, string[]>;
  // Longest prefix first: `Magento\Catalog\` must beat a bare `Magento\`.
  const prefixes = Object.entries(psr4).sort((a, b) => b[0].length - a[0].length);
  const cache = new Map<string, string[]>();

  const fileOf = (fqcn: string): string | null => {
    for (const [prefix, dirs] of prefixes) {
      if (!fqcn.startsWith(prefix)) continue;
      const tail = fqcn.slice(prefix.length).replace(/\\/g, '/') + '.php';
      for (const dir of dirs) {
        const candidate = path.join(dir, tail);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return null;
  };

  // Terminates on `{`, never on end of line: an implements list routinely spans
  // several lines, and stopping at the first newline drops every interface
  // after the first — along with all their plugins.
  const DECLARATION =
    /^[ \t]*(?:(?:final|abstract)[ \t]+)?(?:class|interface|trait)[ \t]+\w+(?:\s+extends\s+([^{]+?))?(?:\s+implements\s+([^{]+?))?\s*\{/m;

  const parse = (source: string, fqcn: string): string[] => {
    const declaration = DECLARATION.exec(source);
    if (!declaration) return [];
    const namespace = /^\s*namespace\s+([^\s;{]+)/m.exec(source)?.[1] ?? '';
    const uses = new Map<string, string>();
    for (const [, target, alias] of source.matchAll(/^\s*use\s+([^\s;(]+?)(?:\s+as\s+(\w+))?\s*;/gim)) {
      const full = normalize(target);
      if (!full || /^(function|const)\s/i.test(target)) continue;
      uses.set(alias ?? full.split('\\').pop()!, full);
    }
    const resolve = (name: string): string | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith('\\')) return normalize(trimmed);
      const [head, ...rest] = trimmed.split('\\');
      const aliased = uses.get(head!);
      if (aliased) return normalize(rest.length ? `${aliased}\\${rest.join('\\')}` : aliased);
      return normalize(namespace ? `${namespace}\\${trimmed}` : trimmed);
    };
    return [declaration[1], declaration[2]]
      .filter((group): group is string => Boolean(group))
      .flatMap((group) => group.split(','))
      .map(resolve)
      .filter((name): name is string => Boolean(name) && name !== fqcn);
  };

  return (type: string): string[] => {
    const cached = cache.get(type);
    if (cached) return cached;
    cache.set(type, []); // cycle guard while this one resolves
    const file = fileOf(type);
    const parents = file ? parse(fs.readFileSync(file, 'utf8').slice(0, 8192), type) : [];
    cache.set(type, parents);
    return parents;
  };
}

/** Coverage lines, printed because the point of the harness is the number. */
function report(label: string, ratio: number): void {
  console.log(`  oracle · ${label.padEnd(34)} ${(100 * ratio).toFixed(1)}%`);
}

const compiledAreas = (): { area: string; file: string }[] => {
  if (!META) return [];
  const pattern = /^primary\|global(?:\|(\w+))?\|plugin-list\.php$/;
  return fs
    .readdirSync(META)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
    .map((e) => ({ area: e.match[1] ?? 'global', file: path.join(META!, e.name) }));
};

/**
 * Built once at module load, and only when an oracle is configured — a
 * `describe.runIf` body is still evaluated during collection, so this cannot
 * live inside it.
 */
function buildFixture(root: string, meta: string) {
  const files = walkConfig(root);
  const context = diskContext(root, files);
  const modules = discoverModules(context);
  sortModules(modules, readModuleConfig(context));
  const newestSource = Math.max(...files.map((f) => f.mtimeMs));
  const oldestMetadata = Math.min(
    ...fs.readdirSync(meta).map((n) => fs.statSync(path.join(meta, n)).mtimeMs),
  );
  return {
    config: buildDiConfig(context, modules),
    fresh: oldestMetadata >= newestSource,
  };
}

const FIXTURE = META ? buildFixture(ORACLE_ROOT!, META) : null;

describe.runIf(META)('Magento DI vs compiled metadata', () => {
  const root = ORACLE_ROOT!;
  // Optional access: this body is evaluated during collection even when the
  // suite is skipped, and no test reads either value in that case.
  const config = FIXTURE?.config as ReturnType<typeof buildDiConfig>;
  const fresh = FIXTURE?.fresh ?? false;

  /**
   * A stale oracle describes a configuration that no longer exists, so a
   * disagreement would say nothing about our code — and "fixing" ourselves to
   * match it would introduce the very bug the harness exists to catch.
   */
  it('was compiled after the last configuration change', () => {
    expect(
      fresh,
      `generated/metadata is older than the newest di.xml — run setup:di:compile in ${root}`,
    ).toBe(true);
  });

  it.runIf(fresh)('resolves the same preferences Magento compiled', () => {
    const compiled = readPhpArray(
      `$d = require ${JSON.stringify(path.join(META!, 'global.php'))}; echo json_encode($d['preferences'] ?? []);`,
    ) as Record<string, string>;

    // An `X => X\Interceptor` entry routes instantiation through interception;
    // it is not a preference anyone declared, and we must NOT emit one.
    const declared = new Map<string, string>();
    for (const [from, to] of Object.entries(compiled)) {
      if (stripInterceptor(to) === normalize(from) && normalize(to) !== normalize(from)) continue;
      declared.set(normalize(from), stripInterceptor(to));
    }

    let agreed = 0;
    const disagreed: string[] = [];
    for (const [name, expected] of declared) {
      const ours = stripInterceptor(resolvePreference(config, name, 'global'));
      if (ours === expected) agreed++;
      else if (ours !== name) disagreed.push(`${name}: ours=${ours} magento=${expected}`);
    }

    const ratio = agreed / declared.size;
    report(`preferences        ${agreed}/${declared.size}`, ratio);
    expect(declared.size, 'the oracle carries preferences to compare').toBeGreaterThan(100);
    expect(ratio, `preference agreement ${(100 * ratio).toFixed(1)}%`).toBeGreaterThan(0.99);
    // A wrong winner is worse than a missing one: it is a confident wrong answer.
    expect(disagreed.length / declared.size, disagreed.slice(0, 5).join('\n')).toBeLessThan(0.01);
  });

  it.runIf(fresh)('resolves the same virtual types Magento compiled', () => {
    const compiled = readPhpArray(
      `$d = require ${JSON.stringify(path.join(META!, 'global.php'))}; echo json_encode($d['instanceTypes'] ?? []);`,
    ) as Record<string, string>;
    // The compiled map names the type a virtual type finally INSTANTIATES, so
    // the chain has to be walked on our side too — a virtual type's `type` is
    // routinely another virtual type. Resolution also has to go through the
    // scope chain (an `app/etc/di.xml` declaration is in `primary`, not
    // `global`), which is what `resolveInstanceType` does.
    let agreed = 0;
    for (const [name, base] of Object.entries(compiled)) {
      const mine = resolveInstanceType(config, normalize(name), 'global');
      if (stripInterceptor(mine) === stripInterceptor(base)) agreed++;
    }

    const total = Object.keys(compiled).length;
    const ratio = agreed / total;
    report(`virtual types      ${agreed}/${total}`, ratio);
    expect(ratio, `virtual type agreement ${(100 * ratio).toFixed(1)}%`).toBeGreaterThan(0.99);
  });

  describe('plugins', () => {
    /** `{target: {pluginName: {instance, sortOrder, disabled}}}` for one slot. */
    const loadSlot = (file: string, slot: 0 | 1): Record<string, Record<string, { instance?: string; disabled?: boolean }>> =>
      readPhpArray(`$d = require ${JSON.stringify(file)}; echo json_encode($d[${slot}] ?? []);`) as never;

    const compare = (
      compiled: Record<string, Record<string, { instance?: string; disabled?: boolean }>>,
      area: string,
      inheritance?: ReturnType<typeof pluginInheritance>,
    ): { bindings: number; agreed: number; extra: number; samples: string[] } => {
      let bindings = 0;
      let agreed = 0;
      let extra = 0;
      const samples: string[] = [];
      for (const [target, plugins] of Object.entries(compiled)) {
        if (!plugins) continue;
        const expected = new Map<string, string>();
        for (const [name, body] of Object.entries(plugins)) {
          if (!body?.instance || body.disabled) continue;
          expected.set(name, normalize(body.instance));
        }
        const ours = new Map(
          pluginsFor(config, target, area, inheritance).map((p) => [p.name, normalize(p.type)]),
        );
        bindings += expected.size;
        for (const [name, instance] of expected) {
          if (ours.get(name) === instance) agreed++;
          else if (samples.length < 5) samples.push(`${target} :: ${name} -> ${instance}`);
        }
        for (const name of ours.keys()) if (!expected.has(name)) extra++;
      }
      return { bindings, agreed, extra, samples };
    };

    it.runIf(fresh)('covers every compiled scope chain', () => {
      const areas = compiledAreas().map((a) => a.area);
      expect(areas, 'the bare primary|global chain must be present').toContain('global');
      expect(areas.length).toBeGreaterThanOrEqual(4);
    });

    it.runIf(fresh)('matches the declarations Magento merged', () => {
      let total = 0;
      for (const { area, file } of compiledAreas()) {
        const { bindings, agreed, extra, samples } = compare(loadSlot(file, 0), area);
        if (bindings === 0) continue;
        total += bindings;
        report(`plugins declared ${area} ${agreed}/${bindings} (+${extra})`, agreed / bindings);
        expect(
          agreed / bindings,
          `${area}: declared plugin agreement ${agreed}/${bindings}\n${samples.join('\n')}`,
        ).toBeGreaterThan(0.99);
      }
      expect(total, 'the oracle carries plugin bindings to compare').toBeGreaterThan(100);
    });

    /**
     * Slot 1 is the per-type chain AFTER inheritance through parents,
     * interfaces and virtual-type bases — what actually intercepts a concrete
     * class, including everything an abstract base or a framework interface
     * declares on its behalf.
     */
    it.runIf(fresh)('matches the chain Magento resolved through the hierarchy', () => {
      const inheritance = pluginInheritance(hierarchyFor(root));
      let total = 0;
      for (const { area, file } of compiledAreas()) {
        const { bindings, agreed } = compare(loadSlot(file, 1), area, inheritance);
        if (bindings === 0) continue;
        total += bindings;
        report(`plugins inherited ${area} ${agreed}/${bindings}`, agreed / bindings);
        expect(
          agreed / bindings,
          `${area}: inherited plugin coverage ${agreed}/${bindings}`,
        ).toBeGreaterThan(0.99);
      }
      expect(total, 'the oracle carries inherited chains to compare').toBeGreaterThan(100);
    });
  });
});
