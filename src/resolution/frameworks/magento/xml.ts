/**
 * Minimal XML reader for Magento configuration.
 *
 * Magento's behaviour lives in ~10 XML dialects (`di.xml`, `events.xml`,
 * `webapi.xml`, `routes.xml`, `crontab.xml`, layout, `ui_component`, …) and
 * CodeGraph ships no XML parser and takes no new dependencies (the same call
 * `installer/targets/toml.ts` made), so the Magento resolver reads them here.
 *
 * Deliberately a reader, not a validator: Magento schema-checks its own config,
 * and an indexer must never fail on a file it merely wants symbols out of.
 * Anything malformed degrades to "fewer elements", never a throw. Comments are
 * stripped length-preservingly (the technique in `extraction/mybatis-extractor.ts`)
 * so every element's `line` still points at the real source line.
 */

/** One XML element: attributes verbatim (namespace prefixes kept), children, direct text. */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated direct text content, CDATA unwrapped, trimmed. */
  text: string;
  /** 1-indexed line of the element's opening tag. */
  line: number;
}

/**
 * Blank comments, prolog, doctype and CDATA bodies so none of them can be read
 * as markup, preserving byte offsets and newlines so line math stays correct.
 */
function blankNonMarkup(source: string): string {
  const out = source.split('');
  const n = source.length;
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to && j < n; j++) {
      if (source.charCodeAt(j) !== 10) out[j] = ' ';
    }
  };
  const skipBlock = (i: number, open: string, close: string): number => {
    const end = source.indexOf(close, i + open.length);
    const stop = end >= 0 ? end + close.length : n;
    blank(i, stop);
    return stop;
  };

  let i = 0;
  while (i < n) {
    if (source.startsWith('<![CDATA[', i)) i = skipBlock(i, '<![CDATA[', ']]>');
    else if (source.startsWith('<!--', i)) i = skipBlock(i, '<!--', '-->');
    else if (source.startsWith('<?', i)) i = skipBlock(i, '<?', '?>');
    else if (source.startsWith('<!', i)) i = skipBlock(i, '<!', '>');
    else i++;
  }
  return out.join('');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[body] ?? whole;
  });
}

const ATTR_RE = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    attrs[m[1]!] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function buildLineLookup(source: string): (offset: number) => number {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  return (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Parse an XML document into its root element, or `null` when the source holds
 * no element at all. Unclosed elements are closed implicitly by an ancestor's
 * closing tag or at end of input, so a truncated config still yields whatever
 * was readable.
 */
export function parseXml(source: string): XmlElement | null {
  const src = blankNonMarkup(source);
  const n = src.length;
  const lineAt = buildLineLookup(source);

  let root: XmlElement | null = null;
  const stack: XmlElement[] = [];

  const pushText = (from: number, to: number): void => {
    const top = stack[stack.length - 1];
    if (!top || to <= from) return;
    const chunk = source.slice(from, to).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const trimmed = decodeEntities(chunk).trim();
    if (trimmed) top.text = top.text ? `${top.text} ${trimmed}` : trimmed;
  };

  let i = 0;
  let textFrom = 0;
  while (i < n) {
    if (src.charCodeAt(i) !== 60) {
      i++;
      continue;
    }
    const gt = src.indexOf('>', i);
    if (gt < 0) break;
    pushText(textFrom, i);

    const inner = src.slice(i + 1, gt);
    if (inner.startsWith('/')) {
      const idx = stack.map((e) => e.name).lastIndexOf(inner.slice(1).trim());
      if (idx >= 0) stack.length = idx;
    } else if (inner.trim()) {
      const selfClosing = inner.endsWith('/');
      const body = selfClosing ? inner.slice(0, -1) : inner;
      const nameMatch = body.match(/^\s*([\w:.-]+)/);
      if (nameMatch) {
        const element: XmlElement = {
          name: nameMatch[1]!,
          attrs: parseAttrs(body.slice(nameMatch[0].length)),
          children: [],
          text: '',
          line: lineAt(i),
        };
        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(element);
        else if (!root) root = element;
        if (!selfClosing) stack.push(element);
      }
    }

    i = gt + 1;
    textFrom = i;
  }

  return root;
}

/** Every descendant named `name`, document order, `element` itself excluded. */
export function findAll(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === name) out.push(child);
      walk(child);
    }
  };
  walk(element);
  return out;
}

/** Direct children named `name`. */
export function findChildren(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((c) => c.name === name);
}

/** An attribute's trimmed value, or `undefined` when absent or blank. */
export function attr(element: XmlElement, name: string): string | undefined {
  const value = element.attrs[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
