import type {
	InputEventData,
	KeyboardInputEvent,
	MouseClickInputEvent,
	MouseMoveInputEvent,
	ScrollInputEvent,
} from '../shared/protocol.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MODIFIER_SHIFT = 1;
export const MODIFIER_CTRL = 2;
export const MODIFIER_ALT = 4;
export const MODIFIER_META = 8;

export const POINTER_LOCK_START_X = 0.5;
export const POINTER_LOCK_START_Y = 0.5;

export const WHEEL_LISTENER_OPTIONS: AddEventListenerOptions = {
	passive: false,
};

// ─── Utility Functions ───────────────────────────────────────────────────────

export function clamp01(value: number): number {
	if (value < 0) {
		return 0;
	}

	if (value > 1) {
		return 1;
	}

	return value;
}

export function normalizeCoordinate(offset: number, size: number): number {
	if (size <= 0) {
		return 0;
	}

	return clamp01(offset / size);
}

export function mapMouseButton(button: number): MouseClickInputEvent['button'] | null {
	if (button === 0) {
		return 'left';
	}

	if (button === 1) {
		return 'middle';
	}

	if (button === 2) {
		return 'right';
	}

	return null;
}

export function buildModifierBitmask(event: KeyboardEvent): number {
	let modifiers = 0;

	if (event.shiftKey) {
		modifiers |= MODIFIER_SHIFT;
	}

	if (event.ctrlKey) {
		modifiers |= MODIFIER_CTRL;
	}

	if (event.altKey) {
		modifiers |= MODIFIER_ALT;
	}

	if (event.metaKey) {
		modifiers |= MODIFIER_META;
	}

	return modifiers;
}

// ─── Input Capture ───────────────────────────────────────────────────────────

export class InputCapture {
	public onClipboardCopy: (() => void) | null = null;
	public onClipboardPaste: (() => void) | null = null;

	private readonly canvas: HTMLCanvasElement;
	private readonly sendInput: (event: Record<string, unknown>) => void;
	private enabled = false;
	private pointerLocked = false;
	private virtualX = POINTER_LOCK_START_X;
	private virtualY = POINTER_LOCK_START_Y;

	constructor(canvas: HTMLCanvasElement, sendInput: (event: Record<string, unknown>) => void) {
		this.canvas = canvas;
		this.sendInput = sendInput;
		this.canvas.tabIndex = 0;
	}

	get isLocked(): boolean {
		return document.pointerLockElement === this.canvas;
	}

	requestPointerLock(): void {
		this.canvas.requestPointerLock();
	}

	exitPointerLock(): void {
		document.exitPointerLock();
	}

	enable(): void {
		if (this.enabled) {
			return;
		}

		this.enabled = true;
		this.pointerLocked = this.isLocked;

		this.canvas.addEventListener('keydown', this.handleKeyDown);
		this.canvas.addEventListener('keyup', this.handleKeyUp);
		this.canvas.addEventListener('mousemove', this.handleMouseMove);
		this.canvas.addEventListener('mousedown', this.handleMouseDown);
		this.canvas.addEventListener('mouseup', this.handleMouseUp);
		this.canvas.addEventListener('wheel', this.handleWheel, WHEEL_LISTENER_OPTIONS);
		this.canvas.addEventListener('contextmenu', this.handleContextMenu);
		this.canvas.addEventListener('click', this.handleClick);
		document.addEventListener('pointerlockchange', this.handlePointerLockChange);
	}

	disable(): void {
		if (!this.enabled) {
			return;
		}

		this.enabled = false;

		this.canvas.removeEventListener('keydown', this.handleKeyDown);
		this.canvas.removeEventListener('keyup', this.handleKeyUp);
		this.canvas.removeEventListener('mousemove', this.handleMouseMove);
		this.canvas.removeEventListener('mousedown', this.handleMouseDown);
		this.canvas.removeEventListener('mouseup', this.handleMouseUp);
		this.canvas.removeEventListener('wheel', this.handleWheel, WHEEL_LISTENER_OPTIONS);
		this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
		this.canvas.removeEventListener('click', this.handleClick);
		document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
	}

