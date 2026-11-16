import { validateEnvironment } from './environment.js';
const base = {
  FIREBASE_PROJECT_ID: 'demo-test',
  FIREBASE_WEB_API_KEY: 'key',
  CHAT_ENCRYPTION_KEY: '12345678901234567890123456789012',
};
it('rejects incomplete configuration and production emulators', () => {
  expect(() => validateEnvironment({})).toThrow();
  expect(() =>
    validateEnvironment({
      ...base,
      NODE_ENV: 'production',
      FIRESTORE_EMULATOR_HOST: 'localhost:8080',
    }),
  ).toThrow();
  expect(() =>
    validateEnvironment({ ...base, CHAT_ENCRYPTION_KEY: 'short' }),
  ).toThrow();
  expect(validateEnvironment(base).PORT).toBe(3000);
});
