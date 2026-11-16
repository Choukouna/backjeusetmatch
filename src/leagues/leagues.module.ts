import { displayName } from '../players/players.repository.js';
import { Inject } from '@nestjs/common';
import {
  Controller,
  Get,
  Query,
  Post,
  Delete,
  Module,
  Injectable,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  FieldValue,
  Filter,
  Timestamp,
  type Transaction,
} from 'firebase-admin/firestore';
import { z } from 'zod';
import { FirebaseService } from '../firebase/firebase.module.js';
import { CurrentUid } from '../auth/auth.guard.js';
import {
  ApiInput,
  Input,
  Page,
  ApiQueries,
  ResourceId,
  idSchema,
  pageSchema,
  operationIdSchema,
  type PageInput,
} from '../common/http.js';
import {
  fields,
  paginate,
  requireDocument,
  participantDtos,
} from '../firebase/repository.js';
import { previousOperation, finishOperation } from '../common/operations.js';
import {
  NotificationsService,
  notificationText,
} from '../notifications/notifications.module.js';
import { assertMember } from '../chat/chat.module.js';
import { matchDto } from '../matches/matches.module.js';
import { roundRobin, standings } from './rules.js';
const roundQuery = pageSchema.extend({
  roundNumber: z.coerce.number().int().min(1).max(1000).optional(),
});
const standingsQuery = z.object({
  upToRoundNumber: z.coerce.number().int().min(1).max(1000).optional(),
});
const createSchema = z
  .object({
    operationId: operationIdSchema,
    groupId: idSchema,
    name: z.string().trim().min(1).max(120),
    playerIds: z.array(idSchema).min(2).max(28),
    sport: z.literal('Tennis').default('Tennis'),
  })
  .strict();
