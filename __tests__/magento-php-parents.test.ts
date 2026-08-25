/**
 * Reading a class's declared parents from its own source.
 *
 * The graph only carries an `extends`/`implements` edge when BOTH ends are
 * indexed. A store's class implementing a Magento core interface — with
 * `vendor/` excluded, as it is by default — therefore has no parent in the
 * graph, while the `<plugin>` on that interface sits in `app/code` where we do
 * read it. Recovering the parent's NAME is enough to inherit that plugin,
 * because inheritance matches on names rather than nodes.
 */
import { describe, it, expect } from 'vitest';
import { declaredParents } from '../src/resolution/frameworks/magento/php-parents';

const file = (body: string): string => `<?php\n${body}`;

describe('declaredParents', () => {
  it('resolves a parent against the file namespace', () => {
    const source = file(`namespace Acme\\M\\Model;

class Child extends Base
{
}`);
    expect(declaredParents(source, 'Child')).toEqual(['Acme\\M\\Model\\Base']);
  });

  it('resolves through the use map, alias included', () => {
    const source = file(`namespace Acme\\M\\Model;

use Magento\\Catalog\\Api\\ProductRepositoryInterface;
use Magento\\Framework\\Model\\AbstractModel as CoreModel;

class Repo extends CoreModel implements ProductRepositoryInterface
{
}`);
    expect(declaredParents(source, 'Repo')).toEqual([
      'Magento\\Framework\\Model\\AbstractModel',
      'Magento\\Catalog\\Api\\ProductRepositoryInterface',
    ]);
  });

  it('keeps every interface of a multi-line implements list', () => {
    const source = file(`namespace Acme\\M\\Controller;

class Save implements
    \\Magento\\Framework\\App\\Action\\HttpPostActionInterface,
    \\Magento\\Framework\\App\\CsrfAwareActionInterface
{
}`);
    expect(declaredParents(source, 'Save')).toEqual([
      'Magento\\Framework\\App\\Action\\HttpPostActionInterface',
      'Magento\\Framework\\App\\CsrfAwareActionInterface',
    ]);
  });

  it('takes a fully qualified name as written', () => {
    const source = file(`namespace Acme\\M;

class Thing extends \\Magento\\Framework\\DataObject
{
}`);
    expect(declaredParents(source, 'Thing')).toEqual(['Magento\\Framework\\DataObject']);
  });

  it('reads the declaration of the named class, not the first one in the file', () => {
    const source = file(`namespace Acme\\M;

interface First extends OtherInterface
{
}

class Second extends Base
{
}`);
    expect(declaredParents(source, 'Second')).toEqual(['Acme\\M\\Base']);
  });

  it('handles an abstract or final declaration', () => {
    const source = file(`namespace Acme\\M;

abstract class Partial extends Base
{
}`);
    expect(declaredParents(source, 'Partial')).toEqual(['Acme\\M\\Base']);
  });

  it('ignores function and const imports', () => {
    const source = file(`namespace Acme\\M;

use function array_map;
use const PHP_INT_MAX;
use Acme\\Other\\Base;

class Thing extends Base
{
}`);
    expect(declaredParents(source, 'Thing')).toEqual(['Acme\\Other\\Base']);
  });

  it('returns nothing for a class with no parents, or one the file does not declare', () => {
    const source = file(`namespace Acme\\M;

class Lonely
{
}`);
    expect(declaredParents(source, 'Lonely')).toEqual([]);
    expect(declaredParents(source, 'Missing')).toEqual([]);
  });

  it('resolves a name without a namespace to the global one', () => {
    expect(declaredParents(file('class Thing extends ArrayObject\n{\n}'), 'Thing')).toEqual([
      'ArrayObject',
    ]);
  });
});
