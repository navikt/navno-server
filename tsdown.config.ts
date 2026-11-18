import { defineConfig } from 'tsdown';

export default defineConfig({
	// index is what a server needs. upstream is apart, since only it needs @itsy/corgi and @prometheus-io/client
	entry: ['src/index.ts', 'src/upstream.ts'],
	platform: 'node',
	format: 'esm',
	dts: true,
});
