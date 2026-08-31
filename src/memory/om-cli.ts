import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Error carrying the om CLI's exit code.
 * Codes: 1 = usage error or search with no matches (grep-style), 2 = db error, 3 = not found.
 * A non-numeric code (e.g. "ENOENT") means the binary itself could not be spawned.
 */
export class OmError extends Error {
	constructor(message: string, readonly code: string | number) {
		super(message);
		this.name = "OmError";
	}
}

/** Path to the om CLI binary: OM_CLI env override > the committed binary at <repo>/cli/om. */
export function omBin(): string {
	return process.env.OM_CLI ?? join(REPO_ROOT, "cli", "om");
}

/**
 * Run the om CLI and return stdout. Rejects with OmError on non-zero exit.
 * Expected "empty" outcomes are reported via exit code (see OmError): callers that treat
 * not-found / no-match as a normal result catch OmError and inspect the code.
 * `stdin` (when given) is piped to the process, e.g. a topic body for `topic put`.
 * stdin is ALWAYS closed after writing — commands that read a body from stdin block forever
 * on an open pipe.
 */
export function omRun(args: string[], stdin?: string): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = execFile(omBin(), args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) {
				const code = error.code ?? -1;
				const message = stderr.trim() || (typeof code === "string" ? `om binary not runnable (${code})` : error.message);
				return reject(new OmError(message, code));
			}
			resolvePromise(stdout);
		});
		if (stdin !== undefined) {
			// EPIPE if the CLI exits before draining (e.g. usage error): the exit callback
			// already reports the failure, so swallow the stream error.
			child.stdin?.on("error", () => {});
			child.stdin?.write(stdin);
		}
		child.stdin?.end();
	});
}
