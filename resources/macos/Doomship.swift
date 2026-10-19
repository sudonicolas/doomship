// doomship's macOS helper. Compiled with the run's demo.swift into a dylib that the app loads at
// launch (DYLD_INSERT_LIBRARIES), so neither the repo nor its exported copy is changed. Inside the
// app it:
// - gives the app a private clipboard, so the demo never reads what you copied or writes into it;
// - captures the app's own windows, which needs no Screen Recording permission, and composites
//   them on a plain backdrop (the menu bar and other apps are never in the picture);
// - plays the demo on its own thread, finding elements through the accessibility API, as
//   XCUITest does, and logs a `DOOMSHIP {json}` marker for each step.
// It writes frames/, frames.json, events.log and, if the demo failed, failure.txt to DOOMSHIP_OUT,
// then quits the app.
import AppKit
import ApplicationServices

private let doomshipOut = ProcessInfo.processInfo.environment["DOOMSHIP_OUT"] ?? ""
private func now() -> Double { Date().timeIntervalSince1970 }

@_cdecl("doomship_init")
public func doomshipInit() {
    guard !doomshipOut.isEmpty else { return }
    DoomshipPasteboard.isolate()
    var token: NSObjectProtocol?
    token = NotificationCenter.default.addObserver(forName: NSApplication.didFinishLaunchingNotification, object: nil, queue: nil) { _ in
        if let token { NotificationCenter.default.removeObserver(token) }
        Thread.detachNewThread { DoomshipRunner.run() }
    }
}

// MARK: - The clipboard

/// Points `NSPasteboard.general` at a pasteboard of the app's own, for the whole run.
enum DoomshipPasteboard {
    static let pasteboard = NSPasteboard(name: NSPasteboard.Name("doomship.demo.\(getpid())"))

    static func isolate() {
        pasteboard.clearContents()
        let method = class_getClassMethod(NSPasteboard.self, #selector(getter: NSPasteboard.general))!
        let block: @convention(block) (AnyObject) -> NSPasteboard = { _ in pasteboard }
        method_setImplementation(method, imp_implementationWithBlock(block))
    }
}

// MARK: - Capture

typealias DoomshipCreateImage = @convention(c) (CGRect, CFArray, UInt32) -> Unmanaged<CGImage>?

/// Captures the app's windows over the backdrop, the whole screen about 20 times a second, each
/// frame stamped with the middle of its capture and the windows' bounds (with room for their
/// shadows) in screen points, top-left origin.
final class DoomshipCapture: @unchecked Sendable {
    struct Frame { let file: String; let t: Double; let rect: CGRect; let scale: CGFloat }
    let screen = CGDisplayBounds(CGMainDisplayID())
    /// Room around the windows for their shadows, in points.
    static let margin: CGFloat = 40
    private(set) var frames: [Frame] = []
    private var running = true
    private let lock = NSLock()
    private let dir: String
    private let createImage: DoomshipCreateImage
    /// A window of the app's own behind its others, so their glass has something to refract.
    private var backdrop: CGWindowID = 0

    init(dir: String) {
        self.dir = dir
        // Deprecated in the SDK, but the only capture that needs no permission for one's own windows.
        let symbol = dlsym(dlopen(nil, RTLD_NOW), "CGWindowListCreateImageFromArray")!
        createImage = unsafeBitCast(symbol, to: DoomshipCreateImage.self)
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    /// The app's windows on screen, front to back, with their bounds; not its menu bar item, which
    /// sits in the menu bar (a menu bar app's popover is at the same level, below it).
    static func windows() -> [(id: CGWindowID, bounds: CGRect)] {
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return info.compactMap { w in
            guard (w[kCGWindowOwnerPID as String] as? Int32) == getpid(),
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let id = w[kCGWindowNumber as String] as? CGWindowID,
                  let b = w[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: b), bounds.width > 4, bounds.height > 4,
                  bounds.maxY > 40
            else { return nil }
            return (id, bounds)
        }
    }

    /// A soft gradient filling the screen, just below normal windows: under the app's windows,
    /// above the desktop. Other apps' windows cover it on screen, but are never captured.
    @MainActor static func makeBackdrop() -> NSWindow {
        let frame = NSScreen.main?.frame ?? .zero
        let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)
        window.ignoresMouseEvents = true
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        let view = NSView(frame: frame)
        let gradient = CAGradientLayer()
        gradient.colors = [CGColor(red: 0.80, green: 0.85, blue: 0.93, alpha: 1), CGColor(red: 0.93, green: 0.90, blue: 0.95, alpha: 1)]
        gradient.startPoint = CGPoint(x: 0, y: 1)
        gradient.endPoint = CGPoint(x: 1, y: 0)
        view.layer = gradient
        view.wantsLayer = true
        window.contentView = view
        window.orderFrontRegardless()
        return window
    }

