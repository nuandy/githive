import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "../Icon";
import { buttonVariants } from "./button";

// A window over the page for something that needs its own room (a new token to copy, say): the page dims behind it and
// can't be reached until it closes. It fades in growing a little, and fades back as it closes; Escape, the close
// button and a click on the dimmed page close it, and focus goes back to what opened it. For a question that must be
// answered (delete? revoke?), AlertDialog.

export function Dialog(props: ComponentProps<typeof DialogPrimitive.Root>) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogTrigger(props: ComponentProps<typeof DialogPrimitive.Trigger>) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogClose(props: ComponentProps<typeof DialogPrimitive.Close>) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** The dimmed page behind a dialog (AlertDialog's too). */
export const OVERLAY = cn(
	"fixed inset-0 z-50 bg-black/40 dark:bg-black/60",
	"data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
);

/** A dialog's box, in the middle of the window (AlertDialog's too). */
export const PANEL = cn(
	"fixed top-1/2 left-1/2 z-50 grid w-[calc(100%-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4",
	"max-h-[calc(100dvh-32px)] overflow-y-auto rounded-lg border border-border bg-card p-5 text-card-foreground",
	"shadow-raised outline-none",
	"data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
	"data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
);

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
	return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn(OVERLAY, className)} {...props} />;
}

export function DialogContent({
	className,
	children,
	closable = true,
	...props
}: ComponentProps<typeof DialogPrimitive.Content> & {
	/** A close button in the corner. */
	closable?: boolean;
}) {
	return (
		<DialogPrimitive.Portal>
			<DialogOverlay />
			<DialogPrimitive.Content data-slot="dialog-content" className={cn(PANEL, className)} {...props}>
				{children}
				{closable ? (
					<DialogPrimitive.Close
						className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "absolute top-3 right-3 size-7")}
						aria-label="Close"
					>
						<Icon name="x" />
					</DialogPrimitive.Close>
				) : null}
			</DialogPrimitive.Content>
		</DialogPrimitive.Portal>
	);
}

/** A dialog's title and what it's about, at its top. */
export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="dialog-header" className={cn("grid gap-1.5 pr-8", className)} {...props} />;
}

/** A dialog's buttons, at its foot, the one that goes ahead last. */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
	return (
		<div data-slot="dialog-footer" className={cn("flex flex-wrap justify-end gap-2 pt-1", className)} {...props} />
	);
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
	return (
		<DialogPrimitive.Title
			data-slot="dialog-title"
			className={cn("text-title-sm leading-6 font-bold", className)}
			{...props}
		/>
	);
}

export function DialogDescription({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
	return (
		<DialogPrimitive.Description
			data-slot="dialog-description"
			className={cn("m-0 text-muted-foreground", className)}
			{...props}
		/>
	);
}
