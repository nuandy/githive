// Toolchains beyond Node, installed in a container when the repo uses them:
// Python (uv), Go and Rust. Which ones a repo uses is read from its tracked
// files, at any depth, so a monorepo with a Go service in a folder gets Go.
// Installs and caches live outside the checkout (/opt, /root), so a clean
// checkout between checks keeps them.

export type Toolchain = "python" | "go" | "rust";

/** The files that say a repo uses a toolchain (matched by name, in any folder). */
const MARKERS: Record<Toolchain, RegExp> = {
	python: /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|setup\.py|setup\.cfg|uv\.lock|Pipfile)$/,
	go: /(^|\/)go\.mod$/,
	rust: /(^|\/)Cargo\.toml$/,
};

/** `git ls-files` pathspecs for every marker, so listing them is cheap in a large repo. */
export const MARKER_PATHSPECS = [
	"*pyproject.toml",
	"*requirements*.txt",
	"*setup.py",
	"*setup.cfg",
	"*uv.lock",
	"*Pipfile",
	"*go.mod",
	"*Cargo.toml",
];

/** The toolchains a repo uses, from its tracked file paths. */
export function detectToolchains(files: string[]): Toolchain[] {
	return (Object.keys(MARKERS) as Toolchain[]).filter((t) => files.some((f) => MARKERS[t].test(f.trim())));
}

/** Where installed tools are found: every check runs in a login shell, which reads this. */
export const PROFILE = `export PATH=/opt/venv/bin:/usr/local/go/bin:/root/go/bin:/root/.cargo/bin:$PATH
[ -d /opt/venv ] && export VIRTUAL_ENV=/opt/venv
export UV_PROJECT_ENVIRONMENT=/opt/venv
export CARGO_TARGET_DIR=/opt/cargo-target
`;

const APT = "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq";

/**
 * Install a toolchain (a no-op when it's there). Python: the system's
 * python3 and uv, with a virtualenv at /opt/venv that python, pip and the
 * project's tools run from. Go: the latest release (a go.mod asking for a
 * newer one gets it through GOTOOLCHAIN). Rust: rustup's minimal profile
 * with clippy and rustfmt (a rust-toolchain.toml is honoured by rustup).
 */
export const INSTALL: Record<Toolchain, string> = {
	python: [
		`{ command -v python3 >/dev/null && command -v curl >/dev/null || ${APT} python3 python3-venv curl >/dev/null; }`,
		"{ command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh >/dev/null; }",
		"{ [ -d /opt/venv ] || uv venv -q --seed /opt/venv; }",
	].join(" && "),
	go: [
		`{ command -v gcc >/dev/null && command -v curl >/dev/null || ${APT} gcc libc6-dev curl >/dev/null; }`,
		'[ -x /usr/local/go/bin/go ] || { v=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1) && curl -fsSL "https://go.dev/dl/$v.linux-$(dpkg --print-architecture).tar.gz" | tar -C /usr/local -xz; }',
	].join(" && "),
	rust: [
		`{ command -v gcc >/dev/null && command -v curl >/dev/null || ${APT} gcc libc6-dev pkg-config curl >/dev/null; }`,
		"[ -x /root/.cargo/bin/cargo ] || curl --proto '=https' -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal -c clippy -c rustfmt --no-modify-path >/dev/null",
	].join(" && "),
};

/**
 * Install the project's dependencies for a toolchain, from the checkout's top
 * folder (the shown command, then the script that runs). Each is skipped when
 * its files aren't there.
 */
export const DEPENDENCIES: Record<Toolchain, { command: string; script: string }> = {
	python: {
		command: "uv sync (or uv pip install -r requirements*.txt)",
		script: [
			'if [ -f uv.lock ] || grep -qs "^\\[project\\]" pyproject.toml; then uv sync -q --all-extras',
			'elif ls requirements*.txt >/dev/null 2>&1; then for f in requirements*.txt; do uv pip install -q -r "$f" || exit 1; done',
			"elif [ -f setup.py ] || [ -f pyproject.toml ]; then uv pip install -q -e .",
			"fi",
		].join("; "),
	},
	go: { command: "go mod download", script: "[ ! -f go.mod ] || go mod download" },
	rust: { command: "cargo fetch", script: "[ ! -f Cargo.toml ] || cargo fetch -q" },
};

/** The files a toolchain's dependencies are installed from: unchanged, an install is skipped. */
export const DEPENDENCY_FILES =
	"pyproject.toml uv.lock requirements*.txt setup.py setup.cfg go.mod go.sum Cargo.toml Cargo.lock rust-toolchain rust-toolchain.toml";
