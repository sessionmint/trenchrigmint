// ============================================
// 5 CHART SYNC MODES
// ============================================

import { DerivedMetrics, ModeParams, ModeResult } from './types';
import { clamp01 } from './data';

// MODE 1 — Trend Rider (slope-driven, clean chart sync)
// Best general default: viewers can "see" it following the trend
export function modeTrendRider(metrics: DerivedMetrics, params: ModeParams): ModeResult {
  const trendAbs = clamp01(Math.abs(metrics.trend) / params.trendCap);
  const chopN = clamp01(metrics.chop / params.chopCap);

  // Intensity with randomized weights
  const intensity = params.weightTrend * trendAbs + params.weightChop * chopN;

  // Map to device
  const speed = Math.round(15 + 85 * intensity);
  const amplitude = Math.round(10 + 40 * (0.35 * trendAbs + 0.65 * chopN));

  return {
    intensity,
    speed,
    amplitude,
    style: 'trend-rider'
  };
}

// MODE 2 — Chop Monster (range-driven, satisfying depth)
// Makes "sideways volatility" feel intense, not boring
export function modeChopMonster(metrics: DerivedMetrics, params: ModeParams): ModeResult {
  const trendAbs = clamp01(Math.abs(metrics.trend) / params.trendCap);
  const chopN = clamp01(metrics.chop / params.chopCap);

  // Intensity weighted toward chop
  const intensity = 0.25 * trendAbs + 0.75 * chopN;

  // Map to device - slower but deeper
  const speed = Math.round(10 + 70 * intensity);
  const amplitude = Math.round(20 + 30 * chopN);

  return {
    intensity,
    speed,
    amplitude,
    style: 'chop-monster'
  };
}

// MODE 3 — Momentum Bursts (acceleration-driven, viewer hype)
// Makes spikes feel like "events"
export function modeMomentumBursts(metrics: DerivedMetrics, params: ModeParams): ModeResult {
  const accelN = clamp01(metrics.accel / params.accelCap);
  const volBoost = clamp01(metrics.volNorm);

  // Intensity weighted toward acceleration
  const intensity = 0.65 * accelN + 0.35 * volBoost;

  // Map to device
  let speed = Math.round(20 + 80 * intensity);
  let amplitude = Math.round(12 + 38 * (0.5 * accelN + 0.5 * volBoost));

  // Burst style for high acceleration
  let style = 'momentum-bursts';
  if (accelN > 0.85) {
    speed = Math.max(speed, 85);
    amplitude = Math.max(amplitude, 30);
    style = 'momentum-burst-spike';
  }

  return {
    intensity,
    speed,
    amplitude,
    style
  };
}

// MODE 4 — Mean Reverter (oscillates with overextension)
// Reduces "always faster when up" symmetry
export function modeMeanReverter(metrics: DerivedMetrics, params: ModeParams): ModeResult {
  const devN = clamp01(Math.abs(metrics.deviation) / params.devCap);
  const chopN = clamp01(metrics.chop / params.chopCap);

  // Intensity
  const intensity = 0.55 * devN + 0.45 * chopN;

  // Base mapping
  let speed = Math.round(10 + 75 * intensity);
  let amplitude = Math.round(15 + 35 * (0.7 * devN + 0.3 * chopN));

  // Directional flavor
  let style = 'mean-reverter';
  if (metrics.deviation > 0) {
    // Overbought: tense - narrow amplitude, raise speed
    amplitude = Math.round(amplitude * 0.85);
    speed = Math.round(speed * 1.1);
    style = 'mean-reverter-overbought';
  } else if (metrics.deviation < 0) {
    // Oversold: slower grind - widen amplitude, moderate speed
    amplitude = Math.round(amplitude * 1.15);
    speed = Math.round(speed * 0.9);
    style = 'mean-reverter-oversold';
  }

  return {
    intensity,
    speed,
    amplitude,
    style
  };
}

