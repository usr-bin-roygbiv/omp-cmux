const OPTIONAL = Symbol("cmux-schema-optional");
declare const STATIC: unique symbol;

export type Schema<T = unknown> = Record<string, unknown> & { readonly [STATIC]: T };
type OptionalSchema<T> = Schema<T> & { readonly [OPTIONAL]: true };
type Properties = Record<string, Schema<unknown>>;
type OptionalKeys<T extends Properties> = {
	[K in keyof T]: T[K] extends OptionalSchema<unknown> ? K : never;
}[keyof T];
type RequiredKeys<T extends Properties> = Exclude<keyof T, OptionalKeys<T>>;
type ObjectValue<T extends Properties> = {
	[K in RequiredKeys<T>]: Static<T[K]>;
} & {
	[K in OptionalKeys<T>]?: Static<T[K]>;
};

export type Static<T extends Schema<unknown>> = T extends Schema<infer TValue> ? TValue : never;

function schema<T>(value: Record<string, unknown>): Schema<T> {
	return value as Schema<T>;
}

function string(options: Record<string, unknown> = {}): Schema<string> {
	return schema({ type: "string", ...options });
}

function integer(options: Record<string, unknown> = {}): Schema<number> {
	return schema({ type: "integer", ...options });
}

function number(options: Record<string, unknown> = {}): Schema<number> {
	return schema({ type: "number", ...options });
}

function boolean(): Schema<boolean> {
	return schema({ type: "boolean" });
}

function unknown(): Schema<unknown> {
	return schema({});
}

function literal<const TValue extends string | number | boolean | null>(value: TValue): Schema<TValue> {
	return schema({ const: value, type: value === null ? "null" : typeof value });
}

function optional<TValue>(value: Schema<TValue>): OptionalSchema<TValue> {
	return Object.assign({}, value, { [OPTIONAL]: true }) as OptionalSchema<TValue>;
}

function array<TValue>(items: Schema<TValue>, options: Record<string, unknown> = {}): Schema<TValue[]> {
	return schema({ type: "array", items, ...options });
}

function union<const TItems extends readonly Schema<unknown>[]>(items: TItems): Schema<Static<TItems[number]>> {
	return schema({ anyOf: items });
}

function record<TKey extends Schema<string>, TValue>(
	_key: TKey,
	value: Schema<TValue>,
): Schema<Record<string, TValue>> {
	return schema({ type: "object", additionalProperties: value });
}

function object<const TProperties extends Properties>(
	properties: TProperties,
	options: Record<string, unknown> = {},
): Schema<ObjectValue<TProperties>> {
	const required = Object.entries(properties)
		.filter(([, value]) => !(OPTIONAL in value))
		.map(([name]) => name);
	return schema({
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
		...options,
	});
}

/** Minimal JSON Schema builders used to keep marketplace installs dependency-free. */
export const Type = {
	Array: array,
	Boolean: boolean,
	Integer: integer,
	Literal: literal,
	Number: number,
	Object: object,
	Optional: optional,
	Record: record,
	String: string,
	Union: union,
	Unknown: unknown,
} as const;
