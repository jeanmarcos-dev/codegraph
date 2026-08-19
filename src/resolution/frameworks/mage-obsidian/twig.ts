/**
 * Twig template analysis for MageObsidian.
 *
 * With the Twig module installed, `.twig` replaces `.phtml` as the storefront's
 * template language. CodeGraph treats `twig` as file-level-only — no grammar,
 * no symbols — so a template's links to its block, its child templates, its Vue
 * islands and its JS entries do not exist in the graph at all.
 *
 * This reads the four shapes that carry those links. Regex rather than a
 * grammar, the same call `liquid-extractor.ts` and `razor-extractor.ts` made for
 * their markup languages.
 */

import type { Node } from '../../../types';

/** What a reference found in a template points at. */
export type TwigReferenceKind =
  | 'template'
  | 'component'
  | 'script'
  | 'block-method'
  | 'child-block';

export interface TwigReference {
  kind: TwigReferenceKind;
  /** Module specifier, method name or block name, depending on `kind`. */
  value: string;
  /** 1-indexed line. */
  line: number;
}

/** Blank `{# … #}` comments, preserving offsets and newlines. */
function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('{#', i)) {
      const end = source.indexOf('#}', i + 2);
      const stop = end >= 0 ? end + 2 : source.length;
      for (let j = i; j < stop; j++) {
        if (source.charCodeAt(j) !== 10) out[j] = ' ';
      }
      i = stop;
      continue;
    }
    i++;
  }
  return out.join('');
}

const MODULE_SPECIFIER = String.raw`[A-Z][A-Za-z0-9]*_[A-Za-z0-9]+::[^'"]+`;

const PATTERNS: Array<{ kind: TwigReferenceKind; re: RegExp }> = [
  {
    kind: 'template',
    re: new RegExp(String.raw`\{%-?\s*(?:include|extends|embed)\s+['"](${MODULE_SPECIFIER})['"]`, 'g'),
  },
  {
    kind: 'component',
    re: new RegExp(String.raw`\brender_vue\s*\(\s*['"](${MODULE_SPECIFIER})['"]`, 'g'),
  },
  {
    kind: 'script',
    re: new RegExp(String.raw`\bscript\s*\(\s*['"](${MODULE_SPECIFIER})['"]`, 'g'),
  },
  {
    kind: 'child-block',
    re: /\bchild_html\s*\(\s*['"]([^'"]+)['"]/g,
  },
  {
    kind: 'block-method',
    re: /\b(?:block|viewModel|view_model)\s*\.\s*(\w+)\s*\(/g,
  },
];

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Every linkable reference in a Twig template, in source order. */
export function extractTwigReferences(source: string): TwigReference[] {
  const safe = blankComments(source);
  const found: TwigReference[] = [];

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(safe)) !== null) {
      found.push({ kind, value: match[1]!.trim(), line: lineAt(safe, match.index) });
    }
  }

  return found.sort((a, b) => a.line - b.line);
}

/** Node id prefix for a Twig template, so passes can find it deterministically. */
export const TWIG_NODE_PREFIX = 'obsidian-template:';

/**
 * A node standing for the template itself. `twig` extracts no symbols, so this
 * is the only handle the graph has on a MageObsidian view file.
 */
export function twigTemplateNode(filePath: string, content: string): Node {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  return {
    id: `${TWIG_NODE_PREFIX}${filePath}`,
    kind: 'component',
    name,
    qualifiedName: filePath,
    filePath,
    startLine: 1,
    endLine: Math.max(1, content.split('\n').length),
    startColumn: 0,
    endColumn: 0,
    language: 'twig',
    updatedAt: Date.now(),
  };
}
