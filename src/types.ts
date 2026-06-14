export interface Config {
  openaiApiKey: string;
  maxRecordingSeconds: number;
  minRecordingSeconds: number;
  language: string;
  model: string;
  translateMode: boolean;
  translateTarget: string;
  hotkey?: string;
  realtime: boolean;
  realtimeIntervalMs: number;
}

export type AppState = 'idle' | 'recording' | 'processing';
