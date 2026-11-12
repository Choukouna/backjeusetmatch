import { z } from 'zod';

const environment = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_WEB_API_KEY: z.string().min(1),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
  CHAT_ENCRYPTION_KEY:
      z
    .string()
    .refine((v) => Buffer.byteLength(v) === 32, 'Expected 32 UTF-8 bytes'),
  CORS_ORIGINS: z.string().default(''),
  ENABLE_SWAGGER: z.enum(['true', 'false']).default('false'),
});
export function validateEnvironment(input: Record<string, unknown>) {
  const result = environment.parse(input);
  if (
    result.NODE_ENV === 'production' &&
    (result.FIRESTORE_EMULATOR_HOST || result.FIREBASE_AUTH_EMULATOR_HOST)
  ) {
    throw new Error('Production cannot use Firebase emulators');
  }
  if (
    Boolean(result.FIRESTORE_EMULATOR_HOST) !==
    Boolean(result.FIREBASE_AUTH_EMULATOR_HOST)
  )
    throw new Error('Configure both Firebase emulators or neither');
  return result;
}
