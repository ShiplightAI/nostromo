/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITelemetryAppender, validateTelemetryData } from './telemetryUtils.js';

export class PostHogAppender implements ITelemetryAppender {

	private readonly _apiKey: string;
	private readonly _host: string;
	private readonly _commonProperties: Record<string, string | boolean | null>;
	private _buffer: object[] = [];
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;

	private static readonly _FLUSH_INTERVAL = 30_000;
	private static readonly _BATCH_SIZE = 20;

	constructor(apiKey: string, version: string, cloudMode: 'server' | 'electron', host?: string) {
		this._apiKey = apiKey;
		this._host = host ?? 'https://us.i.posthog.com';
		this._commonProperties = {
			product: 'nostromo',
			version,
			platform: PostHogAppender._getPlatform(),
			nodeVersion: typeof process !== 'undefined' ? process.version : 'browser',
			cloudMode,
			$geoip_disable: true,
			$ip: null,
		};
	}

	private static _getPlatform(): string {
		if (typeof process !== 'undefined' && typeof process.platform === 'string') {
			return process.platform;
		}
		if (typeof navigator !== 'undefined') {
			const ua = navigator.userAgent;
			if (ua.includes('Win')) { return 'win32'; }
			if (ua.includes('Mac')) { return 'darwin'; }
			if (ua.includes('Linux')) { return 'linux'; }
		}
		return 'unknown';
	}

	log(eventName: string, data?: unknown): void {
		const { properties, measurements } = validateTelemetryData(data);

		this._buffer.push({
			event: eventName,
			properties: {
				...this._commonProperties,
				...properties,
				...measurements,
				distinct_id: properties['common.machineId'] || 'unknown',
			},
			timestamp: new Date().toISOString(),
		});

		if (!this._flushTimer) {
			this._flushTimer = setTimeout(() => this._sendBatch(), PostHogAppender._FLUSH_INTERVAL);
		}

		if (this._buffer.length >= PostHogAppender._BATCH_SIZE) {
			this._sendBatch();
		}
	}

	flush(): Promise<void> {
		return this._sendBatch();
	}

	private async _sendBatch(): Promise<void> {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}

		if (this._buffer.length === 0) {
			return;
		}

		const batch = this._buffer;
		this._buffer = [];

		const payload = JSON.stringify({
			api_key: this._apiKey,
			batch,
		});

		try {
			const response = await fetch(`${this._host}/batch/`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: payload,
			});
			if (!response.ok) {
				// Silently drop — telemetry should never break the app
			}
		} catch {
			// Network errors are expected (offline, adblocked, etc.)
		}
	}
}
