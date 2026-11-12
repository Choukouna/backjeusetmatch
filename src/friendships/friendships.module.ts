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
  BadRequestException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FieldValue, Filter } from 'firebase-admin/firestore';
import { FirebaseService } from '../firebase/firebase.module.js';
import { CurrentUid } from '../auth/auth.guard.js';
import {
  Page,
  ResourceId,
  type PageInput,
  ApiQueries,
  pageSchema,
} from '../common/http.js';
import { fields, paginate, requireDocument } from '../firebase/repository.js';
import {
  NotificationsService,
  notificationText,
} from '../notifications/notifications.module.js';
export function pairId(a: string, b: string) {
  return [a, b].sort().join('_');
}
@Injectable()
export class FriendshipsService {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
    @Inject(NotificationsService)
    private readonly notifications: NotificationsService,
  ) {}
  list(uid: string, page: PageInput) {
    return paginate(
      this.firebase.db
        .collection('friend_requests')
        .where(
          Filter.or(
            Filter.where('fromUid', '==', uid),
            Filter.where('toUid', '==', uid),
          ),
        ),
      page,
      (d, id) => ({
        id,
        ...fields(d, [
          'fromUid',
          'fromName',
          'toUid',
          'toName',
          'status',
          'updatedAt',
        ]),
      }),
      `friends:${uid}`,
    );
  }
  async mutate(
    uid: string,
    otherUid: string,
    action: 'request' | 'accept' | 'delete',
  ) {
    if (uid === otherUid)
      throw new BadRequestException({ code: 'SELF_FRIENDSHIP' });
    const db = this.firebase.db,
      ref = db.collection('friend_requests').doc(pairId(uid, otherUid));
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(ref);
      if (action === 'delete') {
        if (!existing.exists) return;
        if (![existing.get('fromUid'), existing.get('toUid')].includes(uid))
          throw new ForbiddenException();
        tx.delete(ref);
        return;
      }
      const own = requireDocument(
        await tx.get(db.collection('players').doc(uid)),
      );
      const other = requireDocument(
        await tx.get(db.collection('players').doc(otherUid)),
      );
      if (action === 'request') {
        if (existing.exists) return;
        tx.create(ref, {
          fromUid: uid,
          fromName: own.pseudo,
          toUid: otherUid,
          toName: other.pseudo,
          status: 'PENDING',
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        const data = requireDocument(existing);
        if (data.toUid !== uid || data.fromUid !== otherUid)
          throw new ForbiddenException();
        if (data.status === 'ACCEPTED') return;
        if (data.status !== 'PENDING')
          throw new BadRequestException({ code: 'INVALID_FRIENDSHIP_STATE' });
        tx.update(ref, {
          status: 'ACCEPTED',
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      this.notifications.enqueue(tx, [other], ...notificationText.friend);
    });
    return { id: ref.id };
  }
}
@ApiTags('friendships')
@ApiBearerAuth()
@Controller('friendships')
class FriendshipsController {
  constructor(
    @Inject(FriendshipsService)
    private readonly friendships: FriendshipsService,
  ) {}
  @Get() @ApiQueries(pageSchema) list(
    @CurrentUid() uid: string,
    @Page() page: PageInput,
  ) {
    return this.friendships.list(uid, page);
  }
  @Post(':id') request(@CurrentUid() uid: string, @ResourceId() other: string) {
    return this.friendships.mutate(uid, other, 'request');
  }
  @Put(':id/accept') accept(
    @CurrentUid() uid: string,
    @ResourceId() other: string,
  ) {
    return this.friendships.mutate(uid, other, 'accept');
  }
  @Delete(':id') remove(
    @CurrentUid() uid: string,
    @ResourceId() other: string,
  ) {
    return this.friendships.mutate(uid, other, 'delete');
  }
}
@Module({
  controllers: [FriendshipsController],
  providers: [FriendshipsService],
})
export class FriendshipsModule {}
