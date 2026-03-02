import { GlobalKeyboardListener, IGlobalKeyEvent, IGlobalKeyDownMap } from 'node-global-key-listener';
import { loadConfig } from './config';
import { AudioRecorder } from './services/recorder';
import { TranscriptionService } from './services/transcription';
import { FormatterService } from './services/formatter';
import { TextInserter } from './services/inserter';
import { getActiveAppName } from './services/window';
import { logger } from './utils/logger';
import { AppState } from './types';

interface ProcessAudioOptions {
  config: ReturnType<typeof loadConfig>;
  appName: string | null;
  translateMode: boolean;
  onDone: () => void;
}

async function processAudio(
  recorder: AudioRecorder,
  transcriber: TranscriptionService,
  formatter: FormatterService,
  inserter: TextInserter,
  { config, appName, translateMode, onDone }: ProcessAudioOptions
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
    transcribed = await transcriber.transcribe(audioFile, translateMode ? 'auto' : config.language);
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

  logger.startSpinner(translateMode ? 'Translating & formatting...' : 'Formatting...');
  let formatted: string;
  try {
    formatted = await formatter.format(transcribed, appName, translateMode ? config.translateTarget : undefined);
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
  let translateMode = config.translateMode;
  let keyDownTime = 0;
  let recordingLogTimer: ReturnType<typeof setTimeout> | null = null;
  const TOGGLE_TAP_MS = 300;

  // macOS reports Right Option as 'RIGHT ALT' or 'RIGHT OPTION' depending on the library version
  const HOTKEY = process.platform === 'darwin' ? ['RIGHT ALT', 'RIGHT OPTION'] : ['RIGHT ALT'];
  const hotkeyLabel = process.platform === 'darwin' ? 'Right Option' : 'Right Alt';

  const isHotkeyKey = (name: string | undefined): boolean =>
    name !== undefined && HOTKEY.includes(name);

  const keyListener = new GlobalKeyboardListener();

  keyListener.addListener((e: IGlobalKeyEvent, _down: IGlobalKeyDownMap) => {
    if (e.state === 'DOWN' && isHotkeyKey(e.name) && state === 'idle') {
      keyDownTime = Date.now();
      state = 'recording';
      recorder.start(); // fire-and-forget
      // Delay UI feedback — if key is released within TOGGLE_TAP_MS it's a toggle, not a recording
      recordingLogTimer = setTimeout(() => {
        recordingLogTimer = null;
        logger.recording(hotkeyLabel, translateMode, config.translateTarget);
        getActiveAppName().then(name => { activeAppName = name; }).catch(() => { activeAppName = null; });
      }, TOGGLE_TAP_MS);
      return true;
    }

    if (e.state === 'UP' && isHotkeyKey(e.name) && state === 'recording') {
      if (Date.now() - keyDownTime < TOGGLE_TAP_MS) {
        // Short tap: cancel UI, discard recording, toggle translation mode
        if (recordingLogTimer) { clearTimeout(recordingLogTimer); recordingLogTimer = null; }
        recorder.stop(config.minRecordingSeconds, config.maxRecordingSeconds);
        state = 'idle';
        translateMode = !translateMode;
        const readyLabel = translateMode ? `Ready [TRANSLATE → ${config.translateTarget}]` : 'Ready';
        logger.info(readyLabel);
        return true;
      }

      state = 'processing';
      const appName = activeAppName;
      const currentTranslateMode = translateMode;
      processAudio(recorder, transcriber, formatter, inserter, {
        config,
        appName,
        translateMode: currentTranslateMode,
        onDone: () => {
          state = 'idle';
          logger.info('Ready');
        },
      }).catch(err => {
        logger.error(`Unexpected error: ${err.message}`);
        state = 'idle';
      });
      return true;
    }
  });

  const modeLabel = translateMode ? ` [TRANSLATE → ${config.translateTarget}]` : '';
  console.log(`\n  Voice Input — Ready${modeLabel}`);
  logger.info(`Press and hold ${hotkeyLabel} to record | Quick tap to toggle translate\n`);

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
