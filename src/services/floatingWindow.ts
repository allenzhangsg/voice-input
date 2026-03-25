import { ChildProcess, spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { AppState } from '../types';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'voice-input');

// ── Source path helpers ─────────────────────────────────────────────

function findNativeSource(filename: string): string | null {
  // Try relative to this file (works for both src/services and dist/services)
  const nearby = path.join(__dirname, '..', 'native', filename);
  if (fs.existsSync(nearby)) return nearby;
  // Try from project root (handles tsx vs compiled)
  const alt = path.resolve(__dirname, '..', '..', 'src', 'native', filename);
  if (fs.existsSync(alt)) return alt;
  return null;
}

// ── macOS helpers ───────────────────────────────────────────────────

const SWIFT_BINARY = path.join(CACHE_DIR, 'StatusWindow');

function needsCompileMac(): boolean {
  try {
    const src = findNativeSource('StatusWindow.swift');
    if (!src) return false;
    if (!fs.existsSync(SWIFT_BINARY)) return true;
    return fs.statSync(src).mtimeMs > fs.statSync(SWIFT_BINARY).mtimeMs;
  } catch { return true; }
}

function compileMac(): boolean {
  const src = findNativeSource('StatusWindow.swift');
  if (!src) return false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    execSync(`swiftc -O -o "${SWIFT_BINARY}" "${src}"`, { timeout: 30000, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// ── Windows helpers ─────────────────────────────────────────────────

const WIN_BINARY = path.join(CACHE_DIR, 'StatusWindow.exe');

function findCsc(): string | null {
  // .NET Framework csc.exe ships with Windows
  const frameworkDir = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET', 'Framework64', 'v4.0.30319'
  );
  const csc = path.join(frameworkDir, 'csc.exe');
  if (fs.existsSync(csc)) return csc;
  // Try 32-bit fallback
  const fw32 = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET', 'Framework', 'v4.0.30319'
  );
  const csc32 = path.join(fw32, 'csc.exe');
  if (fs.existsSync(csc32)) return csc32;
  return null;
}

function needsCompileWin(): boolean {
  try {
    const src = findNativeSource('StatusWindow.cs');
    if (!src) return false;
    if (!fs.existsSync(WIN_BINARY)) return true;
    return fs.statSync(src).mtimeMs > fs.statSync(WIN_BINARY).mtimeMs;
  } catch { return true; }
}

function compileWin(): boolean {
  const src = findNativeSource('StatusWindow.cs');
  const csc = findCsc();
  if (!src || !csc) return false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    execSync(
      `"${csc}" /nologo /optimize /target:winexe /out:"${WIN_BINARY}" /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Management.dll "${src}"`,
      { timeout: 30000, stdio: 'pipe' }
    );
    return true;
  } catch { return false; }
}

// ── FloatingWindow class ────────────────────────────────────────────

export class FloatingWindow {
  private proc: ChildProcess | null = null;
  private enabled = false;
  private cancelCallback: (() => void) | null = null;

  onCancel(callback: () => void): void {
    this.cancelCallback = callback;
  }

  async start(): Promise<void> {
    if (process.platform === 'darwin') {
      await this.startMacOS();
    } else if (process.platform === 'win32') {
      await this.startWindows();
    }
  }

  private async startMacOS(): Promise<void> {
    if (needsCompileMac()) {
      if (!compileMac()) return;
    }
    if (!fs.existsSync(SWIFT_BINARY)) return;

    this.proc = spawn(SWIFT_BINARY, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.enabled = true;
    this.listenStdout();
    this.proc.on('exit', () => { this.proc = null; this.enabled = false; });
  }

  private async startWindows(): Promise<void> {
    if (needsCompileWin()) {
      if (!compileWin()) return;
    }
    if (!fs.existsSync(WIN_BINARY)) return;

    this.proc = spawn(WIN_BINARY, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    this.enabled = true;
    this.listenStdout();
    this.proc.on('exit', () => { this.proc = null; this.enabled = false; });
  }

  private listenStdout(): void {
    if (!this.proc?.stdout) return;
    let buffer = '';
    this.proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim() === 'CANCEL' && this.cancelCallback) {
          this.cancelCallback();
        }
      }
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
