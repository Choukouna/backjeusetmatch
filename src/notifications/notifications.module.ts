import { Inject } from '@nestjs/common';
import { Injectable, Module, Global } from '@nestjs/common';
import {
  FieldValue,
  type Transaction,
  type DocumentData,
} from 'firebase-admin/firestore';
import { FirebaseService } from '../firebase/firebase.module.js';
export const notificationText = {
  friend: ['Communauté', "Nouvelle notification d'amis"],
  request: [
    'Demande de jeu',
    'Un joueur veut jouer avec vous sur un de vos créneaux',
  ],
  response: [
    'Demande de jeu',
    'Vous avez reçu une réponse à une demande de jeu',
  ],
  league: ['Ligue', "Les tableaux d'une de vos ligues sont prêts"],
} as const;
export function tokens(players: DocumentData[]) {
  return [
    ...new Set(
      players.flatMap((p) =>
        typeof p.fcmToken === 'string'
          ? [p.fcmToken]
          : Array.isArray(p.fcmToken)
            ? p.fcmToken.filter(
                (t: unknown): t is string =>
                  typeof t === 'string' && t.length > 0,
              )
            : [],
      ),
    ),
  ];
}
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(FirebaseService) private readonly firebase: FirebaseService,
  ) {}
  // Called only after transaction reads; queue creation commits with the mutation.
  enqueue(
    tx: Transaction,
    players: DocumentData[],
    title: string,
    body: string,
  ) {
    const recipients = tokens(players);
    if (!recipients.length) return;
    tx.create(this.firebase.db.collection('notifications_to_send').doc(), {
      title,
      body,
      toFcmToken: recipients,
      status: 'PENDING',
      createdAt: FieldValue.serverTimestamp(),
    });
  }
}
@Global()
@Module({ providers: [NotificationsService], exports: [NotificationsService] })
export class NotificationsModule {}
