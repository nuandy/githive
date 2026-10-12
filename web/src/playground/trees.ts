// The repos the playground's hives work on: one shaped like Express, and a large synthetic monorepo. Both are fixed
// lists, the same on every run; files a change creates join them once it lands.

const each = (folder: string, names: string[]) => names.map((name) => `${folder}/${name}`);

const EXPRESS_TESTS = [
	"Route.js",
	"Router.js",
	"app.all.js",
	"app.engine.js",
	"app.head.js",
	"app.js",
	"app.listen.js",
	"app.locals.js",
	"app.options.js",
	"app.param.js",
	"app.render.js",
	"app.request.js",
	"app.response.js",
	"app.route.js",
	"app.router.js",
	"app.routes.error.js",
	"app.use.js",
	"config.js",
	"exports.js",
	"express.json.js",
	"express.raw.js",
	"express.static.js",
	"express.text.js",
	"express.urlencoded.js",
	"middleware.basic.js",
	"regression.js",
	"req.accepts.js",
	"req.acceptsCharsets.js",
	"req.acceptsEncodings.js",
	"req.acceptsLanguages.js",
	"req.baseUrl.js",
	"req.fresh.js",
	"req.get.js",
	"req.host.js",
	"req.hostname.js",
	"req.ip.js",
	"req.ips.js",
	"req.is.js",
	"req.path.js",
	"req.protocol.js",
	"req.query.js",
	"req.range.js",
	"req.route.js",
	"req.secure.js",
	"req.signedCookies.js",
	"req.stale.js",
	"req.subdomains.js",
	"req.xhr.js",
	"res.append.js",
	"res.attachment.js",
	"res.clearCookie.js",
	"res.cookie.js",
	"res.download.js",
	"res.format.js",
	"res.get.js",
	"res.json.js",
	"res.jsonp.js",
	"res.links.js",
	"res.locals.js",
	"res.location.js",
	"res.redirect.js",
	"res.render.js",
	"res.send.js",
	"res.sendFile.js",
	"res.sendStatus.js",
	"res.set.js",
	"res.status.js",
	"res.type.js",
	"res.vary.js",
	"utils.js",
];

const EXPRESS_ACCEPTANCE = [
	"auth.js",
	"cookie-sessions.js",
	"cookies.js",
	"downloads.js",
	"ejs.js",
	"error-pages.js",
	"error.js",
	"hello-world.js",
	"markdown.js",
	"multi-router.js",
	"mvc.js",
	"params.js",
	"resource.js",
	"route-map.js",
	"route-separation.js",
	"vhost.js",
	"web-service.js",
];

const EXPRESS_EXAMPLES: Record<string, string[]> = {
	auth: ["index.js", "views/foot.ejs", "views/head.ejs", "views/login.ejs"],
	"content-negotiation": ["db.js", "index.js", "users.js"],
	"cookie-sessions": ["index.js"],
	cookies: ["index.js"],
	downloads: ["index.js", "files/amazing.txt", "files/notes/groceries.txt"],
	ejs: ["index.js", "public/stylesheets/style.css", "views/footer.html", "views/header.html", "views/users.html"],
	error: ["index.js"],
	"error-pages": [
		"index.js",
		"views/404.ejs",
		"views/500.ejs",
		"views/error_header.ejs",
		"views/footer.ejs",
		"views/index.ejs",
	],
	"hello-world": ["index.js"],
	markdown: ["index.js", "views/index.md"],
	"multi-router": ["controllers/api_v1.js", "controllers/api_v2.js", "index.js"],
	mvc: [
		"controllers/main/index.js",
		"controllers/pet/index.js",
		"controllers/pet/views/edit.ejs",
		"controllers/pet/views/show.ejs",
		"controllers/user/index.js",
		"controllers/user/views/edit.hbs",
		"controllers/user/views/list.hbs",
		"controllers/user/views/show.hbs",
		"controllers/user-pet/index.js",
		"db.js",
		"index.js",
		"lib/boot.js",
		"public/style.css",
		"views/404.ejs",
		"views/5xx.ejs",
	],
	online: ["index.js"],
	params: ["index.js"],
	resource: ["index.js"],
	"route-map": ["index.js"],
	"route-middleware": ["index.js"],
	"route-separation": [
		"index.js",
		"post.js",
		"public/style.css",
		"site.js",
		"user.js",
		"views/footer.ejs",
		"views/header.ejs",
		"views/index.ejs",
		"views/posts/index.ejs",
		"views/users/edit.ejs",
		"views/users/index.ejs",
		"views/users/view.ejs",
	],
	search: ["index.js", "public/client.js", "public/index.html"],
	session: ["index.js", "redis.js"],
	"static-files": ["index.js", "public/css/style.css", "public/hello.txt", "public/js/app.js"],
	vhost: ["index.js"],
	"view-constructor": ["github-view.js", "index.js"],
	"view-locals": ["index.js", "user.js", "views/index.ejs"],
	"web-service": ["index.js"],
};

