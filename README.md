# voice-input
Voice input cli

## Requirements

- Node.js 18+
- OpenAI API key
- **macOS**: Xcode Command Line Tools (for Swift compiler)
- **macOS**: Accessibility permission for the terminal app

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
MODEL=gpt-4o-mini
LANGUAGE=en
MAX_RECORDING_SECONDS=60
MIN_RECORDING_SECONDS=0.5
```

## Usage

```bash
# Development
npm run dev

# Build
npm run build

# Run built output
npm start
```

Press and hold **Right Option** (macOS) or **Right Alt** (Windows/Linux) to record. Release to transcribe and insert.

On first launch on macOS, you will be prompted to grant Accessibility permission to your terminal app. After granting it, restart the process.
