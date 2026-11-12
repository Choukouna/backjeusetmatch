import { Inject } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Put,
  Module,
  Injectable,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FieldValue, Filter } from 'firebase-admin/firestore';
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
  operationIdSchema,
  pageSchema,
  type PageInput,
} from '../common/http.js';
import { fields, paginate, requireDocument } from '../firebase/repository.js';
import { previousOperation, finishOperation } from '../common/operations.js';
import { normalizeScore, scoreWinner, compareRanks } from './rules.js';
const scoreSchema = z
  .object({
    operationId: operationIdSchema,
    sets: z
      .array(
        z
          .object({
            gamesA: z.number().int().min(0).max(99),
            gamesB: z.number().int().min(0).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    playDate: z.iso.datetime({ offset: true }),
    comment: z.string().max(2000).default(''),
  })
  .strict();
const createSchema = scoreSchema.extend({ opponentId: idSchema }).strict();
const matchFields = [
  'player1Id',
  'player2Id',
  'winnerId',
  'score',
  'playDate',
  'comment',
  'status',
  'isTournamentMatch',
  'tournamentId',
  'tournamentRoundId',
  'roundNumber',
  'matchNumber',
  'updatedAt',
  'createdAt',
];
export const matchDto = (d: Record<string, unknown>, id: string) => ({
  id,
  ...fields(d, matchFields),
});
@Injectable()
export class MatchesService {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
  ) {}
  list(uid: string, page: PageInput) {
    return paginate(
      this.firebase.db
        .collection('matches')
        .where(
          Filter.or(
            Filter.where('player1Id', '==', uid),
            Filter.where('player2Id', '==', uid),
          ),
        ),
      page,
      matchDto,
      `matches:${uid}`,
    );
  }
  async save(
    uid: string,
    body: z.infer<typeof createSchema> | z.infer<typeof scoreSchema>,
    scheduledId?: string,
  ) {
    scoreWinner(body.sets);
    if (new Date(body.playDate).getTime() > Date.now())
      throw new BadRequestException({ code: 'FUTURE_MATCH' });
    const db = this.firebase.db;
    const ref = scheduledId
      ? db.collection('matches').doc(scheduledId)
      : db.collection('matches').doc();
    return db.runTransaction(async (tx) => {
      const action = {
        kind: 'match',
        scheduledId: scheduledId ?? null,
        ...body,
      };
      const previous = await previousOperation(
        tx,
        db,
        uid,
        body.operationId,
        action,
      );
      if (previous) return { id: previous };
      const existing = scheduledId
        ? requireDocument(await tx.get(ref))
        : undefined;
      const player1Id = existing ? String(existing.player1Id) : uid;
      const player2Id = existing
        ? String(existing.player2Id)
        : (body as z.infer<typeof createSchema>).opponentId;
      if (uid !== player1Id && uid !== player2Id)
        throw new ForbiddenException();
      if (player1Id === player2Id)
        throw new BadRequestException({ code: 'SELF_MATCH' });
      if (existing && (!existing.isTournamentMatch || existing.winnerId))
        throw new ConflictException({ code: 'SCORE_ALREADY_RECORDED' });
      const tournament = existing?.tournamentId
        ? db.collection('tournaments').doc(String(existing.tournamentId))
        : undefined;
      const tournamentData = tournament
        ? requireDocument(await tx.get(tournament))
        : undefined;
      if (tournamentData?.groupId) {
        const group = requireDocument(
          await tx.get(
            db.collection('groups').doc(String(tournamentData.groupId)),
          ),
        );
        if (group.apiState === 'DELETING')
          throw new ConflictException({ code: 'GROUP_DELETING' });
      }
      if (tournamentData?.status === 'COMPLETED')
        throw new ConflictException({ code: 'LEAGUE_COMPLETED' });
      const p1Ref = db.collection('players').doc(player1Id),
        p2Ref = db.collection('players').doc(player2Id);
      const p1 = requireDocument(await tx.get(p1Ref)),
        p2 = requireDocument(await tx.get(p2Ref));
      const winnerId =
        scoreWinner(body.sets) === 1
          ? uid
          : uid === player1Id
            ? player2Id
            : player1Id;
      const p1Won = winnerId === player1Id;
      const stats = (
        own: Record<string, unknown>,
        other: Record<string, unknown>,
        win: boolean,
      ) => {
        const result: Record<string, unknown> = {
          [win ? 'wins' : 'losses']: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        };
        const field = win ? 'bestWin' : 'worstDefeat';
        if (
          typeof other.rank === 'string' &&
          (!own[field] ||
            (win
              ? compareRanks(
                  other.rank,
                  (typeof own[field] === 'string' ? own[field] : '') as string,
                ) > 0
              : compareRanks(
                  other.rank,
                  (typeof own[field] === 'string' ? own[field] : '') as string,
                ) < 0))
        )
          result[field] = other.rank;
        return result;
      };
      const data = {
        player1Id,
        player2Id,
        winnerId,
        score: normalizeScore(body.sets, uid === player1Id),
        playDate: new Date(body.playDate),
        comment: body.comment,
        status: 'DONE',
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (existing) tx.update(ref, data);
      else tx.create(ref, { ...data, createdAt: FieldValue.serverTimestamp() });
      const stat1 = stats(p1, p2, p1Won),
        stat2 = stats(p2, p1, !p1Won);
      if (Object.keys(stat1).length) tx.update(p1Ref, stat1);
      if (Object.keys(stat2).length) tx.update(p2Ref, stat2);
      if (tournament)
        tx.update(tournament, {
          status: 'ONGOING',
          updatedAt: FieldValue.serverTimestamp(),
        });
      finishOperation(tx, db, uid, body.operationId, action, ref.id);
      return { id: ref.id };
    });
  }
}
@ApiTags('matches')
@ApiBearerAuth()
@Controller('matches')
class MatchesController {
  constructor(
    @Inject(MatchesService) private readonly matches: MatchesService,
  ) {}
  @Get() @ApiQueries(pageSchema) list(
    @CurrentUid() uid: string,
    @Page() page: PageInput,
  ) {
    return this.matches.list(uid, page);
  }
  @Post() @ApiInput(createSchema) create(
    @CurrentUid() uid: string,
    @Input(createSchema) body: z.infer<typeof createSchema>,
  ) {
    return this.matches.save(uid, body);
  }
  @Put(':id/score') @ApiInput(scoreSchema) score(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
    @Input(scoreSchema) body: z.infer<typeof scoreSchema>,
  ) {
    return this.matches.save(uid, body, id);
  }
}
@Module({ controllers: [MatchesController], providers: [MatchesService] })
export class MatchesModule {}
