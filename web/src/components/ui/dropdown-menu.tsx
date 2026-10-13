import { DropdownMenu as Menu } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "../Icon";

// A menu that opens from a button: it grows out of the button and fades in, and fades back as it closes. Arrow keys,
// typing a letter, Escape and outside clicks work as in any menu. Not modal: the page behind keeps its scroll bar,
// so opening a menu never shifts it.

export function DropdownMenu({ modal = false, ...props }: ComponentProps<typeof Menu.Root>) {
	return <Menu.Root data-slot="dropdown-menu" modal={modal} {...props} />;
}

export function DropdownMenuTrigger(props: ComponentProps<typeof Menu.Trigger>) {
	return <Menu.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Menu.Content>) {
	return (
		<Menu.Portal>
			<Menu.Content
				data-slot="dropdown-menu-content"
				sideOffset={sideOffset}
				className={cn(
					"z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-40 overflow-x-hidden overflow-y-auto",
					"origin-(--radix-dropdown-menu-content-transform-origin) rounded-md border border-border bg-popover p-1",
					"text-ui text-popover-foreground shadow-raised",
					"data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
					"data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
					"data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
					className,
				)}
				{...props}
			/>
		</Menu.Portal>
	);
}

const item = [
	"relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 outline-none select-none",
	"transition-colors duration-fast data-highlighted:bg-link-soft data-highlighted:text-link",
	"data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:shrink-0",
];

export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
	return <Menu.Item data-slot="dropdown-menu-item" className={cn(item, className)} {...props} />;
}

export function DropdownMenuRadioGroup(props: ComponentProps<typeof Menu.RadioGroup>) {
	return <Menu.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

/** One of a few choices; the chosen one carries a check. */
export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof Menu.RadioItem>) {
	return (
		<Menu.RadioItem data-slot="dropdown-menu-radio-item" className={cn(item, "pr-8", className)} {...props}>
			{children}
			<span className="absolute right-2 flex size-4 items-center justify-center">
				<Menu.ItemIndicator className="data-[state=checked]:animate-in data-[state=checked]:zoom-in-50">
					<Icon name="check" size={14} />
				</Menu.ItemIndicator>
			</span>
		</Menu.RadioItem>
	);
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof Menu.Label>) {
	return (
		<Menu.Label
			data-slot="dropdown-menu-label"
			className={cn("px-2 py-1 text-caption font-semibold text-muted-foreground", className)}
			{...props}
		/>
	);
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
	return (
		<Menu.Separator
			data-slot="dropdown-menu-separator"
			className={cn("-mx-1 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}
