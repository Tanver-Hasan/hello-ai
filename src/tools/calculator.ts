export type AddArgs = {
	a: number;
	b: number;
};

const LIMIT = 1_000_000_000;

export async function addNumbers(args: unknown): Promise<string> {
	if (
		typeof args !== "object" ||
		args === null ||
		!("a" in args) ||
		!("b" in args) ||
		typeof args.a !== "number" ||
		typeof args.b !== "number" ||
		!Number.isFinite(args.a) ||
		!Number.isFinite(args.b)
	) {
		throw new Error("a and b must be finite numbers");
	}

	if (Math.abs(args.a) > LIMIT || Math.abs(args.b) > LIMIT) {
		throw new Error(`a and b must be between -${LIMIT} and ${LIMIT}`);
	}

	return String(args.a + args.b);
}
