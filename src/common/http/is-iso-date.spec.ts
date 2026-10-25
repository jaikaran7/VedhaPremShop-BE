import { isIsoDate } from './is-iso-date';

describe('isIsoDate', () => {
  it.each(['2026-10-26', '2028-02-29', '2026-12-31'])('accepts %s', (value) => expect(isIsoDate(value)).toBe(true));

  it.each(['2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-10-32', '26-10-26', '2026-1-5', '2026-10-26T00:00:00Z', '', null, 20261026])(
    'rejects %s',
    (value) => expect(isIsoDate(value)).toBe(false),
  );
});
