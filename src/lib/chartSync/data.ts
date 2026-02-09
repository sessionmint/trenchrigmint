// ============================================
// CHART DATA FETCHING & PROCESSING
// ============================================

import { Candle, DerivedMetrics, BUFFER_SIZE } from './types';

const DEXSCREENER_API_BASE = 'https://api.dexscreener.com';

export interface DexScreenerTokenProfileLink {
  type: string;
  label: string;
  url: string;
}

export interface DexScreenerTokenProfile {
  url: string;
  chainId: string;
  tokenAddress: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: DexScreenerTokenProfileLink[];
}

// Fetch 1m candles from DexScreener
export async function fetchCandles(tokenMint: string): Promise<Candle[]> {
  try {
    // DexScreener API for Solana pairs
    const response = await fetch(
      `${DEXSCREENER_API_BASE}/latest/dex/tokens/${tokenMint}`,
      { next: { revalidate: 30 } }
    );

    if (!response.ok) {
      console.error('[ChartSync] DexScreener API error:', response.status);
      return [];
    }

    const data = await response.json();
    const pair = data.pairs?.[0];

    if (!pair) {
      console.error('[ChartSync] No pair found for token:', tokenMint);
      return [];
    }

    // DexScreener doesn't provide direct candle data in the token endpoint
    // We use price and aggregate changes to build synthetic minute candles.

    const priceUsd = parseFloat(pair.priceUsd) || 0;
    const priceChange1m = pair.priceChange?.m5 ? parseFloat(pair.priceChange.m5) / 5 : 0; // Approximate 1m from 5m
    const volume = parseFloat(pair.volume?.h1) / 60 || 0; // Approximate 1m volume from hourly

    // Create a synthetic candle from current data
    const now = Date.now();
    const open = priceUsd / (1 + priceChange1m / 100);
    const volatility = Math.abs(priceChange1m) / 100;

    const candle: Candle = {
      open: open,
      high: priceUsd * (1 + volatility * 0.5),
      low: open * (1 - volatility * 0.5),
      close: priceUsd,
      volume: volume,
      timestamp: now
    };

    return [candle];
  } catch (error) {
    console.error('[ChartSync] Error fetching candles:', error);
    return [];
  }
}

// Fetch latest token profiles from DexScreener.
// Endpoint docs indicate a 60 req/min limit.
export async function fetchLatestTokenProfiles(
  chainId: string = 'solana',
  limit: number = 50
): Promise<DexScreenerTokenProfile[]> {
  try {
    const response = await fetch(
      `${DEXSCREENER_API_BASE}/token-profiles/latest/v1`,
      { next: { revalidate: 60 } }
    );

    if (!response.ok) {
      console.error('[ChartSync] DexScreener token profiles error:', response.status);
      return [];
    }

    const data = await response.json();
    const items = Array.isArray(data) ? data : [data];

    return items
      .filter((item: DexScreenerTokenProfile) => !chainId || item.chainId === chainId)
      .slice(0, Math.max(0, limit));
  } catch (error) {
    console.error('[ChartSync] Error fetching DexScreener token profiles:', error);
    return [];
  }
}

// Compute EMA
export function ema(values: number[], n: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const k = 2 / (n + 1);
  let result = values[0];

  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }

  return result;
}

// Compute SMA
export function sma(values: number[], n: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Clamp value to 0-1
export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Clamp to range
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// Normalize volume using z-score approach
export function normalizeVolume(volumes: number[]): number {
  if (volumes.length < 2) return 0.5;

  const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const variance = volumes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / volumes.length;
  const stdDev = Math.sqrt(variance) || 1;

  const latest = volumes[volumes.length - 1];
  const zScore = (latest - mean) / stdDev;

  // Convert z-score to 0-1 range (roughly -3 to +3 maps to 0 to 1)
  return clamp01((zScore + 3) / 6);
}

// Compute derived metrics from candle buffer
export function computeMetrics(candles: Candle[], prevLiquidity?: number): DerivedMetrics {
  if (candles.length === 0) {
    return {
      ret: 0,
      rangePct: 0,
      trend: 0,
      chop: 0,
      volNorm: 0.5,
      liqDrop: 0,
      accel: 0,
      deviation: 0
    };
  }

  const latest = candles[candles.length - 1];

  // Basic metrics for latest candle
  const ret = latest.open > 0 ? (latest.close - latest.open) / latest.open : 0;
  const rangePct = latest.open > 0 ? (latest.high - latest.low) / latest.open : 0;

  // Compute arrays for EMA
  const returns = candles.map(c => c.open > 0 ? (c.close - c.open) / c.open : 0);
  const ranges = candles.map(c => c.open > 0 ? (c.high - c.low) / c.open : 0);
  const volumes = candles.map(c => c.volume);
  const closes = candles.map(c => c.close);

  // EMAs
  const trend = ema(returns, Math.min(3, candles.length));
  const chop = ema(ranges, Math.min(3, candles.length));

  // Volume normalization
  const volNorm = normalizeVolume(volumes);

  // Acceleration (change in return)
  let accel = 0;
  if (returns.length >= 2) {
    accel = Math.abs(returns[returns.length - 1] - returns[returns.length - 2]);
  }

  // Deviation from SMA
  const ma = sma(closes, Math.min(5, closes.length));
  const deviation = ma > 0 ? (latest.close - ma) / ma : 0;

  // Liquidity drop (simplified - using volume as proxy)
  let liqDrop = 0;
  if (volumes.length >= 2 && prevLiquidity) {
    const currentLiq = volumes[volumes.length - 1];
    liqDrop = Math.max(0, (prevLiquidity - currentLiq) / prevLiquidity);
  }

  return {
    ret,
    rangePct,
    trend,
    chop,
    volNorm,
    liqDrop,
    accel,
    deviation
  };
}

// Update candle buffer with new candle
export function updateBuffer(buffer: Candle[], newCandle: Candle, maxSize: number = BUFFER_SIZE): Candle[] {
  const updated = [...buffer, newCandle];
  if (updated.length > maxSize) {
    return updated.slice(-maxSize);
  }
  return updated;
}
