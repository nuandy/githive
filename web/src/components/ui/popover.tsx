import { Popover as PopoverPrimitive } from "radix-ui";
import { type ComponentProps, useContext } from "react";
import { cn } from "../../lib/utils";
import { PortalContainer } from "./tooltip";

// A small panel that opens from what it's about, on a click or a tap: what a tooltip would say where there's no
// pointer to hover with (a map cell on a phone), or a few controls. It grows out of its trigger and fades in, and
// fades back as it closes; Escape and a click elsewhere close it, and focus goes back to the trigger.

export function Popover(props: ComponentProps<typeof PopoverPrimitive.Root>) {
	return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

export function PopoverTrigger(props: ComponentProps<typeof PopoverPrimitive.Trigger>) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/** Where the panel opens from, when that isn't its trigger. */
export function PopoverAnchor(props: ComponentProps<typeof PopoverPrimitive.Anchor>) {
	return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export function PopoverClose(props: ComponentProps<typeof PopoverPrimitive.Close>) {
	return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

export function PopoverContent({
	className,
	align = "center",
	sideOffset = 6,
	...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
	const container = useContext(PortalContainer);
	return (
		<PopoverPrimitive.Portal {...(container ? { container } : {})}>
			<PopoverPrimitive.Content
				data-slot="popover-content"
				align={align}
				sideOffset={sideOffset}
				className={cn(
					"z-50 w-72 max-w-[calc(100vw-32px)] origin-(--radix-popover-content-transform-origin) rounded-md border border-border",
					"bg-popover p-3 text-ui text-popover-foreground shadow-raised outline-none",
					"data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
					"data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
					"data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
					"data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
					className,
				)}
				{...props}
			/>
		</PopoverPrimitive.Portal>
	);
}
