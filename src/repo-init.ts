import { type Remote, Workspace } from "./git";
import { fail } from "./errors";

// A new repo's first commit: a README, a .gitignore for its toolchain, and a license. A repo with no commit has
// no branch, so agents would have nothing to branch from.

export type GitignoreTemplate = "node" | "python" | "go" | "rust";
export type LicenseTemplate = "mit";

/** What each toolchain builds or installs, kept out of commits (and out of agents' claims). */
export const GITIGNORE: Record<GitignoreTemplate, string> = {
	node: `# Dependencies and build output
node_modules/
dist/
build/
coverage/
.cache/

# Logs and local settings
*.log
npm-debug.log*
.env
.env.*
!.env.example
.DS_Store
`,
	python: `# Virtual environments, caches and build output
.venv/
venv/
__pycache__/
*.py[cod]
.pytest_cache/
.mypy_cache/
.ruff_cache/
build/
dist/
*.egg-info/
.coverage
htmlcov/

# Local settings
.env
.DS_Store
`,
	go: `# Build output
/bin/
*.exe
*.test
*.out
coverage.*

# Local settings
.env
.DS_Store
`,
	rust: `# Build output
/target/

# Local settings
.env
.DS_Store
`,
};

const mit = (year: number, holder: string) => `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

export interface InitOptions {
	readme?: boolean;
	description?: string;
	gitignore?: GitignoreTemplate;
	license?: LicenseTemplate;
}

/** Validates the init options a request asked for. */
export function parseInit(value: unknown): InitOptions {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value))
		return fail(400, "init is {readme, description, gitignore, license}");
	const requested = value as Record<string, unknown>;
	const isSet = (option: unknown) => option !== undefined && option !== null;
	if (isSet(requested.gitignore) && !(String(requested.gitignore) in GITIGNORE))
		fail(400, `gitignore is one of ${Object.keys(GITIGNORE).join(", ")}`);
	if (isSet(requested.license) && requested.license !== "mit") fail(400, "license is mit");
	const description = typeof requested.description === "string" ? requested.description.trim().slice(0, 300) : "";
	const init: InitOptions = {};
	if (requested.readme) init.readme = true;
	if (description) init.description = description;
	if (requested.gitignore) init.gitignore = requested.gitignore as GitignoreTemplate;
	if (requested.license) init.license = "mit";
	return init;
}

/** The first commit's files, or none when nothing was asked for. */
export function initialFiles(
	input: { fullName: string; holder: string; year: number } & InitOptions,
): Record<string, string> {
	const files: Record<string, string> = {};
	if (input.readme) {
		const name = input.fullName.split("/").pop();
		const description = input.description ? `\n${input.description}\n` : "";
		files["README.md"] = `# ${name}\n${description}`;
	}
	if (input.gitignore) files[".gitignore"] = GITIGNORE[input.gitignore];
	if (input.license === "mit") files.LICENSE = mit(input.year, input.holder);
	return files;
}

/** Write the first commit to a new, empty repo's main branch. */
export async function writeFirstCommit(
	remote: Remote,
	files: Record<string, string>,
	author: { name: string; email: string; message?: string },
) {
	const workspace = await Workspace.init(remote, "main");
	await workspace.write(files);
	const message = author.message ?? `Start ${Object.keys(files).join(", ")}`;
	const oid = await workspace.commit(message, { name: author.name, email: author.email });
	await workspace.push("main");
	return oid;
}
