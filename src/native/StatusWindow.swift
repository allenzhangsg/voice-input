import AppKit
import Foundation

class StatusWindow: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var contentViewWrapper: NSView!
    var containerView: NSVisualEffectView!
    var dotView: NSView!
    var pulseLayer: CALayer!
    var modeLabel: NSTextField!
    var label: NSTextField!
    var currentState = "idle"
    var pulseTimer: Timer?
    var flashTimer: Timer?

    let pillHeight: CGFloat = 32
    let padding: CGFloat = 14
    let dotSize: CGFloat = 10
    let gap: CGFloat = 6

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let initialWidth: CGFloat = 120

        let screen = activeScreen()
        let screenFrame = screen.visibleFrame
        let x = screenFrame.midX - initialWidth / 2
        let y = screenFrame.minY + 24

        window = NSWindow(
            contentRect: NSRect(x: x, y: y, width: initialWidth, height: pillHeight),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.level = .floating
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary]
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true
        window.alphaValue = 0

        // Wrapper to mask corners
        contentViewWrapper = NSView(frame: NSRect(x: 0, y: 0, width: initialWidth, height: pillHeight))
        contentViewWrapper.wantsLayer = true
        contentViewWrapper.layer?.cornerRadius = pillHeight / 2
        contentViewWrapper.layer?.masksToBounds = true
        window.contentView = contentViewWrapper

        // Vibrancy background
        containerView = NSVisualEffectView(frame: contentViewWrapper.bounds)
        containerView.material = .hudWindow
        containerView.state = .active
        containerView.blendingMode = .behindWindow
        containerView.wantsLayer = true
        containerView.layer?.cornerRadius = pillHeight / 2
        containerView.layer?.masksToBounds = true
        contentViewWrapper.addSubview(containerView)

        // Pulse glow behind the dot
        pulseLayer = CALayer()
        pulseLayer.frame = CGRect(x: padding - 2, y: pillHeight / 2 - (dotSize / 2 + 2), width: dotSize + 4, height: dotSize + 4)
        pulseLayer.cornerRadius = (dotSize + 4) / 2
        pulseLayer.backgroundColor = NSColor.systemRed.withAlphaComponent(0.3).cgColor
        pulseLayer.isHidden = true
        containerView.layer?.addSublayer(pulseLayer)

        // Colored dot
        dotView = NSView(frame: NSRect(x: padding, y: pillHeight / 2 - dotSize / 2, width: dotSize, height: dotSize))
        dotView.wantsLayer = true
        dotView.layer?.cornerRadius = dotSize / 2
        dotView.layer?.backgroundColor = NSColor.systemRed.cgColor
        containerView.addSubview(dotView)

        let labelX = padding + dotSize + gap

        let fontSize: CGFloat = 12
        let labelHeight: CGFloat = 16
        let labelY = (pillHeight - labelHeight) / 2 - 1

        // Mode tag (secondary color)
        modeLabel = makeLabel(size: fontSize, weight: .regular)
        modeLabel.textColor = NSColor.secondaryLabelColor
        modeLabel.frame = NSRect(x: labelX, y: labelY, width: 0, height: labelHeight)
        containerView.addSubview(modeLabel)

        // Status label
        label = makeLabel(size: fontSize, weight: .medium)
        label.frame = NSRect(x: labelX, y: labelY, width: 0, height: labelHeight)
        containerView.addSubview(label)

        // Start hidden
        window.orderOut(nil)

        // Read stdin on background queue
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed == "QUIT" {
                    DispatchQueue.main.async { NSApp.terminate(nil) }
                    return
                }
                DispatchQueue.main.async { self?.handleCommand(trimmed) }
            }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }

        // Orphan check
        let parentPid = getppid()
        Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            if getppid() != parentPid {
                NSApp.terminate(nil)
            }
        }
    }

    // MARK: - Layout

    func intrinsicWidth(_ field: NSTextField) -> CGFloat {
        guard !field.stringValue.isEmpty, let cell = field.cell else { return 0 }
        return ceil(cell.cellSize.width) + 2
    }

    func resizeToFit() {
        let labelX = padding + dotSize + gap
        let labelHeight: CGFloat = 16
        let labelY = (pillHeight - labelHeight) / 2 - 1

        // Measure mode label
        let modeW = intrinsicWidth(modeLabel)
        modeLabel.frame = NSRect(x: labelX, y: labelY, width: modeW, height: labelHeight)

        // Separator gap between mode and status
        let sepGap: CGFloat = modeW > 0 && !label.stringValue.isEmpty ? 6 : 0

        // Measure status label
        let statusX = labelX + modeW + sepGap
        let statusW = intrinsicWidth(label)
        label.frame = NSRect(x: statusX, y: labelY, width: statusW, height: labelHeight)

        let totalWidth = statusX + statusW + padding

        // Re-center on active screen
        let screen = activeScreen()
        let screenFrame = screen.visibleFrame
        let newX = screenFrame.midX - totalWidth / 2

        var frame = window.frame
        frame.origin.x = newX
        frame.origin.y = screenFrame.minY + 24
        frame.size.width = totalWidth
        window.setFrame(frame, display: false)

        contentViewWrapper.frame = NSRect(x: 0, y: 0, width: totalWidth, height: pillHeight)
        containerView.frame = contentViewWrapper.bounds
    }

    // MARK: - Command handling

    func handleCommand(_ cmd: String) {
        if cmd.hasPrefix("STATE:") {
            let state = String(cmd.dropFirst(6))
            currentState = state
            switch state {
            case "idle":
                stopPulse()
                fadeOut()
            case "recording":
                setDotColor(NSColor.systemRed)
                startPulse()
                setStatusText("Recording…")
                fadeIn()
            case "processing":
                stopPulse()
                setDotColor(NSColor.systemOrange)
                setStatusText("Processing…")
                fadeIn()
            default:
                break
            }
        } else if cmd.hasPrefix("MODE:") {
            let mode = String(cmd.dropFirst(5))
            if mode == "transcribe" {
                modeLabel.stringValue = ""
            } else if mode.hasPrefix("translate:") {
                let target = String(mode.dropFirst(10))
                modeLabel.stringValue = "\u{2192} \(target)"
            }
            resizeToFit()
        } else if cmd.hasPrefix("FLASH:") {
            let text = String(cmd.dropFirst(6))
            flashTimer?.invalidate()
            stopPulse()
            setDotColor(NSColor.systemGreen)
            label.stringValue = text
            label.alphaValue = 1
            resizeToFit()
            fadeIn()
            flashTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
                self?.fadeOut()
            }
        } else if cmd.hasPrefix("TEXT:") {
            let text = String(cmd.dropFirst(5))
            setStatusText(text)
        }
    }

    func setStatusText(_ text: String) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.1
            label.animator().alphaValue = 0
        } completionHandler: { [weak self] in
            self?.label.stringValue = text
            self?.resizeToFit()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.1
                self?.label.animator().alphaValue = 1
            }
        }
    }

    // MARK: - Animations

    func fadeIn() {
        resizeToFit()
        window.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.2
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().alphaValue = 1
        }
    }

    func fadeOut() {
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.25
            ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
            window.animator().alphaValue = 0
        }) { [weak self] in
            self?.window.orderOut(nil)
        }
    }

    func setDotColor(_ color: NSColor) {
        dotView.layer?.backgroundColor = color.cgColor
        pulseLayer.backgroundColor = color.withAlphaComponent(0.3).cgColor
    }

    func startPulse() {
        pulseLayer.isHidden = false
        pulseTimer?.invalidate()
        var on = true
        pulseTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.5
                self.pulseLayer.opacity = on ? 0.0 : 1.0
            }
            on.toggle()
        }
    }

    func stopPulse() {
        pulseTimer?.invalidate()
        pulseTimer = nil
        pulseLayer.isHidden = true
        pulseLayer.opacity = 1.0
    }

    // MARK: - Helpers

    func activeScreen() -> NSScreen {
        let mouseLocation = NSEvent.mouseLocation
        for screen in NSScreen.screens {
            if screen.frame.contains(mouseLocation) {
                return screen
            }
        }
        return NSScreen.main ?? NSScreen.screens[0]
    }

    func makeLabel(size: CGFloat, weight: NSFont.Weight) -> NSTextField {
        let label = NSTextField(frame: .zero)
        label.isEditable = false
        label.isBordered = false
        label.drawsBackground = false
        label.textColor = NSColor.labelColor
        label.font = NSFont.systemFont(ofSize: size, weight: weight)
        label.stringValue = ""
        label.lineBreakMode = .byClipping
        return label
    }
}

let app = NSApplication.shared
let delegate = StatusWindow()
app.delegate = delegate
app.run()
