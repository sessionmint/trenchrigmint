export interface AutoblowDeviceState {
  operationalMode?: string;
  oscillatorTargetSpeed?: number;
  [key: string]: unknown;
}

export interface DeviceSessionStatus {
  mode: string;
  modeId: number;
  elapsed: number;
  remaining: number;
  speed: number;
  amplitude: number;
}

export interface DeviceCooldownStatus {
  active: boolean;
  remainingMs: number;
  totalMs: number;
}

export interface PublicDeviceStatus {
  connected: boolean;
  state: string;
  deviceState?: AutoblowDeviceState;
  session?: DeviceSessionStatus;
  cooldown?: DeviceCooldownStatus;
}