/** A repo shaped like Express: lib/ and lib/router/, a flat test/ with acceptance tests and support, examples, benchmarks. */
export function expressFiles(): string[] {
	return [
		".editorconfig",
		".eslintignore",
		".eslintrc.yml",
		".github/dependabot.yml",
		".github/workflows/ci.yml",
		".github/workflows/codeql.yml",
		".gitignore",
		"Collaborator-Guide.md",
		"Contributing.md",
		"History.md",
		"LICENSE",
		"Readme.md",
		"Release-Process.md",
		"Security.md",
		"Triager-Guide.md",
		"index.js",
		"package-lock.json",
		"package.json",
		...each("benchmarks", ["Makefile", "README.md", "middleware.js", "run"]),
		...Object.entries(EXPRESS_EXAMPLES).flatMap(([example, files]) => each(`examples/${example}`, files)),
		...each("lib", ["application.js", "express.js", "request.js", "response.js", "utils.js", "view.js"]),
		...each("lib/middleware", ["init.js", "query.js"]),
		...each("lib/router", ["index.js", "layer.js", "route.js"]),
		...each("test", EXPRESS_TESTS),
		"test/.eslintrc.yml",
		...each("test/acceptance", EXPRESS_ACCEPTANCE),
		...each("test/fixtures", [
			"% of dogs.txt",
			"blog/index.html",
			"blog/post/index.tmpl",
			"broken.send",
			"default_layout/name.tmpl",
			"email.tmpl",
			"name.tmpl",
			"name.txt",
			"nums.txt",
			"pets/names.txt",
			"snow ☃/.gitkeep",
			"user.html",
			"user.tmpl",
			"users/index.html",
			"users/tobi.txt",
		]),
		...each("test/support", ["env.js", "tmpl.js", "utils.js"]),
	]
		.filter((file, index, all) => all.indexOf(file) === index)
		.sort();
}

// The monorepo's parts. Each list is crossed with the next to make its files, so the tree is big but reads like a
// real one: packages with modules, apps with components and pages, services with routes and jobs.

const PACKAGES: Record<string, string[]> = {
	ui: ["button", "card", "dialog", "menu", "table", "tabs", "toast", "tooltip", "form", "select", "avatar", "badge"],
	core: ["ids", "errors", "result", "clock", "events", "retry", "cache", "money"],
	auth: ["sessions", "tokens", "passwords", "oauth", "mfa", "roles"],
	billing: ["invoices", "plans", "proration", "taxes", "payments", "coupons", "dunning"],
	search: ["indexer", "query", "ranking", "synonyms", "highlight"],
	analytics: ["events", "funnels", "cohorts", "export", "sampling"],
	i18n: ["plurals", "dates", "numbers", "loader"],
	config: ["env", "schema", "flags"],
	logger: ["format", "redact", "transports"],
	db: ["migrations", "pool", "queries", "seed", "transactions"],
	queue: ["producer", "consumer", "dead-letter", "scheduler"],
	mailer: ["templates", "smtp", "preview"],
	flags: ["rollout", "targeting", "audit"],
	storage: ["buckets", "uploads", "signed-urls", "thumbnails"],
};

