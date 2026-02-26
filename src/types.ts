export interface Config {
  openaiApiKey: string;
  maxRecordingSeconds: number;
  minRecordingSeconds: number;
  language: string;
  model: string;
}

export type AppState = 'idle' | 'recording' | 'processing';
