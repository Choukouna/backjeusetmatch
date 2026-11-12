import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  FieldPath,
  Timestamp,
  type DocumentData,
  type Query,
  type DocumentSnapshot,
} from 'firebase-admin/firestore';
import type { PageInput } from '../common/http.js';

export function requireDocument(snapshot: DocumentSnapshot): DocumentData {
  if (!snapshot.exists) throw new NotFoundException();
  return snapshot.data()!;
}
export function fields(
  data: DocumentData,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((k) => data[k] !== undefined)
      .map((k) => [k, serialize(data[k])]),
  );
}
export function participantDtos(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (p): p is { uid: string; name?: string } =>
        p !== null && typeof p === 'object' && typeof p.uid === 'string',
    )
    .map((p) => ({
      uid: p.uid,
      name: typeof p.name === 'string' ? p.name : '',
    }));
}
export function serialize(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, serialize(v)]),
    );
  return value;
}
export async function paginate(
  query: Query,
  page: PageInput,
  project: (data: DocumentData, id: string) => Record<string, unknown>,
  scope: string,
  orderedCollectionPath?: string,
  documentDirection: 'asc' | 'desc' = 'asc',
) {
  let ordered = query.orderBy(FieldPath.documentId(), documentDirection);
  if (page.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(page.cursor, 'base64url').toString(),
      ) as { id: string; scope: string };
      if (
        decoded.scope !== scope ||
        typeof decoded.id !== 'string' ||
        !decoded.id ||
        decoded.id.includes('/')
      )
        throw new Error();
      if (orderedCollectionPath) {
        const snapshot = await query.firestore
          .doc(`${orderedCollectionPath}/${decoded.id}`)
          .get();
        if (!snapshot.exists) throw new Error();
        ordered = ordered.startAfter(snapshot);
      } else ordered = ordered.startAfter(decoded.id);
    } catch {
      throw new BadRequestException({ code: 'INVALID_CURSOR' });
    }
  }
  const result = await ordered.limit(page.limit + 1).get();
  const docs = result.docs.slice(0, page.limit);
  return {
    items: docs.map((d) => project(d.data(), d.id)),
    nextCursor:
      result.size > page.limit
        ? Buffer.from(JSON.stringify({ id: docs.at(-1)!.id, scope })).toString(
            'base64url',
          )
        : null,
  };
}