const MODULE_FILES = ["index.ts", "types.ts", "parse.ts", "validate.ts", "format.ts"];

const APPS: Record<string, { components: string[]; pages: string[]; hooks: string[] }> = {
	web: {
		components: [
			"AppShell",
			"Breadcrumbs",
			"CommandPalette",
			"DatePicker",
			"EmptyState",
			"ErrorBoundary",
			"FileDrop",
			"Header",
			"InviteForm",
			"MemberList",
			"Navigation",
			"Onboarding",
			"Pagination",
			"PlanPicker",
			"ProjectCard",
			"SearchBox",
			"Sidebar",
			"UsageChart",
		],
		pages: [
			"dashboard",
			"projects",
			"project-settings",
			"billing",
			"members",
			"login",
			"signup",
			"reset-password",
			"usage",
			"integrations",
		],
		hooks: ["useProjects", "useSession", "useBilling", "useDebounce", "useMediaQuery", "useToast", "usePagination"],
	},
	admin: {
		components: ["AccountTable", "FlagEditor", "ImpersonateBanner", "RefundForm", "SearchUsers", "Timeline"],
		pages: ["accounts", "flags", "refunds", "health", "jobs"],
		hooks: ["useAccounts", "useFlags", "useJobs"],
	},
	mobile: {
		components: ["TabBar", "ProjectRow", "PushPrompt", "OfflineBanner", "Avatar"],
		pages: ["home", "project", "notifications", "settings"],
		hooks: ["usePush", "useOffline"],
	},
};

const SERVICES: Record<string, { routes: string[]; handlers: string[]; jobs: string[] }> = {
	api: {
		routes: ["projects", "members", "invites", "billing", "usage", "tokens", "webhooks", "search", "files", "audit"],
		handlers: ["auth", "errors", "rate-limit", "cors", "request-id"],
		jobs: ["cleanup-invites"],
	},
	worker: {
		routes: ["health"],
		handlers: ["errors"],
		jobs: ["send-webhooks", "rebuild-index", "export-csv", "expire-trials", "sync-usage", "thumbnails"],
	},
	gateway: { routes: ["proxy", "health"], handlers: ["auth", "request-id", "circuit-breaker", "timeouts"], jobs: [] },
	notifications: {
		routes: ["preferences", "health"],
		handlers: ["errors"],
		jobs: ["digest", "push", "email", "in-app"],
	},
	payments: {
		routes: ["checkout", "webhooks", "health"],
		handlers: ["signature", "errors"],
		jobs: ["reconcile", "retry-charges"],
	},
	ingest: { routes: ["events", "batch", "health"], handlers: ["validate", "errors"], jobs: ["compact", "rollup"] },
};

const DOCS: Record<string, string[]> = {
	guides: [
		"getting-started",
		"local-development",
		"testing",
		"deploying",
		"feature-flags",
		"billing",
		"search",
		"migrations",
		"observability",
		"on-call",
	],
	reference: ["api", "cli", "config", "events", "errors", "webhooks", "permissions"],
	adr: [
		"0001-monorepo",
		"0002-postgres",
		"0003-queue",
		"0004-feature-flags",
		"0005-search-engine",
		"0006-auth-tokens",
		"0007-billing-provider",
		"0008-i18n",
	],
};

