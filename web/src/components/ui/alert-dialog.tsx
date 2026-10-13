import type { VariantProps } from "class-variance-authority";
import { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils";
import { buttonVariants } from "./button";
import { OVERLAY, PANEL } from "./dialog";

// A question that must be answered before going on (delete this repository? revoke this agent?), in a dialog over the
// dimmed page: it says what will happen, and offers going ahead or not. Unlike a Dialog, a click on the page behind
// doesn't close it; Escape and Cancel do, and focus starts on Cancel and goes back to what asked.

export function AlertDialog(props: ComponentProps<typeof AlertDialogPrimitive.Root>) {
	return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

export function AlertDialogTrigger(props: ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
	return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

export function AlertDialogContent({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Content>) {
	return (
		<AlertDialogPrimitive.Portal>
			<AlertDialogPrimitive.Overlay data-slot="alert-dialog-overlay" className={OVERLAY} />
			<AlertDialogPrimitive.Content
				data-slot="alert-dialog-content"
				className={cn(PANEL, "max-w-md", className)}
				{...props}
			/>
		</AlertDialogPrimitive.Portal>
	);
}

export function AlertDialogHeader({ className, ...props }: ComponentProps<"div">) {
	return <div data-slot="alert-dialog-header" className={cn("grid gap-1.5", className)} {...props} />;
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-dialog-footer"
			className={cn("flex flex-wrap justify-end gap-2 pt-1", className)}
			{...props}
		/>
	);
}

export function AlertDialogTitle({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Title>) {
	return (
		<AlertDialogPrimitive.Title
			data-slot="alert-dialog-title"
			className={cn("text-title-sm leading-6 font-bold", className)}
			{...props}
		/>
	);
}

export function AlertDialogDescription({
	className,
	...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
	return (
		<AlertDialogPrimitive.Description
			data-slot="alert-dialog-description"
			className={cn("m-0 text-muted-foreground", className)}
			{...props}
		/>
	);
}

/** Going ahead: in red ink for what can't be undone, unless a variant says otherwise. */
export function AlertDialogAction({
	className,
	variant = "danger",
	...props
}: ComponentProps<typeof AlertDialogPrimitive.Action> & Pick<VariantProps<typeof buttonVariants>, "variant">) {
	return (
		<AlertDialogPrimitive.Action
			data-slot="alert-dialog-action"
			className={cn(buttonVariants({ variant }), className)}
			{...props}
		/>
	);
}

export function AlertDialogCancel({ className, ...props }: ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
	return (
		<AlertDialogPrimitive.Cancel
			data-slot="alert-dialog-cancel"
			className={cn(buttonVariants(), className)}
			{...props}
		/>
	);
}
