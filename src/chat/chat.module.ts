import { Inject } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Sse,
  Req,
  Module,
  Injectable,
  ForbiddenException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FieldValue } from 'firebase-admin/firestore';
import { Observable } from 'rxjs';
import { z } from 'zod';
import { FirebaseService } from '../firebase/firebase.module.js';
import { CurrentUid, type AuthenticatedRequest } from '../auth/auth.guard.js';
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
import { NotificationsService } from '../notifications/notifications.module.js';
import { pairId } from '../friendships/friendships.module.js';
import { MessageEncryption } from './message-encryption.js';
const sendSchema = z
  .object({
    operationId: operationIdSchema,
    content: z.string().trim().min(1).max(10000),
  })
  .strict();
const directSchema = z.object({ playerId: idSchema }).strict();
export function assertMember(chat: Record<string, any>, uid: string) {
  if (
    chat.apiState === 'DELETING' ||
    !Array.isArray(chat.participantsUid) ||
    !chat.participantsUid.includes(uid)
  )
    throw new ForbiddenException();
}
@Injectable()
export class ChatService {
  private readonly connections = new Map<string, number>();
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
    @Inject(MessageEncryption) private readonly encryption: MessageEncryption,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}
  private dto(data: Record<string, any>, id: string) {
    return {
      id,
      participants: participantDtos(data.participants),
      ...fields(data, [
        'type',
        'participantsUid',
        'readBy',
        'createdAt',
        'updatedAt',
        'lastMessageAt',
      ]),
      ...(typeof data.lastMessage === 'string'
        ? { lastMessage: this.encryption.decrypt(data.lastMessage) }
        : {}),
    };
  }
  async list(uid: string, page: PageInput) {
    const db = this.firebase.db;
    const result = await paginate(
      db.collection('chats').where('participantsUid', 'array-contains', uid),
      page,
      (data, id) => ({ ...this.dto(data, id), apiState: data.apiState }),
      `chats:${uid}`,
    );
    const visible = result.items.filter((item) => item.apiState !== 'DELETING');
    const groupIds = visible
      .filter((item) => item.type === 'GROUP')
      .map((item) => String(item.id));
    const groups = groupIds.length
      ? await db.getAll(
          ...groupIds.map((id) => db.collection('groups').doc(id)),
        )
      : [];
    const names = new Map(
      groups
        .filter((group) => group.exists)
        .map((group) => [group.id, group.get('name') as string]),
    );
    return {
      ...result,
      items: visible.map(({ apiState: _apiState, ...item }) => ({
        ...item,
        conversationName:
          item.type === 'GROUP'
            ? (names.get(String(item.id)) ?? null)
            : (participantDtos(item.participants).find((p) => p.uid !== uid)
                ?.name ?? null),
      })),
    };
  }
  async membership(uid: string, id: string) {
    const data = requireDocument(
      await this.firebase.db.collection('chats').doc(id).get(),
    );
    assertMember(data, uid);
    return data;
  }
  async messages(uid: string, id: string, page: PageInput) {
    await this.membership(uid, id);
    const collection = this.firebase.db
      .collection('chats')
      .doc(id)
      .collection('messages');
    // A stable timestamp/id cursor retrieves newest messages first.
    const result = await paginate(
      collection.orderBy('createdAt', 'desc'),
      page,
      (d, messageId) => ({
        id: messageId,
        ...fields(d, ['senderId', 'senderName', 'createdAt']),
        content: this.encryption.decrypt(String(d.content ?? '')),
      }),
      `messages:${id}`,
      collection.path,
      'desc',
    );
    await this.membership(uid, id);
    return result;
  }
  async direct(uid: string, other: string) {
    if (uid === other) throw new ConflictException({ code: 'SELF_CHAT' });
    const db = this.firebase.db,
      id = pairId(uid, other),
      ref = db.collection('chats').doc(id);
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists) {
        assertMember(snapshot.data()!, uid);
        return;
      }
      const own = requireDocument(
        await tx.get(db.collection('players').doc(uid)),
      );
      const player = requireDocument(
        await tx.get(db.collection('players').doc(other)),
      );
      tx.create(ref, {
        type: 'P2P',
        participantsUid: [uid, other].sort(),
        participants: [
          { uid, name: own.pseudo },
          { uid: other, name: player.pseudo },
        ],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return { id };
  }
  async send(uid: string, id: string, body: z.infer<typeof sendSchema>) {
    const db = this.firebase.db,
      ref = db.collection('chats').doc(id),
      message = ref.collection('messages').doc();
    const encrypted = this.encryption.encrypt(body.content);
    return db.runTransaction(async (tx) => {
      const chat = requireDocument(await tx.get(ref));
      assertMember(chat, uid);
      const action = { kind: 'message', chatId: id, ...body };
      const previous = await previousOperation(
        tx,
        db,
        uid,
        body.operationId,
        action,
      );
      if (previous) return { id: previous };
      const own = requireDocument(
        await tx.get(db.collection('players').doc(uid)),
      );
      const recipientIds = (chat.participantsUid as string[]).filter(
        (p) => p !== uid,
      );
      const recipients = recipientIds.length
        ? await tx.getAll(
            ...recipientIds.map((p) => db.collection('players').doc(p)),
          )
        : [];
      tx.create(message, {
        content: encrypted,
        senderId: uid,
        senderName: own.pseudo,
        createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(ref, {
        lastMessage: encrypted,
        lastMessageAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        readBy: [uid],
      });
      this.notifications.enqueue(
        tx,
        recipients.filter((r) => r.exists).map((r) => r.data()!),
        String(own.pseudo),
        body.content,
      );
      finishOperation(tx, db, uid, body.operationId, action, message.id);
      return { id: message.id };
    });
  }
  async read(uid: string, id: string) {
    const db = this.firebase.db,
      ref = db.collection('chats').doc(id);
    await db.runTransaction(async (tx) => {
      assertMember(requireDocument(await tx.get(ref)), uid);
      tx.update(ref, { readBy: FieldValue.arrayUnion(uid) });
    });
    return { read: true };
  }
  async removeDirect(uid: string, id: string) {
    const db = this.firebase.db,
      ref = db.collection('chats').doc(id);
    await db.runTransaction(async (tx) => {
      const data = requireDocument(await tx.get(ref));
      if (data.type !== 'P2P' || !(data.participantsUid ?? []).includes(uid))
        throw new ForbiddenException();
      tx.update(ref, { apiState: 'DELETING' });
    });
    await db.recursiveDelete(ref);
    return { deleted: true };
  }
  async events(
    uid: string,
    expiresAt: number,
    id?: string,
    authenticatedAt = Date.now(),
  ): Promise<Observable<MessageEvent>> {
    if (id) await this.membership(uid, id);
    if ((this.connections.get(uid) ?? 0) >= 5)
      throw new HttpException({ code: 'TOO_MANY_STREAMS' }, 429);
    return new Observable((subscriber) => {
      this.connections.set(uid, (this.connections.get(uid) ?? 0) + 1);
      const stops: (() => void)[] = [];
      const send = (type: string, data: Record<string, unknown> = {}) =>
        subscriber.next({ type, data });
      const close = (reason: string) => {
        send('reconnect', { reason });
        subscriber.complete();
      };
      const failed = () => close('listener_unavailable');
      let messageStop: (() => void) | undefined;
      if (id) {
        stops.push(
          this.firebase.db
            .collection('chats')
            .doc(id)
            .onSnapshot((snapshot) => {
              try {
                assertMember(requireDocument(snapshot), uid);
              } catch {
                close('membership_changed');
                return;
              }
              send('invalidate', { resource: 'chat', id });
              if (!messageStop) {
                messageStop = snapshot.ref
                  .collection('messages')
                  .orderBy('createdAt', 'desc')
                  .limit(20)
                  .onSnapshot(
                    () => send('invalidate', { resource: 'messages', id }),
                    failed,
                  );
                stops.push(messageStop);
              }
            }, failed),
        );
      } else {
        stops.push(
          this.firebase.db
            .collection('chats')
            .where('participantsUid', 'array-contains', uid)
            .onSnapshot(
              () => send('invalidate', { resource: 'chats' }),
              failed,
            ),
        );
      }
      let checking = false;
      const heartbeat = setInterval(() => {
        if (Date.now() >= expiresAt) {
          close('token_expired');
          return;
        }
        if (checking) return;
        checking = true;
        void this.firebase.auth
          .getUser(uid)
          .then((user) => {
            if (
              user.disabled ||
              new Date(user.tokensValidAfterTime ?? 0).getTime() >
                authenticatedAt
            )
              close('session_revoked');
            else send('heartbeat');
          })
          .catch(() => close('session_unavailable'))
          .finally(() => {
            checking = false;
          });
      }, 25000);
      // Bound lifetime below Cloud Run request timeout; clients reconnect and reload.
      const timeout = setTimeout(
        () => close('connection_refresh'),
        Math.max(1, Math.min(240000, expiresAt - Date.now())),
      );
      return () => {
        clearInterval(heartbeat);
        clearTimeout(timeout);
        stops.forEach((stop) => stop());
        this.connections.set(
          uid,
          Math.max(0, (this.connections.get(uid) ?? 1) - 1),
        );
        if (!this.connections.get(uid)) this.connections.delete(uid);
      };
    });
  }
}
@ApiTags('chat')
@ApiBearerAuth()
@Controller('chats')
class ChatController {
  constructor(@Inject(ChatService) private readonly chats: ChatService) {}
  @Get() @ApiQueries(pageSchema) list(
    @CurrentUid() uid: string,
    @Page() page: PageInput,
  ) {
    return this.chats.list(uid, page);
  }
  @Post('direct') @ApiInput(directSchema) direct(
    @CurrentUid() uid: string,
    @Input(directSchema) body: z.infer<typeof directSchema>,
  ) {
    return this.chats.direct(uid, body.playerId);
  }
  @Sse('events') async listEvents(@Req() req: AuthenticatedRequest) {
    return this.chats.events(
      req.uid,
      req.tokenExpiresAt,
      undefined,
      req.tokenAuthenticatedAt,
    );
  }
  @Sse(':id/events') async events(
    @Req() req: AuthenticatedRequest,
    @ResourceId() id: string,
  ) {
    return this.chats.events(
      req.uid,
      req.tokenExpiresAt,
      id,
      req.tokenAuthenticatedAt,
    );
  }
  @Get(':id/messages') @ApiQueries(pageSchema) messages(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
    @Page() page: PageInput,
  ) {
    return this.chats.messages(uid, id, page);
  }
  @Post(':id/messages') @ApiInput(sendSchema) send(
    @CurrentUid() uid: string,
    @ResourceId() id: string,
    @Input(sendSchema) body: z.infer<typeof sendSchema>,
  ) {
    return this.chats.send(uid, id, body);
  }
  @Put(':id/read') read(@CurrentUid() uid: string, @ResourceId() id: string) {
    return this.chats.read(uid, id);
  }
  @Delete(':id') remove(@CurrentUid() uid: string, @ResourceId() id: string) {
    return this.chats.removeDirect(uid, id);
  }
}
@Module({
  controllers: [ChatController],
  providers: [ChatService, MessageEncryption],
  exports: [ChatService],
})
export class ChatModule {}
