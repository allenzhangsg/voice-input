import chalk from 'chalk';
import ora, { Ora } from 'ora';

let currentSpinner: Ora | null = null;

export const logger = {
  info: (msg: string) => console.log(chalk.blue('  ' + msg)),
  success: (msg: string) => console.log(chalk.green('  ✓ ' + msg)),
  error: (msg: string) => console.error(chalk.red('  ✗ ' + msg)),

  recording: (hotkeyLabel = 'hotkey', translate = false, target = 'English') => {
    const tag = translate ? chalk.yellow(' [TRANSLATE → ' + target + ']') : '';
    console.log(chalk.red.bold(`\n  🎙  Recording...${tag} (release ${hotkeyLabel} to stop)`));
  },

  startSpinner: (text: string): Ora => {
    currentSpinner = ora({ text, color: 'cyan' }).start();
    return currentSpinner;
  },

  stopSpinner: (success: boolean, text?: string) => {
    if (!currentSpinner) return;
    if (success) currentSpinner.succeed(text);
    else currentSpinner.fail(text);
    currentSpinner = null;
  },

  done: (totalMs: number) => {
    console.log(chalk.green.bold(`\n  ✓ Done! (${(totalMs / 1000).toFixed(1)}s)\n`));
  },
};
