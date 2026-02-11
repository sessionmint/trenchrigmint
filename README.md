# SessionMint TrenchRig

SessionMint.fun runs TrenchRig on deterministic Session States.

When a Session State is purchased, it becomes the enforced live focus. The selected token chart is used as the control signal, and TrenchRig executes that signal in real time.

## Network

- Solana payments: `mainnet-beta`
- Helius RPC/WS: `mainnet`
- Helius webhook management + delivery: `mainnet`
- Stream defaults:
- Embed: `https://player.kick.com/sessionmint`
- Channel: `https://kick.com/sessionmint`

## Core Flow (Session State)

1. Connect wallet.
2. Enter token contract and purchase Session State.
3. Token becomes active (or queued by priority rules), chart drives live execution.

## Pricing and Priority

- Standard: `0.01 SOL` (10 min display)
- Priority Basic: `0.04 SOL` (10 min, higher priority)
- Priority Duplicate: `0.10 SOL` (10 min, higher priority)
- Priority Premium: `0.42 SOL` (60 min, highest priority)

Reference: `src/lib/constants.ts`

## Architecture

- Next.js app router UI + APIs
- Wallet connection and on-chain payment verification
- Queue persistence: Redis/Vercel KV (recommended) or Vercel Blob (lightweight), with Firestore fallback
- Redis (optional, recommended) for chart-sync session persistence
- Helius enhanced webhooks for trade data and metadata
- Cron-driven queue progression and device tick processing

## Environment Setup

Copy `.env.example` to `.env` and set values:

```bash
cp .env.example .env
```

Required variables:

- `NEXT_PUBLIC_APP_URL` (production URL, e.g. `https://trenchrig.sessionmint.fun`)
- `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta`
- `NEXT_PUBLIC_TREASURY_WALLET`
- `NEXT_PUBLIC_DEFAULT_TOKEN`
- `NEXT_PUBLIC_HELIUS_RPC_URL=https://mainnet.helius-rpc.com`
- `NEXT_PUBLIC_HELIUS_WS_URL=wss://mainnet.helius-rpc.com`
- `NEXT_PUBLIC_HELIUS_API_KEY`
- `HELIUS_API_KEY` (server-side)
- `HELIUS_WEBHOOK_AUTH_TOKEN`
- `QUEUE_DRIVER` (`redis`, `kv`, or `firestore`)
- `KV_URL` / `REDIS_URL` (+ optional `REDIS_QUEUE_PREFIX`)
- `BLOB_READ_WRITE_TOKEN` (if `QUEUE_DRIVER=blob`)
- `BLOB_QUEUE_PREFIX` (optional, defaults `queue`)
- `FIREBASE_*` and/or `FIREBASE_ADMIN_JSON`
- `ADMIN_API_KEY`
- `CRON_SECRET`

## Local Development

```bash
npm install
npm run dev
```

## Webhook Initialization

After deployment, initialize webhook tracking:

```bash
curl -X POST https://your-domain.com/api/webhook/manage \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tokenMint":"YOUR_DEFAULT_TOKEN_ADDRESS"}'
```

## API Surface

Public:

- `POST /api/queue/add` - verify payment and enqueue Session State
- `POST /api/helius-webhook` - receive trade webhooks
- `GET /api/state` - read current token + queue snapshot

Protected (`ADMIN_API_KEY`):

- `GET/POST/DELETE /api/webhook/manage` - webhook status and lifecycle
- `GET/POST /api/queue/process` - queue status/process
- `GET /api/device/status` - device status

## Deployment (Vercel)

1. Deploy:

```bash
vercel
```

2. Add all required environment variables in Vercel project settings.
3. Run:

```bash
npm run check:vercel
```

4. Keep cron routes enabled in `vercel.json`:
- `/api/queue/process`
- `/api/device/tick`

## Security Notes

- Webhook auth token validation is supported and recommended.
- Optional webhook IP allowlisting can be enabled via `VERIFY_WEBHOOK_IP=true`.
- Admin endpoints are protected by `ADMIN_API_KEY`.
- Server-side Helius key remains private (`HELIUS_API_KEY`).

## SessionMint Terminology

- Session State: purchased state that controls live focus and execution.
- Load Session State: user action to submit token + payment.
- Active Session State: currently enforced token/chart control.

## License

MIT
