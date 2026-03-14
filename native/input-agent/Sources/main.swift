import CoreGraphics
import Dispatch
import Foundation

// MARK: - Input Event Types

/// Matches the InputEventData discriminated union from protocol.ts.
/// Coordinates are in screen pixels (Input Bridge normalizes 0-1 → pixels before forwarding).
struct InputEvent: Decodable {
	let kind: String
	let key: String?
	let modifiers: Int?
	let down: Bool?
	let button: String?
	let x: Double?
	let y: Double?
	let deltaX: Double?
	let deltaY: Double?
}

// MARK: - Key Mapping (Web KeyboardEvent.key → macOS Virtual Keycodes)

/// Maps web key names to macOS virtual keycodes (from Carbon HIToolbox/Events.h).
/// Lowercase letters map to their physical key positions. Uppercase characters use the
/// same keycode with Shift modifier applied via CGEvent flags.
let keyMap: [String: UInt16] = [
	// Letters (ANSI layout positions)
	"a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04,
	"g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
	"b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F,
	"y": 0x10, "t": 0x11, "o": 0x1F, "u": 0x20, "i": 0x22,
	"p": 0x23, "l": 0x25, "j": 0x26, "k": 0x28, "n": 0x2D,
	"m": 0x2E,

	// Numbers
	"1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "5": 0x17,
	"6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19, "0": 0x1D,

	// Symbols (unshifted, US ANSI)
	"-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\": 0x2A,
	";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C,
	"`": 0x32,

	// Shifted symbols (US ANSI) — same physical key, maps to base keycode
	"!": 0x12, "@": 0x13, "#": 0x14, "$": 0x15, "%": 0x17,
	"^": 0x16, "&": 0x1A, "*": 0x1C, "(": 0x19, ")": 0x1D,
	"_": 0x1B, "+": 0x18, "{": 0x21, "}": 0x1E, "|": 0x2A,
	":": 0x29, "\"": 0x27, "<": 0x2B, ">": 0x2F, "?": 0x2C,
	"~": 0x32,

	// Whitespace & editing
	" ": 0x31, "Enter": 0x24, "Tab": 0x30, "Backspace": 0x33,
	"Delete": 0x75, "Escape": 0x35,

	// Modifier keys (for explicit key events)
	"Shift": 0x38, "CapsLock": 0x39, "Alt": 0x3A, "Control": 0x3B,
	"Meta": 0x37,

	// Arrow keys
	"ArrowLeft": 0x7B, "ArrowRight": 0x7C, "ArrowDown": 0x7D, "ArrowUp": 0x7E,

	// Function keys
	"F1": 0x7A, "F2": 0x78, "F3": 0x63, "F4": 0x76, "F5": 0x60,
	"F6": 0x61, "F7": 0x62, "F8": 0x64, "F9": 0x65, "F10": 0x6D,
	"F11": 0x67, "F12": 0x6F,

	// Navigation
	"Home": 0x73, "End": 0x77, "PageUp": 0x74, "PageDown": 0x79,
]

// MARK: - Constants

let socketPath = "/tmp/macstream-input.sock"

// Modifier bitmask values (must match protocol.ts MODIFIER_* constants)
let modifierShift = 1
let modifierCtrl = 2
let modifierAlt = 4
let modifierMeta = 8

// MARK: - Logging

func log(_ message: String) {
	fputs("[input-agent] \(message)\n", stderr)
}

// MARK: - Input Event Handlers

func handleKeyEvent(_ event: InputEvent) {
	guard let keyName = event.key, let isDown = event.down else {
		log("Invalid key event: missing key or down field")
		return
	}

	// Look up virtual keycode — try exact match first, then lowercase fallback
	guard let keyCode = keyMap[keyName] ?? keyMap[keyName.lowercased()] else {
		log("Unknown key: \(keyName)")
		return
	}

	guard
		let cgEvent = CGEvent(
			keyboardEventSource: nil,
			virtualKey: keyCode,
			keyDown: isDown
		)
	else {
		log("Failed to create keyboard CGEvent for key: \(keyName)")
		return
	}

	// Apply modifier flags from bitmask
	if let modifiers = event.modifiers, modifiers != 0 {
		var flags = CGEventFlags()
		if modifiers & modifierShift != 0 { flags.insert(.maskShift) }
		if modifiers & modifierCtrl != 0 { flags.insert(.maskControl) }
		if modifiers & modifierAlt != 0 { flags.insert(.maskAlternate) }
		if modifiers & modifierMeta != 0 { flags.insert(.maskCommand) }
		cgEvent.flags = flags
	}

	cgEvent.post(tap: .cghidEventTap)
}

func handleMouseMove(_ event: InputEvent) {
	guard let x = event.x, let y = event.y else {
		log("Invalid mouse_move event: missing x or y")
		return
	}

	let point = CGPoint(x: x, y: y)
	guard
		let cgEvent = CGEvent(
			mouseEventSource: nil,
			mouseType: .mouseMoved,
			mouseCursorPosition: point,
			mouseButton: .left
		)
	else {
		log("Failed to create mouse move CGEvent")
		return
	}

	cgEvent.post(tap: .cghidEventTap)
}

