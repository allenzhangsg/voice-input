import * as dotenv from 'dotenv';
import { Config } from './types';

dotenv.config();

export function loadConfig(): Config {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] OPENAI_API_KEY is not set.');
    console.error('  Create a .env file and add: OPENAI_API_KEY=sk-...');
    process.exit(1);
  }

  return {
    openaiApiKey: apiKey,
    maxRecordingSeconds: Number.parseInt(process.env.MAX_RECORDING_SECONDS || '60', 10),
    minRecordingSeconds: Number.parseFloat(process.env.MIN_RECORDING_SECONDS || '0.5'),
    language: process.env.LANGUAGE || 'en',
    model: process.env.MODEL || 'gpt-4.1-mini',
    translateMode: process.env.TRANSLATE === 'true',
    translateTarget: process.env.TRANSLATE_TARGET || 'English',
  };
}
