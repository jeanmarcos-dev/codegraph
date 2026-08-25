/**
 * The parent types a PHP class declares, read from its own source.
 *
 * The graph only carries an `extends`/`implements` edge when BOTH ends are
 * indexed, and a store's classes routinely implement a Magento core interface
 * that lives in the `vendor/` tree nobody indexes. The `<plugin>` on that
 * interface is declared right there in `app/code`, so the interface's NAME is
 * all that is missing: plugin inheritance matches on names, not nodes.
 *
 * This is deliberately not a PHP parser. Only the declaration line is needed,
 * and it always sits in the first few KB of a Magento source file.
 */

const HEAD_BYTES = 8192;

/**
 * Terminates on `{`, never on end of line: an implements list routinely spans
 * several lines, and stopping at the first newline drops every interface after
 * the first — along with all their plugins.
 */
const DECLARATION =
  /^[ \t]*(?:(?:final|abstract)[ \t]+)*(?:class|interface|trait)[ \t]+(\w+)(?:\s+extends\s+([^{]+?))?(?:\s+implements\s+([^{]+?))?\s*\{/gm;

const NAMESPACE = /^[ \t]*namespace\s+([^\s;{]+)/m;
const USE = /^[ \t]*use\s+([^\s;(]+?)(?:\s+as\s+(\w+))?\s*;/gim;

const trimLeading = (name: string): string => name.replace(/^\\+/, '').trim();

/**
 * Parent class and interface FQCNs declared by `className` in `source`, in
 * declaration order — the base class first, then the interfaces, which is the
 * order Magento's own `Relations::getParents` reports them in.
 *
 * Returns an empty array when the file declares no such class, so a caller can
 * treat "not found" and "no parents" alike.
 */
export function declaredParents(source: string, className: string): string[] {
  const head = source.length > HEAD_BYTES ? source.slice(0, HEAD_BYTES) : source;

  DECLARATION.lastIndex = 0;
  let declaration: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION.exec(head)) !== null) {
    if (match[1] === className) {
      declaration = match;
      break;
    }
  }
  if (!declaration) return [];

  const namespace = NAMESPACE.exec(head)?.[1];
  const aliases = new Map<string, string>();
  USE.lastIndex = 0;
  let use: RegExpExecArray | null;
  while ((use = USE.exec(head)) !== null) {
    const target = use[1]!;
    if (/^(function|const)\b/i.test(target)) continue;
    const full = trimLeading(target);
    if (!full) continue;
    aliases.set(use[2] ?? full.split('\\').pop()!, full);
  }

  const resolve = (raw: string): string | null => {
    const name = raw.trim();
    if (!name) return null;
    if (name.startsWith('\\')) return trimLeading(name);
    const [head_, ...rest] = name.split('\\');
    const aliased = aliases.get(head_!);
    if (aliased) return rest.length ? `${aliased}\\${rest.join('\\')}` : aliased;
    return trimLeading(namespace ? `${namespace}\\${name}` : name);
  };

  const parents: string[] = [];
  for (const group of [declaration[2], declaration[3]]) {
    if (!group) continue;
    for (const piece of group.split(',')) {
      const resolved = resolve(piece);
      if (resolved && !parents.includes(resolved)) parents.push(resolved);
    }
  }
  return parents;
}
