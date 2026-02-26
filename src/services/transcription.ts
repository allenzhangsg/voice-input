import OpenAI from 'openai';
import * as fs from 'fs';

export class TranscriptionService {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async transcribe(audioFilePath: string, language: string): Promise<string> {
    const response = await this.client.audio.transcriptions.create({
      file: fs.createReadStream(audioFilePath),
      model: 'whisper-1',
      language: language === 'auto' ? undefined : language,
      response_format: 'text',
    });

    try { fs.unlinkSync(audioFilePath); } catch { /* ignore */ }

    // With response_format: 'text', SDK returns a plain string
    return (response as unknown as string).trim();
  }
}
