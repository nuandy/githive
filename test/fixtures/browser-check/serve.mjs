// An app for the browser check's --start: serves this folder's pages on the port it's given.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.argv[2]);
createServer((request, response) => {
	const name = request.url === "/" ? "clean.html" : request.url.slice(1);
	let page;
	try {
		page = readFileSync(new URL(name, import.meta.url));
	} catch {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, { "Content-Type": "text/html" }).end(page);
}).listen(port, "127.0.0.1");
