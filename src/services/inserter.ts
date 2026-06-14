import clipboardy from 'clipboardy';
import { execSync } from 'child_process';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function simulatePaste(): void {
  if (process.platform === 'darwin') {
    // macOS: Cmd+V via osascript
    execSync(
      `osascript -e 'tell application "System Events" to keystroke "v" using command down'`,
      { timeout: 3000 }
    );
  } else {
    // Windows: Ctrl+V via PowerShell SendKeys
    execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('+{INSERT}')"`,
      { windowsHide: true, timeout: 3000 }
    );
  }
}

/** Send `count` backspace key presses to the focused field. */
function sendBackspaces(count: number): void {
  if (count <= 0) return;
  if (process.platform === 'darwin') {
    // key code 51 is Delete (backspace) on macOS. Use a single repeat loop so
    // we don't pay the osascript startup cost per keypress.
    execSync(
      `osascript -e 'tell application "System Events"' -e 'repeat ${count} times' -e 'key code 51' -e 'end repeat' -e 'end tell'`,
      { timeout: 5000 }
    );
  } else {
    execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{BACKSPACE ${count}}')"`,
      { windowsHide: true, timeout: 5000 }
    );
  }
}

export class TextInserter {
  // Live preview state. While a live session is active we keep track of exactly
  // what we have typed into the focused field so we can revise or clear it.
  private liveActive = false;
  private liveText = '';
  private savedClipboard = '';

  /** Begin a live preview session, remembering the user's clipboard. */
  async beginLive(): Promise<void> {
    this.savedClipboard = await clipboardy.read().catch(() => '');
    this.liveText = '';
    this.liveActive = true;
  }

  /**
   * Update the live preview to show `text`. Only the differing suffix is
   * rewritten (common prefix is left untouched) to minimise flicker.
   */
  async updateLive(text: string): Promise<void> {
    if (!this.liveActive) return;

    const prev = Array.from(this.liveText);
    const next = Array.from(text);
    let i = 0;
    const min = Math.min(prev.length, next.length);
    while (i < min && prev[i] === next[i]) i++;

    const toDelete = prev.length - i;
    const toAdd = next.slice(i).join('');
    if (toDelete <= 0 && toAdd.length === 0) return;

    if (toDelete > 0) {
      sendBackspaces(toDelete);
      await sleep(30);
    }
    if (toAdd.length > 0) {
      await this.pasteText(toAdd);
    }
    this.liveText = text;
  }

  /** Remove any live preview text and restore the user's clipboard. */
  async cancelLive(): Promise<void> {
    if (!this.liveActive) return;
    const count = Array.from(this.liveText).length;
    if (count > 0) sendBackspaces(count);
    await clipboardy.write(this.savedClipboard).catch(() => {});
    this.liveActive = false;
    this.liveText = '';
  }

  /**
   * Insert the final text. If a live preview is active, the previewed text is
   * cleared first so it is replaced in one motion; otherwise the current
   * clipboard is saved and restored around the paste.
   */
  async insert(text: string): Promise<void> {
    if (this.liveActive) {
      const count = Array.from(this.liveText).length;
      if (count > 0) {
        sendBackspaces(count);
        await sleep(50);
      }
      await this.pasteText(text);
      await sleep(400);
      await clipboardy.write(this.savedClipboard).catch(() => {});
      this.liveActive = false;
      this.liveText = '';
      return;
    }

    const original = await clipboardy.read().catch(() => '');
    await this.pasteText(text);
    await sleep(400);
    await clipboardy.write(original).catch(() => {});
  }

  /** Write `text` to the clipboard and paste it into the focused field. */
  private async pasteText(text: string): Promise<void> {
    await clipboardy.write(text);
    await sleep(30);
    simulatePaste();
    await sleep(60);
  }
}
