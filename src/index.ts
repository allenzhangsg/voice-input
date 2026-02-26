import { GlobalKeyboardListener, IGlobalKeyEvent, IGlobalKeyDownMap } from 'node-global-key-listener';
import { loadConfig } from './config';
import { AudioRecorder } from './services/recorder';
import { TranscriptionService } from './services/transcription';
import { FormatterService } from './services/formatter';
import { TextInserter } from './services/inserter';
import { getActiveAppName } from './services/window';
import { logger } from './utils/logger';
import { AppState } from './types';

async function processAudio(
  recorder: AudioRecorder,
  transcriber: TranscriptionService,
  formatter: FormatterService,
  inserter: TextInserter,
  config: ReturnType<typeof loadConfig>,
  appName: string | null,
  onDone: () => void
) {
  const startTime = Date.now();

  const audioFile = await recorder.stop(config.minRecordingSeconds, config.maxRecordingSeconds);
  if (!audioFile) {
    logger.error('Recording too short — hold the hotkey longer');
    onDone();
    return;
  }

  logger.startSpinner('Transcribing...');
  let transcribed: string;
  try {
    transcribed = await transcriber.transcribe(audioFile, config.language);
    logger.stopSpinner(true, `Transcribed: "${transcribed}"`);
  } catch (err: any) {
    logger.stopSpinner(false, `Transcription failed: ${err.message}`);
    onDone();
    return;
  }

  if (!transcribed.trim()) {
    logger.info('Empty transcript — aborting');
    onDone();
    return;
  }

  logger.startSpinner('Formatting...');
  let formatted: string;
  try {
    formatted = await formatter.format(transcribed, appName);
    logger.stopSpinner(true, `Formatted: "${formatted}"`);
  } catch {
    logger.stopSpinner(false, 'Formatter failed, using raw text');
    formatted = transcribed;
  }

  logger.startSpinner('Inserting...');
  try {
    await inserter.insert(formatted);
    logger.stopSpinner(true, 'Text inserted');
  } catch (err: any) {
    logger.stopSpinner(false, `Insert failed: ${err.message}`);
  }

  logger.done(Date.now() - startTime);
  onDone();
}

async function main() {
  const config = loadConfig();
  const recorder = new AudioRecorder();
  const transcriber = new TranscriptionService(config.openaiApiKey);
  const formatter = new FormatterService(config.openaiApiKey, config.model);
  const inserter = new TextInserter();

  let state: AppState = 'idle';
  let activeAppName: string | null = null;

  // macOS reports Right Option as 'RIGHT ALT' or 'RIGHT OPTION' depending on the library version
  const HOTKEY = process.platform === 'darwin' ? ['RIGHT ALT', 'RIGHT OPTION'] : ['RIGHT ALT'];
  const hotkeyLabel = process.platform === 'darwin' ? 'Right Option' : 'Right Alt';

  const isHotkeyKey = (name: string | undefined): boolean =>
    name !== undefined && HOTKEY.includes(name);

  const keyListener = new GlobalKeyboardListener();

  keyListener.addListener((e: IGlobalKeyEvent, _down: IGlobalKeyDownMap) => {
    if (e.state === 'DOWN' && isHotkeyKey(e.name) && state === 'idle') {
      state = 'recording';
      logger.recording(hotkeyLabel);
      getActiveAppName().then(name => {
        activeAppName = name;
        logger.info(`Active app: ${name ?? 'unknown'}`);
      }).catch(() => { activeAppName = null; });
      recorder.start(); // fire-and-forget
      return true;
    }

    if (e.state === 'UP' && isHotkeyKey(e.name) && state === 'recording') {
      state = 'processing';
      const appName = activeAppName;
      processAudio(recorder, transcriber, formatter, inserter, config, appName, () => {
        state = 'idle';
        logger.info(`Listening... (${hotkeyLabel} to record)`);
      }).catch(err => {
        logger.error(`Unexpected error: ${err.message}`);
        state = 'idle';
      });
      return true;
    }
  });

  console.log('\n  Voice Input — Ready');
  logger.info(`Press and hold ${hotkeyLabel} to record\n`);

  process.on('SIGINT', () => {
    keyListener.kill();
    console.log('\n  Bye!');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
