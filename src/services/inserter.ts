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

export class TextInserter {
  async insert(text: string): Promise<void> {
    const original = await clipboardy.read().catch(() => '');

    await clipboardy.write(text);
    await sleep(50);
    simulatePaste();

    await sleep(400);
    await clipboardy.write(original).catch(() => {});
  }
}
