/**
 * Best-effort run_command nudge for common Git history rewrites. This parser is
 * not a security boundary; authenticated pushes are enforced in SandboxAgent.git.
 */
export function builderGitCommandBlockReason(command: string, hasPushedHistory: boolean): string | undefined {
	// Shell removes backslash-newline pairs before parsing the command list.
	return inspectShell(command.replace(/\\(?:\r\n|\n|\r)/g, ""), hasPushedHistory, 0);
}

export interface BuilderGitPushHistory {
	remoteHead?: string;
	remoteHeadIsAncestor: boolean;
	forcePush: boolean;
	lastPushedHead?: string;
	lastPushedHeadIsAncestor: boolean;
	hasPushedHistory: boolean;
}

/** Refuse a token-authenticated push if it would discard an already-pushed commit. */
export function builderGitPushBlockReason(history: BuilderGitPushHistory): string | undefined {
	if (history.forcePush) return "Refusing force-push: Blueprint pins reviews to exact commits, so pushed history must be preserved. Add a new commit instead.";
	const remoteWouldBeRewritten = Boolean(history.remoteHead) && !history.remoteHeadIsAncestor;
	const lastPushedCommitWasRewritten = Boolean(history.lastPushedHead) && !history.lastPushedHeadIsAncestor;
	const pushedHeadCannotBeVerified = history.hasPushedHistory && !history.remoteHead && !history.lastPushedHead;
	if (!remoteWouldBeRewritten && !lastPushedCommitWasRewritten && !pushedHeadCannotBeVerified) return undefined;
	return "Refusing to push: the local branch no longer contains the head already pushed to the fork, so this would rewrite pushed history. Keep pushed commits, make a new commit, and merge task-base updates with `git merge base/main` instead of rebasing.";
}

const MAX_NESTED_SHELL_DEPTH = 16;
const UNSAFE_SHELL_REASON =
	"Blueprint pins reviews to exact commits. This shell execution cannot be safely inspected for history rewrites; run its Git command directly, preserve pushed history by adding a new commit, and use `git merge base/main` rather than rebasing.";
const PUSH_REASON =
	"Blueprint pins reviews to exact commits. Force-pushes can replace pushed history, so preserve history and add a new commit instead. Use commit_and_push for a normal push.";
const HISTORY_REASON =
	"Blueprint pins reviews to exact commits, so preserve pushed history. Add a new commit instead; bring in task-base updates with `git merge base/main` rather than rebasing.";

function inspectShell(command: string, hasPushedHistory: boolean, depth: number): string | undefined {
	if (depth > MAX_NESTED_SHELL_DEPTH) return UNSAFE_SHELL_REASON;

	// Command substitutions and backticks execute shell code even inside quotes.
	for (const nested of nestedShellCommands(command)) {
		const reason = inspectShell(nested, hasPushedHistory, depth + 1);
		if (reason) return reason;
	}

	for (const words of shellCommands(command)) {
		const first = executableIndex(words);
		if (first >= words.length) continue;
		const executable = words[first]!;

		if (isGit(executable)) {
			const parsed = gitSubcommand(words.slice(first));
			if (!parsed) continue;
			const { subcommand, args } = parsed;
			if (isDynamicWord(subcommand)) return UNSAFE_SHELL_REASON;
			if (subcommand === "push") {
				if (isForcePush(args)) return PUSH_REASON;
				if (args.some(isDynamicWord)) return UNSAFE_SHELL_REASON;
			}
			if (hasPushedHistory && subcommand === "commit") {
				if (args.includes("--amend")) return HISTORY_REASON;
				if (args.some(isDynamicWord)) return UNSAFE_SHELL_REASON;
			}
			if (hasPushedHistory && subcommand === "rebase") return HISTORY_REASON;
			continue;
		}

		if (isShell(executable)) {
			const script = shellScriptArgument(words.slice(first + 1));
			if (script === undefined) return UNSAFE_SHELL_REASON;
			const reason = inspectShell(script, hasPushedHistory, depth + 1);
			if (reason) return reason;
			continue;
		}

		if (executable === "eval") {
			if (!words[first + 1]) return UNSAFE_SHELL_REASON;
			const reason = inspectShell(words.slice(first + 1).join(" "), hasPushedHistory, depth + 1);
			if (reason) return reason;
			continue;
		}

		// A dynamically selected command cannot be classified without executing
		// shell expansion (for example, `$GIT push --force`).
		if (executable.includes("$") || executable.startsWith("`")) return UNSAFE_SHELL_REASON;

		// These builtins execute a separate script whose contents are not present
		// in the command line for us to inspect.
		if (executable === "source" || executable === ".") return UNSAFE_SHELL_REASON;
	}
	return undefined;
}

