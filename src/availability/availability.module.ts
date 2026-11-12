import { Inject } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Query,
  Module,
  Injectable,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FirebaseService } from '../firebase/firebase.module.js';
import { CurrentUid } from '../auth/auth.guard.js';
import {
  ApiInput,
  ApiQueries,
  Input,
  ResourceId,
  operationIdSchema,
  pageSchema,
} from '../common/http.js';
import { fields, paginate, requireDocument } from '../firebase/repository.js';
import { previousOperation, finishOperation } from '../common/operations.js';
import {
  NotificationsService,
  notificationText,
} from '../notifications/notifications.module.js';
import {
  validateSlot,
  slotResponse,
  parisDay,
  parisDayBounds,
} from './rules.js';
function reservation(db: FirebaseService['db'], uid: string, start: Date) {
  const key = createHash('sha256')
    .update(`${uid}:${start.toISOString()}`)
    .digest('hex');
  return db.collection('_api_slot_reservations').doc(key);
}
const createSchema = z
  .object({
    operationId: operationIdSchema,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    sports: z.array(z.enum(['Tennis', 'Padel'])).length(1),
    location: z
      .object({
        stade: z.string().trim().min(1).max(200),
        city: z.string().trim().min(1).max(120),
        nbRequis: z.number().int().min(1).max(3),
      })
      .strict(),
  })
  .strict();
const discoverySchema = pageSchema.extend({
  deptCode: z.string().min(2).max(3).optional(),
  city: z.string().max(120).optional(),
  day: z.iso.date().optional(),
});
const responseSchema = z
  .object({ accept: z.boolean(), operationId: operationIdSchema })
  .strict();
