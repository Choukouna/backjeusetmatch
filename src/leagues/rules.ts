import { BadRequestException } from '@nestjs/common';
export type Pairing = {
  player1Uid: string;
  player2Uid: string;
  matchNumber: number;
};
export function roundRobin(ids: string[]) {
  if (ids.length < 2 || new Set(ids).size !== ids.length || ids.length > 28)
    throw new BadRequestException({ code: 'INVALID_LEAGUE_PLAYERS' });
  const rotating: (string | null)[] = [...ids];
  if (rotating.length % 2) rotating.push(null);
  const rounds: {
    roundNumber: number;
    byeUid: string | null;
    pairings: Pairing[];
  }[] = [];
  for (let round = 0; round < rotating.length - 1; round++) {
    const pairings: Pairing[] = [];
    let byeUid: string | null = null;
    for (let i = 0; i < rotating.length / 2; i++) {
      const a = rotating[i],
        b = rotating[rotating.length - 1 - i];
      if (a === null) byeUid = b;
      else if (b === null) byeUid = a;
      else pairings.push({ player1Uid: a, player2Uid: b, matchNumber: i + 1 });
    }
    rounds.push({ roundNumber: round + 1, byeUid, pairings });
    rotating.splice(1, 0, rotating.pop()!);
  }
  return rounds;
}
export function standings(
  participants: { uid: string; name: string }[],
  matches: Record<string, any>[],
) {
  const rows = new Map(
    participants.map((p) => [p.uid, { ...p, wins: 0, losses: 0 }]),
  );
  for (const match of matches) {
    if (
      !match.winnerId ||
      ![match.player1Id, match.player2Id].includes(match.winnerId)
    )
      continue;
    const loser =
      match.winnerId === match.player1Id ? match.player2Id : match.player1Id;
    const winnerRow = rows.get(match.winnerId),
      loserRow = rows.get(loser);
    if (winnerRow) winnerRow.wins++;
    if (loserRow) loserRow.losses++;
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.wins - a.wins ||
      a.losses - b.losses ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}
