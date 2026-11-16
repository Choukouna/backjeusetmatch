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

## GitHub Actions image publishing

`.github/workflows/docker-publish.yml` checks pull requests targeting `main` and
pushes to `main`: Node 24 dependency installation, lint, typecheck, unit tests,
HTTP end-to-end tests, and a `linux/amd64` Docker build. Emulator integration tests
remain a separate check. Pull requests never authenticate to Google Cloud or push
images. Pushes to `main`, and manual runs selecting `main`, publish after checks
pass. Manual runs on other branches only validate.

Images are tagged with the full Git commit SHA, without a mutable `latest` tag:
`REGION-docker.pkg.dev/PROJECT_ID/jeusetfun/backend:COMMIT_SHA`. The workflow summary
includes the image URI, digest, and digest-based reference for a later deployment.
Re-running a commit can rebuild its image (the base image tag can change); use the
recorded digest when promoting an exact artifact. This workflow does not deploy
to Cloud Run or change Firebase resources.

### Google Cloud setup (done one time to config connection between GCP and Github)

Run the following as a Google Cloud administrator in a Bash shell with `gcloud`
and GitHub CLI (`gh`) installed and authenticated. Use your existing project ID.
Choose the repository region near Firestore and the intended Cloud Run service;
`europe-west9` below is an example, not a required location. These commands create
resources and IAM bindings; run them once, skipping resources already created.

```bash
export GCP_PROJECT_ID='YOUR_EXISTING_PROJECT_ID'
export GAR_LOCATION='europe-west9'
export GAR_REPOSITORY='jeusetfun'
export GITHUB_REPOSITORY='Choukouna/backjeusetmatch'
export WIF_POOL='github-artifact-publisher'
export WIF_PROVIDER='github'
export PUBLISHER_NAME='github-artifact-publisher'

GCP_PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')
GITHUB_REPOSITORY_ID=$(gh api "repos/$GITHUB_REPOSITORY" --jq '.id')
GITHUB_OWNER_ID=$(gh api "repos/$GITHUB_REPOSITORY" --jq '.owner.id')
GCP_SERVICE_ACCOUNT="${PUBLISHER_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  sts.googleapis.com \
  iamcredentials.googleapis.com \
  --project="$GCP_PROJECT_ID"

gcloud artifacts repositories create "$GAR_REPOSITORY" \
  --project="$GCP_PROJECT_ID" \
  --location="$GAR_LOCATION" \
  --repository-format=docker \
  --description='JeuSetFun backend images'

gcloud iam service-accounts create "$PUBLISHER_NAME" \
  --project="$GCP_PROJECT_ID" \
  --display-name='GitHub Artifact Registry publisher'

gcloud artifacts repositories add-iam-policy-binding "$GAR_REPOSITORY" \
  --project="$GCP_PROJECT_ID" \
  --location="$GAR_LOCATION" \
  --member="serviceAccount:$GCP_SERVICE_ACCOUNT" \
  --role='roles/artifactregistry.writer'

gcloud iam workload-identity-pools create "$WIF_POOL" \
  --project="$GCP_PROJECT_ID" \
  --location=global \
  --display-name='GitHub backend image publishing'

gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
  --project="$GCP_PROJECT_ID" \
  --location=global \
  --workload-identity-pool="$WIF_POOL" \
  --issuer-uri='https://token.actions.githubusercontent.com' \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref' \
  --attribute-condition="assertion.repository_owner_id == '${GITHUB_OWNER_ID}' && assertion.repository_id == '${GITHUB_REPOSITORY_ID}' && assertion.ref == 'refs/heads/main' && (assertion.event_name == 'push' || assertion.event_name == 'workflow_dispatch')"

gcloud iam service-accounts add-iam-policy-binding "$GCP_SERVICE_ACCOUNT" \
  --project="$GCP_PROJECT_ID" \
  --role='roles/iam.workloadIdentityUser' \
  --member="principalSet://iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository_id/${GITHUB_REPOSITORY_ID}"

GCP_WORKLOAD_IDENTITY_PROVIDER="projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"

# Repository settings → Secrets and variables → Actions → Variables.
gh variable set GCP_PROJECT_ID --repo "$GITHUB_REPOSITORY" --body "$GCP_PROJECT_ID"
gh variable set GAR_LOCATION --repo "$GITHUB_REPOSITORY" --body "$GAR_LOCATION"
gh variable set GAR_REPOSITORY --repo "$GITHUB_REPOSITORY" --body "$GAR_REPOSITORY"
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$GITHUB_REPOSITORY" --body "$GCP_WORKLOAD_IDENTITY_PROVIDER"
gh variable set GCP_SERVICE_ACCOUNT --repo "$GITHUB_REPOSITORY" --body "$GCP_SERVICE_ACCOUNT"
```

All five settings are GitHub repository **variables**, not secrets. Authentication
uses short-lived GitHub OIDC credentials through Workload Identity Federation;
no service-account key is created. The publisher can write only to this Artifact
Registry repository and is separate from the eventual Cloud Run runtime identity.
The provider uses numeric GitHub owner/repository IDs to avoid trusting a reused
repository name, and permits only main-branch push/manual events. See the
[Google authentication action documentation](https://github.com/google-github-actions/auth)
and [Artifact Registry access control](https://cloud.google.com/artifact-registry/docs/access-control).

No Firebase settings or chat keys are needed to build the image. Credential-file
generation is disabled, and `gha-creds-*.json` is excluded from Git and the Docker
build context as a precaution.

### Verify the first publication

1. Open a pull request targeting `main`; confirm checks and the container build
   succeed, with the publish job skipped and no Google authentication step.
2. Merge to `main` or manually run the workflow on `main`. Missing variables must
   produce a named configuration error. Newly created IAM bindings may take a few
   minutes to propagate before authentication succeeds.
3. Confirm the workflow summary contains the SHA-tagged image and its digest.
   Check the remote image with:

   ```bash
   gcloud artifacts docker images describe \
     "${GAR_LOCATION}-docker.pkg.dev/${GCP_PROJECT_ID}/${GAR_REPOSITORY}/backend:COMMIT_SHA" \
     --project="$GCP_PROJECT_ID" \
     --format='value(image_summary.digest)'
   ```

   Replace `COMMIT_SHA` with the published commit and compare the returned digest
   with the workflow summary.
4. Run manually on a non-main branch after the workflow exists there; confirm
   validation runs and publishing is skipped. Review that no credential files or
   application secrets appear in the repository, build inputs, or logs.
