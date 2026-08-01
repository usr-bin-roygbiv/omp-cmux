import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
const script = resolve(import.meta.dir, "../scripts/sync-compatibility-mirror.sh");

function run(cwd: string, argv: string[], success = true): string {
	const result = Bun.spawnSync(argv, {
		cwd,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (success) expect(result.exitCode, `${argv.join(" ")}\n${stdout}\n${stderr}`).toBe(0);
	else expect(result.exitCode).not.toBe(0);
	return `${stdout}${stderr}`;
}

function configureAuthor(cwd: string): void {
	run(cwd, ["git", "config", "user.name", "Compatibility Test"]);
	run(cwd, ["git", "config", "user.email", "compatibility.invalid"]);
	run(cwd, ["git", "config", "commit.gpgsign", "false"]);
	run(cwd, ["git", "config", "tag.gpgsign", "false"]);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("compatibility mirror synchronization", () => {
	test("fast-forwards main with release tags and rejects a diverged mirror", () => {
		const root = mkdtempSync(join(tmpdir(), "omp-cmux-mirror-"));
		roots.push(root);
		const publicBare = join(root, "public.git");
		const mirrorBare = join(root, "mirror.git");
		const author = join(root, "author");
		const maintainer = join(root, "maintainer");
		const mirrorAuthor = join(root, "mirror-author");

		run(root, ["git", "init", "--bare", "--initial-branch=main", publicBare]);
		run(root, ["git", "init", "--bare", "--initial-branch=main", mirrorBare]);
		run(root, ["git", "clone", publicBare, author]);
		configureAuthor(author);
		writeFileSync(join(author, "release.txt"), "v0.2.0\n");
		run(author, ["git", "add", "release.txt"]);
		run(author, ["git", "commit", "-m", "release"]);
		run(author, ["git", "tag", "-a", "v0.2.0", "-m", "v0.2.0"]);
		run(author, ["git", "push", "origin", "main", "v0.2.0"]);

		run(root, ["git", "clone", publicBare, maintainer]);
		run(maintainer, ["git", "remote", "add", "compatibility", mirrorBare]);
		run(maintainer, ["bash", script, "compatibility"]);
		const publicMain = run(root, ["git", "--git-dir", publicBare, "rev-parse", "refs/heads/main"]).trim();
		expect(run(root, ["git", "--git-dir", mirrorBare, "rev-parse", "refs/heads/main"]).trim()).toBe(publicMain);
		expect(run(root, ["git", "--git-dir", mirrorBare, "rev-parse", "refs/tags/v0.2.0"]).trim()).toBe(
			run(root, ["git", "--git-dir", publicBare, "rev-parse", "refs/tags/v0.2.0"]).trim(),
		);

		run(root, ["git", "clone", mirrorBare, mirrorAuthor]);
		configureAuthor(mirrorAuthor);
		writeFileSync(join(mirrorAuthor, "mirror-only.txt"), "diverged\n");
		run(mirrorAuthor, ["git", "add", "mirror-only.txt"]);
		run(mirrorAuthor, ["git", "commit", "-m", "mirror divergence"]);
		run(mirrorAuthor, ["git", "push", "origin", "main"]);
		writeFileSync(join(author, "public-only.txt"), "new public commit\n");
		run(author, ["git", "add", "public-only.txt"]);
		run(author, ["git", "commit", "-m", "public update"]);
		run(author, ["git", "push", "origin", "main"]);

		const failure = run(maintainer, ["bash", script, "compatibility"], false);
		expect(failure).toContain("mirror main has diverged from public main");
	});
});
