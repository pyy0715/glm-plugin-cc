#!/usr/bin/env node
// @ts-check
import { parseArgs } from "node:util";
import { load } from "../src/config.js";
import { createServer } from "../src/server.js";

const { values } = parseArgs({
	options: {
		port: { type: "string", short: "p" },
		"default-backend": { type: "string", short: "d" },
	},
});

const config = load({
	port: values.port,
	defaultBackend: values["default-backend"],
});

if (!config.backends.claude.apiKey) {
	console.error("CLAUDE_API_KEY (or ANTHROPIC_API_KEY) is not set.");
	process.exit(1);
}
if (!config.backends.glm.apiKey) {
	console.error("GLM_API_KEY is not set.");
	process.exit(1);
}

const server = createServer(config);
server.listen(config.port, () => {
	console.log(`glm-proxy listening on http://localhost:${config.port}`);
	console.log(`  claude -> ${config.backends.claude.baseUrl}`);
	console.log(`  glm    -> ${config.backends.glm.baseUrl}`);
	console.log(`  default: ${config.defaultBackend}`);
});