const leagueFields = [
  'name',
  'groupId',
  'createdByUid',
  'type',
  'nbRound',
  'nbMatch',
  'participantsUid',
  'winnerId',
  'winnerName',
  'status',
  'isPublic',
  'city',
  'deptCode',
  'registeredNumber',
  'requiredNumber',
  'endDate',
  'createdAt',
  'updatedAt',
];
const dto = (d: Record<string, unknown>, id: string) => ({
  id,
  participants: participantDtos(d.participants),
  ...fields(d, leagueFields),
});
function ended(data: Record<string, any>) {
  if (!data.endDate) return false;
  if (!(data.endDate instanceof Timestamp))
    throw new ConflictException({ code: 'UNSUPPORTED_LEAGUE_END_DATE' });
  // Flutter treats endDate as inclusive through its local calendar day.
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' });
  return day.format(data.endDate.toDate()) < day.format(new Date());
}
@Injectable()
export class LeaguesService {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}
  list(uid: string, page: PageInput) {
    return paginate(
      this.firebase.db
        .collection('tournaments')
        .where(
          Filter.or(
            Filter.where('participantsUid', 'array-contains', uid),
            Filter.where('isPublic', '==', true),
          ),
        ),
      page,
      dto,
      `leagues:${uid}`,
    ).then((p) => ({
      ...p,
      items: p.items.filter(
        (d) =>
          ((d.participantsUid as string[]) ?? []).includes(uid) ||
          (d.status === 'OPEN' &&
            (!d.requiredNumber ||
              Number(d.registeredNumber ?? 0) < Number(d.requiredNumber)) &&
            (!d.endDate ||
              (typeof d.endDate === 'string' ? d.endDate : '').slice(0, 10) >=
                new Date().toISOString().slice(0, 10))),
      ),
    }));
  }
  async access(uid: string, id: string) {
    const data = requireDocument(
      await this.firebase.db.collection('tournaments').doc(id).get(),
    );
    if (
      data.apiState === 'DELETING' ||
      (!(data.participantsUid ?? []).includes(uid) && !data.isPublic)
    )
      throw new ForbiddenException();
    return data;
  }
  async get(uid: string, id: string) {
    return dto(await this.access(uid, id), id);
  }
  async rounds(uid: string, id: string, page: PageInput) {
    await this.access(uid, id);
    return paginate(
      this.firebase.db
        .collection('tournament_rounds')
        .where('tournamentId', '==', id),
      page,
      (d, roundId) => ({
        id: roundId,
        ...fields(d, [
          'tournamentId',
          'groupId',
          'roundNumber',
          'matchIds',
          'byeUid',
          'status',
        ]),
      }),
      `rounds:${id}`,
    );
  }
  async matches(uid: string, id: string, page: z.infer<typeof roundQuery>) {
    await this.access(uid, id);
    let query = this.firebase.db
      .collection('matches')
      .where('tournamentId', '==', id);
    if (page.roundNumber)
      query = query.where('roundNumber', '==', page.roundNumber);
    return paginate(
      query,
      page,
      matchDto,
      `league-matches:${id}:${page.roundNumber ?? ''}`,
    );
  }
  async standings(uid: string, id: string, upToRoundNumber?: number) {
    const league = await this.access(uid, id);
    let query = this.firebase.db
      .collection('matches')
      .where('tournamentId', '==', id);
    if (upToRoundNumber)
      query = query.where('roundNumber', '<=', upToRoundNumber);
    const matches = await query.get();
    return {
      items: standings(
        league.participants ?? [],
        matches.docs.map((d) => d.data()),
      ),
    };
  }
  private schedule(
    tx: Transaction,
    id: string,
    groupId: string,
    ids: string[],
  ) {
    const db = this.firebase.db,
      rounds = roundRobin(ids);
    let count = 0;
    for (const round of rounds) {
      const ref = db.collection('tournament_rounds').doc(),
        matchIds: string[] = [];
      for (const pair of round.pairings) {
        const match = db.collection('matches').doc();
        matchIds.push(match.id);
        count++;
        tx.create(match, {
          player1Id: pair.player1Uid,
          player2Id: pair.player2Uid,
          winnerId: null,
          score: '[]',
          playDate: null,
          comment: 'Match de ligue',
          status: 'PENDING',
          isTournamentMatch: true,
          tournamentId: id,
          tournamentRoundId: ref.id,
          groupId,
          roundNumber: round.roundNumber,
          matchNumber: pair.matchNumber,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      tx.create(ref, {
        tournamentId: id,
        groupId,
        roundNumber: round.roundNumber,
        matchIds,
        byeUid: round.byeUid,
        status: 'PENDING',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    return { nbRound: rounds.length, nbMatch: count };
  }
  async create(uid: string, body: z.infer<typeof createSchema>) {
    const db = this.firebase.db,
      ref = db.collection('tournaments').doc();
    const ids = [...new Set(body.playerIds)];
    roundRobin(ids);
    return db.runTransaction(async (tx) => {
      const action = { kind: 'league', ...body };
      const previous = await previousOperation(
        tx,
        db,
        uid,
        body.operationId,
        action,
      );
      if (previous) return { id: previous };
      const groupRef = db.collection('groups').doc(body.groupId);
      const group = requireDocument(await tx.get(groupRef));
      const chat = requireDocument(
        await tx.get(db.collection('chats').doc(body.groupId)),
      );
      assertMember(chat, uid);
      if (
        group.apiState === 'DELETING' ||
        group.ownerUid !== uid ||
        !ids.includes(uid) ||
        ids.some((p) => !(chat.participantsUid as string[]).includes(p))
      )
        throw new ForbiddenException();
      const active = await tx.get(
        db
          .collection('tournaments')
          .where('groupId', '==', body.groupId)
          .where('status', 'in', ['OPEN', 'ONGOING'])
          .limit(1),
      );
      if (!active.empty)
        throw new ConflictException({ code: 'LEAGUE_ALREADY_ACTIVE' });
      const players = await tx.getAll(
        ...ids.map((p) => db.collection('players').doc(p)),
      );
      const participants = players.map((p) => ({
        uid: p.id,
        name: displayName(requireDocument(p)),
      }));
      const schedule = this.schedule(tx, ref.id, body.groupId, ids);
      tx.create(ref, {
        name: body.name,
        groupId: body.groupId,
        createdByUid: uid,
        type: 'RR',
        ...schedule,
        participantsUid: ids,
        participants,
        winnerName: null,
        status: 'OPEN',
        isPublic: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(groupRef, { updatedAt: FieldValue.serverTimestamp() });
      this.notifications.enqueue(
        tx,
        players.map((p) => p.data()!),
        ...notificationText.league,
      );
      finishOperation(tx, db, uid, body.operationId, action, ref.id);
      return { id: ref.id };
    });
  }
  async enrollment(uid: string, id: string, join: boolean) {
    const db = this.firebase.db,
      ref = db.collection('tournaments').doc(id);
    await db.runTransaction(async (tx) => {
      const league = requireDocument(await tx.get(ref));
      if (!league.isPublic || league.status !== 'OPEN' || ended(league))
        throw new ConflictException({ code: 'LEAGUE_CLOSED' });
      if ((league.sport ?? 'Tennis') !== 'Tennis' || league.type !== 'RR')
        throw new BadRequestException({ code: 'UNSUPPORTED_LEAGUE' });
      let ids = (league.participantsUid ?? []) as string[];
      if (ids.includes(uid) === join) return;
      const own = requireDocument(
        await tx.get(db.collection('players').doc(uid)),
      );
      if (join && own.playsTennis === false)
        throw new ForbiddenException({ code: 'LEAGUE_INELIGIBLE' });
      const required = Number(league.requiredNumber ?? 0);
      if (join && (required > 28 || (required > 0 && ids.length >= required)))
        throw new ConflictException({ code: 'LEAGUE_FULL' });
      ids = join ? [...ids, uid] : ids.filter((p) => p !== uid);
      const participants = (league.participants ?? []).filter(
        (p: { uid: string }) => p.uid !== uid,
      );
      if (join) participants.push({ uid, name: displayName(own) });
      const full = join && required > 0 && ids.length === required;
      const recipients = full
        ? await tx.getAll(...ids.map((p) => db.collection('players').doc(p)))
        : [];
      const schedule =
        full && !league.nbMatch
          ? this.schedule(tx, id, String(league.groupId ?? ''), ids)
          : {};
      tx.update(ref, {
        participantsUid: ids,
        participants,
        registeredNumber: ids.length,
        ...schedule,
        ...(full ? { status: 'ONGOING' } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (full)
        this.notifications.enqueue(
          tx,
          recipients.filter((p) => p.exists).map((p) => p.data()!),
          ...notificationText.league,
        );
    });
    return { id };
  }
  async close(uid: string, id: string) {
    const db = this.firebase.db,
      ref = db.collection('tournaments').doc(id);
    await db.runTransaction(async (tx) => {
      const league = requireDocument(await tx.get(ref));
      if (!(league.participantsUid ?? []).includes(uid))
        throw new ForbiddenException();
      if (!league.isPublic && league.createdByUid !== uid)
        throw new ForbiddenException();
      if (league.groupId) {
        const group = requireDocument(
          await tx.get(db.collection('groups').doc(String(league.groupId))),
        );
        if (group.apiState === 'DELETING')
          throw new ConflictException({ code: 'GROUP_DELETING' });
      }
      if (league.status === 'COMPLETED') return;
      if (league.isPublic && league.status !== 'ONGOING')
        throw new ConflictException({ code: 'LEAGUE_NOT_STARTED' });
      const matches = await tx.get(
        db.collection('matches').where('tournamentId', '==', id),
      );
      const rows = standings(
        league.participants ?? [],
        matches.docs.map((d) => d.data()),
      );
      const winner = rows[0]?.wins > 0 ? rows[0] : null;
      tx.update(ref, {
        status: 'COMPLETED',
        winnerId: winner?.uid ?? null,
        winnerName: winner?.name ?? null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return { id };
  }
}
@ApiTags('leagues')
@ApiBearerAuth()
@Controller('leagues')
class LeaguesController {
  constructor(
    @Inject(LeaguesService) private readonly leagues: LeaguesService,
  ) {}
  @Get() @ApiQueries(pageSchema) list(
    @CurrentUid() uid: string,
    @Page() page: PageInput,
  ) {
    return this.leagues.list(uid, page);
  }
  @Get(':id') get(@CurrentUid() uid: string, @ResourceId() id: string) {
    return this.leagues.get(uid, id);
  }
  @Get(':id/rounds') @ApiQueries(pageSchema) rounds(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
    @Page() page: PageInput,
  ) {
    return this.leagues.rounds(uid, id, page);
  }
  @Get(':id/matches') @ApiQueries(roundQuery) matches(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
    @Query({ schema: roundQuery }) page: z.infer<typeof roundQuery>,
  ) {
    return this.leagues.matches(uid, id, page);
  }
  @Get(':id/standings') @ApiQueries(standingsQuery) standings(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
    @Query({ schema: standingsQuery }) query: z.infer<typeof standingsQuery>,
  ) {
    return this.leagues.standings(uid, id, query.upToRoundNumber);
  }
  @Post() @ApiInput(createSchema) create(
    @CurrentUid() uid: string,
    @Input(createSchema) body: z.infer<typeof createSchema>,
  ) {
    return this.leagues.create(uid, body);
  }
  @Post(':id/enrollment') join(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
  ) {
    return this.leagues.enrollment(uid, id, true);
  }
  @Delete(':id/enrollment') leave(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
  ) {
    return this.leagues.enrollment(uid, id, false);
  }
  @Post(':id/close') close(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
  ) {
    return this.leagues.close(uid, id);
  }
}
@Module({ controllers: [LeaguesController], providers: [LeaguesService] })
export class LeaguesModule {}
