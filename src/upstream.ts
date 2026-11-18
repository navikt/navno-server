import { corgi, type CorgiOptions, isHttpError, isTimeoutError, ORDER, order, type Plugin } from '@itsy/corgi';
import { isValidationError, type StandardSchemaV1 } from '@itsy/corgi/schema';
import { withTimeout } from '@itsy/corgi/timeout';
import { Counter, Histogram, type Registry } from '@prometheus-io/client';

// From 10 ms to 30 s, which covers both an answer someone waits for and a data load in the background
const BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export type UpstreamClientOptions = {
	/** The app's Registry from @prometheus-io/client. The two metrics are made in it */
	registry: Registry;
	/** Goes in front of the metric names, such as `nav_office_search_api_` */
	prefix: string;
	/**
	 * @default 0.01 to 30
	 * The buckets of the duration histogram, in seconds
	 */
	buckets?: number[];
};

export type UpstreamOptions = CorgiOptions & {
	/** Gives up on a request after this long, reading its body included, in milliseconds */
	timeout: number;
};

/**
 * Makes `<prefix>upstream_requests_total` and `<prefix>upstream_request_duration_seconds` in the app's registry, and
 * gives back the function that makes a corgi client for one upstream, counted and timed under the name it is given.
 * Call it once, where the app has its registry: the metrics can't be made twice.
 *
 * A client throws when its upstream doesn't answer 2xx in time, and when an answer fails its schema.
 */
export const createUpstreamClient = ({ registry, prefix, buckets = BUCKETS }: UpstreamClientOptions) => {
	// The names, labels and help texts are what the apps had of their own, and what their dashboards and alerts read
	const requests = new Counter({
		name: `${prefix}upstream_requests_total`,
		help: 'Outbound requests by upstream and response status class (2xx, 4xx, 5xx, …), timeout or network_error',
		labelNames: ['upstream', 'status'] as const,
		registers: [registry],
	});

	const duration = new Histogram({
		name: `${prefix}upstream_request_duration_seconds`,
		help: 'Outbound request time until response headers, by upstream',
		labelNames: ['upstream'] as const,
		buckets,
		registers: [registry],
	});

	// Counts and times each request. It is tagged to sit inside a retry, next to the deadline, so every attempt of an
	// app's withRetry is counted on its own. A request that never got an answer counts as a timeout or a network_error.
	const observe = (upstream: string): Plugin =>
		order(ORDER.timeout - 1, (next) => async (url, init) => {
			const stopTimer = duration.startTimer({ upstream });
			try {
				const response = await next(url, init);
				requests.inc({ upstream, status: `${Math.floor(response.status / 100)}xx` });
				return response;
			} catch (e) {
				requests.inc({ upstream, status: isTimeoutError(e) ? 'timeout' : 'network_error' });
				throw e;
			} finally {
				stopTimer();
			}
		});

	return (upstream: string, { timeout, plugins = [], ...defaults }: UpstreamOptions) =>
		corgi.create({ ...defaults, plugins: [...plugins, observe(upstream), withTimeout(timeout)] });
};

const pathOf = (path: StandardSchemaV1.Issue['path'] = []) =>
	path.map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.');

/**
 * What to log about a failed upstream request. Never an HttpError itself: its message and URL have the query, which
 * can be what someone searched for, and its data is the upstream's answer, which can be about a person or a token.
 */
export const failureOf = (error: unknown): object => {
	if (isHttpError(error)) {
		return { status: error.status };
	}
	if (isValidationError(error)) {
		return { issues: error.issues.slice(0, 3).map(({ path, message }) => `${pathOf(path)}: ${message}`) };
	}
	return error instanceof Error ? error : { error: String(error) };
};