    func start(backdrop: CGWindowID) {
        self.backdrop = backdrop
        Thread.detachNewThread { [self] in
            while lock.withLock({ running }) {
                let a = now()
                let wins = Self.windows().filter { $0.id != backdrop }
                guard let first = wins.first else { Thread.sleep(forTimeInterval: 0.02); continue }
                let rect = wins.dropFirst().reduce(first.bounds) { $0.union($1.bounds) }.insetBy(dx: -Self.margin, dy: -Self.margin).integral
                let ids: [UnsafeRawPointer?] = (wins.map(\.id) + [backdrop]).map { UnsafeRawPointer(bitPattern: UInt($0)) }
                let array = ids.withUnsafeBufferPointer { CFArrayCreate(nil, UnsafeMutablePointer(mutating: $0.baseAddress), $0.count, nil)! }
                guard let image = createImage(screen, array, 1 << 3 /* best resolution */)?.takeRetainedValue() else { continue }
                let b = now()
                let file = "\(dir)/\(String(format: "%06d", frames.count)).jpg"
                write(image, to: file, type: "public.jpeg", quality: 0.95)
                lock.withLock { frames.append(Frame(file: file, t: (a + b) / 2, rect: rect, scale: CGFloat(image.width) / screen.width)) }
                let spare = 0.05 - (now() - a)
                if spare > 0 { Thread.sleep(forTimeInterval: spare) }
            }
        }
    }

    func stop() -> [Frame] {
        lock.withLock { running = false }
        Thread.sleep(forTimeInterval: 0.15)
        return lock.withLock { frames }
    }
}

func write(_ image: CGImage, to file: String, type: String, quality: Double = 1) {
    let url = URL(fileURLWithPath: file) as CFURL
    guard let dest = CGImageDestinationCreateWithURL(url, type as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    CGImageDestinationFinalize(dest)
}

/// The frames cropped to one canvas: the union of every frame's windows, at least `minWidth`
/// pixels wide where the screen allows; written as JPEGs. Returns the canvas in screen points.
func composite(_ frames: [DoomshipCapture.Frame], screen: CGRect, into dir: String, minWidth: CGFloat = 600) -> (canvas: CGRect, files: [(String, Double)]) {
    let scale = frames.map(\.scale).max() ?? 1
    var canvas = frames.dropFirst().reduce(frames[0].rect) { $0.union($1.rect) }
    if canvas.width * scale < minWidth { canvas = canvas.insetBy(dx: -(minWidth / scale - canvas.width) / 2, dy: 0) }
    canvas = canvas.intersection(screen).integral
    var files: [(String, Double)] = []
    for (i, f) in frames.enumerated() {
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: f.file) as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(src, 0, nil),
              let crop = image.cropping(to: CGRect(x: (canvas.minX - screen.minX) * scale, y: (canvas.minY - screen.minY) * scale,
                                                  width: canvas.width * scale, height: canvas.height * scale)) else { continue }
        let file = "\(dir)/c\(String(format: "%06d", i)).jpg"
        write(crop, to: file, type: "public.jpeg", quality: 0.92)
        try? FileManager.default.removeItem(atPath: f.file)
        files.append((file, f.t))
    }
    return (canvas, files)
}

// MARK: - Elements

/// An element of the app's accessibility tree, as the demo found it.
public struct DoomshipElement: CustomStringConvertible {
    let ax: AXUIElement
    public let description: String

    func attribute(_ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(ax, name as CFString, &v) == .success ? v : nil
    }

    /// The frame once it has stopped moving (a row animating in, a sheet sliding up): the same
    /// for 0.2 s, or as it is after 1.5 s.
    var settledFrame: CGRect {
        var last = frame
        var still = 0.0
        let deadline = Date().timeIntervalSince1970 + 1.5
        while still < 0.2 && Date().timeIntervalSince1970 < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            let next = frame
            still = next == last ? still + 0.05 : 0
            last = next
        }
        return last
    }

