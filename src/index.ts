import { GlobalKeyboardListener, IGlobalKeyEvent, IGlobalKeyDownMap } from 'node-global-key-listener';
import { loadConfig } from './config';
import { AudioRecorder } from './services/recorder';
import { TranscriptionService } from './services/transcription';
import { FormatterService } from './services/formatter';
import { TextInserter } from './services/inserter';
import { getActiveAppName } from './services/window';
import { logger } from './utils/logger';
import { FloatingWindow } from './services/floatingWindow';
import { AppState } from './types';
import chalk from 'chalk';

interface ProcessAudioOptions {
  config: ReturnType<typeof loadConfig>;
  appName: string | null;
  translateMode: boolean;
  floatingWindow: FloatingWindow;
  onDone: () => void;
}

async function processAudio(
  recorder: AudioRecorder,
  transcriber: TranscriptionService,
  formatter: FormatterService,
  inserter: TextInserter,
  { config, appName, translateMode, floatingWindow, onDone }: ProcessAudioOptions
) {
  const startTime = Date.now();

  const audioFile = await recorder.stop(config.minRecordingSeconds, config.maxRecordingSeconds);
  if (!audioFile) {
    logger.error('Recording too short — hold the hotkey longer');
    onDone();
    return;
  }

  floatingWindow.updateText('Transcribing...');
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

  floatingWindow.updateText(translateMode ? 'Translating...' : 'Formatting...');
  logger.startSpinner(translateMode ? 'Translating & formatting...' : 'Formatting...');
  let formatted: string;
  try {
    formatted = await formatter.format(transcribed, appName, translateMode ? config.translateTarget : undefined);
    logger.stopSpinner(true, `Formatted: "${formatted}"`);
  } catch {
    logger.stopSpinner(false, 'Formatter failed, using raw text');
    formatted = transcribed;
  }

  floatingWindow.updateText('Inserting...');
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

  const floatingWindow = new FloatingWindow();
  await floatingWindow.start();

  let state: AppState = 'idle';
  let activeAppName: string | null = null;
  let translateMode = config.translateMode;
  floatingWindow.updateMode(translateMode, config.translateTarget);
  let recordingLogTimer: ReturnType<typeof setTimeout> | null = null;
  const TOGGLE_TAP_MS = 300;

  // macOS reports Right Option as 'RIGHT ALT' or 'RIGHT OPTION' depending on the library version
  const HOTKEY = config.hotkey
    ? [config.hotkey]
    : process.platform === 'darwin'
      ? ['RIGHT ALT', 'RIGHT OPTION']
      : ['RIGHT CTRL'];
  const hotkeyLabel = config.hotkey
    ?? (process.platform === 'darwin' ? 'Right Option' : 'Right CTRL');

  const isHotkeyKey = (name: string | undefined): boolean =>
    name !== undefined && HOTKEY.includes(name);

  const keyListener = new GlobalKeyboardListener();

  keyListener.addListener((e: IGlobalKeyEvent, _down: IGlobalKeyDownMap) => {
    if (e.state === 'DOWN' && isHotkeyKey(e.name) && state === 'idle') {
      state = 'recording';
      // Defer recorder.start() until after the toggle window so quick-tap
      // doesn't activate the microphone.
      recordingLogTimer = setTimeout(() => {
        recordingLogTimer = null;
        recorder.start();
        floatingWindow.updateState('recording');
        logger.recording(hotkeyLabel, translateMode, config.translateTarget);
        getActiveAppName().then(name => { activeAppName = name; }).catch(() => { activeAppName = null; });
      }, TOGGLE_TAP_MS);
    }

    if (e.state === 'UP' && isHotkeyKey(e.name) && state === 'recording') {
      if (recordingLogTimer) {
        // Released before TOGGLE_TAP_MS — quick tap to toggle translation
        clearTimeout(recordingLogTimer);
        recordingLogTimer = null;
        state = 'idle';
        translateMode = !translateMode;
        floatingWindow.updateMode(translateMode, config.translateTarget);
        floatingWindow.flash(translateMode ? 'Translate' : 'Transcribe');
        const readyLabel = translateMode ? `Ready [TRANSLATE → ${config.translateTarget}]` : 'Ready [TRANSCRIBE]';
        logger.info(readyLabel);
        return;
      }

      state = 'processing';
      floatingWindow.updateState('processing');
      const appName = activeAppName;
      const currentTranslateMode = translateMode;
      processAudio(recorder, transcriber, formatter, inserter, {
        config,
        appName,
        translateMode: currentTranslateMode,
        floatingWindow,
        onDone: () => {
          state = 'idle';
          floatingWindow.updateState('idle');
          const readyLabel = translateMode ? `Ready [TRANSLATE → ${config.translateTarget}]` : 'Ready [TRANSCRIBE]';
          logger.info(readyLabel);
        },
      }).catch(err => {
        logger.error(`Unexpected error: ${err.message}`);
        state = 'idle';
      });
    }
  });

  console.log(`\n  Voice Input`);
  logger.info(`Press and hold ${chalk.bold(hotkeyLabel)} to record | Quick tap to toggle translate`);
  const startupModeLabel = translateMode ? `Ready [TRANSLATE → ${config.translateTarget}]` : 'Ready [TRANSCRIBE]';
  logger.info(startupModeLabel);

  process.on('SIGINT', () => {
    floatingWindow.close();
    keyListener.kill();
    console.log('\n  Bye!');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
