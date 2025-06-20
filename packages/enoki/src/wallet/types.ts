// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SuiClient } from '@mysten/sui/client';
import type { StandardEventsListeners, Wallet } from '@mysten/wallet-standard';

import type { EnokiClient, EnokiClientConfig } from '../EnokiClient/index.js';
import type { AuthProvider, EnokiNetwork } from '../EnokiClient/type.js';
import type { ClientWithCoreApi, Experimental_SuiClientTypes } from '@mysten/sui/experimental';
import type { ZkLoginSignatureInputs } from '@mysten/sui/zklogin';
import type { UseStore } from 'idb-keyval';
import type { WritableAtom } from 'nanostores';

export type WalletEventsMap = {
	[E in keyof StandardEventsListeners]: Parameters<StandardEventsListeners[E]>[0];
};

export type ZkLoginState = {
	address?: string;
	publicKey?: string;
};

export type ZkLoginSession = {
	maxEpoch: number;
	randomness: string;
	expiresAt: number;

	jwt?: string;
	proof?: ZkLoginSignatureInputs;
};

export type EnokiSessionState = {
	idbStore: UseStore;
	client: ClientWithCoreApi;
	storageKey: string;
	$zkLoginSession: WritableAtom<{ initialized: boolean; value: ZkLoginSession | null }>;
};

export type EnokiWalletOptions = {
	provider: AuthProvider;
	windowFeatures?: string | (() => string);
	clients: ClientWithCoreApi[];
	getCurrentNetwork: () => Experimental_SuiClientTypes.Network;
} & AuthProviderOptions &
	EnokiClientConfig &
	Pick<Wallet, 'name' | 'icon'>;

export type AuthProviderOptions = {
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
};

export type RegisterEnokiWalletsOptions = EnokiClientConfig & {
	/**
	 * Configuration for each OAuth provider.
	 */
	providers: Partial<Record<AuthProvider, AuthProviderOptions>>;

	/**
	 * The window features to use when opening the authorization popup.
	 * https://developer.mozilla.org/en-US/docs/Web/API/Window/open#windowfeatures
	 */
	windowFeatures?: string | (() => string);
} & (
		| {
				/**
				 * A list of client instances to use when building and executing transactions.
				 */
				clients: ClientWithCoreApi[];

				/** A function that returns the current network that the application is acting on. */
				getCurrentNetwork: () => Experimental_SuiClientTypes.Network;
		  }
		| {
				/**
				 * The SuiClient instance to use when building and executing transactions.
				 */
				client: SuiClient;

				/**
				 * The network to use when building and executing transactions.
				 * @default 'mainnet'
				 */
				network?: EnokiNetwork;
		  }
	);