/** A large monorepo (about 2,000 files): packages, apps, services, docs and infrastructure. */
export function monorepoFiles(): string[] {
	const files: string[] = [
		".github/CODEOWNERS",
		".github/workflows/ci.yml",
		".github/workflows/deploy.yml",
		".github/workflows/release.yml",
		".gitignore",
		".npmrc",
		"LICENSE",
		"README.md",
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"tsconfig.base.json",
		"turbo.json",
	];
	for (const [name, modules] of Object.entries(PACKAGES)) {
		const root = `packages/${name}`;
		files.push(`${root}/package.json`, `${root}/README.md`, `${root}/tsconfig.json`, `${root}/src/index.ts`);
		for (const module of modules) {
			files.push(...each(`${root}/src/${module}`, MODULE_FILES));
			files.push(`${root}/test/${module}.test.ts`, `${root}/test/fixtures/${module}.json`);
		}
	}
	files.push(
		...["en", "de", "fr", "es", "ja", "pt-PT"].flatMap((locale) =>
			each(`packages/i18n/locales/${locale}`, ["common.json", "errors.json", "onboarding.json", "billing.json"]),
		),
	);
	for (const [name, app] of Object.entries(APPS)) {
		const root = `apps/${name}`;
		files.push(`${root}/package.json`, `${root}/README.md`, `${root}/tsconfig.json`, `${root}/vite.config.ts`);
		files.push(`${root}/index.html`, `${root}/src/main.tsx`, `${root}/src/App.tsx`, `${root}/src/routes.ts`);
		for (const component of app.components)
			files.push(
				...each(`${root}/src/components/${component}`, [
					`${component}.tsx`,
					`${component}.test.tsx`,
					`${component}.module.css`,
					"index.ts",
				]),
			);
		for (const page of app.pages)
			files.push(...each(`${root}/src/pages/${page}`, ["index.tsx", "loader.ts", "page.test.tsx", "styles.css"]));
		for (const hook of app.hooks) files.push(`${root}/src/hooks/${hook}.ts`, `${root}/src/hooks/${hook}.test.ts`);
		files.push(...each(`${root}/public`, ["favicon.svg", "robots.txt", "manifest.json"]));
	}
	for (const [name, service] of Object.entries(SERVICES)) {
		const root = `services/${name}`;
		files.push(`${root}/Dockerfile`, `${root}/package.json`, `${root}/README.md`, `${root}/tsconfig.json`);
		files.push(`${root}/src/index.ts`, `${root}/src/config.ts`, `${root}/src/server.ts`);
		for (const route of service.routes)
			files.push(
				`${root}/src/routes/${route}.ts`,
				`${root}/test/routes/${route}.test.ts`,
				`${root}/src/models/${route}.ts`,
			);
		for (const handler of service.handlers)
			files.push(`${root}/src/handlers/${handler}.ts`, `${root}/test/handlers/${handler}.test.ts`);
		for (const job of service.jobs) files.push(`${root}/src/jobs/${job}.ts`, `${root}/test/jobs/${job}.test.ts`);
	}
	for (const [section, pages] of Object.entries(DOCS)) files.push(...pages.map((page) => `docs/${section}/${page}.md`));
	for (const env of ["prod", "staging"])
		files.push(
			...each(`infra/terraform/${env}`, [
				"main.tf",
				"variables.tf",
				"outputs.tf",
				"database.tf",
				"network.tf",
				"dns.tf",
			]),
		);
	for (const module of ["database", "network", "queue", "bucket", "cdn"])
		files.push(...each(`infra/terraform/modules/${module}`, ["main.tf", "variables.tf", "outputs.tf"]));
	for (const service of Object.keys(SERVICES))
		files.push(...each(`infra/k8s/${service}`, ["deployment.yaml", "service.yaml", "hpa.yaml"]));
	files.push(...each("scripts", ["bootstrap.ts", "release.ts", "seed.ts", "check-licenses.ts", "codegen.ts"]));
	// Generated API clients: many small files, the way codegen leaves them.
	for (const [service, { routes }] of Object.entries(SERVICES))
		for (const model of routes)
			for (const verb of ["get", "list", "create", "update", "delete"])
				files.push(`packages/clients/src/${service}/${model}/${verb}.ts`);
	// Snapshot fixtures for the UI library's visual tests.
	for (const component of PACKAGES.ui ?? [])
		for (const state of [
			"default",
			"hover",
			"focus",
			"disabled",
			"dark",
			"rtl",
			"compact",
			"loading",
			"error",
			"selected",
		])
			files.push(`packages/ui/test/__snapshots__/${component}/${state}.snap`);
	// Storybook stories and the app's translations of every page.
	for (const component of APPS.web?.components ?? [])
		files.push(`apps/web/src/components/${component}/${component}.stories.tsx`);
	for (const locale of ["en", "de", "fr", "es", "ja"])
		for (const page of APPS.web?.pages ?? []) files.push(`apps/web/src/locales/${locale}/${page}.json`);
	// An icon set: one flat folder of a few hundred files.
	for (const icon of ICONS)
		for (const variant of ["", "-filled", "-outline", "-small"]) files.push(`packages/icons/src/${icon}${variant}.tsx`);
	// The database's migrations, numbered.
	MIGRATIONS.forEach((migration, index) =>
		files.push(`packages/db/migrations/${String(index + 1).padStart(4, "0")}_${migration}.sql`),
	);
	// The docs site's pages.
	for (const [section, pages] of Object.entries(DOCS))
		for (const page of pages)
			for (const part of ["index", "examples", "faq", "changelog"])
				files.push(`apps/docs-site/content/${section}/${page}/${part}.mdx`);
	// Recorded events the ingest service's tests replay.
	for (let n = 1; n <= 60; n++) files.push(`services/ingest/test/fixtures/events-${String(n).padStart(3, "0")}.json`);
	return [...new Set(files)].sort();
}

