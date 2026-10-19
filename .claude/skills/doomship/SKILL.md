---
name: doomship
description: Turn a change in an app repo (a commit, a range, a branch or the working tree) into a short GIF of exactly that change, for its pull request; or skip it with a reason when nothing visible changed. Use when asked to "doomship" a change, make a PR GIF or demo of a change, or record a change instead of taking screenshots. Arguments: <repo> <change>, where change is a sha, a..b, a branch, or "worktree".
---

# doomship: a GIF of a change

You write the demo script and its captions; the `doomship` CLI does everything else (export,
build, record, render) deterministically. Work from this repo's root; the CLI is
`node src/cli.ts`. Never write to the repo being demoed, its `.git` included: everything goes to
the run directory the CLI prints.

## 1. Prepare

```sh
node src/cli.ts prepare <repo> <change>            # or --worktree instead of <change>
```

If the repo has no `.doomship.json`, pass `--config examples/<repo name>.doomship.json` (or
`local/<repo name>.doomship.json`, for private apps) when there is one; if there's none, stop and
say a config is needed.
The output names the run directory (`~/Library/Caches/doomship/<repo>/runs/<id>/`). For a fresh
attempt at a change already run before, delete that run directory first.

## 2. Read and decide

Read the run's `context.md` whole: the commit messages, the changed UI files, their identifiers
and visible strings (a `String` entry is text found outside a view's first argument, such as
after `??`; "(new)" marks what the change added), the UI test file the demo goes into, and the config's notes. Read
`diff.patch` when you need the exact change.

**Skip** when nothing a user can see changed: a data model, a refactor, tests, docs, build
settings, or code that only feeds a screen without changing what it shows. Skipping beats filler.

```sh
node src/cli.ts skip <run> --reason "What changed, and why nothing shows: one line."
```

Otherwise **demo**: work out the shortest path from launch to the change, using only
identifiers and strings that `context.md` shows (or the existing UI tests use). If the changed
screen can't be reached, say so and stop; never demo something else.

## 3. Write `demo.swift` in the run directory

One `XCTestCase` named `Doomship` with `func testDemo()`; it's appended to the UI test file after
the doomship helper, so `XCTest` and anything that file defines are in scope. Start from this:

```swift
final class Doomship: XCTestCase {
    @MainActor
    func testDemo() throws {
        continueAfterFailure = false
        XCUIDevice.shared.appearance = .light
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting"]          // from the config's notes
        app.launch()
        let demo = DoomshipDemo(app: app)

        // Get near the change before begin(): what happens before it isn't in the GIF.
        let first = app.buttons["someIdentifier"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        demo.begin()
        demo.caption("…")
        // … the change, step by step …
        demo.hold(1.5)                                // on the result
        demo.end()
    }
}
```

The helper (`resources/ios/Doomship.swift`):

| Call | What it does in the GIF |
|---|---|
| `demo.begin()` | The GIF starts here. Call it once the first screen of the demo is up. |
| `demo.caption("…")` | Shows the text in the band above the screen until the next caption. |
| `demo.tap(element)` | Taps the element's centre and draws a ring where the touch lands. Use it for the taps that are the change; for the way there use plain `element.tap()`, which the GIF speeds through. |
| `demo.show(element)` | Zooms in on a new or changed element and outlines it, for 1.5 s. Use it on what the change added: the new button, row or toggle. A compact element zooms up to 2.2x; a full-width row only 1.2x, so point at the smallest element that is the change. |
| `demo.hold(seconds)` | Keeps the screen still so it can be read. |
| `demo.end()` | The GIF ends here. Hold on the result first (1.5 s). |

Rules:

- **Show the exact change.** Launch as close to it as the app allows (launch arguments), show it
  happen, end on the result. Unchanged screens appear only as the way there.
- **Wait, don't sleep.** After a tap that opens a screen, `XCTAssertTrue(x.waitForExistence(timeout: 5))`
  on something on the new screen before the next step. Waits are sped up in the GIF.
- **1 to 5 captions**, one per step; one is right for a one-line change. Each should stay up at
  least a second: don't caption a step that's over instantly ("Redeem it"), fold it into the
  caption of what it shows ("Redeem, and the account is a coach"). A caption right after a tap that opened a screen (within
  1.5 s) appears as that screen slides in, so it should describe the new screen. A caption before
  a tap describes what's about to be done.
- **5 to 20 seconds** of GIF, before the splash. Stretches with no `demo` call for more than
  1.5 s play at 4x; `demo.tap`, `show`, `hold` and captions play at full speed. So do the setup
  (opening a screen, scrolling a lazy list to the new section) before `begin()`, and walk the way
  between two parts of a change with plain taps. If the render says over 20 s, shorten the demo.
- **Fake data only**: launch arguments and seeded test accounts, never real ones.

### Captions

At most 6 words, sentence case, about what a user does or sees, true to what the change does.
No code words, no emoji, no em dashes, no hype.

| Good | Bad, and why |
|---|---|
| "Pick the days you can train" | "AvailabilityPicker now in SettingsView" (code, not what a user sees) |
| "Your plan moves to fit" | "Amazing new scheduling experience!" (hype, says nothing) |
| "Rate how you're arriving" | "Tap the button at the top of the screen to start rating" (too long; describes the tap, not the meaning) |

### Gotchas (any iOS app)

- **Lazy lists and forms** (`List`, `Form`, `LazyVStack`) only create rows on screen: scroll
  until the element `isHittable` before using it, as in the example below; for a toggle, tap its
  switch (`app.switches["id"].switches.firstMatch`), not its row.
