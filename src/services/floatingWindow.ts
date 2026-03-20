import { ChildProcess, spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { AppState } from '../types';

const SWIFT_SOURCE = path.join(__dirname, '..', 'native', 'StatusWindow.swift');
const CACHE_DIR = path.join(os.homedir(), '.cache', 'voice-input');
const BINARY_PATH = path.join(CACHE_DIR, 'StatusWindow');

function needsCompile(): boolean {
  try {
    // When running via tsx, __dirname points to src/services; when compiled, dist/services.
    // Resolve source relative to this file's location, but also try the src/ path.
    const srcPath = getSwiftSourcePath();
    if (!srcPath) return false; // no source found

    if (!fs.existsSync(BINARY_PATH)) return true;
    const srcMtime = fs.statSync(srcPath).mtimeMs;
    const binMtime = fs.statSync(BINARY_PATH).mtimeMs;
    return srcMtime > binMtime;
  } catch {
    return true;
  }
}

function getSwiftSourcePath(): string | null {
  // Try the path relative to this file first
  if (fs.existsSync(SWIFT_SOURCE)) return SWIFT_SOURCE;
  // Try from project root (handles both tsx and compiled scenarios)
  const altPath = path.resolve(__dirname, '..', '..', 'src', 'native', 'StatusWindow.swift');
  if (fs.existsSync(altPath)) return altPath;
  return null;
}

function compile(): boolean {
  const srcPath = getSwiftSourcePath();
  if (!srcPath) return false;

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    execSync(`swiftc -O -o "${BINARY_PATH}" "${srcPath}"`, {
      timeout: 30000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export class FloatingWindow {
  private proc: ChildProcess | null = null;
  private enabled = false;

  async start(): Promise<void> {
    if (process.platform !== 'darwin') return;

    if (needsCompile()) {
      if (!compile()) return;
    }

    if (!fs.existsSync(BINARY_PATH)) return;

    this.proc = spawn(BINARY_PATH, [], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    this.enabled = true;

    this.proc.on('exit', () => {
      this.proc = null;
      this.enabled = false;
    });
  }

  private send(msg: string): void {
    if (!this.enabled || !this.proc?.stdin?.writable) return;
    try {
      this.proc.stdin.write(msg + '\n');
    } catch {
      this.enabled = false;
    }
  }

  updateState(state: AppState): void {
    this.send(`STATE:${state}`);
  }

  updateMode(translate: boolean, target: string): void {
    const short = target.slice(0, 2).toUpperCase();
    this.send(translate ? `MODE:translate:${short}` : 'MODE:transcribe');
  }

  updateText(text: string): void {
    this.send(`TEXT:${text}`);
  }

  flash(text: string): void {
    this.send(`FLASH:${text}`);
  }

  close(): void {
    if (!this.proc) return;
    this.send('QUIT');
    const proc = this.proc;
    setTimeout(() => {
      try { proc.kill(); } catch {}
    }, 500);
    this.proc = null;
    this.enabled = false;
  }
}