// MODE 5 — Liquidity Panic (meme-coin storytelling mode)
// "Oh shit" mode for dramatic moments
export function modeLiquidityPanic(metrics: DerivedMetrics, params: ModeParams): ModeResult {
  const trendAbs = clamp01(Math.abs(metrics.trend) / params.trendCap);
  const chopN = clamp01(metrics.chop / params.chopCap);
  const liqDropN = clamp01(metrics.liqDrop / params.liqDropCap);

  // Base intensity from trend/chop
  const baseI = 0.5 * trendAbs + 0.5 * chopN;

  // Use max of base or liquidity drop
  const intensity = Math.max(baseI, liqDropN);

  let speed: number;
  let amplitude: number;
  let style = 'liquidity-panic';

  if (liqDropN >= 0.9) {
    // Extreme panic - stop for this minute
    speed = 0;
    amplitude = 0;
    style = 'liquidity-panic-stop';
  } else if (liqDropN >= 0.35) {
    // Panic mode: fast and tight
    speed = Math.round(60 + 40 * liqDropN);
    amplitude = Math.round(6 + 16 * (1 - liqDropN));
    style = 'liquidity-panic-active';
  } else {
    // Normal operation
    speed = Math.round(15 + 75 * baseI);
    amplitude = Math.round(12 + 38 * chopN);
  }

  return {
    intensity,
    speed,
    amplitude,
    style
  };
}

// Mode dispatcher
export function computeMode(modeId: number, metrics: DerivedMetrics, params: ModeParams): ModeResult {
  switch (modeId) {
    case 1:
      return modeTrendRider(metrics, params);
    case 2:
      return modeChopMonster(metrics, params);
    case 3:
      return modeMomentumBursts(metrics, params);
    case 4:
      return modeMeanReverter(metrics, params);
    case 5:
      return modeLiquidityPanic(metrics, params);
    default:
      return modeTrendRider(metrics, params); // Default fallback
  }
}

// Get mode name for logging
export function getModeName(modeId: number): string {
  const names: Record<number, string> = {
    1: 'Trend Rider',
    2: 'Chop Monster',
    3: 'Momentum Bursts',
    4: 'Mean Reverter',
    5: 'Liquidity Panic'
  };
  return names[modeId] || 'Unknown';
}

// Dynamically select the best mode based on current chart conditions
export function selectModeFromMetrics(metrics: DerivedMetrics, params: ModeParams): number {
  // Normalize each metric to 0-1 scale
  const trendScore = clamp01(Math.abs(metrics.trend) / params.trendCap);
  const chopScore = clamp01(metrics.chop / params.chopCap);
  const accelScore = clamp01(metrics.accel / params.accelCap);
  const devScore = clamp01(Math.abs(metrics.deviation) / params.devCap);
  const liqDropScore = clamp01(metrics.liqDrop / params.liqDropCap);

  // Log scores for debugging
  console.log('[ModeSelect] Scores:', {
    trend: trendScore.toFixed(3),
    chop: chopScore.toFixed(3),
    accel: accelScore.toFixed(3),
    dev: devScore.toFixed(3),
    liqDrop: liqDropScore.toFixed(3)
  });

  // Priority check: Liquidity Panic takes precedence if there's a significant drop
  if (liqDropScore >= 0.35) {
    console.log('[ModeSelect] -> Liquidity Panic (liqDrop >= 0.35)');
    return 5; // Liquidity Panic
  }

  // Find the dominant market condition
  const scores = [
    { mode: 1, score: trendScore * 1.0, name: 'Trend Rider' },      // Strong directional move
    { mode: 2, score: chopScore * 1.1, name: 'Chop Monster' },      // Sideways volatility (boosted)
    { mode: 3, score: accelScore * 1.2, name: 'Momentum Bursts' },  // Acceleration spikes (boosted more)
    { mode: 4, score: devScore * 1.05, name: 'Mean Reverter' },     // Overextended price
  ];

  // Sort by score descending and pick the highest
  scores.sort((a, b) => b.score - a.score);

  console.log('[ModeSelect] Top 2:', scores.slice(0, 2).map(s => `${s.name}:${s.score.toFixed(3)}`).join(', '));

  // Lower threshold - only default to Trend Rider if ALL scores are very low
  if (scores[0].score < 0.05) {
    console.log('[ModeSelect] -> Trend Rider (all scores < 0.05)');
    return 1; // Trend Rider (default)
  }

  console.log('[ModeSelect] -> ' + scores[0].name);
  return scores[0].mode;
}
