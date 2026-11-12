# Cloud Run deployment

Deploy first to a dedicated Firebase test project. Select the Cloud Run region near the existing Firestore location; the production project, region, hostname, and service identity are deployment inputs and are not embedded in source.

Build the Dockerfile with your container builder and publish an immutable image to Artifact Registry. Run as a dedicated service account with only the required Firebase Auth administration, Firestore access, and access to the chat-key secret. `createCustomToken` also requires signing permission (`iam.serviceAccounts.signBlob` on the signing identity; typically a scoped Service Account Token Creator grant) and the IAM Credentials API. Do not download a service-account key into the container.

Set `NODE_ENV=production`, `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY`, `CORS_ORIGINS` (explicit web origins if applicable), and `ENABLE_SWAGGER=false`. Bind `CHAT_ENCRYPTION_KEY` from Secret Manager to the existing shared application key. Do not set emulator hosts. Cloud Run supplies `PORT`; the app listens on `0.0.0.0` and handles termination signals.

Configure a 300-second request timeout for SSE and test reconnects through the actual load balancer. Cloud Run needs to accept public invocation because Firebase bearer-token validation occurs in NestJS; do not require a second Google IAM token from Flutter. Limit instance count and concurrency according to Firestore listener load. SSE connections keep requests active and incur instance/listener costs. Start with one instance in staging, then verify two instances before increasing production traffic.

The built-in throttler and SSE connection counts are per instance. Configure a shared edge rate limit (for example a Cloud Armor policy behind an external load balancer) before an internet-facing production rollout. Do not assume in-process counters enforce a global quota across Cloud Run instances. Preserve accurate client IP attribution at the trusted ingress; the app does not trust arbitrary forwarded headers.

Liveness is `/api/jeusetfun/v1/health/live`; readiness checks Firestore at `/api/jeusetfun/v1/health/ready`. Logs use request IDs and exclude credentials and request bodies. Monitor API error rates/latency, denied requests, Firestore reads/listeners, signup completion failures, and notification queue age. NestJS Observe is not connected: a real Observe account/key pair is needed before adding the production telemetry integration described in AGENTS.md. Existing production telemetry must be checked before drawing release/regression conclusions.

Review `firestore.indexes.json` against the deployed indexes; merge additions rather than deleting existing indexes. Deploy only indexes with an explicit project:

```bash
npm exec firebase -- deploy --only firestore:indexes --config firebase.indexes.config.json --project YOUR_TEST_PROJECT
```

`firebase.emulators.json` and `test/firestore.rules` are exclusively for local tests. Never deploy emulator rules to a live project. The current production Firestore rules and notification sender live outside this repo and must remain unchanged during coexistence.

Production rollout needs real project configuration, credentials, deployed-index verification, notification-sender verification, and frontend test builds. None is inferred or executed automatically.
