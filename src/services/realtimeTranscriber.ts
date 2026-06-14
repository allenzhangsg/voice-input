import WebSocket from 'ws';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?intent=transcription';

// PvRecorder always captures at 16 kHz, but the Realtime API expects pcm16 at
// 24 kHz mono little-endian, so every frame is upsampled before it is sent.
const RECORDER_RATE = 16000;
const REALTIME_RATE = 24000;

/** Linear-interpolation resample of a single PCM16 frame. */
function resample(input: Int16Array, inRate: number, outRate: number): Int16Array {
  if (inRate === outRate) return input;
  const ratio = outRate / inRate;
  const outLen = Math.floor(input.length * ratio);
  const out = new Int16Array(outLen);
  for (let j = 0; j < outLen; j++) {
    const srcPos = j / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[j] = (input[i0] * (1 - frac) + input[i1] * frac) | 0;
  }
  return out;
}

function frameToBase64(frame: Int16Array): string {
  return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString('base64');
}

export interface RealtimeOptions {
  model: string;
  /** ISO-639-1 code, or undefined to auto-detect. */
  language?: string;
  /** Called with the full transcript so far whenever it changes. */
  onUpdate: (fullText: string) => void;
}

/**
 * Streams microphone audio to the OpenAI Realtime API and surfaces incremental
 * transcripts as they arrive. Audio appended before the session is ready is
 * buffered and flushed once the connection is configured.
 */
export class RealtimeTranscriber {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private pending: string[] = [];
  private completed: string[] = [];
  private currentDelta = '';
  private onUpdate: ((text: string) => void) | null = null;

  constructor(private apiKey: string) {}

  private fullText(): string {
    const parts = [...this.completed];
    if (this.currentDelta) parts.push(this.currentDelta);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  start(opts: RealtimeOptions): Promise<void> {
    this.onUpdate = opts.onUpdate;
    this.completed = [];
    this.currentDelta = '';
    this.pending = [];
    this.ready = false;
    this.closed = false;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });
      this.ws = ws;

      const failTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.closed = true;
        reject(new Error('Realtime connection timed out'));
        try { ws.close(); } catch { /* ignore */ }
      }, 8000);

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimer);
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(failTimer);
        this.closed = true;
        reject(err);
      };

      ws.on('open', () => {
        const transcription: Record<string, unknown> = { model: opts.model };
        if (opts.language) transcription.language = opts.language;
        // gpt-realtime-whisper streams deltas continuously and does NOT support
        // turn detection — it must be null and the buffer committed manually
        // (done in stop()). Other models use server VAD so they still emit
        // interim deltas per detected utterance.
        const turnDetection =
          opts.model === 'gpt-realtime-whisper'
            ? null
            : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 };
        try {
          ws.send(JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: REALTIME_RATE },
                  transcription,
                  turn_detection: turnDetection,
                },
              },
            },
          }));
        } catch (err) {
          fail(err as Error);
        }
      });

      ws.on('message', (data: WebSocket.RawData) => {
        let evt: any;
        try { evt = JSON.parse(data.toString()); } catch { return; }

        switch (evt.type) {
          case 'session.created':
          case 'session.updated':
          case 'transcription_session.created':
          case 'transcription_session.updated':
            if (!this.ready) {
              this.ready = true;
              for (const audio of this.pending) {
                try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio })); } catch { /* ignore */ }
              }
              this.pending = [];
            }
            succeed();
            break;

          case 'conversation.item.input_audio_transcription.delta':
            if (typeof evt.delta === 'string') {
              this.currentDelta += evt.delta;
              this.onUpdate?.(this.fullText());
            }
            break;

          case 'conversation.item.input_audio_transcription.completed':
            if (typeof evt.transcript === 'string' && evt.transcript.trim()) {
              this.completed.push(evt.transcript.trim());
            }
            this.currentDelta = '';
            this.onUpdate?.(this.fullText());
            break;

          case 'error':
            fail(new Error(evt.error?.message || 'Realtime API error'));
            break;
        }
      });

      ws.on('error', (err: Error) => fail(err));
      ws.on('close', () => { this.ready = false; this.closed = true; });
    });
  }

  /** Queue a captured 16 kHz frame for transcription. */
  appendAudio(frame16k: Int16Array): void {
    if (this.closed) return;
    const audio = frameToBase64(resample(frame16k, RECORDER_RATE, REALTIME_RATE));
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio })); } catch { /* ignore */ }
    } else if (this.pending.length < 4000) {
      // Buffer until the session is ready (cap well above the max recording length).
      this.pending.push(audio);
    }
  }

  /**
   * Flush any remaining audio, wait briefly for trailing transcripts, then
   * close the connection and return the final transcript.
   */
  async stop(graceMs = 1500): Promise<string> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.closeNow();
      return this.fullText();
    }

    try { ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch { /* ignore */ }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        ws.off('message', onMsg);
        clearTimeout(timer);
        resolve();
      };
      const onMsg = (data: WebSocket.RawData) => {
        try {
          const evt = JSON.parse(data.toString());
          // Once the final segment is transcribed, give a brief window for any
          // remaining segments, then finish.
          if (evt.type === 'conversation.item.input_audio_transcription.completed') {
            clearTimeout(timer);
            setTimeout(finish, 250);
          }
        } catch { /* ignore */ }
      };
      let timer = setTimeout(finish, graceMs);
      ws.on('message', onMsg);
    });

    const text = this.fullText();
    this.closeNow();
    return text;
  }

  /** Abort the session and discard any transcript. */
  cancel(): void {
    this.closeNow();
  }

  private closeNow(): void {
    this.closed = true;
    this.ready = false;
    this.pending = [];
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}