const ICONS = [
	"activity",
	"alert",
	"archive",
	"arrow-down",
	"arrow-left",
	"arrow-right",
	"arrow-up",
	"at-sign",
	"bell",
	"bolt",
	"book",
	"bookmark",
	"box",
	"calendar",
	"camera",
	"chart",
	"check",
	"chevron-down",
	"chevron-left",
	"chevron-right",
	"chevron-up",
	"clipboard",
	"clock",
	"cloud",
	"code",
	"cog",
	"command",
	"copy",
	"credit-card",
	"database",
	"download",
	"edit",
	"external",
	"eye",
	"file",
	"filter",
	"flag",
	"folder",
	"gift",
	"globe",
	"grid",
	"heart",
	"help",
	"home",
	"image",
	"inbox",
	"key",
	"layers",
	"link",
	"list",
	"lock",
	"mail",
	"map",
	"menu",
	"message",
	"mic",
	"minus",
	"moon",
	"more",
	"move",
	"music",
	"paperclip",
	"pause",
	"phone",
	"pin",
	"play",
	"plus",
	"printer",
	"refresh",
	"save",
	"search",
	"send",
	"server",
	"share",
	"shield",
	"shopping-cart",
	"sliders",
	"star",
	"sun",
	"tag",
	"terminal",
	"trash",
	"trending-up",
	"truck",
	"unlock",
	"upload",
	"user",
	"users",
	"video",
	"wallet",
	"wifi",
	"x",
	"zoom-in",
	"zoom-out",
];

const MIGRATIONS = [
	"create_accounts",
	"create_users",
	"create_projects",
	"create_members",
	"create_invites",
	"add_users_email_index",
	"create_plans",
	"create_subscriptions",
	"create_invoices",
	"add_invoices_due_at",
	"create_payments",
	"create_tokens",
	"add_tokens_family",
	"create_webhooks",
	"create_deliveries",
	"add_deliveries_attempts",
	"create_events",
	"partition_events",
	"create_flags",
	"create_flag_rules",
	"create_audit_log",
	"add_audit_log_actor_index",
	"create_files",
	"add_files_checksum",
	"create_search_documents",
	"add_projects_archived_at",
	"create_coupons",
	"create_notifications",
	"create_notification_preferences",
	"add_members_role",
	"drop_legacy_sessions",
	"create_usage_rollups",
	"add_usage_rollups_unique",
	"create_exports",
	"add_accounts_region",
	"backfill_accounts_region",
	"create_mfa_devices",
	"add_users_locale",
	"create_api_keys",
	"add_api_keys_last_used",
];
