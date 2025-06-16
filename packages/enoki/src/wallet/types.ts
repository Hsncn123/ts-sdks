// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { StandardEventsListeners } from '@mysten/wallet-standard';

import type { EnokiClientConfig } from '../EnokiClient/index.js';
import type { AuthProvider } from '../EnokiClient/type.js';
import type { ClientWithCoreApi, Experimental_SuiClientTypes } from '@mysten/sui/experimental';

export type WalletEventsMap = {
	[E in keyof StandardEventsListeners]: Parameters<StandardEventsListeners[E]>[0];
};

export interface RegisterEnokiWalletsOptions extends EnokiClientConfig {
	/**
	 * Configuration for each OAuth provider.
	 */
	providers: Partial<
		Record<
			AuthProvider,
			{
				/**
				 * The OAuth client ID.
				 */
				clientId: string;

				/**
				 * The URL to redirect to after authorization.
				 */
				redirectUrl?: string;

				/**
				 * Extra parameters to include in the authorization URL.
				 */
				extraParams?: Record<string, string>;
			}
		>
	>;

	/**
	 * A list of client instances to use when building and executing transactions.
	 */
	clients: ClientWithCoreApi[];

	/** A function that returns the current network that the application is acting on. */
	getCurrentNetwork: () => Experimental_SuiClientTypes.Network;

	/**
	 * The window features to use when opening the authorization popup.
	 * https://developer.mozilla.org/en-US/docs/Web/API/Window/open#windowfeatures
	 */
	windowFeatures?: string | (() => string);
}
