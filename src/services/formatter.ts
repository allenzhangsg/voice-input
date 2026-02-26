import OpenAI from 'openai';

const SYSTEM_PROMPT = `You are a text formatter for voice transcriptions.
Fix grammar and punctuation. Keep original meaning and tone.
If casual/short → Slack/chat style. If formal/complete sentences → email style.
Preserve technical terms exactly. Output ONLY the formatted text, nothing else.`;

export class FormatterService {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async format(rawText: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: rawText },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    return response.choices[0]?.message?.content?.trim() ?? rawText;
  }
}
