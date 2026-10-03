import type { JsonPatchOp } from './events';

/**
 * Minimal RFC 6902 JSON Patch implementation (add, remove, replace, move, copy, test).
 * Operates immutably: the input document is never mutated; a new document is returned.
 * Throws `JsonPatchError` on invalid paths or a failed `test`.
 */

export class JsonPatchError extends Error {
  constructor(
    message: string,
    public readonly op: JsonPatchOp,
    public readonly index: number,
  ) {
    super(`JSON Patch op #${index} (${op.op} ${op.path}): ${message}`);
    this.name = 'JsonPatchError';
  }
}

function unescape(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON pointer: ${pointer}`);
  return pointer.slice(1).split('/').map(unescape);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.slice() as T;
  if (isObject(v)) return { ...v } as T;
  return v;
}

export function getAtPointer(doc: unknown, pointer: string): { found: boolean; value: unknown } {
  const tokens = parsePointer(pointer);
  let cur: unknown = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      const i = t === '-' ? cur.length : Number(t);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { found: false, value: undefined };
      cur = cur[i];
    } else if (isObject(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, t)) return { found: false, value: undefined };
      cur = cur[t];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

type Mode = 'add' | 'replace' | 'remove';

/** Immutable path write. Returns the new root. */
function setAtPointer(doc: unknown, tokens: string[], mode: Mode, value: unknown): unknown {
  if (tokens.length === 0) {
    if (mode === 'remove') return undefined;
    return value;
  }
  const [head, ...rest] = tokens as [string, ...string[]];
  if (Array.isArray(doc)) {
    const arr = doc.slice();
    const idx = head === '-' ? arr.length : Number(head);
    if (!Number.isInteger(idx) || idx < 0) throw new Error(`invalid array index "${head}"`);
    if (rest.length === 0) {
      if (mode === 'add') {
        if (idx > arr.length) throw new Error(`array index ${idx} out of bounds`);
        arr.splice(idx, 0, value);
      } else if (mode === 'replace') {
        if (idx >= arr.length) throw new Error(`array index ${idx} out of bounds`);
        arr[idx] = value;
      } else {
        if (idx >= arr.length) throw new Error(`array index ${idx} out of bounds`);
        arr.splice(idx, 1);
      }
      return arr;
    }
    if (idx >= arr.length) throw new Error(`array index ${idx} out of bounds`);
    arr[idx] = setAtPointer(arr[idx], rest, mode, value);
    return arr;
  }
  if (isObject(doc)) {
    const obj = clone(doc);
    if (rest.length === 0) {
      if (mode === 'remove') {
        if (!Object.prototype.hasOwnProperty.call(obj, head)) throw new Error(`path does not exist`);
        delete obj[head];
      } else if (mode === 'replace') {
        if (!Object.prototype.hasOwnProperty.call(obj, head)) throw new Error(`path does not exist`);
        obj[head] = value;
      } else {
        obj[head] = value;
      }
      return obj;
    }
    if (!Object.prototype.hasOwnProperty.call(obj, head)) throw new Error(`path does not exist`);
    obj[head] = setAtPointer(obj[head], rest, mode, value);
    return obj;
  }
  throw new Error(`cannot descend into ${doc === null ? 'null' : typeof doc}`);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
  }
  return false;
}

/** Apply a JSON Patch to `doc` and return the new document. Does not mutate `doc`. */
export function applyPatch(doc: unknown, ops: JsonPatchOp[]): unknown {
  let cur = doc;
  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case 'add':
          cur = setAtPointer(cur, parsePointer(op.path), 'add', op.value);
          break;
        case 'replace':
          cur = setAtPointer(cur, parsePointer(op.path), 'replace', op.value);
          break;
        case 'remove':
          cur = setAtPointer(cur, parsePointer(op.path), 'remove', undefined);
          break;
        case 'move': {
          const { found, value } = getAtPointer(cur, op.from);
          if (!found) throw new Error(`"from" path does not exist`);
          if (op.path.startsWith(op.from + '/')) throw new Error(`cannot move into own child`);
          cur = setAtPointer(cur, parsePointer(op.from), 'remove', undefined);
          cur = setAtPointer(cur, parsePointer(op.path), 'add', value);
          break;
        }
        case 'copy': {
          const { found, value } = getAtPointer(cur, op.from);
          if (!found) throw new Error(`"from" path does not exist`);
          cur = setAtPointer(cur, parsePointer(op.path), 'add', structuredCloneSafe(value));
          break;
        }
        case 'test': {
          const { found, value } = getAtPointer(cur, op.path);
          if (!found || !deepEqual(value, op.value)) throw new Error(`test failed`);
          break;
        }
        default:
          throw new Error(`unknown op "${(op as { op: string }).op}"`);
      }
    } catch (e) {
      if (e instanceof JsonPatchError) throw e;
      throw new JsonPatchError((e as Error).message, op, i);
    }
  });
  return cur;
}

function structuredCloneSafe<T>(v: T): T {
  if (typeof v !== 'object' || v === null) return v;
  return JSON.parse(JSON.stringify(v)) as T;
}
