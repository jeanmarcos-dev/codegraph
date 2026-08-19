/**
 * MageObsidian module specifiers.
 *
 * Every cross-module import in MageObsidian's JS, Vue and Twig is written
 * `Vendor_Module::path`. That is a hard convention, not a style preference: a
 * relative import bypasses theme inheritance, so an override stops being
 * reachable and the build guard rejects it.
 */

/** Extensions the Vite build treats as resolvable assets (`ConfigInterface::ALLOWED_EXTENSIONS`). */
export const ASSET_EXTENSIONS = ['.js', '.vue', '.cjs', '.ts'] as const;

/** Roots a module specifier may target under the web directory. */
const ASSET_ROOTS = ['components/', 'js/'];

const SPECIFIER_RE = /^([A-Z][A-Za-z0-9]*_[A-Za-z0-9]+)::(.+)$/;

export interface ModuleSpecifier {
  moduleName: string;
  assetPath: string;
}

/** Split `Vendor_Module::path`, or null when the string is not one. */
export function parseModuleSpecifier(specifier: string): ModuleSpecifier | null {
  const match = specifier.trim().match(SPECIFIER_RE);
  if (!match) return null;
  return { moduleName: match[1]!, assetPath: match[2]! };
}

/**
 * The index key for an asset path: `components/` is implied when the path
 * targets neither known root, and a build extension is dropped so a specifier
 * written with or without one lands on the same entry.
 */
export function normalizeAssetPath(assetPath: string): string {
  let normalized = assetPath.trim();
  for (const extension of ASSET_EXTENSIONS) {
    if (normalized.endsWith(extension)) {
      normalized = normalized.slice(0, -extension.length);
      break;
    }
  }
  if (!ASSET_ROOTS.some((root) => normalized.startsWith(root))) {
    normalized = `components/${normalized}`;
  }
  return normalized;
}

/** Whether a file is a build asset MageObsidian can resolve a specifier to. */
export function isAssetFile(filePath: string): boolean {
  return ASSET_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}
