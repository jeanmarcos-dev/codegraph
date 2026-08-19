/**
 * events.xml — observers.
 *
 * Magento's event system is string-keyed: `$eventManager->dispatch('name')` on
 * one side, `<event name="name"><observer instance="Class"/></event>` on the
 * other, and nothing in PHP connects them. Worse than the usual string-keyed
 * case, the dispatch usually lives in `vendor/magento`, which is not indexed by
 * default — so an edge from the dispatch site alone would leave every observer
 * of a core event orphaned. The event therefore becomes a node of its own: it
 * answers "who listens to this" even when the emitter is outside the index,
 * and the dispatch side links to it when it is inside.
 */
import { describe, it, expect } from 'vitest';
import { extractEvents } from '../src/resolution/frameworks/magento/config-xml';

describe('extractEvents', () => {
  it('emits an event node and a reference to each observer', () => {
    const { nodes, references } = extractEvents(
      'app/code/Acme/M/etc/events.xml',
      `<?xml version="1.0"?>
<config>
    <event name="sales_order_place_after">
        <observer name="acme_notify" instance="Acme\\M\\Observer\\NotifyObserver"/>
    </event>
</config>`,
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('sales_order_place_after');
    expect(nodes[0]!.startLine).toBe(3);
    expect(nodes[0]!.language).toBe('xml');
    expect(references).toHaveLength(1);
    expect(references[0]!.referenceName).toBe('Acme\\M\\Observer\\NotifyObserver::execute');
    expect(references[0]!.fromNodeId).toBe(nodes[0]!.id);
  });

  it('honours an explicit observer method', () => {
    const { references } = extractEvents(
      'app/code/Acme/M/etc/events.xml',
      `<config>
    <event name="custom_event">
        <observer name="acme" instance="Acme\\M\\Observer\\Multi" method="handleCustom"/>
    </event>
</config>`,
    );
    expect(references[0]!.referenceName).toBe('Acme\\M\\Observer\\Multi::handleCustom');
  });

  it('links every observer of the same event', () => {
    const { nodes, references } = extractEvents(
      'app/code/Acme/M/etc/events.xml',
      `<config>
    <event name="shared_event">
        <observer name="one" instance="Acme\\M\\Observer\\One"/>
        <observer name="two" instance="Acme\\M\\Observer\\Two"/>
    </event>
</config>`,
    );
    expect(nodes).toHaveLength(1);
    expect(references).toHaveLength(2);
    expect(references.every((r) => r.fromNodeId === nodes[0]!.id)).toBe(true);
  });

  it('skips a disabled observer', () => {
    const { references } = extractEvents(
      'app/code/Acme/M/etc/events.xml',
      `<config>
    <event name="e">
        <observer name="off" instance="Acme\\M\\Observer\\Off" disabled="true"/>
        <observer name="on" instance="Acme\\M\\Observer\\On"/>
    </event>
</config>`,
    );
    expect(references.map((r) => r.referenceName)).toEqual(['Acme\\M\\Observer\\On::execute']);
  });

  it('gives events in different areas distinct nodes', () => {
    const global = extractEvents(
      'app/code/Acme/M/etc/events.xml',
      '<config><event name="e"><observer name="o" instance="Acme\\O"/></event></config>',
    );
    const frontend = extractEvents(
      'app/code/Acme/M/etc/frontend/events.xml',
      '<config><event name="e"><observer name="o" instance="Acme\\O"/></event></config>',
    );
    expect(global.nodes[0]!.id).not.toBe(frontend.nodes[0]!.id);
  });

  it('emits nothing for an event with no observers', () => {
    const { nodes, references } = extractEvents(
      'app/code/Acme/M/etc/events.xml',
      '<config><event name="lonely"/></config>',
    );
    expect(nodes).toHaveLength(0);
    expect(references).toHaveLength(0);
  });

  it('ignores an observer with no instance', () => {
    const { references } = extractEvents(
      'app/code/Acme/M/etc/events.xml',
      '<config><event name="e"><observer name="broken"/></event></config>',
    );
    expect(references).toHaveLength(0);
  });
});
