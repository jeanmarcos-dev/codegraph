/**
 * Magento 2 / Adobe Commerce support.
 *
 * Magento decides what code actually runs through XML configuration, not
 * through the PHP call graph: `di.xml` `<preference>` swaps an interface for a
 * concrete class, `<plugin>` wraps a method with before/around/after
 * interceptors, `events.xml` binds observers to string event names, and layout
 * XML binds a block class to its `.phtml` template. None of that is visible to
 * a tree-sitter pass, so these tests pin the pieces that make it visible.
 */
import { describe, it, expect } from 'vitest';
import { detectLanguage, isSourceFile } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { loadGrammarsForLanguages, initGrammars } from '../src/extraction/grammars';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['php']);
});

describe('.phtml templates', () => {
  it('maps to the php language', () => {
    expect(detectLanguage('app/design/frontend/Acme/theme/Magento_Catalog/templates/list.phtml')).toBe('php');
    expect(isSourceFile('app/code/Acme/Catalog/view/frontend/templates/list.phtml')).toBe(true);
  });

  it('extracts block and view-model callsites from mixed HTML/PHP source', () => {
    const src = `<?php
/** @var \\Magento\\Catalog\\Block\\Product\\ListProduct $block */
?>
<div class="products">
    <h2><?= $block->escapeHtml($block->getTitle()) ?></h2>
    <?php foreach ($block->getLoadedProductCollection() as $product): ?>
        <span><?= $viewModel->formatPrice($product) ?></span>
    <?php endforeach; ?>
</div>
`;
    const result = extractFromSource(
      'app/code/Acme/Catalog/view/frontend/templates/list.phtml',
      src,
      'php',
    );

    expect(result.errors).toEqual([]);
    const refs = result.unresolvedReferences.map((r) => r.referenceName);
    expect(refs).toContain('block.getLoadedProductCollection');
    expect(refs).toContain('viewModel.formatPrice');
  });
});
