// ============================================
// BOOSTER MECHANIC
// ============================================
// When intensity falls below 10%, apply a 3-step rotating pattern
// to keep the device "alive" without feeling like pure RNG

import { BOOSTER_THRESHOLD } from './types';

export interface BoosterState {
  step: number;      // 0, 1, or 2
  isActive: boolean;
}

export interface BoosterResult {
  speed: number;
  amplitude: number;
  newStep: number;
  wasApplied: boolean;
}

// 3-step rotating booster pattern
const BOOSTER_PATTERNS = [
  // Step 0: "heartbeat" - gentle pulse
  { minSpeed: 28, minAmp: 18 },
  // Step 1: "pump" - stronger push
  { minSpeed: 45, minAmp: 28 },
  // Step 2: "tease reset" - back down
  { minSpeed: 35, minAmp: 12 }
];

/**
 * Apply booster if intensity is below threshold
 * Returns adjusted speed/amplitude and new booster step
 */
export function applyBooster(
  intensity: number,
  speed: number,
  amplitude: number,
  currentStep: number
): BoosterResult {
  // If intensity is above threshold, reset and return unchanged
  if (intensity >= BOOSTER_THRESHOLD) {
    return {
      speed,
      amplitude,
      newStep: 0, // Reset step when intensity recovers
      wasApplied: false
    };
  }

  // Apply booster pattern
  const pattern = BOOSTER_PATTERNS[currentStep];
  const boostedSpeed = Math.max(speed, pattern.minSpeed);
  const boostedAmplitude = Math.max(amplitude, pattern.minAmp);

  // Advance to next step (cycle 0 -> 1 -> 2 -> 0)
  const nextStep = (currentStep + 1) % 3;

  return {
    speed: boostedSpeed,
    amplitude: boostedAmplitude,
    newStep: nextStep,
    wasApplied: true
  };
}

/**
 * Get booster pattern description for logging
 */
export function getBoosterPatternName(step: number): string {
  const names = ['heartbeat', 'pump', 'tease-reset'];
  return names[step] || 'unknown';
}

/**
 * Check if booster should be active
 */
export function shouldBoost(intensity: number): boolean {
  return intensity < BOOSTER_THRESHOLD;
}
