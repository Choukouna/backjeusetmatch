import { Inject } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Module,
  Injectable,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FieldValue } from 'firebase-admin/firestore';
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
import {
  fields,
  paginate,
  requireDocument,
  participantDtos,
} from '../firebase/repository.js';
import { previousOperation, finishOperation } from '../common/operations.js';
import { pairId } from '../friendships/friendships.module.js';
import { assertMember } from '../chat/chat.module.js';
const membersSchema = z
  .object({ playerIds: z.array(idSchema).min(1).max(30) })
  .strict();
const createSchema = membersSchema
  .extend({
    name: z.string().trim().min(1).max(120),
    operationId: operationIdSchema,
  })
  .strict();
@Injectable()
export class GroupsService {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
  ) {}
  async list(uid: string, page: PageInput) {
    const result = await paginate(
      this.firebase.db
        .collection('chats')
        .where('participantsUid', 'array-contains', uid)
        .where('type', '==', 'GROUP'),
      page,
      (d, id) => ({
        id,
        participants: participantDtos(d.participants),
        ...fields(d, ['participantsUid', 'createdAt', 'updatedAt']),
      }),
      `groups:${uid}`,
    );
    if (!result.items.length) return result;
    const groups = await this.firebase.db.getAll(
      ...result.items.map((item) =>
        this.firebase.db.collection('groups').doc(String(item.id)),
      ),
    );
    return {
      ...result,
      items: result.items.flatMap((item, i) =>
        !groups[i].exists || groups[i].get('apiState') === 'DELETING'
          ? []
          : [{ ...item, ...fields(groups[i].data()!, ['name', 'ownerUid']) }],
      ),
    };
  }
  async get(uid: string, id: string) {
    const db = this.firebase.db;
    const [group, chat] = await Promise.all([
      db.collection('groups').doc(id).get(),
      db.collection('chats').doc(id).get(),
    ]);
    const data = requireDocument(chat);
    assertMember(data, uid);
    return {
      id,
      ...fields(requireDocument(group), [
        'name',
        'ownerUid',
        'createdAt',
        'updatedAt',
      ]),
      participants: participantDtos(data.participants),
      ...fields(data, ['participantsUid']),
    };
  }
  async members(
    uid: string,
    id: string | undefined,
    body: z.infer<typeof membersSchema> & {
      name?: string;
      operationId?: string;
    },
  ) {
    const db = this.firebase.db,
      groupRef = id
        ? db.collection('groups').doc(id)
        : db.collection('groups').doc(),
      chatRef = db.collection('chats').doc(groupRef.id);
    return db.runTransaction(async (tx) => {
      const action = { kind: 'group', ...body };
      if (!id && body.operationId) {
        const previous = await previousOperation(
          tx,
          db,
          uid,
          body.operationId,
          action,
        );
        if (previous) return { id: previous };
      }
      const oldGroup = id ? requireDocument(await tx.get(groupRef)) : undefined;
      const oldChat = id ? requireDocument(await tx.get(chatRef)) : undefined;
      if (oldGroup && oldChat) {
        assertMember(oldChat, uid);
        if (oldGroup.ownerUid !== uid) throw new ForbiddenException();
      }
      const existing = (oldChat?.participantsUid ?? []) as string[];
      const newIds = [...new Set([uid, ...body.playerIds])].filter(
        (p) => !existing.includes(p),
      );
      const friendIds = newIds.filter((p) => p !== uid);
      const friendships = friendIds.length
        ? await tx.getAll(
            ...friendIds.map((p) =>
              db.collection('friend_requests').doc(pairId(uid, p)),
            ),
          )
        : [];
      if (
        friendships.some(
          (f) =>
            !f.exists ||
            f.get('status') !== 'ACCEPTED' ||
            ![f.get('fromUid'), f.get('toUid')].includes(uid),
        )
      )
        throw new ForbiddenException({ code: 'FRIENDSHIP_REQUIRED' });
      const players = newIds.length
        ? await tx.getAll(...newIds.map((p) => db.collection('players').doc(p)))
        : [];
      const participants = players.map((p) => ({
        uid: p.id,
        name: requireDocument(p).pseudo,
      }));
      if (existing.length + newIds.length > 30)
        throw new ConflictException({ code: 'GROUP_FULL' });
      if (id)
        tx.update(chatRef, {
          participantsUid: [...existing, ...newIds],
          participants: [...(oldChat!.participants ?? []), ...participants],
          updatedAt: FieldValue.serverTimestamp(),
        });
      else {
        tx.create(groupRef, {
          ownerUid: uid,
          name: body.name,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.create(chatRef, {
          type: 'GROUP',
          participantsUid: newIds,
          participants,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        finishOperation(tx, db, uid, body.operationId!, action, groupRef.id);
      }
      return { id: groupRef.id };
    });
  }
  async leave(uid: string, id: string) {
    const db = this.firebase.db,
      ref = db.collection('chats').doc(id);
    await db.runTransaction(async (tx) => {
      const group = requireDocument(
          await tx.get(db.collection('groups').doc(id)),
        ),
        chat = requireDocument(await tx.get(ref));
      assertMember(chat, uid);
      if (group.ownerUid === uid)
        throw new ConflictException({ code: 'OWNER_CANNOT_LEAVE' });
      tx.update(ref, {
        participantsUid: (chat.participantsUid as string[]).filter(
          (p) => p !== uid,
        ),
        participants: (chat.participants as { uid: string }[]).filter(
          (p) => p.uid !== uid,
        ),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return { left: true };
  }
  async remove(uid: string, id: string) {
    const db = this.firebase.db,
      group = db.collection('groups').doc(id),
      chat = db.collection('chats').doc(id);
    await db.runTransaction(async (tx) => {
      const data = requireDocument(await tx.get(group));
      if (data.ownerUid !== uid) throw new ForbiddenException();
      tx.update(group, { apiState: 'DELETING' });
      tx.set(chat, { apiState: 'DELETING' }, { merge: true });
    });
    // Tombstones prevent new backend writes. Retrying finishes an interrupted cleanup.
    const tournaments = await db
      .collection('tournaments')
      .where('groupId', '==', id)
      .get();
    for (const tournament of tournaments.docs) {
      for (const collection of ['matches', 'tournament_rounds']) {
        const records = await db
          .collection(collection)
          .where('tournamentId', '==', tournament.id)
          .get();
        for (const record of records.docs) await db.recursiveDelete(record.ref);
      }
      await tournament.ref.delete();
    }
    await db.recursiveDelete(chat);
    await group.delete();
    return { deleted: true };
  }
}
@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
class GroupsController {
  constructor(@Inject(GroupsService) private readonly groups: GroupsService) {}
  @Get() @ApiQueries(pageSchema) list(
    @CurrentUid() uid: string,
    @Page() page: PageInput,
  ) {
    return this.groups.list(uid, page);
  }
  @Get(':id') get(@CurrentUid() uid: string, @ResourceId() id: string) {
    return this.groups.get(uid, id);
  }
  @Post() @ApiInput(createSchema) create(
    @CurrentUid() uid: string,
    @Input(createSchema) body: z.infer<typeof createSchema>,
  ) {
    return this.groups.members(uid, undefined, body);
  }
  @Put(':id/members') @ApiInput(membersSchema) members(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
    @Input(membersSchema) body: z.infer<typeof membersSchema>,
  ) {
    return this.groups.members(uid, id, body);
  }
  @Post(':id/leave') leave(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
  ) {
    return this.groups.leave(uid, id);
  }
  @Delete(':id') remove(@CurrentUid() uid: string, @ResourceId() id: string) {
    return this.groups.remove(uid, id);
  }
}
@Module({ controllers: [GroupsController], providers: [GroupsService] })
export class GroupsModule {}
