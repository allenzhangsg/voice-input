import { PvRecorder } from '@picovoice/pvrecorder-node';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 512;

function writeWav(filePath: string, frames: Int16Array[]): void {
  const totalSamples = frames.reduce((sum, f) => sum + f.length, 0);
  const dataSize = totalSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(1, 22);       // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);       // block align
  buf.writeUInt16LE(16, 34);      // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i++) {
      buf.writeInt16LE(frame[i], offset);
      offset += 2;
    }
  }

  fs.writeFileSync(filePath, buf);
}

export class AudioRecorder {
  private recorder: PvRecorder | null = null;
  private frames: Int16Array[] = [];
  private recording = false;

  async start(): Promise<void> {
    this.frames = [];
    this.recording = true;
    this.recorder = new PvRecorder(FRAME_LENGTH, -1);
    this.recorder.start();

    const loop = async () => {
      while (this.recording) {
        try {
          const frame = await this.recorder!.read();
          this.frames.push(new Int16Array(frame));
        } catch {
          break;
        }
      }
    };
    loop();
  }

  async stop(minSeconds: number, maxSeconds: number): Promise<string | null> {
    this.recording = false;

    if (this.recorder) {
      this.recorder.stop();
      this.recorder.release();
      this.recorder = null;
    }

    // Small delay to let loop exit
    await new Promise(r => setTimeout(r, 100));

    const totalSamples = this.frames.reduce((sum, f) => sum + f.length, 0);
    const durationSeconds = totalSamples / SAMPLE_RATE;

    if (durationSeconds < minSeconds) return null;

    // Clamp to maxSeconds
    const maxSamples = maxSeconds * SAMPLE_RATE;
    const keptFrames: Int16Array[] = [];
    let kept = 0;
    for (const frame of this.frames) {
      if (kept + frame.length > maxSamples) break;
      keptFrames.push(frame);
      kept += frame.length;
    }

    const filePath = path.join(os.tmpdir(), `voice-input-${Date.now()}.wav`);
    writeWav(filePath, keptFrames);
    return filePath;
  }
}
