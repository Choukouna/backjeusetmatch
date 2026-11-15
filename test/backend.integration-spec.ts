import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Timestamp } from 'firebase-admin/firestore';
import { AppModule } from '../src/app.module.js';
import { FirebaseService } from '../src/firebase/firebase.module.js';
import { configureApp } from '../src/bootstrap.js';
import { ChatService } from '../src/chat/chat.module.js';
import { firstValueFrom, take, toArray } from 'rxjs';

// Never permit these tests to run against a real project.
if (
  process.env.FIREBASE_PROJECT_ID !== 'demo-jeusetfun' ||
  process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099'
)
  throw new Error('Local demo emulators required');
const profile = {
  name: 'Alice',
  lastname: 'Test',
  rank: '30/2',
  city: 'rennes',
  deptCode: '35',
  playsTennis: true,
  playsPadel: true,
  notificationFrequency: '2h',
};
const password = 'tennis-test-password';
describe('Firebase-backed API', () => {
  let app: INestApplication, firebase: FirebaseService;
  const accounts = new Map<string, string>();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    firebase = app.get(FirebaseService);
    await Promise.all(
      (await firebase.db.listCollections()).map((c) =>
        firebase.db.recursiveDelete(c),
      ),
    );
    let authPage = await firebase.auth.listUsers(1000);
    while (authPage.users.length) {
      await firebase.auth.deleteUsers(authPage.users.map((user) => user.uid));
      authPage = await firebase.auth.listUsers(1000);
    }
    for (const uid of ['alice', 'bob', 'carol', 'outsider']) {
      try {
        await firebase.auth.deleteUser(uid);
      } catch {
        /* fresh emulator */
      }
      await firebase.auth.createUser({
        uid,
        email: `${uid}@example.test`,
        password,
      });
      await firebase.db
        .collection('players')
        .doc(uid)
        .set({
          ...profile,
          pseudo: `${uid}01`,
          email: `${uid}@example.test`,
          fcmToken: [`token-${uid}`],
          wins: 0,
          losses: 0,
          bestWin: '',
          worstDefeat: '',
        });
      const response = await fetch(
        'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-key',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            email: `${uid}@example.test`,
            password,
            returnSecureToken: true,
          }),
        },
      );
      const body = (await response.json()) as { idToken: string };
      accounts.set(uid, body.idToken);
    }
  });
  afterAll(async () => {
    await app?.close();
  });
  const api = (uid: string) => ({
    get: (path: string) =>
      request(app.getHttpServer())
        .get(`/api/jeusetfun/v1${path}`)
        .auth(accounts.get(uid)!, { type: 'bearer' }),
    post: (path: string) =>
      request(app.getHttpServer())
        .post(`/api/jeusetfun/v1${path}`)
        .auth(accounts.get(uid)!, { type: 'bearer' }),
    put: (path: string) =>
      request(app.getHttpServer())
        .put(`/api/jeusetfun/v1${path}`)
        .auth(accounts.get(uid)!, { type: 'bearer' }),
    delete: (path: string) =>
      request(app.getHttpServer())
        .delete(`/api/jeusetfun/v1${path}`)
        .auth(accounts.get(uid)!, { type: 'bearer' }),
  });
  it('returns an authenticated activity summary and private last-screen time', async () => {
    const now = new Date();
    const since = Timestamp.fromDate(new Date(now.getTime() - 60000));
    await firebase.db
      .collection('players')
      .doc('alice')
      .update({ lastScreenTime: since });
    await firebase.db
      .collection('players_slot')
      .doc('activity-owned')
      .set({ ownerUid: 'alice', status: 'PENDING' });
    await firebase.db
      .collection('players_slot')
      .doc('activity-response')
      .set({
        ownerUid: 'bob',
        opponentUid: 'alice',
        status: 'ACCEPTED',
        updatedAt: Timestamp.fromDate(now),
      });
    await firebase.db
      .collection('players_slot')
      .doc('activity-new')
      .set({
        ownerUid: 'bob',
        deptCode: '35',
        createdAt: Timestamp.fromDate(now),
      });
    const result = await api('alice').get('/players/me/activity').expect(200);
    expect(result.body).toEqual({
      pendingSlotRequests: true,
      slotResponses: true,
      newSlots: true,
    });
    const own = await api('alice').get('/players/me').expect(200);
    expect(own.body.lastScreenTime).toBe(since.toDate().toISOString());
    const other = await api('bob').get('/players/alice').expect(200);
    expect(other.body).not.toHaveProperty('lastScreenTime');
  });
  it('returns safe player DTOs and scoped pagination', async () => {
    const result = await api('alice').get('/players/bob').expect(200);
    expect(result.body).toHaveProperty('pseudo', 'bob01');
    expect(result.body).not.toHaveProperty('email');
    expect(result.body).not.toHaveProperty('fcmToken');
    expect(result.body).not.toHaveProperty('lastname');
    expect(result.body).not.toHaveProperty('name');
    expect(result.body).toHaveProperty('displayName', 'Test A.');
    const own = await api('alice').get('/players/me').expect(200);
    expect(own.body.email).toBe('alice@example.test');
    const first = await api('alice')
      .get('/players?deptCode=35&limit=1')
      .expect(200);
    const second = await api('alice')
      .get(`/players?deptCode=35&limit=1&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(first.body.items[0].id).not.toBe(second.body.items[0].id);
    await api('alice')
      .get(`/players?deptCode=75&cursor=${first.body.nextCursor}`)
      .expect(400);
  });
  it('authenticates pseudo/password without exposing email', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/jeusetfun/v1/auth/login')
      .send({ pseudo: 'ALICE01', password })
      .expect(200);
    expect(login.body.customToken).toBeTypeOf('string');
    expect(login.body).not.toHaveProperty('email');
    await request(app.getHttpServer())
      .post('/api/jeusetfun/v1/auth/login')
      .send({ pseudo: 'alice01', password: 'wrong' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/jeusetfun/v1/auth/login')
      .send({ pseudo: 'nobody01', password })
      .expect(401);
  });
  it('recovers signup after a conflicting pseudo and reserves new pseudos', async () => {
    const signup = await request(app.getHttpServer())
      .post('/api/jeusetfun/v1/auth/signup')
      .send({
        ...profile,
        pseudo: 'alice01',
        email: 'recovery@example.test',
        password,
      })
      .expect(201);
    expect(signup.body).toMatchObject({
      profileComplete: false,
      profileError: 'PSEUDO_BUSY',
    });
    expect(signup.body.customToken).toBeTypeOf('string');
    const session = (await fetch(
      'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=emulator-key',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          token: signup.body.customToken,
          returnSecureToken: true,
        }),
      },
    ).then((r) => r.json())) as { idToken: string };
    await request(app.getHttpServer())
      .post('/api/jeusetfun/v1/auth/complete-profile')
      .auth(session.idToken, { type: 'bearer' })
      .send({ ...profile, pseudo: 'recover01' })
      .expect(201);
    const claim = await firebase.db
      .collection('_pseudo_reservations')
      .doc('recover01')
      .get();
    expect(claim.exists).toBe(true);
  });
  it('serializes competing registrations for one normalized pseudo', async () => {
    const responses = await Promise.all(
      ['one', 'two'].map((suffix) =>
        request(app.getHttpServer())
          .post('/api/jeusetfun/v1/auth/signup')
          .send({
            ...profile,
            pseudo: 'newplayer',
            email: `unique-${suffix}@example.test`,
            password,
          }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(responses.filter((r) => r.body.profileComplete)).toHaveLength(1);
    expect(
      responses.filter((r) => r.body.profileError === 'PSEUDO_BUSY'),
    ).toHaveLength(1);
    expect(
      (
        await firebase.db
          .collection('players')
          .where('pseudo', '==', 'newplayer')
          .get()
      ).size,
    ).toBe(1);
  });
  it('preserves legacy scalar device tokens while adding and removing devices', async () => {
    await firebase.db
      .collection('players')
      .doc('alice')
      .update({ fcmToken: 'legacy-token' });
    await api('alice')
      .put('/players/me/device-token')
      .send({ token: 'new-token' })
      .expect(200);
    expect(
      (await firebase.db.collection('players').doc('alice').get()).get(
        'fcmToken',
      ),
    ).toEqual(['legacy-token', 'new-token']);
    await api('alice')
      .delete('/players/me/device-token')
      .send({ token: 'new-token' })
      .expect(200);
    expect(
      (await firebase.db.collection('players').doc('alice').get()).get(
        'fcmToken',
      ),
    ).toEqual(['legacy-token']);
  });
  it('commits a match and both statistics once under concurrent retries', async () => {
    const body = {
      operationId: randomUUID(),
      opponentId: 'bob',
      sets: [
        { gamesA: 6, gamesB: 4 },
        { gamesA: 6, gamesB: 3 },
      ],
      playDate: new Date(Date.now() - 86400000).toISOString(),
      comment: '',
    };
    const results = await Promise.all([
      api('alice').post('/matches').send(body),
      api('alice').post('/matches').send(body),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results[0].body.id).toBe(results[1].body.id);
    expect(
      (await firebase.db.collection('players').doc('alice').get()).get('wins'),
    ).toBe(1);
    expect(
      (await firebase.db.collection('players').doc('bob').get()).get('losses'),
    ).toBe(1);
    const matches = await api('bob').get('/matches').expect(200);
    expect(
      matches.body.items.some(
        (m: { id: string }) => m.id === results[0].body.id,
      ),
    ).toBe(true);
    await api('alice')
      .post('/matches')
      .send({ ...body, comment: 'changed' })
      .expect(409);
  });
  it('records anonymous-opponent matches using existing JA player records', async () => {
    await firebase.db
      .collection('players')
      .doc('ja30')
      .set({ pseudo: 'ja30', rank: '30', wins: 0, losses: 0 });
    const lookup = await api('alice')
      .get('/players/by-pseudo/ja30')
      .expect(200);
    expect(lookup.body.id).toBe('ja30');
    await api('alice')
      .post('/matches')
      .send({
        operationId: randomUUID(),
        opponentId: 'ja30',
        sets: [{ gamesA: 6, gamesB: 2 }],
        playDate: new Date(Date.now() - 10000).toISOString(),
      })
      .expect(201);
  });
  it('only lets the recipient accept a friend request and preserves queue payloads', async () => {
    await api('alice').post('/friendships/bob').expect(201);
    await api('alice').put('/friendships/bob/accept').expect(403);
    await api('bob').put('/friendships/alice/accept').expect(200);
    const queued = await firebase.db.collection('notifications_to_send').get();
    expect(
      queued.docs.some(
        (d) =>
          d.get('title') === 'Communauté' &&
          d.get('status') === 'PENDING' &&
          d.get('toFcmToken').includes('token-bob'),
      ),
    ).toBe(true);
  });
  it('rejects competing slot requests and handles padel capacity idempotently', async () => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(10, 0, 0, 0);
    const created = await api('alice')
      .post('/slots')
      .send({
        operationId: randomUUID(),
        start: start.toISOString(),
        end: new Date(start.getTime() + 3600000).toISOString(),
        sports: ['Padel'],
        location: { stade: 'Court', city: 'rennes', nbRequis: 3 },
      })
      .expect(201);
    const id = created.body.id;
    const requests = await Promise.all([
      api('bob').post(`/slots/${id}/request`),
      api('carol').post(`/slots/${id}/request`),
    ]);
    expect(requests.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    await api('outsider')
      .put(`/slots/${id}/response`)
      .send({ accept: true, operationId: randomUUID() })
      .expect(403);
    const response = { accept: true, operationId: randomUUID() };
    await api('alice').put(`/slots/${id}/response`).send(response).expect(200);
    await api('alice').put(`/slots/${id}/response`).send(response).expect(200);
    const slot = await firebase.db.collection('players_slot').doc(id).get();
    expect(slot.get('location.nbRequis')).toBe(2);
    expect(slot.get('status')).toBe('AVAILABLE');
  });
  it('serializes bookings across different slot documents and releases deleted reservations', async () => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(12, 0, 0, 0);
    const payload = () => ({
      operationId: randomUUID(),
      start: start.toISOString(),
      end: new Date(start.getTime() + 3600000).toISOString(),
      sports: ['Tennis'],
      location: { stade: 'Court', city: 'rennes', nbRequis: 1 },
    });
    const races = await Promise.all([
      api('alice').post('/slots').send(payload()),
      api('alice').post('/slots').send(payload()),
    ]);
    expect(races.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    const id = races.find((r) => r.status === 201)!.body.id;
    const calendar = await api('alice').get('/slots?deptCode=35').expect(200);
    expect(
      calendar.body.items.some((slot: { id: string }) => slot.id === id),
    ).toBe(true);
    await api('alice').delete(`/slots/${id}`).expect(200);
    await api('alice').post('/slots').send(payload()).expect(201);
  });
  it('prevents one player requesting two different slots at the same time', async () => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(14, 0, 0, 0);
    const payload = () => ({
      operationId: randomUUID(),
      start: start.toISOString(),
      end: new Date(start.getTime() + 3600000).toISOString(),
      sports: ['Tennis'],
      location: { stade: 'Court', city: 'rennes', nbRequis: 1 },
    });
    const slots = await Promise.all(
      ['bob', 'carol'].map((uid) =>
        api(uid).post('/slots').send(payload()).expect(201),
      ),
    );
    const results = await Promise.all(
      slots.map((slot) => api('alice').post(`/slots/${slot.body.id}/request`)),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
  });
  it('keeps legacy chat messages readable and rejects nonmembers', async () => {
    const created = await api('alice')
      .post('/chats/direct')
      .send({ playerId: 'bob' })
      .expect(201);
    const id = created.body.id;
    expect(
      (await firebase.db.collection('chats').doc(id).get()).get('type'),
    ).toBe('P2P');
    await firebase.db
      .collection('chats')
      .doc(id)
      .collection('messages')
      .doc('legacy')
      .set({
        content: 'ancien message',
        senderId: 'bob',
        senderName: 'bob01',
        createdAt: Timestamp.fromMillis(1),
      });
    await api('outsider').get(`/chats/${id}/messages`).expect(403);
    const body = { operationId: randomUUID(), content: 'Salut 🎾' };
    const message = await api('alice')
      .post(`/chats/${id}/messages`)
      .send(body)
      .expect(201);
    const retried = await api('alice')
      .post(`/chats/${id}/messages`)
      .send(body)
      .expect(201);
    expect(retried.body.id).toBe(message.body.id);
    const stored = await firebase.db
      .collection('chats')
      .doc(id)
      .collection('messages')
      .doc(message.body.id)
      .get();
    expect(stored.get('content')).not.toBe(body.content);
    const list = await api('bob')
      .get(`/chats/${id}/messages?limit=1`)
      .expect(200);
    expect(list.body.items[0].content).toBe('Salut 🎾');
    const next = await api('bob')
      .get(`/chats/${id}/messages?limit=1&cursor=${list.body.nextCursor}`)
      .expect(200);
    expect(next.body.items[0].content).toBe('ancien message');
  });
  it('invalidates live chat on legacy writes and closes on membership removal', async () => {
    const service = app.get(ChatService),
      id = 'live-chat';
    await firebase.db
      .collection('chats')
      .doc(id)
      .set({ participantsUid: ['alice', 'bob'], type: 'P2P' });
    const stream = await service.events('alice', Date.now() + 60000, id);
    const first = await firstValueFrom(stream.pipe(take(1)));
    expect(first.type).toBe('invalidate');
    const events: { type?: string; data?: unknown }[] = [];
    const completed = new Promise<void>((resolve) => {
      stream.subscribe({ next: (e) => events.push(e), complete: resolve });
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await firebase.db
      .collection('chats')
      .doc(id)
      .collection('messages')
      .add({ content: 'legacy', createdAt: Timestamp.now() });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await firebase.db
      .collection('chats')
      .doc(id)
      .update({ participantsUid: ['bob'] });
    await completed;
    expect(
      events.some(
        (e) =>
          e.type === 'invalidate' &&
          (e.data as { resource: string }).resource === 'messages',
      ),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: 'reconnect',
      data: { reason: 'membership_changed' },
    });
  });
  it('serves an authenticated HTTP event stream', async () => {
    const address = app.getHttpServer().address() as { port: number };
    const abort = new AbortController();
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/jeusetfun/v1/chats/events`,
        {
          headers: {
            Authorization: `Bearer ${accounts.get('alice')}`,
            Accept: 'text/event-stream',
          },
          signal: abort.signal,
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      const reader = response.body!.getReader();
      let text = '';
      while (!text.includes('event: invalidate')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      expect(text).toContain('event: invalidate');
    } finally {
      abort.abort();
    }
  });
  it('creates a group league, normalizes player-two scores, and blocks completed-league scoring', async () => {
    const group = await api('alice')
      .post('/groups')
      .send({ operationId: randomUUID(), name: 'Amis', playerIds: ['bob'] })
      .expect(201);
    const league = await api('alice')
      .post('/leagues')
      .send({
        operationId: randomUUID(),
        groupId: group.body.id,
        name: 'Ligue',
        playerIds: ['alice', 'bob'],
      })
      .expect(201);
    await api('outsider').get(`/leagues/${league.body.id}`).expect(403);
    const list = await api('bob')
      .get(`/leagues/${league.body.id}/matches`)
      .expect(200);
    const match = list.body.items[0];
    const body = {
      operationId: randomUUID(),
      sets: [{ gamesA: 6, gamesB: 3 }],
      playDate: new Date(Date.now() - 1000).toISOString(),
    };
    await api(match.player2Id)
      .put(`/matches/${match.id}/score`)
      .send(body)
      .expect(200);
    const stored = await firebase.db.collection('matches').doc(match.id).get();
    expect(stored.get('winnerId')).toBe(match.player2Id);
    expect(JSON.parse(stored.get('score'))).toEqual([{ gamesA: 3, gamesB: 6 }]);
    await api('alice').post(`/leagues/${league.body.id}/close`).expect(201);
    await api('bob')
      .put(`/matches/${match.id}/score`)
      .send({ ...body, operationId: randomUUID() })
      .expect(409);
    const filtered = await api('bob')
      .get(`/leagues/${league.body.id}/standings?upToRoundNumber=1`)
      .expect(200);
    expect(filtered.body.items[0].uid).toBe(match.player2Id);
    const table = await api('bob')
      .get(`/leagues/${league.body.id}/standings`)
      .expect(200);
    expect(table.body.items[0].uid).toBe(match.player2Id);
  });
  it('enrolls the last public participant and creates exactly one schedule', async () => {
    const ref = firebase.db.collection('tournaments').doc('public-league');
    await ref.set({
      type: 'RR',
      status: 'OPEN',
      isPublic: true,
      participantsUid: ['alice'],
      participants: [{ uid: 'alice', name: 'alice01' }],
      registeredNumber: 1,
      requiredNumber: 2,
      nbMatch: 0,
      endDate: Timestamp.fromMillis(Date.now() + 86400000),
    });
    const results = await Promise.all([
      api('bob').post('/leagues/public-league/enrollment'),
      api('carol').post('/leagues/public-league/enrollment'),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);
    const matches = await firebase.db
      .collection('matches')
      .where('tournamentId', '==', ref.id)
      .get();
    expect(matches.size).toBe(1);
    expect((await ref.get()).get('status')).toBe('ONGOING');
  });
  it('coordinates independent listeners over the same Firestore data', async () => {
    const { MessageEncryption } =
      await import('../src/chat/message-encryption.js');
    const { NotificationsService } =
      await import('../src/notifications/notifications.module.js');
    const otherInstance = new ChatService(
      firebase,
      app.get(MessageEncryption),
      app.get(NotificationsService),
    );
    const stream = await otherInstance.events(
      'bob',
      Date.now() + 60000,
      'live-chat',
    );
    const events = firstValueFrom(stream.pipe(take(2), toArray()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await firebase.db
      .collection('chats')
      .doc('live-chat')
      .collection('messages')
      .add({ content: 'other-instance', createdAt: Timestamp.now() });
    expect((await events).every((e) => e.type === 'invalidate')).toBe(true);
  });
  it('serves public commune autocomplete using legacy nameNormalized', async () => {
    await firebase.db
      .collection('communes')
      .doc('35238')
      .set({ nameNormalized: 'rennes', departmentCode: '35' });
    const response = await request(app.getHttpServer())
      .get('/api/jeusetfun/v1/communes?q=ren&departmentCode=35')
      .expect(200);
    expect(response.body.items).toContainEqual({
      id: '35238',
      nameNormalized: 'rennes',
      departmentCode: '35',
    });
  });
  it('rejects disabled accounts and expires event streams', async () => {
    await firebase.auth.updateUser('outsider', { disabled: true });
    await api('outsider').get('/players/me').expect(401);
    await firebase.auth.updateUser('outsider', { disabled: false });
    const stream = await app.get(ChatService).events('alice', Date.now() + 200);
    const events = await firstValueFrom(stream.pipe(toArray()));
    expect(events.at(-1)).toMatchObject({
      type: 'reconnect',
      data: { reason: 'connection_refresh' },
    });
  });
  it('anonymizes account records, preserves match references, and rejects stale deletion authentication', async () => {
    const { AuthService } = await import('../src/auth/auth.module.js');
    const auth = app.get(AuthService);
    await expect(
      auth.deleteAccount('carol', Date.now() - 600000),
    ).rejects.toThrow();
    await auth.deleteAccount('carol', Date.now());
    const player = await firebase.db.collection('players').doc('carol').get();
    expect(player.get('pseudo')).toBe('');
    expect(player.get('email')).toBeUndefined();
    expect(player.get('fcmToken')).toEqual([]);
    await api('carol').get('/players/me').expect(401);
  });
  it('persists feedback with legacy field names', async () => {
    const response = await api('alice')
      .post('/feedback')
      .send({ operationId: randomUUID(), message: 'Très bien' })
      .expect(201);
    const doc = await firebase.db
      .collection('user_feedbacks')
      .doc(response.body.id)
      .get();
    expect(doc.data()).toMatchObject({
      userId: 'alice',
      feedback: 'Très bien',
    });
  });
});
