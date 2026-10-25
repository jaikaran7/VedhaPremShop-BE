// Lets the frontend's node:test files run unchanged under jest: same assertions, expressed with expect.
const shim = {
  equal: (actual: unknown, expected: unknown) => expect(actual).toBe(expected),
  notEqual: (actual: unknown, expected: unknown) => expect(actual).not.toBe(expected),
  deepEqual: (actual: unknown, expected: unknown) => expect(actual).toEqual(expected),
  ok: (value: unknown) => expect(value).toBeTruthy(),
};
export default shim;
