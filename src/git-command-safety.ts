/**
 * Find Git commands in a shell command and explain when a builder must not run
 * a history-rewriting operation. This deliberately parses only enough shell
 * syntax to separate ordinary composed commands; it does not execute or
 * evaluate shell expansions.
 */
export function builderGitCommandBlockReason(command: string, hasPushedHistory: boolean): string | undefined {
	for (const args of gitCommands(command)) {
		const parsed = gitSubcommand(args);
		if (!parsed) continue;
		const { subcommand, args: subcommandArgs } = parsed;

		if (subcommand === "push" && isForcePush(subcommandArgs)) {
			return "Blueprint pins reviews to exact commits. Force-pushes can replace pushed history, so preserve history and add a new commit instead. Use commit_and_push for a normal push.";
		}
		if (hasPushedHistory && ((subcommand === "commit" && subcommandArgs.includes("--amend")) || subcommand === "rebase")) {
			return "Blueprint pins reviews to exact commits, so preserve pushed history. Add a new commit instead; bring in task-base updates with `git merge base/main` rather than rebasing.";
		}
	}
	return undefined;
}

/** Split on shell command-list operators while keeping quoted text inside words. */
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
			} else if (char === "\\" && quote !== "'" && i + 1 < command.length) {
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
			// The second character in && or || is part of the same operator.
			if ((char === "&" || char === "|") && command[i + 1] === char) i++;
		} else {
			inWord = true;
			word += char;
		}
	}
	finishCommand();
	return commands;
}

function gitCommands(command: string): string[][] {
	const commands: string[][] = [];
	for (const words of shellCommands(command)) {
		let first = 0;
		while (first < words.length && isAssignment(words[first]!)) first++;
		while (words[first] === "command" || words[first] === "builtin") first++;
		if (isGit(words[first])) commands.push(words.slice(first));
	}
	return commands;
}

function isAssignment(word: string) {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function isGit(word: string | undefined) {
	return word !== undefined && /(?:^|\/)git(?:\.exe)?$/.test(word);
}

function gitSubcommand(args: string[]): { subcommand: string; args: string[] } | undefined {
	let i = 1; // first word is the git executable
	while (i < args.length) {
		const arg = args[i]!;
		if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace" || arg === "--exec-path" || arg === "--config-env" || arg === "--super-prefix") {
			i += 2;
			continue;
		}
		if (arg.startsWith("-C") && arg.length > 2) {
			i++;
			continue;
		}
		if (arg.startsWith("-c") && arg.length > 2) {
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
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
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
