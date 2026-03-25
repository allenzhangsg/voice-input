# voice-input

A CLI tool that turns voice into polished text. Press a hotkey to start recording, press again to stop, then it transcribes (via Whisper), formats (via GPT), and pastes into the active app. Supports translation mode and context-aware formatting based on the target application.

## Requirements

- Node.js 18+
- OpenAI API key
- **macOS**: Xcode Command Line Tools (for Swift compiler) and Accessibility permission for the terminal app
- **Windows**: No additional requirements

## Install

```bash
npm install
```

### macOS only — compile the key listener binary

The global hotkey listener requires a native Swift binary that is not bundled in the npm package:

```bash
curl -fsSL "https://raw.githubusercontent.com/LaunchMenu/node-global-key-listener/master/src/bin/MacKeyServer/main.swift" -o /tmp/MacKeyServer.swift

{ echo "import CoreGraphics"; echo "import Foundation"; cat /tmp/MacKeyServer.swift; } > /tmp/MacKeyServer_fixed.swift

swiftc /tmp/MacKeyServer_fixed.swift -o node_modules/node-global-key-listener/bin/MacKeyServer
```

This only needs to be done once. Re-run it after `npm install` if `node_modules` is deleted.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
OPENAI_API_KEY=sk-...

# Optional
MODEL=gpt-4.1-mini        # OpenAI model for formatting
LANGUAGE=en                # Whisper transcription language
MAX_RECORDING_SECONDS=60
MIN_RECORDING_SECONDS=0.5
TRANSLATE=false            # Start in translation mode
TRANSLATE_TARGET=English   # Translation target language
HOTKEY=                    # Override default hotkey (e.g. "RIGHT ALT")
```

## Usage

```bash
# Development
npm run dev

# Build & run
npm run build
npm start
```

### Hotkeys

| Action | macOS | Windows |
|---|---|---|
| **Start/stop recording** (single tap) | Right Option | Right Ctrl |
| **Toggle translate mode** (double-tap) | Right Option | Right Ctrl |
| **Cancel recording** | ESC or click X button | ESC or click X button |

Recording auto-stops when the maximum duration is reached. A floating status pill appears during recording and processing, with a close button (X) to cancel.

The hotkey can be overridden with the `HOTKEY` env var (uses `node-global-key-listener` key names, e.g. `RIGHT ALT`, `RIGHT CTRL`).

### Context-aware formatting

The formatter adapts its style based on the active application:

- **Chat apps** (Slack, Teams) — professional but conversational
- **Personal chat** (Discord, Telegram, WhatsApp) — casual and friendly
- **Email** (Mail, Outlook) — formal with proper greeting structure
- **Code editors** (VS Code, Cursor, Terminal) — precise, suitable for AI prompts
- **Other apps** — professional default

### Translation mode

Double-tap the hotkey to toggle translation mode. When active, spoken text is transcribed and then translated into the configured target language (`TRANSLATE_TARGET`, default: English).

## Platform notes

- **macOS**: On first launch you will be prompted to grant Accessibility permission to your terminal app. Restart the process after granting it.
- **Windows**: On first launch, a UAC prompt may appear for the global key listener.
