/**
 * Magento class-name shapes and how they map onto CodeGraph node names.
 *
 * PHP extraction qualifies a class as `<namespace>::<Class>` and a method as
 * `<namespace>::<Class>::<method>`, so a Magento FQCN from XML config has to be
 * rewritten before it can be looked up.
 */

/** Synthetic reference prefix for a module-to-module sequence dependency. */
export const MODULE_REF_PREFIX = 'magento:module:';

/**
 * Synthetic reference prefix for a Magento type named in XML config. Needed
 * because a virtual type name (`AcmeVirtualLogger`) carries no namespace, so
 * without the prefix the resolver's name pre-filter would drop the reference
 * before `resolve()` ever sees it.
 */
export const TYPE_REF_PREFIX = 'magento:type:';

/**
 * Synthetic reference prefix for a `Vendor_Module::path/file.phtml` template.
 * Turning one into a real path needs the module list and the file set, neither
 * of which per-file extraction has.
 */
export const TEMPLATE_REF_PREFIX = 'magento:template:';

/** `Acme\Catalog\Model\Stock` → `Acme\Catalog\Model::Stock`. */
export function fqcnToQualifiedName(fqcn: string): string {
  const clean = fqcn.replace(/^\\+/, '').trim();
  const lastSeparator = clean.lastIndexOf('\\');
  if (lastSeparator < 0) return clean;
  return `${clean.slice(0, lastSeparator)}::${clean.slice(lastSeparator + 1)}`;
}

/** The class name without its namespace. */
export function shortClassName(fqcn: string): string {
  const clean = fqcn.replace(/^\\+/, '').trim();
  const lastSeparator = clean.lastIndexOf('\\');
  return lastSeparator < 0 ? clean : clean.slice(lastSeparator + 1);
}

/** Whether a name looks like a namespaced PHP class rather than a bare symbol. */
export function looksLikeFqcn(name: string): boolean {
  return name.includes('\\');
}

/**
 * Split a `Class::method` config value. Magento writes handlers this way in
 * `queue_consumer.xml` and `webapi.xml` uses separate attributes for it.
 */
export function splitClassMethod(value: string): { fqcn: string; method?: string } {
  const clean = value.replace(/^\\+/, '').trim();
  const separator = clean.lastIndexOf('::');
  if (separator < 0) return { fqcn: clean };
  return { fqcn: clean.slice(0, separator), method: clean.slice(separator + 2) };
}

/** Magento generates `X\Factory` and `X\Proxy` at build time; both stand in for `X`. */
export function stripGeneratedSuffix(fqcn: string): { base: string; kind: 'factory' | 'proxy' } | null {
  const clean = fqcn.replace(/^\\+/, '').trim();
  if (clean.endsWith('Factory') && clean.length > 'Factory'.length) {
    return { base: clean.slice(0, -'Factory'.length), kind: 'factory' };
  }
  if (clean.endsWith('\\Proxy')) {
    return { base: clean.slice(0, -'\\Proxy'.length), kind: 'proxy' };
  }
  return null;
}
