import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key]) continue;
    let value = trimmed.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(path.resolve(process.cwd(), '.env.local'));

const required = [
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_HELIUS_API_KEY',
  'HELIUS_API_KEY',
  'NEXT_PUBLIC_HELIUS_RPC_URL',
  'NEXT_PUBLIC_HELIUS_WS_URL',
  'NEXT_PUBLIC_TREASURY_WALLET',
  'NEXT_PUBLIC_DEFAULT_TOKEN',
  'HELIUS_WEBHOOK_AUTH_TOKEN',
  'AUTOBLOW_DEVICE_TOKEN',
  'AUTOBLOW_CLUSTER',
  'AUTOBLOW_ENABLED',
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
  'REDIS_URL',
  'ADMIN_API_KEY',
  'CRON_SECRET',
];

const weakSecretPatterns = [
  /change_later/i,
  /^dev_/i,
  /^test/i,
  /^placeholder/i,
];

const missing = [];
const weak = [];
const warnings = [];

for (const key of required) {
  if (!process.env[key] || process.env[key].trim() === '') {
    missing.push(key);
  }
}

// Firebase Admin credentials: require either a JSON blob OR (private key + client email)
const hasAdminJson = !!(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_ADMIN_JSON);
const hasAdminParts = !!(process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL);
if (!hasAdminJson && !hasAdminParts) {
  missing.push('FIREBASE_SERVICE_ACCOUNT_JSON (or FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL)');
}

for (const key of ['ADMIN_API_KEY', 'CRON_SECRET']) {
  const value = process.env[key] || '';
  if (!value) continue;
  if (value.length < 24 || weakSecretPatterns.some((p) => p.test(value))) {
    weak.push(key);
  }
}

if (!hasAdminJson && (process.env.FIREBASE_PRIVATE_KEY || '').includes('BEGIN PRIVATE KEY') === false) {
  warnings.push('FIREBASE_PRIVATE_KEY does not look like a private key.');
}

if ((process.env.AUTOBLOW_ENABLED || '').toLowerCase() !== 'true') {
  warnings.push('AUTOBLOW_ENABLED is not "true". Device control will be disabled.');
}

if (process.env.NEXT_PUBLIC_APP_BASEPATH?.trim() || process.env.NEXT_PUBLIC_TRENCHRIG_PATH?.trim()) {
  warnings.push('Base path is set. For root-domain deploy, leave NEXT_PUBLIC_APP_BASEPATH and NEXT_PUBLIC_TRENCHRIG_PATH empty.');
}

if (process.env.NEXT_PUBLIC_DEVICE_API_KEY?.trim()) {
  warnings.push('NEXT_PUBLIC_DEVICE_API_KEY is set. Prefer DEVICE_API_KEY to avoid exposing secret to browser bundles.');
}

if (process.env.NEXT_PUBLIC_APP_URL && !process.env.NEXT_PUBLIC_APP_URL.startsWith('https://')) {
  warnings.push('NEXT_PUBLIC_APP_URL should use https:// in production.');
}

if (missing.length > 0 || weak.length > 0) {
  console.error('Vercel deploy env check failed.');
  if (missing.length > 0) {
    console.error(`Missing required env vars (${missing.length}):`);
    for (const key of missing) console.error(`- ${key}`);
  }
  if (weak.length > 0) {
    console.error(`Weak placeholder secrets detected (${weak.length}):`);
    for (const key of weak) console.error(`- ${key}`);
  }
  if (warnings.length > 0) {
    console.error('Warnings:');
    for (const w of warnings) console.error(`- ${w}`);
  }
  process.exit(1);
}

console.log('Vercel deploy env check passed.');
if (warnings.length > 0) {
  console.log('Warnings:');
  for (const w of warnings) console.log(`- ${w}`);
}