    /// Screen points, top-left origin.
    var frame: CGRect {
        var p = CGPoint.zero, s = CGSize.zero
        if let v = attribute(kAXPositionAttribute) { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
        if let v = attribute(kAXSizeAttribute) { AXValueGetValue(v as! AXValue, .cgSize, &s) }
        return CGRect(origin: p, size: s)
    }
    var children: [DoomshipElement] {
        (attribute(kAXChildrenAttribute) as? [AXUIElement] ?? []).map { DoomshipElement(ax: $0, description: "") }
    }
    var role: String { attribute(kAXRoleAttribute) as? String ?? "" }
    /// What a person would call it: its identifier, title, label, or value.
    var names: [String] {
        [kAXIdentifierAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
            .compactMap { attribute($0) as? String }.filter { !$0.isEmpty }
    }
}

public struct DoomshipError: Error, CustomStringConvertible {
    public let description: String
}

// MARK: - The demo's vocabulary

/// What demo.swift's `play(_ demo: Demo)` is given. Each step logs a marker with the wall-clock
/// time, which the frames share, so captions, rings and zooms line up with the recording. Every
/// call that can fail throws with the demo's own line.
public final class Demo: @unchecked Sendable {
    var markers: [[String: Any]] = []
    let app = AXUIElementCreateApplication(getpid())

    private func mark(_ event: String, _ fields: [String: Any] = [:]) {
        var all = fields
        all["event"] = event
        all["t"] = fields["t"] ?? now()
        markers.append(all)
    }

    /// Starts the GIF here: call it once the first screen of the demo is up.
    public func begin() { mark("begin") }

    /// Shows this text in the band above the screen until the next caption.
    public func caption(_ text: String) { mark("caption", ["text": text]) }

    /// Keeps the screen still, so a viewer can read it.
    public func hold(_ seconds: Double) {
        mark("hold", ["seconds": seconds])
        Thread.sleep(forTimeInterval: seconds)
    }

    /// Ends the GIF here: call it after holding on the result.
    public func end() { mark("end") }

    /// The first element, in the app's windows (and its menu bar item), whose identifier, title,
    /// label or value is `name`, optionally of an accessibility role such as "AXButton"; waits up
    /// to `timeout` seconds for it to appear.
    public func element(_ name: String, role: String? = nil, timeout: Double = 5, line: Int = #line) throws -> DoomshipElement {
        let deadline = now() + timeout
        repeat {
            if let found = find(DoomshipElement(ax: app, description: ""), name: name, role: role, depth: 0) {
                return DoomshipElement(ax: found.ax, description: "\"\(name)\"")
            }
            Thread.sleep(forTimeInterval: 0.1)
        } while now() < deadline
        let seen = Array(Set(visibleNames(DoomshipElement(ax: app, description: ""), depth: 0))).sorted().prefix(40)
        throw DoomshipError(description: "demo.swift:\(line): no element named \"\(name)\"\(role.map { " (\($0))" } ?? "") appeared within \(timeout) s. Names on screen: \(seen.map { "\"\($0)\"" }.joined(separator: ", "))")
    }

    private func find(_ e: DoomshipElement, name: String, role: String?, depth: Int) -> DoomshipElement? {
        if depth > 0, e.names.contains(name), role == nil || e.role == role { return e }
        guard depth < 40 else { return nil }
        for child in e.children + (depth == 0 ? menuBarItems() : []) {
            if let hit = find(child, name: name, role: role, depth: depth + 1) { return hit }
        }
        return nil
    }

    private func visibleNames(_ e: DoomshipElement, depth: Int) -> [String] {
        guard depth < 40 else { return [] }
        return (depth > 0 ? e.names.filter { $0.count < 60 } : []) + e.children.flatMap { visibleNames($0, depth: depth + 1) }
    }

    private func menuBarItems() -> [DoomshipElement] {
        guard let bar = DoomshipElement(ax: app, description: "").attribute("AXExtrasMenuBar") else { return [] }
        return DoomshipElement(ax: bar as! AXUIElement, description: "").children
    }

    /// Clicks the app's menu bar item (a menu bar app's icon), with the app made active first, as
    /// a click would. The item isn't in the GIF (macOS draws the menu bar, not the app), so call
    /// this before begin().
    public func clickMenuBarItem(line: Int = #line) throws {
        // A press through accessibility doesn't reach a status item's action; its button's own click does.
        let clicked = onMain { () -> Bool in
            NSApp.activate(ignoringOtherApps: true)
            func button(in view: NSView) -> NSStatusBarButton? {
                if let b = view as? NSStatusBarButton { return b }
                return view.subviews.lazy.compactMap(button(in:)).first
            }
            guard let b = NSApp.windows.lazy.compactMap({ $0.contentView.flatMap(button(in:)) }).first(where: { $0.window?.isVisible == true }) else { return false }
            b.performClick(nil)
            return true
        }
        guard clicked else { throw DoomshipError(description: "demo.swift:\(line): the app has no menu bar item") }
        Thread.sleep(forTimeInterval: 0.6)
    }

    /// Clicks the element (its accessibility press) and draws a ring at its centre.
    public func tap(_ element: DoomshipElement, line: Int = #line) throws {
        let f = element.settledFrame
        let t0 = now()
        let r = AXUIElementPerformAction(element.ax, kAXPressAction as CFString)
        guard r == .success else {
            throw DoomshipError(description: "demo.swift:\(line): \(element) can't be clicked (AXPress gave \(r.rawValue)); tap a button or row, not its text")
        }
        mark("tap", ["x": f.midX, "y": f.midY, "t0": t0, "screen": true])
        Thread.sleep(forTimeInterval: 0.3)
    }

    /// Points at a new or changed element: the GIF zooms in on it, outlined, while this holds.
    public func show(_ element: DoomshipElement, seconds: Double = 1.5) {
        let f = element.settledFrame
        mark("show", ["x": f.minX, "y": f.minY, "w": f.width, "h": f.height, "seconds": seconds, "screen": true])
        Thread.sleep(forTimeInterval: seconds)
    }

    /// Puts text on the clipboard, as if it was copied in another app. The clipboard is the app's
    /// own for the run, so yours is never read or changed.
    public func copy(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    /// Types into a text field: focuses it and sets its value a character at a time.
    public func type(_ text: String, into element: DoomshipElement, perCharacter: Double = 0.06) {
        AXUIElementSetAttributeValue(element.ax, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        var typed = (element.attribute(kAXValueAttribute) as? String) ?? ""
        for c in text {
            typed.append(c)
            AXUIElementSetAttributeValue(element.ax, kAXValueAttribute as CFString, typed as CFString)
            Thread.sleep(forTimeInterval: perCharacter)
        }
    }

    /// Runs code on the app's main thread, for anything the vocabulary doesn't cover.
    public func onMain<T>(_ body: @MainActor () -> T) -> T {
        DispatchQueue.main.sync { MainActor.assumeIsolated(body) }
    }
}

// MARK: - The run

enum DoomshipRunner {
    static func run() {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: doomshipOut, withIntermediateDirectories: true)
        let capture = DoomshipCapture(dir: "\(doomshipOut)/frames")
        let demo = Demo()
        let backdrop = DispatchQueue.main.sync { MainActor.assumeIsolated { DoomshipCapture.makeBackdrop() } }
        // The app's first windows and SwiftUI's accessibility tree take a moment.
        Thread.sleep(forTimeInterval: 1.0)
        capture.start(backdrop: CGWindowID(backdrop.windowNumber))
        var failure: String?
        let deadline = DispatchTime.now() + 170
        let done = DispatchSemaphore(value: 0)
        Thread.detachNewThread {
            do { try play(demo) } catch { failure = "Demo failed: \(error)" }
            done.signal()
        }
        if done.wait(timeout: deadline) == .timedOut { failure = "Demo failed: the demo ran for more than 170 s" }
        Thread.sleep(forTimeInterval: 0.3) // the last frames after end()
        let frames = capture.stop()
        finish(demo: demo, frames: frames, failure: failure)
    }

    static func finish(demo: Demo, frames: [DoomshipCapture.Frame], failure: String?) {
        let out = doomshipOut
        func save(_ text: String, _ name: String) { try? text.write(toFile: "\(out)/\(name)", atomically: true, encoding: .utf8) }
        DoomshipPasteboard.pasteboard.releaseGlobally()
        if let failure {
            let captions = demo.markers.filter { $0["event"] as? String == "caption" }.compactMap { $0["text"] as? String }
            save(failure + (captions.last.map { "\nThe last caption reached: \"\($0)\"." } ?? "\nNo caption was reached.") + "\n", "failure.txt")
            exit(1)
        }
        guard !frames.isEmpty else {
            save("No frames were captured: the app showed no window.\n", "failure.txt")
            exit(1)
        }
        let (canvas, files) = composite(frames, screen: CGDisplayBounds(CGMainDisplayID()), into: "\(out)/frames")
        let list = files.map { ["file": $0.0, "t": $0.1] as [String: Any] }
        try? JSONSerialization.data(withJSONObject: list).write(to: URL(fileURLWithPath: "\(out)/frames.json"))
        // Screen points become canvas points; begin gets the canvas's size.
        let lines = demo.markers.map { m -> String in
            var m = m
            if m.removeValue(forKey: "screen") != nil {
                m["x"] = (m["x"] as! CGFloat) - canvas.minX
                m["y"] = (m["y"] as! CGFloat) - canvas.minY
            }
            if m["event"] as? String == "begin" { m["w"] = canvas.width; m["h"] = canvas.height }
            let data = try! JSONSerialization.data(withJSONObject: m, options: [.sortedKeys])
            return "DOOMSHIP " + String(decoding: data, as: UTF8.self)
        }
        save(lines.joined(separator: "\n") + "\n", "events.log")
        exit(0)
    }
}
