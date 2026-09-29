import { describe, expect, it } from "vitest";

import type { Message } from "@earendil-works/pi-ai";

import { serializeConversation, tieredTruncate } from "../src/ledger/serialize.js";

describe("tieredTruncate", () => {
	it("is a no-op when maxChars is 0 (unlimited default)", () => {
		const text = "x".repeat(10_000);
		expect(tieredTruncate(text, 0)).toBe(text);
		expect(tieredTruncate(text, -5)).toBe(text);
	});

	it("is a no-op when the text fits within the cap", () => {
		expect(tieredTruncate("hello world", 100)).toBe("hello world");
	});

	it("keeps head (80%) and tail (20%) with an explicit marker", () => {
		const text = "abcdefg".repeat(100); // 700 chars
		const head = text.slice(0, 80);
		const tail = text.slice(text.length - 20);
		expect(tieredTruncate(text, 100)).toBe(`${head}\n… [truncated 600 chars] …\n${tail}`);
	});

	it("computes head/tail split for odd caps (floor on the head)", () => {
		const text = "abcdefgh".repeat(50); // 400 chars
		const head = text.slice(0, 80); // floor(101 * 0.8)
		const tail = text.slice(text.length - 21); // 101 - 80
		expect(tieredTruncate(text, 101)).toBe(`${head}\n… [truncated 299 chars] …\n${tail}`);
	});
});

describe("serializeConversation tool-result truncation", () => {
	const ts = 1_700_000_000_000;
	const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts }) as Message;
	const assistant = (text: string) =>
		({ role: "assistant", content: [{ type: "text", text }], timestamp: ts }) as Message;
	const toolResult = (text: string) =>
		({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: ts,
		}) as Message;

	it("truncates only tool result blocks when toolResultMaxChars is set", () => {
		const bigTool = "t".repeat(1000);
		const out = serializeConversation([user("short question"), assistant("I'll run it."), toolResult(bigTool)], {
			toolResultMaxChars: 100,
		});
		expect(out).toContain("short question");
		expect(out).toContain("I'll run it.");
		expect(out).toContain("… [truncated 900 chars] …");
		expect(out).not.toContain(bigTool);
	});

	it("does not truncate user or assistant text", () => {
		const bigUser = "u".repeat(5000);
		const bigAssistant = "a".repeat(5000);
		const out = serializeConversation([user(bigUser), assistant(bigAssistant)], { toolResultMaxChars: 100 });
		expect(out).toContain(bigUser);
		expect(out).toContain(bigAssistant);
		expect(out).not.toContain("truncated");
	});

	it("leaves tool results unlimited by default (no options)", () => {
		const bigTool = "t".repeat(5000);
		const out = serializeConversation([toolResult(bigTool)]);
		expect(out).toContain(bigTool);
		expect(out).not.toContain("truncated");
	});

	it("does not truncate short tool results below the cap", () => {
		const out = serializeConversation([toolResult("tiny result")], { toolResultMaxChars: 100 });
		expect(out).toContain("tiny result");
		expect(out).not.toContain("truncated");
	});
});
