import { GlobalKeyboardListener, IGlobalKeyEvent, IGlobalKeyDownMap } from 'node-global-key-listener';
import { loadConfig } from './config';
import { AudioRecorder } from './services/recorder';
import { TranscriptionService } from './services/transcription';
import { FormatterService } from './services/formatter';
import { TextInserter } from './services/inserter';
import { getActiveAppName } from './services/window';
import { logger } from './utils/logger';
import { FloatingWindow } from './services/floatingWindow';
import { RealtimeTranscriber } from './services/realtimeTranscriber';
import { AppState } from './types';
import * as fs from 'fs';
import chalk from 'chalk';

interface ProcessAudioOptions {
  config: ReturnType<typeof loadConfig>;
  appName: string | null;
  translateMode: boolean;
  floatingWindow: FloatingWindow;
  realtime: RealtimeTranscriber | null;
  onDone: () => void;
}

async function processAudio(
  recorder: AudioRecorder,
  transcriber: TranscriptionService,
  formatter: FormatterService,
  inserter: TextInserter,
  { config, appName, translateMode, floatingWindow, realtime, onDone }: ProcessAudioOptions
) {
  const startTime = Date.now();

  const audioFile = await recorder.stop(config.minRecordingSeconds, config.maxRecordingSeconds);

  // Finalize the realtime transcript (also closes its connection). Kept even
  // when we end up aborting so the websocket is always cleaned up.
  let realtimeText = '';
  if (realtime) {
    try { realtimeText = (await realtime.stop()).trim(); } catch { realtimeText = ''; }
  }

  if (!audioFile) {
    await inserter.cancelLive();
    logger.error('Recording too short — try recording for longer');
    onDone();
    return;
  }

  let transcribed = realtimeText;
  if (transcribed) {
    // The realtime stream already produced the transcript; drop the WAV that
    // was only kept as a fallback.
    try { fs.unlinkSync(audioFile); } catch { /* ignore */ }
    logger.success(`Transcribed (realtime): "${transcribed}"`);
  } else {
    // No realtime transcript (disabled or connection failed) — fall back to the
    // batch Whisper call on the recorded audio.
    floatingWindow.updateText('Transcribing...');
    logger.startSpinner('Transcribing...');
    try {
      transcribed = await transcriber.transcribe(audioFile, translateMode ? 'auto' : config.language);
      logger.stopSpinner(true, `Transcribed: "${transcribed}"`);
    } catch (err: any) {
      await inserter.cancelLive();
      logger.stopSpinner(false, `Transcription failed: ${err.message}`);
      onDone();
      return;
    }
  }

  if (!transcribed.trim()) {
    await inserter.cancelLive();
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
    state = 'idle';
    if (realtime) { realtime.cancel(); realtime = null; }
    inserter.cancelLive().catch(() => {});
    recorder.stop(0, config.maxRecordingSeconds).catch(() => {});
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
  // Realtime streaming transcriber for the live preview, recreated per recording.
  let realtime: RealtimeTranscriber | null = null;

  function stopAndProcess() {
    if (maxRecordingTimer) {
      clearTimeout(maxRecordingTimer);
      maxRecordingTimer = null;
    }
    state = 'processing';
    floatingWindow.updateState('processing');
    const appName = activeAppName;
    const currentTranslateMode = translateMode;
    // Keep `realtime` set so trailing frames captured while the recorder winds
    // down are still streamed; processAudio finalizes and closes it.
    processAudio(recorder, transcriber, formatter, inserter, {
      config,
      appName,
      translateMode: currentTranslateMode,
      floatingWindow,
      realtime,
      onDone: () => {
        realtime = null;
        state = 'idle';
        floatingWindow.updateState('idle');
        const readyLabel = translateMode ? `Ready [TRANSLATE → ${config.translateTarget}]` : 'Ready [TRANSCRIBE]';
        logger.info(readyLabel);
      },
    }).catch(err => {
      realtime = null;
      logger.error(`Unexpected error: ${err.message}`);
      state = 'idle';
    });
  }

  function startRecording() {
    state = 'recording';

    // Spin up the realtime stream for the live preview. Audio frames are fed
    // straight from the recorder; partial transcripts are typed into the
    // focused field as they arrive.
    if (config.realtime) {
      inserter.beginLive().catch(() => {});
      const liveTranslate = translateMode;
      const language = liveTranslate || config.language === 'auto' ? undefined : config.language;
      const rt = new RealtimeTranscriber(config.openaiApiKey);
      realtime = rt;
      rt.start({
        model: config.realtimeModel,
        language,
        onUpdate: (text) => {
          if (state === 'recording' && realtime === rt && text) {
            inserter.updateLive(text).catch(() => {});
            floatingWindow.updateText(text.slice(-60));
          }
        },
      }).catch((err: any) => {
        // Connection failed — keep recording; processAudio falls back to Whisper.
        logger.info(`Realtime preview unavailable: ${err.message}`);
      });
    } else {
      realtime = null;
    }

    recorder.start((frame) => { realtime?.appendAudio(frame); });
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
