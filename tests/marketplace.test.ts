import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const allowedProjectOwner = "usr-bin-roygbiv";

async function readJson(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function repositoryTextFiles(directory = repositoryRoot): Promise<string[]> {
	const ignoredDirectories = new Set([".git", "node_modules", "coverage", "dist"]);
	const textExtensions = new Set([".ts", ".tsx", ".js", ".json", ".md", ".txt", ".yml", ".yaml", ".toml", ".lock", ""]);
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) files.push(...(await repositoryTextFiles(join(directory, entry.name))));
			continue;
		}
		if (entry.isFile() && !ignoredDirectories.has(entry.name) && textExtensions.has(extname(entry.name))) {
			files.push(join(directory, entry.name));
		}
	}
	return files;
}

function collectIdentityNames(value: unknown, names: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) collectIdentityNames(item, names);
		return names;
	}
	if (!value || typeof value !== "object") return names;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if ((key === "author" || key === "owner") && typeof child === "string") names.push(child);
		if ((key === "author" || key === "owner") && child && typeof child === "object") {
			const name = (child as Record<string, unknown>).name;
			if (typeof name === "string") names.push(name);
		}
		collectIdentityNames(child, names);
	}
	return names;
}

describe("marketplace discovery", () => {
	test("catalog points to a loadable local OMP extension package", async () => {
		const catalogPath = join(repositoryRoot, ".claude-plugin", "marketplace.json");
		const catalog = await readJson(catalogPath);
		const plugins = catalog.plugins as Array<Record<string, unknown>>;
		expect(catalog.name).toBe("omp-cmux");
		expect(plugins).toHaveLength(1);
		expect(plugins[0]).toMatchObject({ name: "cmux", source: "./plugins/cmux", strict: true });

		const pluginRoot = join(repositoryRoot, String(plugins[0]!.source));
		expect((await stat(pluginRoot)).isDirectory()).toBe(true);
		const packageJson = await readJson(join(pluginRoot, "package.json"));
		const omp = packageJson.omp as Record<string, unknown>;
		expect(packageJson.name).toBe("omp-cmux");
		expect(packageJson.peerDependencies).toMatchObject({ "@oh-my-pi/pi-coding-agent": ">=14.7.3 <18" });
		expect(omp.extensions).toEqual(["./index.ts"]);

		const entrypoint = join(pluginRoot, "index.ts");
		expect((await stat(entrypoint)).isFile()).toBe(true);
		const loaded = (await import(pathToFileURL(entrypoint).href)) as { default?: unknown };
		expect(typeof loaded.default).toBe("function");
	});

	test("repository root activates the extension for direct Git installs", async () => {
		const rootPackage = await readJson(join(repositoryRoot, "package.json"));
		const rootOmp = rootPackage.omp as Record<string, unknown>;
		expect(rootOmp.extensions).toEqual(["./plugins/cmux/index.ts"]);

		const extensionPackage = await readJson(join(repositoryRoot, "plugins", "cmux", "package.json"));
		expect(extensionPackage.dependencies).toBeUndefined();
	});

	test("links the repository root so development cannot activate a duplicate extension package", async () => {
		const readme = await readFile(join(repositoryRoot, "README.md"), "utf8");
		expect(readme).toContain("omp plugin link .");
		expect(readme).not.toContain("omp plugin link ./plugins/cmux");
	});

	test("publishes one matching release version across manifests", async () => {
		const root = await readJson(join(repositoryRoot, "package.json"));
		const plugin = await readJson(join(repositoryRoot, "plugins", "cmux", "package.json"));
		const catalog = await readJson(join(repositoryRoot, ".claude-plugin", "marketplace.json"));
		const catalogPlugins = catalog.plugins as Array<Record<string, unknown>>;
		expect([root.version, (root.omp as Record<string, unknown>).version, plugin.version, (plugin.omp as Record<string, unknown>).version, (catalog.metadata as Record<string, unknown>).version, catalogPlugins[0]?.version]).toEqual([
			"0.2.0", "0.2.0", "0.2.0", "0.2.0", "0.2.0", "0.2.0",
		]);
	});

	test("uses only the intended public project owner in marketplace identity fields", async () => {
		const manifests = await Promise.all([
			readJson(join(repositoryRoot, "package.json")),
			readJson(join(repositoryRoot, "plugins", "cmux", "package.json")),
			readJson(join(repositoryRoot, ".claude-plugin", "marketplace.json")),
		]);
		const identities = manifests.flatMap(manifest => collectIdentityNames(manifest));
		expect(identities.length).toBeGreaterThan(0);
		expect(new Set(identities)).toEqual(new Set([allowedProjectOwner]));
	});
});

describe("repository privacy policy", () => {
	test("contains no personal home paths, email addresses, private keys, or credential-shaped values", async () => {
		const patterns: Array<{ label: string; expression: RegExp }> = [
			{
				label: "POSIX personal home path",
				expression: new RegExp(["/", "home", "/[a-z_][a-z0-9_-]*/"].join(""), "i"),
			},
			{
				label: "macOS personal home path",
				expression: new RegExp(["/", "Users", "/[^/\\s]+/"].join("")),
			},
			{
				label: "Windows personal home path",
				expression: new RegExp(["[A-Z]:\\\\", "Users", "\\\\[^\\\\\\s]+\\\\"].join(""), "i"),
			},
			{
				label: "email address",
				expression: new RegExp(["[a-z0-9.!#$%&'*+/=?^_`{|}~-]+", "@", "[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}"].join(""), "i"),
			},
			{
				label: "private key material",
				expression: new RegExp(["-{5}BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY", "-{5}"].join("")),
			},
			{
				label: "cloud access key",
				expression: new RegExp(["AK", "IA[0-9A-Z]{16}"].join("")),
			},
			{
				label: "Git hosting token",
				expression: new RegExp(["gh", "[pousr]_[A-Za-z0-9]{20,}"].join("")),
			},
			{
				label: "chat service token",
				expression: new RegExp(["xo", "x[baprs]-[A-Za-z0-9-]{16,}"].join("")),
			},
			{
				label: "payment or AI bearer token",
				expression: new RegExp(["s", "k-(?:live|proj)-[A-Za-z0-9_-]{16,}"].join("")),
			},
		];

		const violations: string[] = [];
		for (const path of await repositoryTextFiles()) {
			const content = await readFile(path, "utf8");
			for (const { label, expression } of patterns) {
				if (expression.test(content)) violations.push(`${relative(repositoryRoot, path)}: ${label}`);
			}
		}
		expect(violations).toEqual([]);
	});
});
