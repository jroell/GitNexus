# Vurvey GitNexus Cloud Run

This deploy bundle builds one Cloud Run service per Vurvey environment. Each service embeds a fresh GitNexus index for:

- `Batterii/vurvey-api`
- `Batterii/vurvey-web-manager`
- `Batterii/vurvey-cli`

The Cloud Build config builds GitNexus from upstream source, clones the requested refs, runs `gitnexus analyze --embeddings 0 --skip-agents-md`, syncs an environment group, bakes `/workspace/.gitnexus-runtime` into a runtime image, and deploys `gitnexus serve` behind a Basic Auth proxy.

`--embeddings 0` disables GitNexus' 50,000-node safety cap so large Vurvey repos still get vectors. The build and runtime both use OpenAI-compatible HTTP embeddings with `text-embedding-3-small` and `GITNEXUS_EMBEDDING_DIMS=1536`, so query embeddings match the indexed vectors. The build patches GitNexus' HTTP embedding timeout to 120 seconds before compiling so larger OpenAI batches do not fail on the fixed upstream 30 second timeout.

Cloud Run warmup can take several minutes before `gitnexus serve` is listening; the verify step waits for `/api/health` readiness before asserting repo/search routes.

## Required GCP Resources

- Artifact Registry Docker repository: `gitnexus`
- Secret Manager secrets:
  - `gitnexus-github-token`
  - `gitnexus-basic-auth-user`
  - `gitnexus-basic-auth-password`
  - `gitnexus-openai-api-key`

## Manual Deploy

Staging:

```bash
gcloud builds submit deploy/vurvey-gitnexus \
  --project=vurvey-development \
  --config=deploy/vurvey-gitnexus/cloudbuild.index-and-deploy.yaml \
  --substitutions=_ENV=staging,_SERVICE=gitnexus-staging,_API_REF=staging,_WEB_REF=staging,_CLI_REF=main,_IMAGE_TAG="$(date +%Y%m%d-%H%M%S)"
```

Experimental:

```bash
gcloud builds submit deploy/vurvey-gitnexus \
  --project=vurvey-development \
  --config=deploy/vurvey-gitnexus/cloudbuild.index-and-deploy.yaml \
  --substitutions=_ENV=experimental,_SERVICE=gitnexus-experimental,_API_REF=experimental,_WEB_REF=experimental,_CLI_REF=main,_IMAGE_TAG="$(date +%Y%m%d-%H%M%S)"
```

Production:

```bash
gcloud builds submit deploy/vurvey-gitnexus \
  --project=vurvey-production \
  --config=deploy/vurvey-gitnexus/cloudbuild.index-and-deploy.yaml \
  --substitutions=_ENV=prod,_SERVICE=gitnexus-prod,_API_REF=release,_WEB_REF=release,_CLI_REF=v0.16.0,_IMAGE_TAG="$(date +%Y%m%d-%H%M%S)"
```

## Registry Names

Each environment registers three repositories:

- `vurvey-api-<env>`
- `vurvey-web-manager-<env>`
- `vurvey-cli-<env>`

Each environment also has a group:

- `vurvey-<env>`
