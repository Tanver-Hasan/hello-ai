import { describe, expect, it } from "vitest";
import { addNumbers } from "../src/tools/calculator";

describe("addNumbers", () => {
	it.each([
		[2, 3, "5"],
		[-4, 9, "5"],
		[1.25, 2.5, "3.75"],
	])("adds %s and %s", async (a, b, expected) => {
		await expect(addNumbers({ a, b })).resolves.toBe(expected);
	});

	it.each([
		[Number.NaN, 1],
		[Number.POSITIVE_INFINITY, 1],
		[1_000_000_001, 1],
	])("rejects unsafe input", async (a, b) => {
		await expect(addNumbers({ a, b })).rejects.toThrow();
	});
});
