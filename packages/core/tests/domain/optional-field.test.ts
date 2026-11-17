import { describe, expect, it } from 'vitest';
import { optionalField } from '../../src/domain/kernel/optional-field';

describe('optionalField', () => {
  it('omits the field only when the value is undefined', () => {
    expect(optionalField('attemptId', undefined)).toEqual({});
    expect(Object.keys(optionalField('attemptId', undefined))).toEqual([]);
  });

  it('keeps every defined value as it is, falsy ones included', () => {
    expect(optionalField('attemptId', 'A')).toEqual({ attemptId: 'A' });
    expect(optionalField('detail', '')).toEqual({ detail: '' });
    expect(optionalField('count', 0)).toEqual({ count: 0 });
    expect(optionalField('flag', false)).toEqual({ flag: false });
  });
});
