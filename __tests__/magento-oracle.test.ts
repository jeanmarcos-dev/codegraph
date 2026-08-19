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
import { discoverModules, sortModules } from '../src/resolution/frameworks/magento/modules';
import { buildDiConfig, resolvePreference, pluginsFor } from '../src/resolution/frameworks/magento/di';
import type { ResolutionContext } from '../src/resolution/types';

const ORACLE_ROOT = process.env.CODEGRAPH_MAGENTO_ORACLE;

/** Trees that hold no module configuration and are expensive to walk. */
const SKIP_ROOTS = new Set([
  'var', 'pub', 'generated', 'node_modules', '.git', 'dev', 'setup', '.pnpm-store',
]);

const CONFIG_FILES = new Set(['di.xml', 'module.xml', 'registration.php']);

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
  const modules = discoverModules(diskContext(root, files));
  sortModules(modules);
  const newestSource = Math.max(...files.map((f) => f.mtimeMs));
  const oldestMetadata = Math.min(
    ...fs.readdirSync(meta).map((n) => fs.statSync(path.join(meta, n)).mtimeMs),
  );
  return {
    config: buildDiConfig(diskContext(root, files), modules),
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
    // Below the floor sit two known gaps, both tracked: the `primary` scope
    // (`app/etc/di.xml`) is not read, and modules disabled in `app/etc/config.php`
    // are treated as active, so a preference of theirs can win a merge Magento
    // never ran.
    expect(ratio, `preference agreement ${(100 * ratio).toFixed(1)}%`).toBeGreaterThan(0.8);
    // A wrong winner is worse than a missing one: it is a confident wrong answer.
    expect(disagreed.length / declared.size, disagreed.slice(0, 5).join('\n')).toBeLessThan(0.01);
  });

  it.runIf(fresh)('resolves the same virtual types Magento compiled', () => {
    const compiled = readPhpArray(
      `$d = require ${JSON.stringify(path.join(META!, 'global.php'))}; echo json_encode($d['instanceTypes'] ?? []);`,
    ) as Record<string, string>;
    const ours = config.virtualTypes.get('global') ?? new Map();

    let agreed = 0;
    for (const [name, base] of Object.entries(compiled)) {
      const mine = ours.get(normalize(name));
      if (mine && stripInterceptor(mine.type) === stripInterceptor(base)) agreed++;
    }

    const total = Object.keys(compiled).length;
    const ratio = agreed / total;
    report(`virtual types      ${agreed}/${total}`, ratio);
    expect(ratio, `virtual type agreement ${(100 * ratio).toFixed(1)}%`).toBeGreaterThan(0.8);
  });

  describe('plugins', () => {
    /** `{target: {pluginName: {instance, sortOrder, disabled}}}` for one slot. */
    const loadSlot = (file: string, slot: 0 | 1): Record<string, Record<string, { instance?: string; disabled?: boolean }>> =>
      readPhpArray(`$d = require ${JSON.stringify(file)}; echo json_encode($d[${slot}] ?? []);`) as never;

    const compare = (
      compiled: Record<string, Record<string, { instance?: string; disabled?: boolean }>>,
      area: string,
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
        const ours = new Map(pluginsFor(config, target, area).map((p) => [p.name, normalize(p.type)]));
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
        ).toBeGreaterThan(0.97);
      }
      expect(total, 'the oracle carries plugin bindings to compare').toBeGreaterThan(100);
    });

    /**
     * Slot 1 is the per-type chain AFTER inheritance through parents,
     * interfaces and virtualType bases. We do not inherit yet — `pluginsFor`
     * matches the target name exactly — so a plugin declared on an abstract
     * block or a framework interface never reaches the concrete class. The
     * floor records where that leaves us rather than hiding it; raise it when
     * inheritance lands.
     */
    it.runIf(fresh)('records how much of the inherited chain we reach', () => {
      let total = 0;
      for (const { area, file } of compiledAreas()) {
        const { bindings, agreed } = compare(loadSlot(file, 1), area);
        if (bindings === 0) continue;
        total += bindings;
        report(`plugins inherited ${area} ${agreed}/${bindings}`, agreed / bindings);
        expect(
          agreed / bindings,
          `${area}: inherited plugin coverage ${agreed}/${bindings}`,
        ).toBeGreaterThan(0.4);
      }
      expect(total, 'the oracle carries inherited chains to compare').toBeGreaterThan(100);
    });
  });
});