func handleMouseClick(_ event: InputEvent) {
	guard let buttonName = event.button,
		let x = event.x,
		let y = event.y,
		let isDown = event.down
	else {
		log("Invalid mouse_click event: missing fields")
		return
	}

	let point = CGPoint(x: x, y: y)

	let (downType, upType, button): (CGEventType, CGEventType, CGMouseButton) = {
		switch buttonName {
		case "right": return (.rightMouseDown, .rightMouseUp, .right)
		case "middle": return (.otherMouseDown, .otherMouseUp, .center)
		default: return (.leftMouseDown, .leftMouseUp, .left)
		}
	}()

	let eventType = isDown ? downType : upType

	guard
		let cgEvent = CGEvent(
			mouseEventSource: nil,
			mouseType: eventType,
			mouseCursorPosition: point,
			mouseButton: button
		)
	else {
		log("Failed to create mouse click CGEvent")
		return
	}

	cgEvent.post(tap: .cghidEventTap)
}

func handleScroll(_ event: InputEvent) {
	guard let deltaX = event.deltaX, let deltaY = event.deltaY else {
		log("Invalid scroll event: missing deltaX or deltaY")
		return
	}

	// Move cursor to scroll position if coordinates provided
	if let x = event.x, let y = event.y {
		let point = CGPoint(x: x, y: y)
		if let moveEvent = CGEvent(
			mouseEventSource: nil,
			mouseType: .mouseMoved,
			mouseCursorPosition: point,
			mouseButton: .left
		) {
			moveEvent.post(tap: .cghidEventTap)
		}
	}

	guard
		let scrollEvent = CGEvent(
			scrollWheelEvent2Source: nil,
			units: .pixel,
			wheelCount: 2,
			wheel1: Int32(deltaY),
			wheel2: Int32(deltaX)
		)
	else {
		log("Failed to create scroll CGEvent")
		return
	}

	scrollEvent.post(tap: .cghidEventTap)
}

func processEvent(_ event: InputEvent) {
	switch event.kind {
	case "key": handleKeyEvent(event)
	case "mouse_move": handleMouseMove(event)
	case "mouse_click": handleMouseClick(event)
	case "scroll": handleScroll(event)
	default: log("Unknown event kind: \(event.kind)")
	}
}

// MARK: - Unix Domain Socket Server

func startServer() {
	// Clean up stale socket file
	unlink(socketPath)

	// Create socket
	let fd = socket(AF_UNIX, SOCK_STREAM, 0)
	guard fd >= 0 else {
		log("Failed to create socket: \(String(cString: strerror(errno)))")
		exit(1)
	}

	// Bind to socket path
	var addr = sockaddr_un()
	addr.sun_family = sa_family_t(AF_UNIX)
	socketPath.withCString { cstr in
		withUnsafeMutableBytes(of: &addr.sun_path) { buf in
			let pathBuf = buf.baseAddress!.assumingMemoryBound(to: CChar.self)
			strncpy(pathBuf, cstr, buf.count - 1)
		}
	}

	let bindResult = withUnsafePointer(to: &addr) { ptr in
		ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
			bind(fd, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
		}
	}

	guard bindResult == 0 else {
		log("Failed to bind socket: \(String(cString: strerror(errno)))")
		close(fd)
		exit(1)
	}

	// Listen for connections (backlog of 5)
	guard listen(fd, 5) == 0 else {
		log("Failed to listen on socket: \(String(cString: strerror(errno)))")
		close(fd)
		exit(1)
	}

	log("Listening on \(socketPath)")

	// Clean shutdown on SIGTERM/SIGINT
	let cleanup: @convention(c) (Int32) -> Void = { _ in
		unlink(socketPath)
		exit(0)
	}
	signal(SIGTERM, cleanup)
	signal(SIGINT, cleanup)

	let decoder = JSONDecoder()

	// Accept loop
	while true {
		var clientAddr = sockaddr_un()
		var clientAddrLen = socklen_t(MemoryLayout<sockaddr_un>.size)

		let clientFd = withUnsafeMutablePointer(to: &clientAddr) { ptr in
			ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
				accept(fd, sockPtr, &clientAddrLen)
			}
		}

		guard clientFd >= 0 else {
			log("Failed to accept connection: \(String(cString: strerror(errno)))")
			continue
		}

		log("Client connected (fd=\(clientFd))")

		// Handle each client connection on a background thread
		DispatchQueue.global(qos: .userInteractive).async {
			handleClient(clientFd, decoder: decoder)
		}
	}
}

// MARK: - Client Connection Handler

func handleClient(_ fd: Int32, decoder: JSONDecoder) {
	var buffer = Data()
	let readSize = 4096
	let readBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: readSize)
	defer {
		readBuffer.deallocate()
		close(fd)
		log("Client disconnected (fd=\(fd))")
	}

	while true {
		let bytesRead = read(fd, readBuffer, readSize)

		if bytesRead <= 0 {
			// Connection closed or error
			break
		}

		buffer.append(readBuffer, count: bytesRead)

		// Process complete JSON lines (newline-delimited)
		while let newlineIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
			let lineData = buffer[buffer.startIndex..<newlineIndex]
			buffer = Data(buffer[buffer.index(after: newlineIndex)...])

			guard !lineData.isEmpty else { continue }

			do {
				let event = try decoder.decode(InputEvent.self, from: lineData)
				processEvent(event)
			} catch {
				log("Failed to parse event: \(error.localizedDescription)")
			}
		}
	}
}

// MARK: - Entry Point

startServer()
