/**
 * Minimal XML reader used by the Magento resolver.
 *
 * Magento configuration is ~10 different XML dialects (di, events, webapi,
 * routes, crontab, layout, ui_component, …) and CodeGraph ships no XML parser
 * and takes no new dependencies, so the resolver reads them with this. The
 * requirements it has to meet come straight from real Magento files: nested
 * elements (`<type><arguments><argument>`), namespaced attributes
 * (`xsi:type`), self-closing tags, CDATA, and 1-indexed line numbers that
 * survive comment stripping so emitted nodes point at the right source line.
 */
import { describe, it, expect } from 'vitest';
import { parseXml, findAll, findChildren, attr } from '../src/resolution/frameworks/magento/xml';

describe('parseXml', () => {
  it('returns null for a document with no root element', () => {
    expect(parseXml('')).toBeNull();
    expect(parseXml('<?xml version="1.0"?>\n<!-- just a comment -->')).toBeNull();
  });

  it('reads the root element with its attributes', () => {
    const root = parseXml(
      `<?xml version="1.0"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="urn:magento:framework:ObjectManager/etc/config.xsd">
</config>`,
    );
    expect(root!.name).toBe('config');
    expect(root!.attrs['xsi:noNamespaceSchemaLocation']).toBe(
      'urn:magento:framework:ObjectManager/etc/config.xsd',
    );
    expect(root!.line).toBe(2);
  });

  it('nests children and records 1-indexed lines', () => {
    const root = parseXml(`<config>
    <type name="Acme\\Catalog\\Model\\Foo">
        <arguments>
            <argument name="bar" xsi:type="object">Acme\\Catalog\\Model\\Bar</argument>
        </arguments>
    </type>
</config>`);

    const type = root!.children[0]!;
    expect(type.name).toBe('type');
    expect(type.line).toBe(2);
    const argument = type.children[0]!.children[0]!;
    expect(argument.name).toBe('argument');
    expect(argument.attrs.name).toBe('bar');
    expect(argument.attrs['xsi:type']).toBe('object');
    expect(argument.text).toBe('Acme\\Catalog\\Model\\Bar');
    expect(argument.line).toBe(4);
  });

  it('handles self-closing tags', () => {
    const root = parseXml(`<config>
    <preference for="Acme\\Api\\FooInterface" type="Acme\\Model\\Foo" />
    <preference for="Acme\\Api\\BarInterface" type="Acme\\Model\\Bar"/>
</config>`);
    expect(root!.children).toHaveLength(2);
    expect(root!.children[1]!.attrs.type).toBe('Acme\\Model\\Bar');
  });

  it('ignores commented-out elements but keeps line numbers intact', () => {
    const root = parseXml(`<config>
    <!--
    <preference for="Acme\\Api\\Disabled" type="Acme\\Model\\Disabled"/>
    -->
    <preference for="Acme\\Api\\Live" type="Acme\\Model\\Live"/>
</config>`);
    expect(root!.children).toHaveLength(1);
    expect(root!.children[0]!.attrs.for).toBe('Acme\\Api\\Live');
    expect(root!.children[0]!.line).toBe(5);
  });

  it('reads CDATA as text and does not treat markup inside it as elements', () => {
    const root = parseXml(`<config>
    <item><![CDATA[<not-a-tag/> raw]]></item>
</config>`);
    expect(root!.children).toHaveLength(1);
    expect(root!.children[0]!.children).toHaveLength(0);
    expect(root!.children[0]!.text).toBe('<not-a-tag/> raw');
  });

  it('accepts single-quoted attribute values', () => {
    const root = parseXml(`<config><preference for='A' type='B'/></config>`);
    expect(root!.children[0]!.attrs.for).toBe('A');
    expect(root!.children[0]!.attrs.type).toBe('B');
  });

  it('decodes the XML entities Magento config actually uses', () => {
    const root = parseXml(`<config><job name="a&amp;b" instance="A&lt;B"/></config>`);
    expect(root!.children[0]!.attrs.name).toBe('a&b');
    expect(root!.children[0]!.attrs.instance).toBe('A<B');
  });

  it('tolerates an unclosed element instead of throwing', () => {
    const root = parseXml(`<config>
    <type name="Acme\\Foo">
        <plugin name="p" type="Acme\\Plugin"/>
</config>`);
    expect(root!.name).toBe('config');
    expect(findAll(root!, 'plugin')).toHaveLength(1);
  });

  it('skips the doctype declaration', () => {
    const root = parseXml(`<!DOCTYPE config SYSTEM "config.dtd">
<config><preference for="A" type="B"/></config>`);
    expect(root!.name).toBe('config');
    expect(root!.children).toHaveLength(1);
  });
});

describe('findAll / findChildren / attr', () => {
  const root = parseXml(`<config>
    <type name="Outer">
        <plugin name="p1" type="Acme\\P1"/>
        <arguments>
            <argument name="deep" xsi:type="object">Acme\\Deep</argument>
        </arguments>
    </type>
    <type name="Other">
        <plugin name="p2" type="Acme\\P2" disabled="true"/>
    </type>
</config>`)!;

  it('findAll walks the whole subtree', () => {
    expect(findAll(root, 'plugin').map((p) => p.attrs.name)).toEqual(['p1', 'p2']);
    expect(findAll(root, 'argument')).toHaveLength(1);
  });

  it('findChildren only looks one level down', () => {
    expect(findChildren(root, 'type')).toHaveLength(2);
    expect(findChildren(root, 'plugin')).toHaveLength(0);
  });

  it('attr trims and returns undefined for missing or blank values', () => {
    const plugin = findAll(root, 'plugin')[0]!;
    expect(attr(plugin, 'type')).toBe('Acme\\P1');
    expect(attr(plugin, 'disabled')).toBeUndefined();
  });
});