- **The keyboard** covers things: put it away (`app.keyboards.buttons["Return"]`, or tap a
  non-input area) before tapping something it moved.
- **Never open URLs or touch SpringBoard** (no `XCUIApplication(bundleIdentifier:)` for other
  apps, no `open`): `xcodebuild` stalls after the test.
- Element queries: `app.buttons["id"]` matches the accessibility identifier or the label. When
  several match, add `.firstMatch`.
- Read the repo's own notes in `context.md`: they say how to put the app in any state.

### Worked example (an iOS app's first-run welcome and profile)

```swift
final class Doomship: XCTestCase {
    @MainActor
    func testDemo() throws {
        continueAfterFailure = false
        XCUIDevice.shared.appearance = .light
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting", "-firstRun"]
        app.launch()
        let demo = DoomshipDemo(app: app)

        let start = app.buttons["getStarted"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        demo.begin()
        demo.caption("Welcome on a fresh install")
        demo.hold(1.5)
        demo.tap(start)

        XCTAssertTrue(app.navigationBars["About You"].waitForExistence(timeout: 5))
        demo.caption("A short profile about you")
        demo.tap(app.buttons["Male"])
        let increment = app.buttons["profileWeight-Increment"].firstMatch
        var swipes = 0
        while !increment.isHittable && swipes < 6 { app.swipeUp(); swipes += 1 }
        demo.tap(increment)
        demo.tap(increment)
        demo.hold(0.8)

        demo.caption("Start, and your plan is ready")
        let finish = app.buttons["finishFirstRun"]
        demo.show(finish)
        demo.tap(finish)
        XCTAssertTrue(app.buttons["todaySession"].waitForExistence(timeout: 5))
        demo.hold(2)
        demo.end()
    }
}
```

### macOS apps (`"platform": "macos"`)

A Swift package app (SwiftUI or AppKit). `demo.swift` is one function, compiled with the helper
(`resources/macos/Doomship.swift`) into a library the app loads at launch; the demo runs inside
the app, on its own thread, while the helper captures the app's windows over a plain backdrop.
The app starts with an empty home folder in the cache and a clipboard of its own, so it reads
none of the person's data. No `XCTest`, no `app.launch()`: the app is already running.

| Call | What it does |
|---|---|
| `try demo.element("name", role: "AXButton")` | Waits up to 5 s for an element whose identifier, title, label or value is `name`; the error lists the names on screen. `role` is optional. |
| `try demo.tap(el)` | Clicks it (accessibility press) with a ring. Rows and buttons, not their text. |
| `demo.show(el, seconds:)` | The zoom and outline, once the element has stopped moving. |
| `try demo.clickMenuBarItem()` | Opens a menu bar app's popover. The menu bar isn't in the GIF, so do it before `begin()`. |
| `demo.copy("text")` | Puts text on the app's private clipboard, as if copied in another app. |
| `demo.type("text", into: el)` | Types into a text field. |
| `begin`, `caption`, `hold`, `end` | As for iOS. |

```swift
import Foundation

func play(_ demo: Demo) throws {
    try demo.clickMenuBarItem()                 // setup before begin()
    demo.begin()
    demo.caption("Copy a hex colour")
    demo.hold(0.8)
    demo.copy("#FF6B35")
    let row = try demo.element("#FF6B35")       // waits for the new row
    demo.caption("Encore shows it as a swatch")
    demo.show(row, seconds: 2)
    demo.hold(2)                                // on the result
    demo.end()
}
```

A compile error is reported as `demo.swift:<line>`. Things copied while another app is in front
are recorded as from that app (its icon and name show), so open the app's window or popover
before seeding data. The app takes focus while it records.

## 4. Record, at most 3 attempts

```sh
node src/cli.ts record <run>       # run it in the background; wait for it to exit
```

A cold build takes a few minutes, a warm one seconds; recording takes about as long as the demo.
Exit 0: recorded (`video.mov`, `events.json`). Exit 1: the build or the demo failed; read
`failure.txt` (the error, its `demo.swift` line, the last caption reached), and `build.log` or
`test.log` if it isn't enough; fix `demo.swift` and record again. Exit 2: `xcodebuild` stalled
twice; check the demo for URLs or SpringBoard, else report it.

`attempts.jsonl` counts the attempts. After the third failure, stop and report what failed, with
`failure.txt`; don't skip a change that has something visible just because the demo failed.

## 5. Render and look at it

```sh
node src/cli.ts render <run>
scripts/frames.sh <gif> <seconds> …      # frames at the times you want to check
```

The GIF opens and closes on the doomship splash (about 1 s and 2 s). **Look at the frames**:
read the images, one per caption, each `show` zoom, and the result before the end splash
(`events.json` and `render.json` give the times; the flow starts at 1 s). Check that each caption
is on the step it describes, the zoom lands on the changed element, and the result is what the
change does. If it's wrong, fix the demo and record again (it counts as an attempt). An exit
code proves nothing about a GIF.

## 6. Report

Say what the GIF shows, then the summary: its path, length, size, captions, attempts, and
build, record and render times (`render.json`, `attempts.jsonl`). Or the skip and its reason, or
what failed after 3 attempts.

**Never post the GIF to a PR unless the person asked** for it in this request or their
instructions say so. Posting is its own command: `node src/cli.ts post <repo> <pr> --dry-run`
shows the section, then the same without `--dry-run` hosts the GIF on GitHub and puts it in the
PR description. It posts the newest render of the PR's head commit, so render that change
(`<base>..<head>`) first.
