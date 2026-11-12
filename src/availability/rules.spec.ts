import { validateSlot, slotResponse, parisDayBounds } from './rules.js';
const now = new Date('2026-03-27T12:00:00Z');
const slot = {
  start: '2026-03-29T08:00:00+02:00',
  end: '2026-03-29T09:00:00+02:00',
  sports: ['Padel'] as 'Padel'[],
  location: { stade: 'Stade', city: 'Rennes', nbRequis: 3 },
};
describe('availability rules', () => {
  it('uses Paris calendar time across daylight saving', () => {
    expect(() => validateSlot(slot, now)).not.toThrow();
  });
  it('uses 23-hour and 25-hour Paris days at DST transitions', () => {
    const spring = parisDayBounds('2026-03-29'),
      autumn = parisDayBounds('2026-10-25');
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3600000);
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * 3600000);
  });
  it('permits the inclusive fourteenth day', () => {
    expect(() =>
      validateSlot(
        {
          ...slot,
          start: '2026-04-10T21:00:00+02:00',
          end: '2026-04-10T22:00:00+02:00',
        },
        now,
      ),
    ).not.toThrow();
  });
  it.each([
    { ...slot, start: '2026-03-29T07:00:00+02:00' },
    { ...slot, end: '2026-03-29T10:00:00+02:00' },
    {
      ...slot,
      start: '2026-04-11T08:00:00+02:00',
      end: '2026-04-11T09:00:00+02:00',
    },
    { ...slot, sports: ['Tennis'] as 'Tennis'[] },
  ])('rejects invalid time or capacity %#', (invalid) => {
    expect(() => validateSlot(invalid, now)).toThrow();
  });
  it('decreases padel capacity once per pending request', () => {
    const data = {
      ownerUid: 'owner',
      opponentUid: 'guest',
      status: 'PENDING',
      participants: ['owner', 'accepted', 'guest'],
      location: { nbRequis: 2 },
    };
    expect(slotResponse(data, 'owner', true)).toEqual({
      status: 'AVAILABLE',
      participants: ['owner', 'accepted', 'guest'],
      'location.nbRequis': 1,
    });
    expect(slotResponse(data, 'owner', false).participants).toEqual([
      'owner',
      'accepted',
    ]);
    expect(() => slotResponse(data, 'outsider', true)).toThrow();
    expect(() =>
      slotResponse({ ...data, status: 'ACCEPTED' }, 'owner', true),
    ).toThrow();
  });
});
