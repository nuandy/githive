// Edit: a README.md for every example app, saying what it shows, what it needs and how to run it.
// Usage: node example-readmes.mjs <repo> [--rewrite]   (prints the files it wrote; --rewrite replaces existing ones)
import { existsSync, writeFileSync } from "node:fs";
const [repo, flag] = process.argv.slice(2);
const rewrite = flag === "--rewrite";
// Not among Express's dev dependencies, so `npm install` at the root doesn't bring them.
// Redis examples need modules that aren't among Express's dev dependencies, so `npm install` at the root doesn't bring them.
const redis = (modules, install, note = "") =>
	`It needs a Redis server running on its default port (https://redis.io/), and ${modules}, which ${modules.includes(" and ") ? "aren't" : "isn't"} among Express's dev dependencies: install ${modules.includes(" and ") ? "them" : "it"} first with \`${install}\`.${note}`;
// How to run most examples, and the exceptions.
const runs = {
	vhost: "Run it from the repository root, after `npm install`:\n\n```sh\nnode examples/vhost\n```\n\nIt only answers on the example.com names, so first map them to your machine in `/etc/hosts`, as the comment at the top of `index.js` shows:\n\n```\n127.0.0.1       example.com\n127.0.0.1       foo.example.com\n127.0.0.1       bar.example.com\n```\n\nThen open http://example.com:3000, or http://foo.example.com:3000 to see a subdomain redirected.\n",
	session: "Run it from the repository root, after `npm install`:\n\n```sh\nnode examples/session\n```\n\nThen open http://localhost:3000.\n\n`redis.js` shows the same app keeping its sessions in Redis through `connect-redis`. It's written for an older `connect-redis` than the version Express installs (which exports `RedisStore` rather than a function), so it doesn't run as is.\n",
};
const examples = {
	auth: ["Authentication", "Password login with sessions: `/login` checks a username and password hashed with `pbkdf2-password`, `/restricted` is only for signed-in users, and `/logout` ends the session."],
	"content-negotiation": ["Content negotiation", "Answers `/` and `/users` as HTML, plain text or JSON, depending on the request's `Accept` header, with `res.format()`."],
	"cookie-sessions": ["Cookie sessions", "Keeps a session in a signed cookie with `cookie-session`, counting how many times you've viewed the page."],
	cookies: ["Cookies", "Sets, reads and clears a cookie with `cookie-parser`: post the form on `/` to remember yourself, and visit `/forget` to clear it."],
	downloads: ["Downloads", "Serves files as downloads with `res.download()` from `/files/*file`, and handles a missing file with a 404."],
	ejs: ["EJS views", "Renders views with EJS registered as the engine for `.html` files."],
	"error-pages": ["Error pages", "Custom 404, 403 and 500 pages: visit `/404`, `/403` and `/500` to see each one."],
	error: ["Error handling", "Error-handling middleware (functions with four arguments) catching an error thrown in a route on `/` and one passed with `next(err)` on `/next`."],
	"hello-world": ["Hello world", "The smallest Express app: `/` answers \"Hello World\"."],
	markdown: ["Markdown views", "Registers `.md` as a view engine, rendering Markdown with `marked`; `/fail` shows a missing view's error."],
	"multi-router": ["Multiple routers", "Mounts two versions of an API, each its own `express.Router()`, at `/api/v1` and `/api/v2`."],
	mvc: ["MVC", "A model-view-controller layout: controllers in `controllers/` are loaded at boot and mapped to routes, with EJS views, sessions and `method-override`."],
	online: ["Online users", "Tracks which users were active recently with the `online` module and Redis. " + redis("`online` and `redis`", "npm install --no-save online redis@3", " (`online` uses the callback API of the Redis client's version 3, which later versions dropped.)")],
	params: ["Route parameters", "`app.param()` loading a user for `/user/:user`, and a range of users for `/users/:from-:to`, with a 404 from `http-errors` when there's none."],
	resource: ["Resource routes", "An ad-hoc `app.resource()` helper that maps a resource's actions to routes: list them all, show one, show a range of ids, and delete one."],
	"route-map": ["Route map", "Defines routes from a nested object of paths and methods with a small `app.map()` helper."],
	"route-middleware": ["Route middleware", "Middleware on individual routes: load a user for `/user/:id`, and check permissions before `/user/:id/edit` and `DELETE /user/:id`."],
	"route-separation": ["Route separation", "Routes split into their own modules (`site`, `user`, `post`), with views for listing, viewing and editing users."],
	search: ["Search", "A search page whose client script calls `/search/:query`, answered from Redis. " + redis("`redis`", "npm install --no-save redis")],
	session: ["Sessions", "Sessions with `express-session`, kept in memory, counting your visits to `/`."],
	"static-files": ["Static files", "Serves the `public/` folder with `express.static()`, at the root and again under `/static`, and `public/css` at the root too."],
	vhost: ["Virtual hosts", "Serves apps by host name with `vhost`: the main app on `example.com`, and a redirecting app for its subdomains. Point those names at your machine in your hosts file to try it."],
	"view-constructor": ["Custom view class", "Replaces Express's view lookup with a View class that fetches Markdown from GitHub and renders it."],
	"view-locals": ["View locals", "Passes data to views three ways: in `res.render()`, through `res.locals` set by middleware, and both together."],
	"web-service": ["Web service", "A small JSON API under `/api` with users and repos. Every request needs an API key in the `api-key` query parameter, checked in middleware; errors come back as JSON."],
};
for (const [name, [title, about]] of Object.entries(examples)) {
	const file = `examples/${name}/README.md`;
	if (!existsSync(`${repo}/examples/${name}`) || (existsSync(`${repo}/${file}`) && !rewrite)) continue;
	const run = runs[name] ?? `Run it from the repository root, after \`npm install\`:\n\n\`\`\`sh\nnode examples/${name}\n\`\`\`\n\nThen open http://localhost:3000.\n`;
	writeFileSync(`${repo}/${file}`, `# ${title}\n\n${about}\n\n${run}`);
	console.log(file);
}
