# cutline-asr — Cloudflare Workers AI transcription

One small Worker that turns a WAV chunk into timed words with
`@cf/openai/whisper-large-v3-turbo`. The app does the chunking and keeps the
timeline offsets, so this Worker stays stateless.

```
POST /transcribe?offset=0.000&language=en   body: audio/wav
GET  /health
```

The response is `{ ok, model, offset, text, duration, language, words[], segments[] }`
with every `start`/`end` already shifted by `offset`, ready to feed
`resolveTriggerAnchor`.

## What you need from Cloudflare

### 1. Account ID

Dashboard → **Workers & Pages** → the account ID is in the right-hand sidebar
(or in the URL: `dash.cloudflare.com/<account-id>/...`).

### 2. API token

Dashboard → **My Profile** → **API Tokens** → **Create Token** →
**Create Custom Token**.

| Type      | Permission             | Why                                    |
| --------- | ---------------------- | -------------------------------------- |
| Account   | Workers Scripts — Edit | upload/deploy the Worker               |
| Account   | Workers AI — Read      | call the Whisper model during deploy   |
| Account   | Account Settings — Read| let Wrangler resolve the account       |

Account resources: **your account**. Zone resources: **none**.

> The running Worker does **not** use this token. The `ai` binding in
> `wrangler.jsonc` authenticates the model call from inside Cloudflare, so the
> token is only a deploy credential and never ships to the browser.

## Deploy

Run these from the **repo root**, not from `worker/`. Wrangler refuses to start
inside a subdirectory of this project because Lovable's build leaves a generated
`.wrangler/deploy/config.json` at the root; pointing `--config` at the worker
keeps the two deployments separate.

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "paste-account-id"
$env:CLOUDFLARE_API_TOKEN  = "paste-api-token"

bunx wrangler deploy --config worker/wrangler.jsonc
```

Wrangler prints the URL, e.g. `https://cutline-asr.<your-subdomain>.workers.dev`.

Keep the two environment variables only for the deploy; they are read by
Wrangler, not written anywhere in the repo.

## Verify

```powershell
Invoke-RestMethod https://cutline-asr.<your-subdomain>.workers.dev/health
```

Expect `aiBinding : True`. If it is `False`, the `ai` binding did not upload —
check that `wrangler.jsonc` still contains `"ai": { "binding": "AI" }`.

A real transcription check without the app:

```powershell
$bytes = [IO.File]::ReadAllBytes("C:\path\to\narration.wav")
Invoke-RestMethod -Method Post `
  -Uri "https://cutline-asr.<your-subdomain>.workers.dev/transcribe?offset=0&language=en" `
  -ContentType "audio/wav" -Body $bytes
```

## Lock it down (recommended)

The endpoint is public by default. Two cheap guards:

1. **Shared secret** — the app sends it as `Authorization: Bearer …`:

   ```powershell
   bunx wrangler secret put SHARED_SECRET
   ```

   Enter a long random string. The app stores the same string locally (never in
   the repo) and shows a 401 as "worker rejected the request".

2. **Origin allow-list** — edit `ALLOWED_ORIGINS` in `wrangler.jsonc` so it
   includes every origin that will call the Worker:

   ```jsonc
   "ALLOWED_ORIGINS": "http://localhost:8080,http://localhost:8081,https://your-project.lovable.app"
   ```

   Then redeploy:

   ```powershell
   bunx wrangler deploy --config worker/wrangler.jsonc
   ```

   Requests from other origins get no CORS headers and preflights are rejected
   with 403.

## Local development

```powershell
bunx wrangler dev --config worker/wrangler.jsonc
```

Local dev proxies the model call to Cloudflare, so it needs the same
`CLOUDFLARE_API_TOKEN` (or `wrangler login`). The default local URL is
`http://localhost:8787`.

## Cost

$0.000513 per audio minute. A 10-minute narration is about half a cent, and the
Workers AI free allowance (10,000 neurons/day) covers ordinary editing long
before that.

## Chunking and alignment

The app never sends 1 MB byte slices — those cut words in half. It decodes the
narration to 16 kHz mono, looks for the quietest 250 ms near each 90 s mark, and
sends whole phrases with an `offset`, so every returned word can be mapped back
to the recording without guessing.

`vad_filter` is on by default because it trims long dead air. If the first
transcript's word times look compressed (cues all early), send `?vad=0` for that
run: the app exposes this as the `vad` option on `transcribeAudio`.

A good first check: import a narration with a known phrase near the 10 s mark,
transcribe it, and confirm that word's `start` is within ~0.2 s of where you hear
it.

## Tests

```powershell
bunx vitest run --config worker/vitest.config.ts
bunx tsc -p worker/tsconfig.json --noEmit
```

The Worker is tested with a fake `AI` binding: routing, CORS, the shared secret,
base64 handling, chunk offsets and the `segments[].words[]` normaliser.
