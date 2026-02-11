const AUTOBLOW_LATENCY_API = 'https://latency.autoblowapi.com';
const RESOLVE_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Ordered by preference for your setup: primary cluster first, then global fallbacks.
const KNOWN_CLUSTER_URLS = [
  'https://ca-central-1.autoblowapi.com',
  'https://us-east-1.autoblowapi.com',
  'https://us-east-2.autoblowapi.com',
  'https://us-west-1.autoblowapi.com',
  'https://us-west-2.autoblowapi.com',
  'https://ap-southeast-2.autoblowapi.com',
  'https://eu-west-2.autoblowapi.com',
  'https://eu-central-1.autoblowapi.com',
];

type ConnectedResponse = {
  connected?: boolean;
  cluster?: string;
};

let cachedClusterUrl: string | null = null;
let cachedAt = 0;

function normalizeClusterUrl(raw: string): string {
  const value = raw.trim().replace(/^['"]|['"]$/g, '').replace(/\/+$/, '');
  if (!value) return '';

  const aliases: Record<string, string> = {
    ca: 'ca-central-1',
    use1: 'us-east-1',
    use2: 'us-east-2',
    usw1: 'us-west-1',
    usw2: 'us-west-2',
    aps2: 'ap-southeast-2',
    euw2: 'eu-west-2',
    euc1: 'eu-central-1',
  };
  const canonical = aliases[value] || value;
  if (canonical.startsWith('http://') || canonical.startsWith('https://')) {
    return canonical;
  }
  if (canonical.includes('.')) {
    return `https://${canonical}`;
  }
  return `https://${canonical}.autoblowapi.com`;
}

function uniqueUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const url of urls) {
    const normalized = normalizeClusterUrl(url);
    if (!normalized) continue;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(normalized);
    }
  }
  return unique;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs: number = RESOLVE_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function isClusterUsable(baseUrl: string, deviceToken: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/autoblow/state`, {
      method: 'GET',
      headers: { 'x-device-token': deviceToken },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function discoverClusterFromLatency(deviceToken: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(`${AUTOBLOW_LATENCY_API}/autoblow/connected`, {
      method: 'GET',
      headers: { 'x-device-token': deviceToken },
    });

    if (!response.ok) return null;

    const data = await response.json() as ConnectedResponse;
    if (!data.connected || !data.cluster) return null;

    return normalizeClusterUrl(data.cluster);
  } catch {
    return null;
  }
}

function getCandidates(explicitCluster?: string): string[] {
  const candidates: string[] = [];
  if (explicitCluster?.trim()) {
    candidates.push(explicitCluster.trim());
  }
  candidates.push(...KNOWN_CLUSTER_URLS);
  return uniqueUrls(candidates);
}

export async function resolveAutoblowClusterUrl(deviceToken: string, explicitCluster?: string): Promise<string> {
  if (!deviceToken) {
    throw new Error('Device token not configured');
  }

  const now = Date.now();
  if (cachedClusterUrl && now - cachedAt < CACHE_TTL_MS) {
    return cachedClusterUrl;
  }

  // Fast path: try preferred cluster(s), including configured cluster first.
  const candidates = getCandidates(explicitCluster);
  for (const candidate of candidates) {
    if (await isClusterUsable(candidate, deviceToken)) {
      cachedClusterUrl = candidate;
      cachedAt = now;
      return candidate;
    }
  }

  // Discovery path: ask Autoblow latency API for the currently connected cluster.
  const discovered = await discoverClusterFromLatency(deviceToken);
  if (discovered) {
    if (await isClusterUsable(discovered, deviceToken)) {
      cachedClusterUrl = discovered;
      cachedAt = now;
      return discovered;
    }
  }

  throw new Error('Unable to resolve Autoblow cluster from configured and fallback regions');
}
