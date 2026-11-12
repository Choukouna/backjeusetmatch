import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  FieldValue,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';
export function operation(db: Firestore, uid: string, id: string) {
  return db
    .collection('_api_operations')
    .doc(createHash('sha256').update(`${uid}:${id}`).digest('hex'));
}
export function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export async function previousOperation(
  tx: Transaction,
  db: Firestore,
  uid: string,
  id: string,
  body: unknown,
): Promise<string | undefined> {
  const snapshot = await tx.get(operation(db, uid, id));
  if (!snapshot.exists) return;
  if (snapshot.get('fingerprint') !== fingerprint(body))
    throw new ConflictException({ code: 'OPERATION_REUSED' });
  return snapshot.get('resourceId') as string;
}
export function finishOperation(
  tx: Transaction,
  db: Firestore,
  uid: string,
  id: string,
  body: unknown,
  resourceId: string,
) {
  tx.create(operation(db, uid, id), {
    fingerprint: fingerprint(body),
    resourceId,
    createdAt: FieldValue.serverTimestamp(),
  });
}
