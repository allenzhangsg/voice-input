import clipboardy from 'clipboardy';
import { execSync } from 'child_process';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function focusWindowByPid(processId: number): void {
  try {
    // WScript.Shell.AppActivate brings the window with the given PID to the foreground.
    // This is needed on Windows because releasing Right Alt (AltGr) can cause VSCode or
    // Edge to intercept the key-up event and shift focus away from the active text box.
    execSync(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$shell = New-Object -ComObject WScript.Shell; $shell.AppActivate(${processId})"`,
      { windowsHide: true, timeout: 3000 }
    );
  } catch {
    // Ignore focus errors — paste will proceed regardless
  }
}

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
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
      { windowsHide: true, timeout: 3000 }
    );
  }
}

export class TextInserter {
  async insert(text: string, processId?: number | null): Promise<void> {
    const original = await clipboardy.read().catch(() => '');

    await clipboardy.write(text);
    await sleep(50);

    if (process.platform === 'win32' && processId) {
      focusWindowByPid(processId);
      await sleep(200); // Wait for the window to gain focus before pasting
    }

    simulatePaste();

    await sleep(400);
    await clipboardy.write(original).catch(() => {});
  }
}
