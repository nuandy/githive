// Toolchains beyond Node, installed when a repo's tracked files show it uses them, in any folder.
// Installs and caches live outside the checkout, so cleaning the checkout between checks keeps them.

export type Toolchain = "python" | "go" | "rust";

const MARKERS: Record<Toolchain, RegExp> = {
	python: /(^|\/)(pyproject\.toml|requirements[^/]*\.txt|setup\.py|setup\.cfg|uv\.lock|Pipfile)$/,
	go: /(^|\/)go\.mod$/,
	rust: /(^|\/)Cargo\.toml$/,
};

/** Pathspecs for the markers, so `git ls-files` stays cheap in a large repo. */
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

export function detectToolchains(files: string[]): Toolchain[] {
	const toolchains = Object.keys(MARKERS) as Toolchain[];
	return toolchains.filter((toolchain) => files.some((file) => MARKERS[toolchain].test(file.trim())));
}

/** Puts installed tools on the PATH. Every check runs in a login shell, which reads this. */
export const PROFILE = `export PATH=/opt/venv/bin:/usr/local/go/bin:/root/go/bin:/root/.cargo/bin:$PATH
[ -d /opt/venv ] && export VIRTUAL_ENV=/opt/venv
export UV_PROJECT_ENVIRONMENT=/opt/venv
export CARGO_TARGET_DIR=/opt/cargo-target
`;

const APT = "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq";

/**
 * Idempotent install scripts. Go installs the latest release, and a go.mod that wants a newer
 * one gets it through GOTOOLCHAIN. rustup honours a rust-toolchain.toml.
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

/** Dependency installs run from the checkout's root: a command to show, and the script that runs. */
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

/** When none of these files changed, the dependency install is skipped. */
export const DEPENDENCY_FILES =
	"pyproject.toml uv.lock requirements*.txt setup.py setup.cfg go.mod go.sum Cargo.toml Cargo.lock rust-toolchain rust-toolchain.toml";