const slotDto = (d: Record<string, unknown>, id: string) => ({
  id,
  ...fields(d, [
    'ownerUid',
    'deptCode',
    'participants',
    'status',
    'start',
    'end',
    'sports',
    'location',
    'opponentUid',
    'opponentUsername',
    'createdAt',
    'updatedAt',
  ]),
});
@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}
  list(uid: string, query: z.infer<typeof discoverySchema>) {
    const collection = this.firebase.db.collection('players_slot');
    const filtered = query.deptCode
      ? collection.where('deptCode', '==', query.deptCode)
      : collection.where('participants', 'array-contains', uid);
    const today = parisDay(new Date()).day;
    const last = new Date(`${today}T12:00:00Z`);
    last.setUTCDate(last.getUTCDate() + 14);
    const lastDay = last.toISOString().slice(0, 10);
    if (query.day && (query.day < today || query.day > lastDay))
      throw new BadRequestException({ code: 'SLOT_INVALID_DAY' });
    const start = parisDayBounds(query.day ?? today).start;
    const end = parisDayBounds(query.day ?? lastDay).end;
    return paginate(
      filtered
        .where('start', '>=', start)
        .where('start', '<', end)
        .orderBy('start'),
      query,
      slotDto,
      `slots:${query.deptCode ?? uid}:${query.city ?? ''}:${query.day ?? today}`,
      collection.path,
    ).then((page) => ({
      ...page,
      items: page.items.filter(
        (d) =>
          !query.city ||
          String(
            (d.location as Record<string, unknown>)?.city,
          ).toLowerCase() === query.city.toLowerCase(),
      ),
    }));
  }
  async create(uid: string, body: z.infer<typeof createSchema>) {
    validateSlot(body);
    const db = this.firebase.db,
      ref = db.collection('players_slot').doc();
    return db.runTransaction(async (tx) => {
      const previous = await previousOperation(tx, db, uid, body.operationId, {
        kind: 'slot',
        ...body,
      });
      if (previous) return { id: previous };
      const player = requireDocument(
        await tx.get(db.collection('players').doc(uid)),
      );
      const start = new Date(body.start);
      const lock = reservation(db, uid, start);
      await tx.get(lock); // Shared read/write serializes backend bookings across different slot documents.
      const occupied = await tx.get(
        db
          .collection('players_slot')
          .where('participants', 'array-contains', uid)
          .where('start', '==', Timestamp.fromDate(start))
          .limit(1),
      );
      if (!occupied.empty)
        throw new ConflictException({ code: 'SLOT_OCCUPIED' });
      const bounds = parisDayBounds(parisDay(start).day);
      const departmentSlots = await tx.get(
        db
          .collection('players_slot')
          .where('deptCode', '==', player.deptCode)
          .where('start', '>=', bounds.start)
          .where('start', '<', bounds.end),
      );
      const recipients = await tx.get(
        db.collection('players').where('deptCode', '==', player.deptCode),
      );
      const sameDay = departmentSlots.docs.filter(
        (d) =>
          d.get('start') instanceof Timestamp &&
          parisDay(d.get('start').toDate()).day === parisDay(start).day,
      );
      const lastCreated = Math.max(
        0,
        ...sameDay.map((d) =>
          d.get('createdAt') instanceof Timestamp
            ? d.get('createdAt').toMillis()
            : 0,
        ),
      );
      const notified = recipients.docs
        .filter((d) => {
          const p = d.data();
          const frequency = p.notificationFrequency ?? '2h';
          const delay =
            frequency === 'daily'
              ? 86400000
              : frequency === '6h'
                ? 21600000
                : 7200000;
          return (
            d.id !== uid &&
            frequency !== 'never' &&
            (body.sports[0] === 'Padel'
              ? p.playsPadel === true
              : p.playsTennis !== false) &&
            Date.now() - lastCreated > delay
          );
        })
        .map((d) => d.data());
      validateSlot(body);
      const { operationId: _operationId, ...slot } = body;
      tx.set(lock, { slotId: ref.id });
      tx.create(ref, {
        ...slot,
        start,
        end: new Date(body.end),
        ownerUid: uid,
        deptCode: player.deptCode,
        participants: [uid],
        status: 'AVAILABLE',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      const day = parisDay(start).day.split('-').reverse().join('-');
      this.notifications.enqueue(
        tx,
        notified,
        'Nouveau créneau',
        `Un joueur a ajouté un créneau pour le ${day}`,
      );
      finishOperation(
        tx,
        db,
        uid,
        body.operationId,
        { kind: 'slot', ...body },
        ref.id,
      );
      return { id: ref.id };
    });
  }
  async request(uid: string, id: string) {
    const db = this.firebase.db,
      ref = db.collection('players_slot').doc(id);
    await db.runTransaction(async (tx) => {
      const slot = requireDocument(await tx.get(ref));
      if (slot.ownerUid === uid) throw new ForbiddenException();
      if (slot.status === 'PENDING' && slot.opponentUid === uid) return;
      if (
        slot.status !== 'AVAILABLE' ||
        (slot.participants ?? []).includes(uid)
      )
        throw new ConflictException({ code: 'SLOT_UNAVAILABLE' });
      if (
        !(slot.start instanceof Timestamp) ||
        slot.start.toMillis() <= Date.now()
      )
        throw new ConflictException({ code: 'SLOT_EXPIRED' });
      const lock = reservation(db, uid, slot.start.toDate());
      await tx.get(lock);
      const occupied = await tx.get(
        db
          .collection('players_slot')
          .where('participants', 'array-contains', uid)
          .where('start', '==', slot.start)
          .limit(1),
      );
      if (!occupied.empty)
        throw new ConflictException({ code: 'SLOT_OCCUPIED' });
      const own = requireDocument(
        await tx.get(db.collection('players').doc(uid)),
      );
      const owner = requireDocument(
        await tx.get(db.collection('players').doc(String(slot.ownerUid))),
      );
      tx.set(lock, { slotId: id });
      tx.update(ref, {
        opponentUid: uid,
        opponentUsername: own.pseudo,
        participants: FieldValue.arrayUnion(uid),
        status: 'PENDING',
        updatedAt: FieldValue.serverTimestamp(),
      });
      this.notifications.enqueue(tx, [owner], ...notificationText.request);
    });
    return { id };
  }
  async respond(uid: string, id: string, body: z.infer<typeof responseSchema>) {
    const db = this.firebase.db,
      ref = db.collection('players_slot').doc(id);
    await db.runTransaction(async (tx) => {
      const action = { kind: 'slot-response', id, ...body };
      if (await previousOperation(tx, db, uid, body.operationId, action))
        return;
      const slot = requireDocument(await tx.get(ref));
      const patch = slotResponse(slot, uid, body.accept);
      const lock = reservation(
        db,
        String(slot.opponentUid),
        slot.start.toDate(),
      );
      const claim = await tx.get(lock);
      const other = requireDocument(
        await tx.get(db.collection('players').doc(String(slot.opponentUid))),
      );
      if (!body.accept && claim.get('slotId') === id) tx.delete(lock);
      tx.update(ref, {
        ...patch,
        opponentUid: FieldValue.delete(),
        opponentUsername: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      this.notifications.enqueue(tx, [other], ...notificationText.response);
      finishOperation(tx, db, uid, body.operationId, action, id);
    });
    return { id };
  }
  async remove(uid: string, id: string) {
    const db = this.firebase.db,
      ref = db.collection('players_slot').doc(id);
    await db.runTransaction(async (tx) => {
      const slot = await tx.get(ref);
      if (!slot.exists) return;
      if (slot.get('ownerUid') !== uid) throw new ForbiddenException();
      const participants = (slot.get('participants') ?? [uid]) as string[];
      const locks = participants.map((p) =>
        reservation(db, p, (slot.get('start') as Timestamp).toDate()),
      );
      const claims = locks.length ? await tx.getAll(...locks) : [];
      claims
        .filter((c) => c.get('slotId') === id)
        .forEach((c) => tx.delete(c.ref));
      tx.delete(ref);
    });
    return { deleted: true };
  }
}
@ApiTags('availability')
@ApiBearerAuth()
@Controller('slots')
class AvailabilityController {
  constructor(
    @Inject(AvailabilityService) private readonly slots: AvailabilityService,
  ) {}
  @Get() @ApiQueries(discoverySchema) list(
    @CurrentUid() uid: string,
    @Query({ schema: discoverySchema }) query: z.infer<typeof discoverySchema>,
  ) {
    return this.slots.list(uid, query);
  }
  @Post() @ApiInput(createSchema) create(
    @CurrentUid() uid: string,
    @Input(createSchema) body: z.infer<typeof createSchema>,
  ) {
    return this.slots.create(uid, body);
  }
  @Post(':id/request') request(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
  ) {
    return this.slots.request(uid, id);
  }
  @Put(':id/response') @ApiInput(responseSchema) respond(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
    @Input(responseSchema) body: z.infer<typeof responseSchema>,
  ) {
    return this.slots.respond(uid, id, body);
  }
  @Delete(':id') remove(@CurrentUid() uid: string, @ResourceId() id: string) {
    return this.slots.remove(uid, id);
  }
}
@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
})
export class AvailabilityModule {}
