// omp resolves this import at runtime inside the host; declared here for type-checking only.
declare module "@oh-my-pi/pi-coding-agent/config/registry" {
	export function lookup(id: string): { get(scope: unknown): unknown } | undefined;
}
