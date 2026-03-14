import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	InputCapture,
	MODIFIER_ALT,
	MODIFIER_CTRL,
	MODIFIER_META,
	MODIFIER_SHIFT,
	POINTER_LOCK_START_X,
	POINTER_LOCK_START_Y,
	WHEEL_LISTENER_OPTIONS,
	buildModifierBitmask,
	clamp01,
	mapMouseButton,
	normalizeCoordinate,
} from '../src/client/input.js';

// ─── Mock Infrastructure ─────────────────────────────────────────────────────

type Listener = (event: unknown) => void;

interface MockCanvas {
	tabIndex: number;
	clientWidth: number;
	clientHeight: number;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
	requestPointerLock: ReturnType<typeof vi.fn>;
}

interface MockDocument {
	pointerLockElement: unknown;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
	exitPointerLock: ReturnType<typeof vi.fn>;
}

function createListenerRegistry() {
	const listeners = new Map<string, Listener[]>();

	const add = vi.fn((type: string, listener: Listener) => {
		const existing = listeners.get(type) ?? [];
		existing.push(listener);
		listeners.set(type, existing);
	});

	const remove = vi.fn((type: string, listener: Listener) => {
		const existing = listeners.get(type) ?? [];
		listeners.set(
			type,
			existing.filter((candidate) => candidate !== listener),
		);
	});

	const dispatch = (type: string, event: unknown) => {
		for (const listener of listeners.get(type) ?? []) {
			listener(event);
		}
	};

	const count = (type: string) => (listeners.get(type) ?? []).length;

	return { add, remove, dispatch, count };
}

function createMockDocument() {
	const registry = createListenerRegistry();
	const mockDocument: MockDocument = {
		pointerLockElement: null,
		addEventListener: registry.add,
		removeEventListener: registry.remove,
		exitPointerLock: vi.fn(),
	};

	return {
		mockDocument,
		dispatch: registry.dispatch,
		count: registry.count,
	};
}

function createMockCanvas() {
	const registry = createListenerRegistry();
	const mockCanvas: MockCanvas = {
		tabIndex: -1,
		clientWidth: 1000,
		clientHeight: 500,
		addEventListener: registry.add,
		removeEventListener: registry.remove,
		requestPointerLock: vi.fn(),
	};

	return {
		mockCanvas,
		dispatch: registry.dispatch,
		count: registry.count,
	};
}

function createKeyboardEvent(overrides: Partial<KeyboardEvent> = {}) {
	return {
		key: 'a',
		shiftKey: false,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		preventDefault: vi.fn(),
		...overrides,
	} as KeyboardEvent;
}

function createMouseEvent(overrides: Partial<MouseEvent> = {}) {
	return {
		button: 0,
		offsetX: 0,
		offsetY: 0,
		movementX: 0,
		movementY: 0,
		preventDefault: vi.fn(),
		...overrides,
	} as MouseEvent;
}

function createWheelEvent(overrides: Partial<WheelEvent> = {}) {
	return {
		deltaX: 0,
		deltaY: 0,
		offsetX: 0,
		offsetY: 0,
		preventDefault: vi.fn(),
		...overrides,
	} as WheelEvent;
}