/** Split shell command lists, preserving quoted arguments as individual words. */
function shellCommands(command: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | "`" | undefined;

	const finishWord = () => {
		if (!inWord) return;
		words.push(word);
		word = "";
		inWord = false;
	};
	const finishCommand = () => {
		finishWord();
		if (words.length) commands.push(words);
		words = [];
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else if (char === "\\" && i + 1 < command.length) {
				word += command[++i]!;
			} else {
				word += char;
			}
			continue;
		}

		if (char === "\\" && i + 1 < command.length) {
			inWord = true;
			word += command[++i]!;
		} else if (char === "'" || char === '"' || char === "`") {
			quote = char;
			inWord = true;
		} else if (char === "#" && !inWord) {
			// Shell comments run to the next command line.
			while (i < command.length && command[i] !== "\n") i++;
			finishCommand();
		} else if (/\s/.test(char)) {
			finishWord();
			if (char === "\n") finishCommand();
		} else if (char === ";" || char === "|" || char === "&" || char === "(" || char === ")") {
			finishCommand();
			if ((char === "&" || char === "|") && command[i + 1] === char) i++;
		} else {
			inWord = true;
			word += char;
		}
	}
	finishCommand();
	return commands;
}

/** Extract literal command substitutions, including those inside double quotes. */
function nestedShellCommands(command: string): string[] {
	const nested: string[] = [];
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (char === "\\" && i + 1 < command.length) {
			i++;
			continue;
		}
		if (char === "'" && !quote) {
			quote = "'";
			continue;
		}
		if (char === '"') {
			quote = quote === '"' ? undefined : '"';
			continue;
		}
		if (char === "`") {
			let end = i + 1;
			let body = "";
			for (; end < command.length; end++) {
				if (command[end] === "\\" && end + 1 < command.length) body += command[++end]!;
				else if (command[end] === "`") break;
				else body += command[end]!;
			}
			if (end < command.length) nested.push(body);
			i = end;
			continue;
		}
		if (char === "$" && command[i + 1] === "(") {
			const found = parenthesizedCommand(command, i + 1);
			if (found) {
				nested.push(found.body);
				i = found.end;
			}
		}
	}
	return nested;
}

function parenthesizedCommand(source: string, open: number): { body: string; end: number } | undefined {
	let level = 0;
	let quote: "'" | '"' | "`" | undefined;
	for (let i = open; i < source.length; i++) {
		const char = source[i]!;
		if (quote) {
			if (char === "\\" && quote !== "'" && i + 1 < source.length) i++;
			else if (char === quote) quote = undefined;
			continue;
		}
		if (char === "\\" && i + 1 < source.length) {
			i++;
		} else if (char === "'" || char === '"' || char === "`") {
			quote = char;
		} else if (char === "(") {
			level++;
		} else if (char === ")" && --level === 0) {
			return { body: source.slice(open + 1, i), end: i };
		}
	}
	return undefined;
}

