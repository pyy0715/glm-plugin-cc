#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

const PORT = Number(process.env.PROXY_PORT || 4000);
const PROXY_PATH = process.env.GLM_PROXY_PATH;
const READY_TIMEOUT_MS = Number(process.env.GLM_PROXY_READY_TIMEOUT_MS || 3000);
const POLL_INTERVAL_MS = 100;
const LOG_PATH = process.env.GLM_PROXY_LOG || "/tmp/glm-proxy.log";

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function checkPort(port) {
	return new Promise((resolve) => {
		const sock = net.createConnection(port, "127.0.0.1");
		sock.on("connect", () => {
			sock.destroy();
			resolve(true);
		});
		sock.on("error", () => resolve(false));
	});
}

/**
 * @param {number} port
 * @param {number} deadline
 * @returns {Promise<boolean>}
 */
async function waitReady(port, deadline) {
	while (Date.now() < deadline) {
		if (await checkPort(port)) return true;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return false;
}

async function main() {
	if (await checkPort(PORT)) return; // already running
	if (!PROXY_PATH) return; // not yet setup — graceful no-op

	// Route proxy stdout/stderr to a log file so users can observe routing
	// decisions without running the proxy in the foreground.
	const logFd = fs.openSync(LOG_PATH, "a");
	const child = spawn(process.execPath, [PROXY_PATH], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: process.env,
	});
	child.unref();
	fs.closeSync(logFd);

	await waitReady(PORT, Date.now() + READY_TIMEOUT_MS);
}

main()
	.catch(() => {})
	.finally(() => process.exit(0));