function getSentEvent(sendInput: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
	return sendInput.mock.calls[index][0] as Record<string, unknown>;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('InputCapture', () => {
	let previousDocument: unknown;
	let mockDocument: MockDocument;
	let dispatchDocument: (type: string, event: unknown) => void;
	let countDocumentListeners: (type: string) => number;
	let mockCanvas: MockCanvas;
	let dispatchCanvas: (type: string, event: unknown) => void;
	let countCanvasListeners: (type: string) => number;
	let sendInput: ReturnType<typeof vi.fn>;
	let inputCapture: InputCapture;

	beforeEach(() => {
		const documentSetup = createMockDocument();
		mockDocument = documentSetup.mockDocument;
		dispatchDocument = documentSetup.dispatch;
		countDocumentListeners = documentSetup.count;

		const canvasSetup = createMockCanvas();
		mockCanvas = canvasSetup.mockCanvas;
		dispatchCanvas = canvasSetup.dispatch;
		countCanvasListeners = canvasSetup.count;

		previousDocument = (globalThis as Record<string, unknown>).document;
		(globalThis as Record<string, unknown>).document = mockDocument;

		sendInput = vi.fn();
		inputCapture = new InputCapture(mockCanvas as unknown as HTMLCanvasElement, (event) =>
			sendInput(event),
		);
	});

	afterEach(() => {
		inputCapture.dispose();
		(globalThis as Record<string, unknown>).document = previousDocument;
	});

	// ─── Utility Functions ───────────────────────────────────────────────

	describe('utility helpers', () => {
		it('clamp01 clamps values below range', () => {
			expect(clamp01(-0.25)).toBe(0);
		});

		it('clamp01 keeps values in range', () => {
			expect(clamp01(0.75)).toBe(0.75);
		});

		it('clamp01 clamps values above range', () => {
			expect(clamp01(2.5)).toBe(1);
		});

		it('normalizeCoordinate handles zero size', () => {
			expect(normalizeCoordinate(100, 0)).toBe(0);
		});

		it('normalizeCoordinate computes normalized value', () => {
			expect(normalizeCoordinate(250, 1000)).toBe(0.25);
		});

		it('normalizeCoordinate clamps values to [0,1]', () => {
			expect(normalizeCoordinate(-1, 1000)).toBe(0);
			expect(normalizeCoordinate(1001, 1000)).toBe(1);
		});

		it('buildModifierBitmask combines modifier flags', () => {
			const modifiers = buildModifierBitmask({
				shiftKey: true,
				ctrlKey: true,
				altKey: true,
				metaKey: true,
			} as KeyboardEvent);
			expect(modifiers).toBe(MODIFIER_SHIFT | MODIFIER_CTRL | MODIFIER_ALT | MODIFIER_META);
		});

		it('mapMouseButton maps supported button codes', () => {
			expect(mapMouseButton(0)).toBe('left');
			expect(mapMouseButton(1)).toBe('middle');
			expect(mapMouseButton(2)).toBe('right');
		});

		it('mapMouseButton returns null for unsupported button codes', () => {
			expect(mapMouseButton(3)).toBeNull();
		});
	});

	// ─── Lifecycle ───────────────────────────────────────────────────────

	describe('lifecycle', () => {
		it('makes canvas focusable in constructor', () => {
			expect(mockCanvas.tabIndex).toBe(0);
		});

		it('does not auto-enable in constructor', () => {
			expect(countCanvasListeners('keydown')).toBe(0);
		});

		it('enable attaches all expected listeners', () => {
			inputCapture.enable();

			expect(countCanvasListeners('keydown')).toBe(1);
			expect(countCanvasListeners('keyup')).toBe(1);
			expect(countCanvasListeners('mousemove')).toBe(1);
			expect(countCanvasListeners('mousedown')).toBe(1);
			expect(countCanvasListeners('mouseup')).toBe(1);
			expect(countCanvasListeners('wheel')).toBe(1);
			expect(countCanvasListeners('contextmenu')).toBe(1);
			expect(countCanvasListeners('click')).toBe(1);
			expect(countDocumentListeners('pointerlockchange')).toBe(1);
		});

		it('disable removes all listeners', () => {
			inputCapture.enable();
			inputCapture.disable();

			expect(countCanvasListeners('keydown')).toBe(0);
			expect(countCanvasListeners('keyup')).toBe(0);
			expect(countCanvasListeners('mousemove')).toBe(0);
			expect(countCanvasListeners('mousedown')).toBe(0);
			expect(countCanvasListeners('mouseup')).toBe(0);
			expect(countCanvasListeners('wheel')).toBe(0);
			expect(countCanvasListeners('contextmenu')).toBe(0);
			expect(countCanvasListeners('click')).toBe(0);
			expect(countDocumentListeners('pointerlockchange')).toBe(0);
		});

		it('enable is idempotent', () => {
			inputCapture.enable();
			inputCapture.enable();

			expect(mockCanvas.addEventListener).toHaveBeenCalledTimes(8);
			expect(mockDocument.addEventListener).toHaveBeenCalledTimes(1);
		});

		it('disable is idempotent', () => {
			inputCapture.disable();
			inputCapture.disable();

			expect(mockCanvas.removeEventListener).not.toHaveBeenCalled();
			expect(mockDocument.removeEventListener).not.toHaveBeenCalled();
		});

		it('dispose disables listeners', () => {
			inputCapture.enable();
			inputCapture.dispose();

			expect(countCanvasListeners('keydown')).toBe(0);
			expect(countDocumentListeners('pointerlockchange')).toBe(0);
		});

		it('does not send events while disabled', () => {
			dispatchCanvas('keydown', createKeyboardEvent({ key: 'x' }));
			expect(sendInput).not.toHaveBeenCalled();
		});
	});

	// ─── Keyboard ────────────────────────────────────────────────────────

	describe('keyboard capture', () => {
		beforeEach(() => {
			inputCapture.enable();
		});

		it('sends keydown event and prevents default', () => {
			const event = createKeyboardEvent({ key: 'Enter', ctrlKey: true });

			dispatchCanvas('keydown', event);

			expect(event.preventDefault).toHaveBeenCalledOnce();
			expect(getSentEvent(sendInput)).toEqual({
				kind: 'key',
				key: 'Enter',
				modifiers: MODIFIER_CTRL,
				down: true,
			});
		});

		it('sends keyup event and prevents default', () => {
			const event = createKeyboardEvent({ key: 'Enter', shiftKey: true });

			dispatchCanvas('keyup', event);

			expect(event.preventDefault).toHaveBeenCalledOnce();
			expect(getSentEvent(sendInput)).toEqual({
				kind: 'key',
				key: 'Enter',
				modifiers: MODIFIER_SHIFT,
				down: false,
			});
		});

		it('computes no-modifier bitmask as 0', () => {
			dispatchCanvas('keydown', createKeyboardEvent());
			expect(getSentEvent(sendInput).modifiers).toBe(0);
		});

		it('computes single modifier bitmasks correctly', () => {
			dispatchCanvas('keydown', createKeyboardEvent({ shiftKey: true }));
			dispatchCanvas('keydown', createKeyboardEvent({ ctrlKey: true }));
			dispatchCanvas('keydown', createKeyboardEvent({ altKey: true }));
			dispatchCanvas('keydown', createKeyboardEvent({ metaKey: true }));

			expect(getSentEvent(sendInput, 0).modifiers).toBe(MODIFIER_SHIFT);
			expect(getSentEvent(sendInput, 1).modifiers).toBe(MODIFIER_CTRL);
			expect(getSentEvent(sendInput, 2).modifiers).toBe(MODIFIER_ALT);
			expect(getSentEvent(sendInput, 3).modifiers).toBe(MODIFIER_META);
		});

		it('computes combined modifier bitmask correctly', () => {
			dispatchCanvas(
				'keydown',
				createKeyboardEvent({
					shiftKey: true,
					ctrlKey: true,
					altKey: true,
					metaKey: true,
				}),
			);

			expect(getSentEvent(sendInput).modifiers).toBe(15);
		});

		it('triggers clipboard copy callback on Ctrl+C and still forwards event', () => {
			const onCopy = vi.fn();
			inputCapture.onClipboardCopy = onCopy;

			dispatchCanvas('keydown', createKeyboardEvent({ key: 'c', ctrlKey: true }));

			expect(onCopy).toHaveBeenCalledOnce();
			expect(sendInput).toHaveBeenCalledOnce();
		});

		it('triggers clipboard copy callback for uppercase C', () => {
			const onCopy = vi.fn();
			inputCapture.onClipboardCopy = onCopy;

			dispatchCanvas('keydown', createKeyboardEvent({ key: 'C', ctrlKey: true }));

			expect(onCopy).toHaveBeenCalledOnce();
		});

		it('triggers clipboard paste callback on Ctrl+V and still forwards event', () => {
			const onPaste = vi.fn();
			inputCapture.onClipboardPaste = onPaste;

			dispatchCanvas('keydown', createKeyboardEvent({ key: 'v', ctrlKey: true }));

			expect(onPaste).toHaveBeenCalledOnce();
			expect(sendInput).toHaveBeenCalledOnce();
		});

		it('does not trigger clipboard callback without Ctrl modifier', () => {
			const onCopy = vi.fn();
			inputCapture.onClipboardCopy = onCopy;

			dispatchCanvas('keydown', createKeyboardEvent({ key: 'c' }));

			expect(onCopy).not.toHaveBeenCalled();
		});

		it('does not trigger clipboard callback on keyup', () => {
			const onCopy = vi.fn();
			inputCapture.onClipboardCopy = onCopy;

			dispatchCanvas('keyup', createKeyboardEvent({ key: 'c', ctrlKey: true }));

			expect(onCopy).not.toHaveBeenCalled();
		});
	});

	// ─── Mouse Move ──────────────────────────────────────────────────────

	describe('mouse move capture', () => {
		beforeEach(() => {
			inputCapture.enable();
		});

		it('normalizes origin coordinates', () => {
			dispatchCanvas('mousemove', createMouseEvent({ offsetX: 0, offsetY: 0 }));

			expect(getSentEvent(sendInput)).toEqual({ kind: 'mouse_move', x: 0, y: 0 });
		});

		it('normalizes maximum coordinates', () => {
			dispatchCanvas('mousemove', createMouseEvent({ offsetX: 1000, offsetY: 500 }));

			expect(getSentEvent(sendInput)).toEqual({ kind: 'mouse_move', x: 1, y: 1 });
		});

		it('clamps out-of-bounds coordinates', () => {
			dispatchCanvas('mousemove', createMouseEvent({ offsetX: -50, offsetY: 750 }));

			expect(getSentEvent(sendInput)).toEqual({ kind: 'mouse_move', x: 0, y: 1 });
		});

		it('uses movement deltas while pointer is locked', () => {
			mockDocument.pointerLockElement = mockCanvas;
			dispatchDocument('pointerlockchange', {});

			dispatchCanvas('mousemove', createMouseEvent({ movementX: 100, movementY: -50 }));

			expect(getSentEvent(sendInput)).toEqual({
				kind: 'mouse_move',
				x: POINTER_LOCK_START_X + 0.1,
				y: POINTER_LOCK_START_Y - 0.1,
			});
		});

		it('clamps locked cursor movement to bounds', () => {
			mockDocument.pointerLockElement = mockCanvas;
			dispatchDocument('pointerlockchange', {});

			dispatchCanvas('mousemove', createMouseEvent({ movementX: 5000, movementY: -5000 }));

			expect(getSentEvent(sendInput)).toEqual({ kind: 'mouse_move', x: 1, y: 0 });
		});
	});

	// ─── Mouse Click ─────────────────────────────────────────────────────

	describe('mouse click capture', () => {
		beforeEach(() => {
			inputCapture.enable();
		});

		it('maps mousedown left button and includes normalized coordinates', () => {
			dispatchCanvas('mousedown', createMouseEvent({ button: 0, offsetX: 250, offsetY: 250 }));

			expect(getSentEvent(sendInput)).toEqual({
				kind: 'mouse_click',
				button: 'left',
				x: 0.25,
				y: 0.5,
				down: true,
			});
		});

		it('maps mouseup right button and includes normalized coordinates', () => {
			dispatchCanvas('mouseup', createMouseEvent({ button: 2, offsetX: 800, offsetY: 125 }));

			expect(getSentEvent(sendInput)).toEqual({
				kind: 'mouse_click',
				button: 'right',
				x: 0.8,
				y: 0.25,
				down: false,
			});
		});

		it('maps middle button correctly', () => {
			dispatchCanvas('mousedown', createMouseEvent({ button: 1 }));
			expect(getSentEvent(sendInput).button).toBe('middle');
		});

		it('ignores unsupported mouse buttons', () => {
			dispatchCanvas('mousedown', createMouseEvent({ button: 4 }));
			expect(sendInput).not.toHaveBeenCalled();
		});

		it('suppresses context menu', () => {
			const event = createMouseEvent();

			dispatchCanvas('contextmenu', event);

			expect(event.preventDefault).toHaveBeenCalledOnce();
		});

		it('requests pointer lock on canvas click', () => {
			dispatchCanvas('click', createMouseEvent());

			expect(mockCanvas.requestPointerLock).toHaveBeenCalledOnce();
		});
	});

	// ─── Scroll ──────────────────────────────────────────────────────────

	describe('scroll capture', () => {
		beforeEach(() => {
			inputCapture.enable();
		});

		it('registers wheel listener with passive false options', () => {
			expect(mockCanvas.addEventListener).toHaveBeenCalledWith(
				'wheel',
				expect.any(Function),
				WHEEL_LISTENER_OPTIONS,
			);
		});

		it('sends scroll payload with deltas and normalized coordinates', () => {
			const event = createWheelEvent({
				deltaX: 2,
				deltaY: -3,
				offsetX: 500,
				offsetY: 250,
			});

			dispatchCanvas('wheel', event);

			expect(event.preventDefault).toHaveBeenCalledOnce();
			expect(getSentEvent(sendInput)).toEqual({
				kind: 'scroll',
				deltaX: 2,
				deltaY: -3,
				x: 0.5,
				y: 0.5,
			});
		});

		it('uses virtual locked position for scroll coordinates', () => {
			mockDocument.pointerLockElement = mockCanvas;
			dispatchDocument('pointerlockchange', {});
			dispatchCanvas('mousemove', createMouseEvent({ movementX: 100, movementY: 50 }));

			dispatchCanvas('wheel', createWheelEvent({ deltaX: 1, deltaY: 1, offsetX: 0, offsetY: 0 }));

			expect(getSentEvent(sendInput, 1)).toMatchObject({
				kind: 'scroll',
				x: 0.6,
				y: 0.6,
			});
		});
	});

	// ─── Pointer Lock ────────────────────────────────────────────────────

	describe('pointer lock', () => {
		beforeEach(() => {
			inputCapture.enable();
		});

		it('requestPointerLock delegates to canvas', () => {
			inputCapture.requestPointerLock();
			expect(mockCanvas.requestPointerLock).toHaveBeenCalledOnce();
		});

		it('exitPointerLock delegates to document', () => {
			inputCapture.exitPointerLock();
			expect(mockDocument.exitPointerLock).toHaveBeenCalledOnce();
		});

		it('isLocked returns false when document lock element differs', () => {
			mockDocument.pointerLockElement = null;
			expect(inputCapture.isLocked).toBe(false);
		});

		it('isLocked returns true when canvas is lock element', () => {
			mockDocument.pointerLockElement = mockCanvas;
			expect(inputCapture.isLocked).toBe(true);
		});

		it('resets virtual cursor to center on lock acquire', () => {
			dispatchCanvas('mousemove', createMouseEvent({ offsetX: 1000, offsetY: 0 }));
			mockDocument.pointerLockElement = mockCanvas;
			dispatchDocument('pointerlockchange', {});
			dispatchCanvas('mousemove', createMouseEvent({ movementX: 0, movementY: 0 }));

			expect(getSentEvent(sendInput, 1)).toEqual({
				kind: 'mouse_move',
				x: POINTER_LOCK_START_X,
				y: POINTER_LOCK_START_Y,
			});
		});
	});

	// ─── Re-enable Flow ──────────────────────────────────────────────────

	describe('re-enable flow', () => {
		it('captures events again after disable + enable', () => {
			inputCapture.enable();
			inputCapture.disable();
			inputCapture.enable();

			dispatchCanvas('keydown', createKeyboardEvent({ key: 'x' }));

			expect(sendInput).toHaveBeenCalledOnce();
			expect(getSentEvent(sendInput)).toMatchObject({ kind: 'key', key: 'x' });
		});
	});
});