	dispose(): void {
		this.disable();
	}

	private handleKeyDown = (event: KeyboardEvent): void => {
		event.preventDefault();

		const keyEvent: KeyboardInputEvent = {
			kind: 'key',
			key: event.key,
			modifiers: buildModifierBitmask(event),
			down: true,
		};

		this.handleClipboardShortcut(event);
		this.emitInput(keyEvent);
	};

	private handleKeyUp = (event: KeyboardEvent): void => {
		event.preventDefault();

		const keyEvent: KeyboardInputEvent = {
			kind: 'key',
			key: event.key,
			modifiers: buildModifierBitmask(event),
			down: false,
		};

		this.emitInput(keyEvent);
	};

	private handleMouseMove = (event: MouseEvent): void => {
		const position = this.getMousePosition(event);

		const moveEvent: MouseMoveInputEvent = {
			kind: 'mouse_move',
			x: position.x,
			y: position.y,
		};

		this.emitInput(moveEvent);
	};

	private handleMouseDown = (event: MouseEvent): void => {
		this.emitMouseClick(event, true);
	};

	private handleMouseUp = (event: MouseEvent): void => {
		this.emitMouseClick(event, false);
	};

	private handleWheel = (event: WheelEvent): void => {
		event.preventDefault();
		const position = this.getWheelPosition(event);

		const scrollEvent: ScrollInputEvent = {
			kind: 'scroll',
			deltaX: event.deltaX,
			deltaY: event.deltaY,
			x: position.x,
			y: position.y,
		};

		this.emitInput(scrollEvent);
	};

	private handleContextMenu = (event: MouseEvent): void => {
		event.preventDefault();
	};

	private handleClick = (): void => {
		this.requestPointerLock();
	};

	private handlePointerLockChange = (): void => {
		this.pointerLocked = this.isLocked;
		if (this.pointerLocked) {
			this.virtualX = POINTER_LOCK_START_X;
			this.virtualY = POINTER_LOCK_START_Y;
		}
	};

	private handleClipboardShortcut(event: KeyboardEvent): void {
		if (!event.ctrlKey) {
			return;
		}

		const key = event.key.toLowerCase();
		if (key === 'c') {
			this.onClipboardCopy?.();
		}

		if (key === 'v') {
			this.onClipboardPaste?.();
		}
	}

	private emitMouseClick(event: MouseEvent, down: boolean): void {
		const button = mapMouseButton(event.button);
		if (!button) {
			return;
		}

		const position = this.getMousePosition(event);
		const clickEvent: MouseClickInputEvent = {
			kind: 'mouse_click',
			button,
			x: position.x,
			y: position.y,
			down,
		};

		this.emitInput(clickEvent);
	}

	private emitInput(event: InputEventData): void {
		this.sendInput({ ...event });
	}

	private getMousePosition(event: MouseEvent): { x: number; y: number } {
		if (this.pointerLocked) {
			const deltaX = this.canvas.clientWidth > 0 ? event.movementX / this.canvas.clientWidth : 0;
			const deltaY = this.canvas.clientHeight > 0 ? event.movementY / this.canvas.clientHeight : 0;
			const nextX = clamp01(this.virtualX + deltaX);
			const nextY = clamp01(this.virtualY + deltaY);
			this.virtualX = nextX;
			this.virtualY = nextY;
			return { x: nextX, y: nextY };
		}

		return {
			x: normalizeCoordinate(event.offsetX, this.canvas.clientWidth),
			y: normalizeCoordinate(event.offsetY, this.canvas.clientHeight),
		};
	}

	private getWheelPosition(event: WheelEvent): { x: number; y: number } {
		if (this.pointerLocked) {
			return { x: this.virtualX, y: this.virtualY };
		}

		return {
			x: normalizeCoordinate(event.offsetX, this.canvas.clientWidth),
			y: normalizeCoordinate(event.offsetY, this.canvas.clientHeight),
		};
	}
}
