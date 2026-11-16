import { roundRobin, standings } from './rules.js';
describe('round robin', () => {
  it.each([2, 3, 4, 7, 28])(
    'schedules every pair exactly once for %i players',
    (n) => {
      const ids = Array.from({ length: n }, (_, i) => `p${i}`),
        rounds = roundRobin(ids);
      const pairs = rounds.flatMap((r) =>
        r.pairings.map((p) => [p.player1Uid, p.player2Uid].sort().join(':')),
      );
      expect(pairs).toHaveLength((n * (n - 1)) / 2);
      expect(new Set(pairs).size).toBe(pairs.length);
      for (const round of rounds) {
        const played = round.pairings.flatMap((p) => [
          p.player1Uid,
          p.player2Uid,
        ]);
        expect(new Set(played).size).toBe(played.length);
        if (n % 2) expect(played).not.toContain(round.byeUid);
      }
      if (n % 2) expect(new Set(rounds.map((r) => r.byeUid)).size).toBe(n);
    },
  );
  it('rejects duplicates and schedules exceeding one transaction', () => {
    expect(() => roundRobin(['a', 'a'])).toThrow();
    expect(() =>
      roundRobin(Array.from({ length: 29 }, (_, i) => String(i))),
    ).toThrow();
  });
  it('ignores unplayed matches and sorts wins before losses', () => {
    const rows = standings(
      [
        { uid: 'a', name: 'Alice' },
        { uid: 'b', name: 'Bob' },
      ],
      [
        { player1Id: 'a', player2Id: 'b', winnerId: 'b' },
        { player1Id: 'a', player2Id: 'b', winnerId: null },
      ],
    );
    expect(rows[0]).toEqual({ uid: 'b', name: 'Bob', wins: 1, losses: 0 });
  });
});
