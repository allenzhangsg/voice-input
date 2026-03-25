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
    logger.error('Recording too short — try recording for longer');
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

  function cancelRecording() {
    if (state !== 'recording') return;
    if (maxRecordingTimer) {
      clearTimeout(maxRecordingTimer);
      maxRecordingTimer = null;
    }
    recorder.stop(0, config.maxRecordingSeconds).catch(() => {});
    state = 'idle';
    floatingWindow.updateState('idle');
    logger.info('Recording cancelled');
    const readyLabel = translateMode ? `Ready [TRANSLATE → ${config.translateTarget}]` : 'Ready [TRANSCRIBE]';
    logger.info(readyLabel);
  }

  floatingWindow.onCancel(cancelRecording);
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

  const DOUBLE_TAP_MS = 300;
  let lastTapTime = 0;
  let startRecordingTimer: ReturnType<typeof setTimeout> | null = null;
  let maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;

  function stopAndProcess() {
    if (maxRecordingTimer) {
      clearTimeout(maxRecordingTimer);
      maxRecordingTimer = null;
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

  function startRecording() {
    state = 'recording';
    recorder.start();
    floatingWindow.updateState('recording');
    logger.recording(hotkeyLabel, translateMode, config.translateTarget);
    getActiveAppName().then(name => { activeAppName = name; }).catch(() => { activeAppName = null; });

    // Auto-stop at max recording duration
    maxRecordingTimer = setTimeout(() => {
      maxRecordingTimer = null;
      if (state === 'recording') {
        logger.info('Max recording duration reached — auto-stopping');
        stopAndProcess();
      }
    }, config.maxRecordingSeconds * 1000);
  }

  const keyListener = new GlobalKeyboardListener();

  keyListener.addListener((e: IGlobalKeyEvent, _down: IGlobalKeyDownMap) => {
    // ESC cancels recording (same as clicking the X button)
    if (e.state === 'DOWN' && e.name === 'ESCAPE' && state === 'recording') {
      cancelRecording();
      return;
    }

    if (e.state !== 'DOWN' || !isHotkeyKey(e.name)) return;

    // While recording: tap to stop & process (no ambiguity)
    if (state === 'recording') {
      stopAndProcess();
      return;
    }

    // While processing: ignore
    if (state === 'processing') return;

    // In idle state: detect single tap vs double-tap
    const now = Date.now();
    if (now - lastTapTime < DOUBLE_TAP_MS) {
      // Double-tap → toggle translate/transcribe mode
      lastTapTime = 0;
      if (startRecordingTimer) {
        clearTimeout(startRecordingTimer);
        startRecordingTimer = null;
      }
      translateMode = !translateMode;
      floatingWindow.updateMode(translateMode, config.translateTarget);
      floatingWindow.flash(translateMode ? 'Translate' : 'Transcribe');
      const readyLabel = translateMode ? `Ready [TRANSLATE → ${config.translateTarget}]` : 'Ready [TRANSCRIBE]';
      logger.info(readyLabel);
    } else {
      // First tap → wait to see if a second tap follows
      lastTapTime = now;
      startRecordingTimer = setTimeout(() => {
        startRecordingTimer = null;
        if (state === 'idle') {
          startRecording();
        }
      }, DOUBLE_TAP_MS);
    }
  });

  console.log(`\n  Voice Input`);
  logger.info(`Press ${chalk.bold(hotkeyLabel)} to start/stop recording | Double-tap to toggle translate`);
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
