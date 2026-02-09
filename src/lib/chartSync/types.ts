// ============================================
// CHART SYNC TYPES
// ============================================

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface DerivedMetrics {
  ret: number;           // (close - open) / open
  rangePct: number;      // (high - low) / open
  trend: number;         // EMA of ret
  chop: number;          // EMA of rangePct
  volNorm: number;       // normalized volume (0-1)
  liqDrop: number;       // liquidity drop percentage
  accel: number;         // acceleration (change in ret)
  deviation: number;     // deviation from SMA
}

export interface ModeParams {
  trendCap: number;
  chopCap: number;
  accelCap: number;
  devCap: number;
  liqDropCap: number;
  weightTrend: number;
  weightChop: number;
  emaN: number;
}

export interface ModeResult {
  intensity: number;
  speed: number;
  amplitude: number;
  style?: string;
}

export interface DeviceCommand {
  speed: number;
  minY: number;
  maxY: number;
}

export interface ChartSyncSession {
  sessionId: string;
  tokenMint: string;
  startTime: number;
  endTime: number;
  modeId: number;
  modeParams: ModeParams;
  seed: number;
  lastSpeed: number;
  lastAmplitude: number;
  boosterStep: number;
  candleBuffer: Candle[];
  isActive: boolean;
}

export interface SessionConfig {
  sessionStateId: string;
  tokenMint: string;
  startTime?: number;
  durationMs?: number;
  initialModeId?: number;
  initialSpeed?: number;
  initialAmplitude?: number;
}

// Constants
export const COMMAND_INTERVAL_MS = 60000; // 1 minute
export const SESSION_DURATION_MS = 10 * 60 * 1000; // 10 minutes
export const BOOSTER_THRESHOLD = 0.10; // 10% intensity
export const BUFFER_SIZE = 10; // Keep last 10 candles

// Safety limits - increased for more responsive movement
export const MAX_SPEED_CHANGE = 25;  // Allow bigger speed jumps
export const MAX_AMP_CHANGE = 15;    // Allow bigger amplitude jumps
export const MIN_SPEED = 0;
export const MAX_SPEED = 100;
export const MIN_AMP = 0;
export const MAX_AMP = 50;

// Easing factor for smooth ramping (0-1, higher = faster approach)
export const EASE_FACTOR = 0.5;  // Increased for quicker response