function executableIndex(words: string[]): number {
	let i = 0;
	while (i < words.length) {
		if (isAssignment(words[i]!)) {
			i++;
			continue;
		}
		if (isRedirect(words[i]!)) {
			const redirect = words[i++]!;
			if (/^(?:\d*>>?|\d*<|&>>?)$/.test(redirect) && i < words.length) i++;
			continue;
		}
		break;
	}
	while (i < words.length) {
		if (words[i] === "sudo") {
			i++;
			while (i < words.length && words[i]!.startsWith("-")) {
				const option = words[i++]!;
				if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "--chdir"].includes(option)) i++;
				else if (option === "--") break;
			}
			continue;
		}
		if (isShellPrefix(words[i]!)) {
			i++;
			continue;
		}
		break;
	}
	if (words[i] === "env") {
		i++;
		while (i < words.length && (isAssignment(words[i]!) || words[i] === "-i" || words[i] === "--ignore-environment" || words[i] === "-0" || words[i] === "--null")) i++;
		while (words[i] === "-u" || words[i] === "--unset" || words[i] === "-C" || words[i] === "--chdir") i += 2;
		while (i < words.length && (words[i]!.startsWith("--unset=") || words[i]!.startsWith("--chdir="))) i++;
	}
	while (i < words.length && isAssignment(words[i]!)) i++;
	return i;
}

function isShellPrefix(word: string) {
	return word === "command" || word === "builtin" || word === "exec" || word === "nohup" || word === "time" || word === "!" || word === "if" || word === "then" || word === "else" || word === "elif" || word === "while" || word === "until" || word === "do" || word === "coproc" || word === "sudo";
}

function isRedirect(word: string) {
	return /^(?:\d*>>?|\d*<|&>>?|\d*>&|\d*<&)/.test(word);
}

function isAssignment(word: string) {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isDynamicWord(word: string) {
	return word.includes("$") || word.includes("\u0060");
}

function isGit(word: string | undefined) {
	return word !== undefined && /(?:^|\/)git(?:\.exe)?$/.test(word);
}

function isShell(word: string) {
	return /(?:^|\/)(?:ba|da|k|z)?sh$/.test(word);
}

/** Return the code following -c/--command, or undefined for an opaque shell run. */
function shellScriptArgument(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "-c" || arg === "--command") return args[i + 1];
		if (arg.startsWith("--command=")) return arg.slice("--command=".length);
		// bash/sh permit combined options such as -lc and -ec.
		if (/^-[^-].*c/.test(arg)) return args[i + 1];
	}
	return undefined;
}

function gitSubcommand(args: string[]): { subcommand: string; args: string[] } | undefined {
	let i = 1; // first word is the git executable
	while (i < args.length) {
		const arg = args[i]!;
		if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace" || arg === "--config-env" || arg === "--super-prefix") {
			i += 2;
			continue;
		}
		if (arg === "-p" || arg === "-P" || arg === "--paginate" || arg === "--no-pager" || arg === "--bare" || arg === "--no-replace-objects" || arg === "--no-optional-locks" || arg === "--no-lazy-fetch" || arg === "--literal-pathspecs") {
			i++;
			continue;
		}
		if ((arg.startsWith("-C") || arg.startsWith("-c")) && arg.length > 2) {
			i++;
			continue;
		}
		if (arg.startsWith("--")) {
			i++;
			continue;
		}
		if (arg.startsWith("-")) return undefined;
		return { subcommand: arg, args: args.slice(i + 1) };
	}
	return undefined;
}

function isForcePush(args: string[]) {
	let options = true;
	for (const arg of args) {
		if (arg === "--") {
			options = false;
			continue;
		}
		if (options && (arg === "--force" || arg.startsWith("--force=") || arg === "--force-with-lease" || arg.startsWith("--force-with-lease="))) return true;
		// Git accepts combined short options, such as `-fu`.
		if (options && /^-[^-]/.test(arg) && arg.slice(1).includes("f")) return true;
		// A leading + makes a push refspec force-update its destination.
		if (arg.startsWith("+") && arg.length > 1) return true;
	}
	return false;
}
