import { describe, expect, it } from 'vitest';
import { applyPatch, deepEqual, getAtPointer, JsonPatchError, parsePointer } from '../../src';

describe('applyPatch (RFC 6902)', () => {
  const doc = { a: { b: [1, 2, 3] }, c: 'x', 'k/ey': 1, 't~ilde': 2 };

  it('add: object member, array index, array end', () => {
    expect(applyPatch(doc, [{ op: 'add', path: '/d', value: 4 }])).toMatchObject({ d: 4 });
    expect(applyPatch(doc, [{ op: 'add', path: '/a/b/1', value: 9 }])).toMatchObject({ a: { b: [1, 9, 2, 3] } });
    expect(applyPatch(doc, [{ op: 'add', path: '/a/b/-', value: 9 }])).toMatchObject({ a: { b: [1, 2, 3, 9] } });
    expect(applyPatch(doc, [{ op: 'add', path: '/c', value: 'y' }])).toMatchObject({ c: 'y' }); // add replaces existing
  });

  it('add: whole document and escaped pointers', () => {
    expect(applyPatch(doc, [{ op: 'add', path: '', value: { fresh: 1 } }])).toEqual({ fresh: 1 });
    expect(applyPatch(doc, [{ op: 'replace', path: '/k~1ey', value: 2 }])).toMatchObject({ 'k/ey': 2 });
    expect(applyPatch(doc, [{ op: 'replace', path: '/t~0ilde', value: 3 }])).toMatchObject({ 't~ilde': 3 });
  });

  it('remove', () => {
    const r = applyPatch(doc, [{ op: 'remove', path: '/a/b/0' }, { op: 'remove', path: '/c' }]) as typeof doc;
    expect(r.a.b).toEqual([2, 3]);
    expect('c' in r).toBe(false);
    expect(() => applyPatch(doc, [{ op: 'remove', path: '/nope' }])).toThrow(JsonPatchError);
  });

  it('replace', () => {
    expect(applyPatch(doc, [{ op: 'replace', path: '/a/b/2', value: 'z' }])).toMatchObject({ a: { b: [1, 2, 'z'] } });
    expect(() => applyPatch(doc, [{ op: 'replace', path: '/missing', value: 1 }])).toThrow(JsonPatchError);
  });

  it('move', () => {
    const r = applyPatch(doc, [{ op: 'move', from: '/c', path: '/a/moved' }]) as Record<string, unknown>;
    expect(r).toMatchObject({ a: { b: [1, 2, 3], moved: 'x' } });
    expect('c' in r).toBe(false);
    expect(applyPatch({ l: [1, 2, 3] }, [{ op: 'move', from: '/l/0', path: '/l/2' }])).toEqual({ l: [2, 3, 1] });
    expect(() => applyPatch(doc, [{ op: 'move', from: '/a', path: '/a/b' }])).toThrow(/own child/);
  });

  it('copy (deep)', () => {
    const r = applyPatch(doc, [{ op: 'copy', from: '/a', path: '/a2' }]) as { a: { b: number[] }; a2: { b: number[] } };
    expect(r.a2).toEqual(r.a);
    expect(r.a2).not.toBe(r.a);
    expect(r.a2.b).not.toBe(r.a.b);
  });

  it('test: passes on equal, fails otherwise (and fails the whole patch atomically)', () => {
    expect(applyPatch(doc, [{ op: 'test', path: '/a/b', value: [1, 2, 3] }])).toEqual(doc);
    let err: unknown;
    try {
      applyPatch(doc, [{ op: 'replace', path: '/c', value: 'changed' }, { op: 'test', path: '/c', value: 'x' }]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JsonPatchError);
    expect((err as JsonPatchError).index).toBe(1);
    expect(doc.c).toBe('x'); // input untouched
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(doc);
    applyPatch(doc, [{ op: 'add', path: '/a/b/-', value: 1 }, { op: 'remove', path: '/c' }]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('rejects bad indices and invalid pointers', () => {
    expect(() => applyPatch({ l: [1] }, [{ op: 'add', path: '/l/5', value: 1 }])).toThrow(/out of bounds/);
    expect(() => applyPatch({ l: [1] }, [{ op: 'add', path: '/l/x', value: 1 }])).toThrow(/invalid array index/);
    expect(() => parsePointer('a/b')).toThrow(/Invalid JSON pointer/);
  });

  it('getAtPointer / deepEqual helpers', () => {
    expect(getAtPointer(doc, '/a/b/1')).toEqual({ found: true, value: 2 });
    expect(getAtPointer(doc, '/a/zz').found).toBe(false);
    expect(getAtPointer(doc, '')).toEqual({ found: true, value: doc });
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual([1], { 0: 1 })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});
