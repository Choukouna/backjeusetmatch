import { BadRequestException } from '@nestjs/common';
export type SetScore = { gamesA: number; gamesB: number };
export function scoreWinner(sets: SetScore[]): 1 | 2 {
  if (
    !sets.length ||
    sets.some(
      (s) =>
        !Number.isInteger(s.gamesA) ||
        !Number.isInteger(s.gamesB) ||
        s.gamesA < 0 ||
        s.gamesB < 0 ||
        s.gamesA === s.gamesB,
    )
  )
    throw new BadRequestException({ code: 'INVALID_SCORE' });
  const balance = sets.reduce((n, s) => n + Math.sign(s.gamesA - s.gamesB), 0);
  if (!balance) throw new BadRequestException({ code: 'AMBIGUOUS_SCORE' });
  return balance > 0 ? 1 : 2;
}
export function normalizeScore(sets: SetScore[], submittedByPlayer1: boolean) {
  return JSON.stringify(
    sets.map((s) => ({
      gamesA: submittedByPlayer1 ? s.gamesA : s.gamesB,
      gamesB: submittedByPlayer1 ? s.gamesB : s.gamesA,
    })),
  );
}
export function compareRanks(left: string, right: string) {
  const parse = (value: string) => {
    const [n, d] = (value === 'NC' ? '50' : value).split('/').map(Number);
    return { sign: value.startsWith('-') ? -1 : 1, n: Math.abs(n), d: d ?? 0 };
  };
  const a = parse(left),
    b = parse(right);
  if (a.sign !== b.sign) return a.sign < b.sign ? 1 : -1;
  return -Math.sign(a.n - b.n || a.d - b.d) * a.sign || 0;
}
