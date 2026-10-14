import {
	type ComponentType,
	createElement,
	lazy,
	type ReactNode,
	type RefObject,
	Suspense,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "../lib/utils";

// What most visits never need (Admin, an org, your agents, a new repository, a repo's settings and code, a change's
// files, the palette) loads as it's first shown, keeping the dashboard's first load small. Meanwhile "Loading…" holds
// its place, after a moment so what comes at once never flashes it; what took its place fades in, as anything that
// replaces "Loading…" does. Once loaded, a part shows at once.

/** Every part's loader, to load them all at once (tests: preloadLazyParts). */
const loaders: (() => Promise<unknown>)[] = [];

/**
 * A component that loads as it's first drawn (`React.lazy`), from `load`, which reads it from its module: draw it in a
 * `Lazy`. Once it has loaded, it's drawn at once, with no wait.
 */
export function lazyPart<Props extends object>(load: () => Promise<ComponentType<Props>>): ComponentType<Props> {
	let loaded: ComponentType<Props> | undefined;
	const preload = () =>
		load().then((component) => {
			loaded = component;
			return component;
		});
	loaders.push(preload);
	const Later = lazy(() => preload().then((component) => ({ default: component })));
	return function LazyPart(props: Props) {
		// Chosen once, so a part drawn while it loaded isn't drawn afresh as it comes.
		const [part] = useState<ComponentType<Props>>(() => loaded ?? Later);
		return createElement(part, props);
	};
}

/** Loads every part now: tests draw them as a page does once they've come. */
export const preloadLazyParts = () => Promise.all(loaders.map((preload) => preload()));

/** "Loading…" in the dashboard's look, fading in only after a moment (`animate-fade`, delayed). */
export function LoadingLine({ children = "Loading…", className }: { children?: ReactNode; className?: string }) {
	return (
		<p
			className={cn("my-3.75 animate-fade py-8 text-center text-muted-foreground [animation-delay:300ms]", className)}
			role="status"
		>
			{children}
		</p>
	);
}

/** The fallback, noting that it showed. */
function Waiting({ waited, children }: { waited: RefObject<boolean>; children: ReactNode }) {
	useEffect(() => {
		waited.current = true;
	}, [waited]);
	return children;
}

/** What loaded, fading in if it took the place of the fallback. */
function Arrived({
	waited,
	className,
	children,
}: {
	waited: RefObject<boolean>;
	className?: string;
	children: ReactNode;
}) {
	const [fades] = useState(() => waited.current);
	return <div className={cn(className, fades && "animate-fade")}>{children}</div>;
}

/**
 * A part loaded when it's first shown (`React.lazy`): `fallback` in its place until it's here (a `LoadingLine`, in a
 * page's frame for a page), then it fades in. `className` lays out the part's wrapper (a page's: a column that fills).
 */
export function Lazy({
	fallback = <LoadingLine />,
	className,
	children,
}: {
	fallback?: ReactNode;
	className?: string;
	children: ReactNode;
}) {
	const waited = useRef(false);
	return (
		<Suspense fallback={<Waiting waited={waited}>{fallback}</Waiting>}>
			<Arrived waited={waited} {...(className ? { className } : {})}>
				{children}
			</Arrived>
		</Suspense>
	);
}
