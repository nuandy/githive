import { type ThemeChoice, useTheme } from "../lib/theme";
import { Icon, type IconName } from "./Icon";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

// Light, dark, or as this device is set: a round button in the top bar showing the sun or the moon (one turns away as
// the other turns in), opening a menu of the three. As tall as the bar's other pills: 30px, 28px once their labels go.

const CHOICES: { value: ThemeChoice; words: string; icon: IconName }[] = [
	{ value: "light", words: "Light", icon: "sun" },
	{ value: "dark", words: "Dark", icon: "moon" },
	{ value: "system", words: "Same as this device", icon: "monitor" },
];

export function ThemeMenu() {
	const { choice, theme, setChoice } = useTheme();
	const label = `Theme: ${choice === "system" ? `same as this device (${theme})` : theme}`;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={[
					"relative inline-flex size-7.5 flex-none to-560:size-7 cursor-pointer items-center justify-center rounded-full border",
					"border-border bg-transparent p-0 text-foreground transition-colors duration-fast",
					"hover:bg-surface-2 focus-visible:border-ring focus-visible:shadow-focus focus-visible:outline-none",
					"data-[state=open]:bg-surface-2",
				].join(" ")}
				aria-label={label}
				title={label}
			>
				<Icon
					name="sun"
					size={15}
					className="absolute transition-[rotate,scale,opacity] duration-slow ease-spring dark:scale-50 dark:-rotate-90 dark:opacity-0"
				/>
				<Icon
					name="moon"
					size={15}
					className="absolute scale-50 rotate-90 opacity-0 transition-[rotate,scale,opacity] duration-slow ease-spring dark:scale-100 dark:rotate-0 dark:opacity-100"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuLabel>Theme</DropdownMenuLabel>
				<DropdownMenuRadioGroup value={choice} onValueChange={(value) => setChoice(value as ThemeChoice)}>
					{CHOICES.map((each) => (
						<DropdownMenuRadioItem key={each.value} value={each.value}>
							<Icon name={each.icon} size={15} />
							{each.words}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
