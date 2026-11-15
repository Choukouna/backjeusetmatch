import { Inject } from '@nestjs/common';
import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { FirebaseService } from '../firebase/firebase.module.js';
import { fields, paginate, requireDocument } from '../firebase/repository.js';
import type { PageInput } from '../common/http.js';
import type { Profile, Registration } from './players.schemas.js';

const publicFields = [
  'pseudo',
  'city',
  'deptCode',
  'rank',
  'playsTennis',
  'playsPadel',
  'wins',
  'losses',
  'bestWin',
  'worstDefeat',
] as const;
const privateFields = [
  ...publicFields,
  'name',
  'lastname',
  'email',
  'notificationFrequency',
  'createdAt',
  'updatedAt',
  'lastScreenTime',
] as const;
export function displayName(data: Record<string, unknown>) {
  const surname = (typeof data.name === 'string' ? data.name : '').trim();
  const first = (typeof data.lastname === 'string' ? data.lastname : '').trim();
  const capitalize = (value: string) =>
    value ? value[0].toUpperCase() + value.slice(1) : '';
  return first
    ? `${capitalize(first)}${surname ? ` ${Array.from(surname)[0].toUpperCase()}.` : ''}`
    : capitalize(surname) || 'Joueur';
}
export const playerDto = (
  data: Record<string, unknown>,
  id: string,
  own = false,
) => ({
  id,
  displayName: displayName(data),
  ...fields(data, own ? privateFields : publicFields),
});
@Injectable()
export class PlayersRepository {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
  ) {}
  async get(uid: string, own = false) {
    return playerDto(
      requireDocument(
        await this.firebase.db.collection('players').doc(uid).get(),
      ),
      uid,
      own,
    );
  }
  async discover(deptCode: string, city: string | undefined, page: PageInput) {
    let query = this.firebase.db
      .collection('players')
      .where('deptCode', '==', deptCode);
    if (city) query = query.where('city', '==', city.toLowerCase());
    const result = await paginate(
      query,
      page,
      (d, id) => playerDto(d, id),
      `players:${deptCode}:${city ?? ''}`,
    );
    result.items = result.items.filter((p) => p.pseudo !== '');
    return result;
  }
  async byPseudo(pseudo: string) {
    const result = await this.firebase.db
      .collection('players')
      .where('pseudo', '==', pseudo.toLowerCase())
      .limit(2)
      .get();
    if (result.size !== 1) throw new NotFoundException();
    return playerDto(result.docs[0].data(), result.docs[0].id);
  }
  async activity(uid: string) {
    const db = this.firebase.db;
    const own = requireDocument(await db.collection('players').doc(uid).get());
    const since = own.lastScreenTime?.toDate?.() as Date | undefined;
    const [owned, responses, slots] = await Promise.all([
      db.collection('players_slot').where('ownerUid', '==', uid).get(),
      db.collection('players_slot').where('opponentUid', '==', uid).get(),
      since && own.deptCode
        ? db
            .collection('players_slot')
            .where('deptCode', '==', own.deptCode)
            .get()
        : Promise.resolve(undefined),
    ]);
    const newer = (value: unknown) =>
      value &&
      typeof (value as any).toDate === 'function' &&
      (!since || (value as any).toDate() > since);
    return {
      pendingSlotRequests: owned.docs.some(
        (d) => d.get('status') === 'PENDING',
      ),
      slotResponses: responses.docs.some(
        (d) =>
          ['AVAILABLE', 'ACCEPTED'].includes(d.get('status')) &&
          (!since || newer(d.get('updatedAt'))),
      ),
      newSlots:
        !!since &&
        !!slots?.docs.some(
          (d) => d.get('ownerUid') !== uid && newer(d.get('createdAt')),
        ),
    };
  }
  async touch(uid: string) {
    const ref = this.firebase.db.collection('players').doc(uid);
    await this.firebase.db.runTransaction(async (tx) => {
      requireDocument(await tx.get(ref));
      tx.update(ref, { lastScreenTime: FieldValue.serverTimestamp() });
    });
    return { saved: true };
  }
  async deviceToken(uid: string, token: string, remove: boolean) {
    const ref = this.firebase.db.collection('players').doc(uid);
    await this.firebase.db.runTransaction(async (tx) => {
      const player = requireDocument(await tx.get(ref));
      const raw = player.fcmToken;
      const existing =
        typeof raw === 'string'
          ? [raw]
          : Array.isArray(raw)
            ? raw.filter(
                (value: unknown): value is string => typeof value === 'string',
              )
            : [];
      const tokens = remove
        ? existing.filter((value) => value !== token)
        : [...new Set([...existing, token])];
      tx.update(ref, {
        fcmToken: tokens,
        updatedAt: FieldValue.serverTimestamp(),
        ...(remove ? { lastScreenTime: FieldValue.serverTimestamp() } : {}),
      });
    });
    return { saved: true };
  }
  async register(uid: string, email: string, data: Registration) {
    const ref = this.firebase.db.collection('players').doc(uid);
    const reservation = this.firebase.db
      .collection('_pseudo_reservations')
      .doc(data.pseudo);
    await this.firebase.db.runTransaction(async (tx) => {
      const [existing, claim, legacy] = await Promise.all([
        tx.get(ref),
        tx.get(reservation),
        tx.get(
          this.firebase.db
            .collection('players')
            .where('pseudo', '==', data.pseudo)
            .limit(1),
        ),
      ]);
      if (existing.exists) {
        if (existing.get('pseudo') === data.pseudo) return;
        throw new ConflictException({ code: 'PROFILE_ALREADY_EXISTS' });
      }
      if ((claim.exists && claim.get('uid') !== uid) || !legacy.empty)
        throw new ConflictException({ code: 'PSEUDO_BUSY' });
      tx.set(reservation, { uid });
      tx.create(ref, {
        ...data,
        email,
        wins: 0,
        losses: 0,
        bestWin: '',
        worstDefeat: '',
        fcmToken: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return this.get(uid, true);
  }
  async update(uid: string, data: Profile) {
    const ref = this.firebase.db.collection('players').doc(uid);
    await this.firebase.db.runTransaction(async (tx) => {
      requireDocument(await tx.get(ref));
      tx.update(ref, { ...data, updatedAt: FieldValue.serverTimestamp() });
    });
    return this.get(uid, true);
  }
}
