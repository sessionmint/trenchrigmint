// ============================================
// SAFETY RAILS
// ============================================
// Rate-of-change limiting, hard clamps, and anti-boredom floor

import {
  MAX_SPEED_CHANGE,
  MAX_AMP_CHANGE,
  MIN_SPEED,
  MAX_SPEED,
  MIN_AMP,
  MAX_AMP,
  EASE_FACTOR,
  DeviceCommand
} from './types';
import { clamp } from './data';

export interface SafetyResult {
  speed: number;
  amplitude: number;
  minY: number;
  maxY: number;
  wasLimited: boolean;
  limitDetails?: string;
}

/**
 * Apply smooth easing and rate-of-change limiting to prevent jarring jumps
 * Uses exponential easing for natural feeling transitions
 */
export function applyRateLimit(
  targetSpeed: number,
  targetAmplitude: number,
  lastSpeed: number,
  lastAmplitude: number
): { speed: number; amplitude: number; wasLimited: boolean; details: string[] } {
  const details: string[] = [];
  let wasLimited = false;

  // Apply easing: smoothly approach target (closes EASE_FACTOR of the gap each tick)
  let speed = lastSpeed + (targetSpeed - lastSpeed) * EASE_FACTOR;
  let amplitude = lastAmplitude + (targetAmplitude - lastAmplitude) * EASE_FACTOR;

  // Apply max change cap as safety net
  if (Math.abs(speed - lastSpeed) > MAX_SPEED_CHANGE) {
    speed = clamp(speed, lastSpeed - MAX_SPEED_CHANGE, lastSpeed + MAX_SPEED_CHANGE);
    details.push(`speed capped: ${targetSpeed} -> ${Math.round(speed)}`);
    wasLimited = true;
  }

  if (Math.abs(amplitude - lastAmplitude) > MAX_AMP_CHANGE) {
    amplitude = clamp(amplitude, lastAmplitude - MAX_AMP_CHANGE, lastAmplitude + MAX_AMP_CHANGE);
    details.push(`amplitude capped: ${targetAmplitude} -> ${Math.round(amplitude)}`);
    wasLimited = true;
  }

  // If very close to target (within 2), snap to target to avoid endless tiny adjustments
  if (Math.abs(speed - targetSpeed) < 2) speed = targetSpeed;
  if (Math.abs(amplitude - targetAmplitude) < 2) amplitude = targetAmplitude;

  return { speed, amplitude, wasLimited, details };
}

/**
 * Apply hard clamps to ensure values stay within device limits
 */
export function applyHardClamps(
  speed: number,
  amplitude: number
): { speed: number; amplitude: number } {
  return {
    speed: clamp(Math.round(speed), MIN_SPEED, MAX_SPEED),
    amplitude: clamp(Math.round(amplitude), MIN_AMP, MAX_AMP)
  };
}

/**
 * Optional anti-boredom floor
 * Ensures minimum activity even without booster
 */
export function applyAntiBoredFloor(
  speed: number,
  amplitude: number,
  enabled: boolean = false
): { speed: number; amplitude: number } {
  if (!enabled) return { speed, amplitude };

  return {
    speed: Math.max(speed, 12),
    amplitude: Math.max(amplitude, 8)
  };
}

/**
 * Convert amplitude to minY/maxY (centered at 50)
 * amplitude is 0-50, expanding ±amplitude around center
 */
export function amplitudeToRange(amplitude: number): { minY: number; maxY: number } {
  const center = 50;
  const minY = clamp(center - amplitude, 0, 100);
  const maxY = clamp(center + amplitude, 0, 100);
  return { minY: Math.round(minY), maxY: Math.round(maxY) };
}

/**
 * Full safety pipeline
 * Takes raw speed/amplitude and returns safe device command
 */
export function applySafetyPipeline(
  targetSpeed: number,
  targetAmplitude: number,
  lastSpeed: number,
  lastAmplitude: number,
  enableAntiBoredFloor: boolean = false
): SafetyResult {
  // 1. Rate limiting
  const rateLimited = applyRateLimit(targetSpeed, targetAmplitude, lastSpeed, lastAmplitude);

  // 2. Hard clamps
  const clamped = applyHardClamps(rateLimited.speed, rateLimited.amplitude);

  // 3. Optional anti-boredom floor
  const floored = applyAntiBoredFloor(clamped.speed, clamped.amplitude, enableAntiBoredFloor);

  // 4. Convert amplitude to minY/maxY
  const range = amplitudeToRange(floored.amplitude);

  return {
    speed: floored.speed,
    amplitude: floored.amplitude,
    minY: range.minY,
    maxY: range.maxY,
    wasLimited: rateLimited.wasLimited,
    limitDetails: rateLimited.details.join('; ')
  };
}

/**
 * Create final device command
 */
export function createDeviceCommand(safetyResult: SafetyResult): DeviceCommand {
  return {
    speed: safetyResult.speed,
    minY: safetyResult.minY,
    maxY: safetyResult.maxY
  };
}

/**
 * Validate device command is within acceptable ranges
 */
export function validateCommand(command: DeviceCommand): boolean {
  return (
    command.speed >= 0 && command.speed <= 100 &&
    command.minY >= 0 && command.minY <= 100 &&
    command.maxY >= 0 && command.maxY <= 100 &&
    command.minY < command.maxY
  );
}
