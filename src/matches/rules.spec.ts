import { scoreWinner, normalizeScore, compareRanks } from './rules.js';
describe('legacy match rules', () => {
  it('normalizes a player-two submission to scheduled order', () => {
    const sets = [
      { gamesA: 6, gamesB: 4 },
      { gamesA: 3, gamesB: 6 },
      { gamesA: 6, gamesB: 2 },
    ];
    expect(scoreWinner(sets)).toBe(1);
    expect(JSON.parse(normalizeScore(sets, false))).toEqual([
      { gamesA: 4, gamesB: 6 },
      { gamesA: 6, gamesB: 3 },
      { gamesA: 2, gamesB: 6 },
    ]);
  });
  it('rejects ambiguous and malformed scores', () => {
    expect(() =>
      scoreWinner([
        { gamesA: 6, gamesB: 4 },
        { gamesA: 4, gamesB: 6 },
      ]),
    ).toThrow();
    expect(() => scoreWinner([{ gamesA: 6, gamesB: 6 }])).toThrow();
    expect(() => scoreWinner([{ gamesA: -1, gamesB: 6 }])).toThrow();
  });
  it.each([
    ['30/1', '30/2'],
    ['15', '30'],
    ['0', '15'],
    ['-2/6', '0'],
    ['-4/6', '-2/6'],
    ['40', 'NC'],
  ])('ranks %s above %s', (a, b) => {
    expect(compareRanks(a, b)).toBe(1);
    expect(compareRanks(b, a)).toBe(-1);
  });
  it('uses 50 for NC comparison', () => {
    expect(compareRanks('NC', '50')).toBe(0);
  });
});
