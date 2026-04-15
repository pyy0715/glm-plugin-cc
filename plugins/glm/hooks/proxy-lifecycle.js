// @ts-check
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

export const PORT = Number(process.env.PROXY_PORT || 4000);
const POLL_INTERVAL_MS = 100;

/**
 * Non-blocking TCP probe to 127.0.0.1:port. Resolves true if a connection
 * succeeds within the default socket timeout, false otherwise.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function checkPort(port) {
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
 * Poll checkPort until it returns true or the deadline (ms epoch) passes.
 * @param {number} port
 * @param {number} deadline
 * @returns {Promise<boolean>}
 */
export async function waitReady(port, deadline) {
	while (Date.now() < deadline) {
		if (await checkPort(port)) return true;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
	return false;
}

/**
 * Spawn the GLM proxy detached, routing stdio to the configured log file.
 * Caller is responsible for polling readiness; this function returns
 * immediately after spawn.
 * @param {string} proxyPath
 * @param {string} logPath
 */
export function spawnProxy(proxyPath, logPath) {
	const logFd = fs.openSync(logPath, "a");
	try {
		const child = spawn(process.execPath, [proxyPath], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
		});
		child.unref();
	} finally {
		fs.closeSync(logFd);
	}
}

/**
 * Ensure the proxy is reachable on its port. If not, spawn it and wait for
 * readiness. Safe to call from any hook; if GLM_PROXY_PATH is unset we can't
 * spawn and the caller must tolerate a dead proxy.
 *
 * @param {object} [opts]
 * @param {number} [opts.port]         Defaults to PROXY_PORT or 4000.
 * @param {number} [opts.readyTimeoutMs] Defaults to GLM_PROXY_READY_TIMEOUT_MS or 3000.
 * @param {string} [opts.proxyPath]    Defaults to GLM_PROXY_PATH.
 * @param {string} [opts.logPath]      Defaults to GLM_PROXY_LOG or /tmp/glm-proxy.log.
 * @returns {Promise<"already-up" | "started" | "missing-path" | "unreachable">}
 */
export async function ensureProxyRunning(opts = {}) {
	const port = opts.port ?? PORT;
	const readyTimeoutMs =
		opts.readyTimeoutMs ?? Number(process.env.GLM_PROXY_READY_TIMEOUT_MS || 3000);
	const proxyPath = opts.proxyPath ?? process.env.GLM_PROXY_PATH;
	const logPath = opts.logPath ?? process.env.GLM_PROXY_LOG ?? "/tmp/glm-proxy.log";

	if (await checkPort(port)) return "already-up";
	if (!proxyPath) return "missing-path";

	spawnProxy(proxyPath, logPath);
	const up = await waitReady(port, Date.now() + readyTimeoutMs);
	return up ? "started" : "unreachable";
}
