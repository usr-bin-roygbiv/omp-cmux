function literals(values: readonly string[]) {
	return { anyOf: values.map(value => ({ const: value })) };
}

const timeout = { type: "integer", minimum: 1, maximum: 300_000 };
const kvmTarget = literals(["zacs-mbp-1", "linkedin-mac", "zacs-mbp", "remote-mac", "faro-laptop"]);
const remoteMacTarget = literals(["zacs-mbp-1", "zacs-mbp-2", "zacs-mbp-3"]);

export const KvmInventorySchema = {
	type: "object",
	properties: { timeout_ms: timeout },
	additionalProperties: false,
} as const;

export const KvmDeviceSchema = {
	type: "object",
	properties: {
		target: kvmTarget,
		action: literals(["check", "ping", "id", "video", "wake"]),
		mac: { type: "string", pattern: "^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$" },
		timeout_ms: timeout,
	},
	required: ["target", "action"],
	additionalProperties: false,
} as const;

export const KvmCaptureSchema = {
	type: "object",
	properties: {
		target: kvmTarget,
		output: { type: "string", minLength: 1, maxLength: 4_096, pattern: "^/" },
		timeout_ms: timeout,
	},
	required: ["target", "output"],
	additionalProperties: false,
} as const;

export const KvmInputSchema = {
	type: "object",
	properties: {
		target: kvmTarget,
		action: literals(["key", "combo", "text", "mouse-move", "click", "double-click", "scroll"]),
		key: { type: "string", minLength: 1, maxLength: 64 },
		keys: { type: "array", items: { type: "string", minLength: 1, maxLength: 64 }, minItems: 2, maxItems: 6 },
		text: { type: "string", minLength: 1, maxLength: 100_000 },
		x: { type: "integer", minimum: 0, maximum: 65_535 },
		y: { type: "integer", minimum: 0, maximum: 65_535 },
		button: literals(["left", "right"]),
		delta: { type: "integer", minimum: -65_535, maximum: 65_535 },
		timeout_ms: timeout,
	},
	required: ["target", "action"],
	additionalProperties: false,
} as const;

export const KvmStorageSchema = {
	type: "object",
	properties: {
		target: kvmTarget,
		action: literals(["list", "space", "mount-local", "mount-url", "unmount"]),
		value: { type: "string", minLength: 1, maxLength: 8_192 },
		timeout_ms: timeout,
	},
	required: ["target", "action"],
	additionalProperties: false,
} as const;

export const KvmRemoteMacSchema = {
	type: "object",
	properties: {
		target: remoteMacTarget,
		action: literals(["status", "jxa"]),
		script: { type: "string", minLength: 1, maxLength: 1_048_576 },
		argument: { type: "string", maxLength: 100_000 },
		timeout_ms: timeout,
	},
	required: ["target", "action"],
	additionalProperties: false,
} as const;

export type KvmInventoryInput = { timeout_ms?: number };
export type KvmDeviceInput = { target: string; action: "check" | "ping" | "id" | "video" | "wake"; mac?: string; timeout_ms?: number };
export type KvmCaptureInput = { target: string; output: string; timeout_ms?: number };
export type KvmInputInput = {
	target: string;
	action: "key" | "combo" | "text" | "mouse-move" | "click" | "double-click" | "scroll";
	key?: string;
	keys?: string[];
	text?: string;
	x?: number;
	y?: number;
	button?: "left" | "right";
	delta?: number;
	timeout_ms?: number;
};
export type KvmStorageInput = { target: string; action: "list" | "space" | "mount-local" | "mount-url" | "unmount"; value?: string; timeout_ms?: number };
export type KvmRemoteMacInput = { target: string; action: "status" | "jxa"; script?: string; argument?: string; timeout_ms?: number };
