# Token Queue Stream

A livestream token queue system with Solana payments (DEVNET) and real-time mainnet trade monitoring via Helius webhooks.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              HYBRID NETWORK SETUP                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PAYMENTS (DEVNET)                    WEBHOOKS (MAINNET)                    │
│  ─────────────────                    ──────────────────                    │
│  • Users pay with test SOL            • Track real token trades             │
│  • Get SOL: faucet.solana.com         • Helius enhanced webhooks            │
│  • Queue positions via devnet         • Real-time trade alerts              │
│  • No real money required             • Firebase for persistence            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Security Features

### Webhook Security
- **IP Allowlisting**: Only accept webhooks from Helius's known IP addresses
- **Auth Token Verification**: Validate incoming webhook authorization headers
- **Server-side API Keys**: Mainnet Helius key never exposed to browser

### Firebase Security
- **Firestore Rules**: Strict read/write permissions
- **Admin SDK**: Server-side operations only
- **Anonymous Auth**: Track users without requiring accounts

### API Security
- **Admin Key Protection**: All management endpoints require authentication
- **Cron Secret**: Queue processing only via authorized cron jobs
- **Signature Verification**: Prevent payment replay attacks

## Quick Start

### 1. Clone and Install

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

**Required Configuration:**

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_HELIUS_API_KEY` | Devnet API key for client RPC |
| `HELIUS_API_KEY` | Mainnet API key for webhooks (server-only) |
| `HELIUS_WEBHOOK_AUTH_TOKEN` | Auth token for webhook verification |
| `FIREBASE_*` | Firebase project credentials |
| `REDIS_URL` | Redis primary store for chart-sync sessions |
| `ADMIN_API_KEY` | Admin endpoint protection |
| `CRON_SECRET` | Queue processing authentication |

### 3. Generate Security Keys

```bash
# Generate secure random keys
openssl rand -hex 32  # Use for ADMIN_API_KEY
openssl rand -hex 32  # Use for CRON_SECRET
openssl rand -hex 32  # Use for HELIUS_WEBHOOK_AUTH_TOKEN
```

### 4. Firebase Setup

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com)
2. Enable **Firestore Database**
3. Enable **Anonymous Authentication**
4. Generate Admin SDK private key (Project Settings > Service Accounts)
5. Deploy security rules:

```bash
firebase deploy --only firestore:rules
```

### 5. Run Development Server

```bash
npm run dev
```

### 6. Initialize Webhook (After Deployment)

Once deployed, initialize the Helius webhook:

```bash
curl -X POST https://your-domain.com/api/webhook/manage \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tokenMint": "YOUR_DEFAULT_TOKEN_ADDRESS"}'
```

## API Endpoints

### Public Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/queue/add` | POST | Add token to queue (requires payment) |
| `/api/helius-webhook` | POST | Receive Helius trade webhooks |

### Protected Endpoints (require `ADMIN_API_KEY`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhook/manage` | GET | Get webhook status |
| `/api/webhook/manage` | POST | Create/update webhook |
| `/api/webhook/manage` | DELETE | Remove webhook |
| `/api/queue/process` | GET | Get queue status |
| `/api/queue/process` | POST | Process queue (cron) |

## Deployment (Vercel)

### 1. Deploy to Vercel

```bash
vercel
```

### 2. Configure Environment Variables

Add all `.env` variables to Vercel project settings.

### 3. Run Pre-Deploy Check

```bash
npm run check:vercel
```

### 4. Configure Cron

The `vercel.json` includes cron configuration for queue processing and device ticks:

```json
{
  "crons": [
    {
      "path": "/api/queue/process",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/device/tick",
      "schedule": "* * * * *"
    }
  ]
}
```

### 5. Update App URL

After deployment, update `NEXT_PUBLIC_APP_URL` to your Vercel domain.

## Development Notes

### Local Webhook Testing

Use ngrok to expose localhost for webhook testing:

```bash
ngrok http 3000
```

Then update `NEXT_PUBLIC_APP_URL` to your ngrok URL and reinitialize the webhook.

### Network Behavior

| Action | Network | Notes |
|--------|---------|-------|
| User payments | DEVNET | Test SOL from faucet |
| Payment verification | DEVNET | RPC calls to devnet |
| Webhook management | MAINNET | Helius API calls |
| Trade monitoring | MAINNET | Real token trades |
| Webhook delivery | MAINNET | Enhanced transaction data |

### IP Verification

For production, enable IP verification:

```env
VERIFY_WEBHOOK_IP=true
```

Helius webhook IPs are configured in `src/lib/constants.ts`. Verify they're current at [docs.helius.dev](https://docs.helius.dev/webhooks/ip-addresses).

## Troubleshooting

### Webhook not receiving events

1. Check webhook status: `GET /api/webhook/manage` with admin key
2. Verify the token address is a mainnet token
3. Check Helius dashboard for webhook delivery logs
4. Ensure `VERIFY_WEBHOOK_IP` is `false` during development

### Payments not verifying

1. Ensure using devnet SOL (get from faucet.solana.com)
2. Check wallet is connected to devnet
3. Verify treasury wallet address in constants

### Firebase permission errors

1. Deploy Firestore rules: `firebase deploy --only firestore:rules`
2. Check Admin SDK credentials are correct
3. Verify `FIREBASE_PRIVATE_KEY` has `\n` for newlines

## File Structure

```
src/
├── app/
│   └── api/
│       ├── helius-webhook/    # Mainnet trade webhooks
│       ├── queue/
│       │   ├── add/          # Add to queue (with payment)
│       │   └── process/      # Process queue (cron)
│       └── webhook/
│           └── manage/       # Webhook CRUD
├── components/
│   ├── PaymentPanel.tsx      # Queue payment UI
│   └── ...
├── lib/
│   ├── constants.ts          # Configuration
│   ├── firebase.ts           # Client SDK
│   ├── firebase-admin.ts     # Admin SDK
│   └── helius.ts            # Helius utilities
└── store/
    └── useQueueStore.ts      # State management
```

## License

MIT
