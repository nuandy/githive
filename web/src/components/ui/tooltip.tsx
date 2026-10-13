import { Tooltip as TooltipPrimitive } from "radix-ui";
import { type ComponentProps, createContext, useContext } from "react";
import { cn } from "../../lib/utils";

// A few words about what's under the pointer or the keyboard's focus, in ink, after a moment: what a title= attribute
// said, in the theme's look and reachable by keyboard (give a trigger that isn't a control tabIndex={0}). It grows out
// of what it's about and fades in, and fades back as it goes. The dashboard sits in one TooltipProvider (main.tsx), so
// going from one tooltip to the next skips the wait; a tooltip outside one (a test, a part drawn on its own) brings
// its own.

const Provided = createContext(false);

export function TooltipProvider({ delayDuration = 300, ...props }: ComponentProps<typeof TooltipPrimitive.Provider>) {
	return (
		<Provided value={true}>
			<TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props} />
		</Provided>
	);
}

export function Tooltip(props: ComponentProps<typeof TooltipPrimitive.Root>) {
	const root = <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
	return useContext(Provided) ? root : <TooltipProvider>{root}</TooltipProvider>;
}

export function TooltipTrigger(props: ComponentProps<typeof TooltipPrimitive.Trigger>) {
	return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
	className,
	sideOffset = 6,
	...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				sideOffset={sideOffset}
				className={cn(
					"z-50 w-fit max-w-72 origin-(--radix-tooltip-content-transform-origin) rounded-md bg-primary px-2.5 py-1.5",
					"text-caption leading-4 text-balance text-primary-foreground shadow-raised",
					"animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
					"data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1",
					"data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1",
					className,
				)}
				{...props}
			/>
		</TooltipPrimitive.Portal>
	);
}
