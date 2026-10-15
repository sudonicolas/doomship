// MARK: - doomship (appended to an exported copy of a UI test file, which imports XCTest; never to the repo)

/// The demo's vocabulary. Each call prints a `DOOMSHIP {json}` marker with the wall-clock time
/// (the simulator shares the Mac's clock), and the renderer lines captions, tap rings and zooms up
/// with the recording from them.
@MainActor
struct DoomshipDemo {
    let app: XCUIApplication

    private func mark(_ event: String, _ fields: [String: Any] = [:]) {
        var all = fields
        all["event"] = event
        all["t"] = Date().timeIntervalSince1970
        let data = try! JSONSerialization.data(withJSONObject: all, options: [.sortedKeys])
        print("DOOMSHIP " + String(decoding: data, as: UTF8.self))
    }

    /// Starts the GIF here. Logs the window size in points, so taps can be scaled to pixels.
    func begin() {
        let frame = app.windows.firstMatch.frame
        mark("begin", ["w": frame.width, "h": frame.height])
    }

    /// Shows this text in the band above the screen until the next caption.
    func caption(_ text: String) { mark("caption", ["text": text]) }

    /// Taps the element's centre and logs where, with the time the call started (`t0`) and
    /// returned (`t`): the touch shows on screen about 0.15 s after `t0`.
    func tap(_ element: XCUIElement) {
        let frame = element.frame
        let t0 = Date().timeIntervalSince1970
        element.tap()
        mark("tap", ["x": frame.midX, "y": frame.midY, "t0": t0])
    }

    /// Points at a new or changed element: the renderer zooms in on it, outlined, while this holds.
    func show(_ element: XCUIElement, seconds: Double = 1.5) {
        let frame = element.frame
        mark("show", ["x": frame.minX, "y": frame.minY, "w": frame.width, "h": frame.height, "seconds": seconds])
        Thread.sleep(forTimeInterval: seconds)
    }

    /// Keeps the screen still, so a viewer can read it.
    func hold(_ seconds: Double) {
        mark("hold", ["seconds": seconds])
        Thread.sleep(forTimeInterval: seconds)
    }

    /// Ends the GIF here: call it after holding on the result.
    func end() { mark("end") }
}
