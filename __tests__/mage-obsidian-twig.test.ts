/**
 * Twig template analysis.
 *
 * MageObsidian registers a `.twig` engine alongside `.phtml`, and the storefront
 * theme is written in Twig — so the entire view layer is invisible to CodeGraph,
 * which treats `twig` as a file-level-only language with no symbols.
 *
 * A real template ties together four things nothing else references:
 *
 *   {% set form = block.getSearchForm() %}                    the block/ViewModel
 *   {% include 'Magento_Search::search-form/initial.twig' %}  another template
 *   {{ render_vue('MageObsidian_Storefront::nav/Search') }}   a Vue component
 *   {{ script('MageObsidian_Storefront::js/cart-actions') }}  a JS entry
 */
import { describe, it, expect } from 'vitest';
import { extractTwigReferences } from '../src/resolution/frameworks/mage-obsidian/twig';

function kinds(source: string, kind: string): string[] {
  return extractTwigReferences(source)
    .filter((r) => r.kind === kind)
    .map((r) => r.value);
}

describe('extractTwigReferences', () => {
  it('finds included, extended and embedded templates', () => {
    const source = `{% extends 'MageObsidian_Storefront::layouts/base.twig' %}
{% include 'Magento_Search::search-form/initial.twig' with { block: block } only %}
{% embed "Magento_Catalog::card.twig" %}{% endembed %}`;
    expect(kinds(source, 'template')).toEqual([
      'MageObsidian_Storefront::layouts/base.twig',
      'Magento_Search::search-form/initial.twig',
      'Magento_Catalog::card.twig',
    ]);
  });

  it('finds Vue islands rendered through render_vue', () => {
    const source = `{{ render_vue(
    'MageObsidian_Storefront::navigation/SearchAutocomplete',
    { actionUrl: form.getActionUrl() },
    true
) }}`;
    expect(kinds(source, 'component')).toEqual([
      'MageObsidian_Storefront::navigation/SearchAutocomplete',
    ]);
  });

  it('finds script entries', () => {
    const source = `{{ script('MageObsidian_Storefront::js/cart-actions') }}`;
    expect(kinds(source, 'script')).toEqual(['MageObsidian_Storefront::js/cart-actions']);
  });

  it('finds block and view-model method calls', () => {
    const source = `{% set form = block.getSearchForm() %}
<span>{{ block.getStockLabel() }}</span>
<span>{{ viewModel.formatQty(3.0) }}</span>`;
    expect(kinds(source, 'block-method').sort()).toEqual([
      'formatQty',
      'getSearchForm',
      'getStockLabel',
    ]);
  });

  it('finds child block names', () => {
    expect(kinds(`{{ child_html('product.info.form') }}`, 'child-block')).toEqual([
      'product.info.form',
    ]);
  });

  it('records the line each reference sits on', () => {
    const source = `{# header #}
{{ script('A_B::js/x') }}`;
    const script = extractTwigReferences(source).find((r) => r.kind === 'script')!;
    expect(script.line).toBe(2);
  });

  it('ignores everything inside a twig comment', () => {
    const source = `{#
  {% include 'A_B::commented.twig' %}
  {{ render_vue('A_B::Ghost') }}
  block.getCommented()
#}
{{ script('A_B::js/live') }}`;
    const refs = extractTwigReferences(source);
    expect(refs.map((r) => r.value)).toEqual(['A_B::js/live']);
  });

  it('does not treat a non-module argument as a specifier', () => {
    const source = `{{ script('just-a-string') }}
{% include 'relative/path.twig' %}`;
    expect(extractTwigReferences(source).filter((r) => r.kind !== 'block-method')).toHaveLength(0);
  });

  it('ignores twig filters and language constructs that look like calls', () => {
    const source = `{{ form.getActionUrl()|escape_url }}
{{ __('Search') }}
{% if block.isEnabled() %}{% endif %}`;
    const methods = kinds(source, 'block-method');
    expect(methods).toContain('isEnabled');
    expect(methods).not.toContain('__');
    expect(methods).not.toContain('escape_url');
  });

  it('returns nothing for a template with no references', () => {
    expect(extractTwigReferences('<div class="static">text</div>')).toHaveLength(0);
  });
});
