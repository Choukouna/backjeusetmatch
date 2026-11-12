# JeuSetFun backend

NestJS 12 REST API for the French Flutter tennis/padel application. This repository owns application rules and Firebase Admin access. The Flutter repository remains unchanged; its feature-by-feature API integration is the next migration stage.

## Run locally

Requires Node 24 and Java 21+ for the Firestore emulator.

```bash
npm ci
cp .env.example .env
npm exec firebase -- emulators:start --config firebase.emulators.json --project demo-jeusetfun --only auth,firestore
# In another terminal:
npm run start:dev
```

The API is at `/api/jeusetfun/v1`; Swagger UI at `/api/docs` and OpenAPI JSON at `/api/docs-json` when `ENABLE_SWAGGER=true`. The demo emulators use no production project or credentials. Use the 32-byte existing app key only when connecting to legacy records; changing it breaks old-client chat compatibility. Never commit real environment files or service-account keys.

For a real test/production Firebase project, remove both emulator variables, supply its project ID and Firebase Web API key, and use Application Default Credentials. Cloud Run uses its attached service account; local ADC setup is `gcloud auth application-default login`. The API key identifies Firebase's Identity Toolkit project; it does not replace bearer authentication.

## Verify

```bash
npm run build
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run test:emulators
```

`test:e2e` checks HTTP validation/authentication with a stubbed Firebase provider. `test:emulators` starts isolated demo Auth/Firestore services and runs transactional/API integration tests. If emulators are already running, use `npm run test:integration`. Integration tests clear the demo emulator database and explicitly reject non-demo/nonlocal configuration. Java 21 must be on PATH. The emulator rules deny client access; Admin SDK bypasses them as in production.

## APIs

All routes below use `/api/jeusetfun/v1`. Bearer Firebase ID tokens are required except login, signup, reset, communes, and health. Public player DTOs exclude emails, real names, and FCM tokens.

| Domain         | Routes                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication | `POST /auth/login`, `/auth/signup`, `/auth/complete-profile`, `/auth/password-reset`; `DELETE /auth/account`                                                       |
| Players        | `GET /players`, `/players/me`, `/players/:id`, `/players/by-pseudo/:pseudo`; `PATCH /players/me`; `POST /players/me/opened`; `PUT/DELETE /players/me/device-token` |
| Communes       | `GET /communes?q=ren&departmentCode=35`                                                                                                                            |
| Matches        | `GET/POST /matches`; `PUT /matches/:id/score` for scheduled league matches                                                                                         |
| Availability   | `GET/POST /slots`; `POST /slots/:id/request`; `PUT /slots/:id/response`; `DELETE /slots/:id`                                                                       |
| Friendships    | `GET /friendships`; `POST/DELETE /friendships/:playerId`; `PUT /friendships/:playerId/accept`                                                                      |
| Chat           | `GET /chats`; `POST /chats/direct`; `GET/POST /chats/:id/messages`; `PUT /chats/:id/read`; `DELETE /chats/:id` (P2P)                                               |
| Live events    | `GET /chats/events`, `/chats/:id/events` with `Accept: text/event-stream` and bearer header                                                                        |
| Groups         | `GET/POST /groups`; `GET/DELETE /groups/:id`; `PUT /groups/:id/members`; `POST /groups/:id/leave`                                                                  |
| Tennis leagues | `GET/POST /leagues`; `GET /leagues/:id`, `/rounds`, `/matches`, `/standings`; `POST/DELETE /leagues/:id/enrollment`; `POST /leagues/:id/close`                     |
| Feedback       | `POST /feedback`                                                                                                                                                   |
| Health         | `GET /health/live`, `/health/ready`                                                                                                                                |

Availability accepts an optional `day=YYYY-MM-DD` within today through day +14 (Europe/Paris); otherwise it returns that whole window. League matches accept `roundNumber`; standings accept `upToRoundNumber`. Use Swagger for request schemas. All fixed UI text stays in Flutter's French `Constante`; the API returns machine-readable `{code,statusCode,requestId}` errors. Request IDs also appear in `x-request-id`. Dates are ISO 8601 strings. Most lists return `{items,nextCursor}` with `limit` (1–100) and an opaque `cursor`; cursors belong to their original query. Chat messages sort newest first, calendars by start time, and commune search by normalized name; other lists sort by document ID. Clients must sort presentation rows and continue while `nextCursor` exists, even if compatibility filtering yields an empty page.

Mutations creating matches, slots, messages, groups, leagues, and feedback, plus slot responses, require a client-generated UUID `operationId`. Retain it across network retries. A reused ID with a different payload returns `OPERATION_REUSED`; never switch to a direct Firestore write after an uncertain API result. Operation records currently have no TTL, so deduplication lasts as long as the record exists.

Login accepts `{pseudo,password}` and returns `{customToken}`. Flutter exchanges the custom token with Firebase `signInWithCustomToken`, then sends Firebase **ID tokens**, not custom tokens, to API calls. Signup also returns `profileComplete`; if false, establish the session and call `/auth/complete-profile` with a corrected profile. If signup loses its network response before session receipt, recover through Firebase email/password sign-in and complete the profile. Firebase SDK session persistence, token refresh, password reauthentication, and FCM receipt remain client responsibilities. Password reset always returns an acceptance response rather than a pseudo/email lookup. Account deletion requires authentication within five minutes; historical player references are anonymized.

For SSE, use a Flutter client that can attach bearer headers. `invalidate` events identify resources to reload through REST; `heartbeat` maintains the stream. `reconnect` closes the stream with a reason. Obtain a fresh ID token, reconnect with exponential backoff/jitter, and reload authoritative snapshots. Membership removal stops a conversation subscription. Server lifetimes are bounded to four minutes, below Cloud Run's configured five-minute timeout. Firestore listeners work across instances and observe writes from older Flutter versions. There is no durable SSE replay; resynchronization is mandatory.

## Deployment and migration

See [migration contracts and rollout](docs/migration.md) and [Cloud Run deployment](docs/deployment.md). No production deployment, rule change, data rewrite, or replacement of the existing notification sender is performed by this repository's tests.
