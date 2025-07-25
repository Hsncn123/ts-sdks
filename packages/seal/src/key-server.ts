// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0
import { bcs, fromBase64, fromHex, toHex } from '@mysten/bcs';
import { bls12_381 } from '@noble/curves/bls12-381';

import { KeyServerMove, KeyServerMoveV1 } from './bcs.js';
import { InvalidKeyServerVersionError, SealAPIError, UnsupportedNetworkError } from './error.js';
import { DST_POP } from './ibe.js';
import { PACKAGE_VERSION } from './version.js';
import type { SealCompatibleClient } from './types.js';
import type { G1Element } from './bls12381.js';
import { flatten, Version } from './utils.js';

const EXPECTED_SERVER_VERSION = 1;

export type KeyServer = {
	objectId: string;
	name: string;
	url: string;
	keyType: KeyServerType;
	pk: Uint8Array;
};

export enum KeyServerType {
	BonehFranklinBLS12381 = 0,
}

export const SERVER_VERSION_REQUIREMENT = new Version('0.4.1');

/**
 * Returns a static list of Seal key server object ids that the dapp can choose to use.
 * @param network - The network to use.
 * @returns The object id's of the key servers.
 */
export function getAllowlistedKeyServers(network: 'testnet' | 'mainnet'): string[] {
	if (network === 'testnet') {
		return [
			'0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75',
			'0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8',
		];
	} else {
		throw new UnsupportedNetworkError(`Unsupported network ${network}`);
	}
}

/**
 * Given a list of key server object IDs, returns a list of SealKeyServer
 * from onchain state containing name, objectId, URL and pk.
 *
 * @param objectIds - The key server object IDs.
 * @param client - The SuiClient to use.
 * @returns - An array of SealKeyServer.
 */
export async function retrieveKeyServers({
	objectIds,
	client,
}: {
	objectIds: string[];
	client: SealCompatibleClient;
}): Promise<KeyServer[]> {
	return await Promise.all(
		objectIds.map(async (objectId) => {
			// First get the KeyServer object and validate it.
			const res = await client.core.getObject({
				objectId,
			});
			const ks = KeyServerMove.parse(await res.object.content);
			if (
				EXPECTED_SERVER_VERSION < Number(ks.firstVersion) ||
				EXPECTED_SERVER_VERSION > Number(ks.lastVersion)
			) {
				throw new InvalidKeyServerVersionError(
					`Key server ${objectId} supports versions between ${ks.firstVersion} and ${ks.lastVersion} (inclusive), but SDK expects version ${EXPECTED_SERVER_VERSION}`,
				);
			}

			// Then fetch the expected versioned object and parse it.
			const resVersionedKs = await client.core.getDynamicField({
				parentId: objectId,
				name: {
					type: 'u64',
					bcs: bcs.u64().serialize(EXPECTED_SERVER_VERSION).toBytes(),
				},
			});

			const ksVersioned = KeyServerMoveV1.parse(resVersionedKs.dynamicField.value.bcs);

			return {
				objectId,
				name: ksVersioned.name,
				url: ksVersioned.url,
				keyType: ksVersioned.keyType,
				pk: new Uint8Array(ksVersioned.pk),
			};
		}),
	);
}

/**
 * Given a KeyServer, fetch the proof of possession (PoP) from the URL and verify it
 * against the pubkey. This should be used only rarely when the dapp uses a dynamic
 * set of key servers.
 *
 * @param server - The KeyServer to verify.
 * @returns - True if the key server is valid, false otherwise.
 */
export async function verifyKeyServer(
	server: KeyServer,
	timeout: number,
	apiKeyName?: string,
	apiKey?: string,
): Promise<boolean> {
	const requestId = crypto.randomUUID();
	const response = await fetch(server.url! + '/v1/service?service_id=' + server.objectId, {
		method: 'GET',
		headers: {
			'Content-Type': 'application/json',
			'Request-Id': requestId,
			'Client-Sdk-Type': 'typescript',
			'Client-Sdk-Version': PACKAGE_VERSION,
			...(apiKeyName && apiKey ? { apiKeyName: apiKey } : {}),
		},
		signal: AbortSignal.timeout(timeout),
	});

	await SealAPIError.assertResponse(response, requestId);
	verifyKeyServerVersion(response);
	const serviceResponse = await response.json();

	if (serviceResponse.service_id !== server.objectId) {
		return false;
	}
	const fullMsg = flatten([DST_POP, server.pk, fromHex(server.objectId)]);
	return bls12_381.verifyShortSignature(fromBase64(serviceResponse.pop), fullMsg, server.pk);
}

/**
 * Verify the key server version. Throws an `InvalidKeyServerError` if the version is not supported.
 *
 * @param response - The response from the key server.
 */
export function verifyKeyServerVersion(response: Response) {
	const keyServerVersion = response.headers.get('X-KeyServer-Version');
	if (keyServerVersion == null) {
		throw new InvalidKeyServerVersionError('Key server version not found');
	}
	if (new Version(keyServerVersion).older_than(SERVER_VERSION_REQUIREMENT)) {
		throw new InvalidKeyServerVersionError(
			`Key server version ${keyServerVersion} is not supported`,
		);
	}
}

export interface DerivedKey {
	toString(): string;
}

/**
 * A user secret key for the Boneh-Franklin BLS12381 scheme.
 * This is a wrapper around the G1Element type.
 */
export class BonehFranklinBLS12381DerivedKey implements DerivedKey {
	representation: string;

	constructor(public key: G1Element) {
		this.representation = toHex(key.toBytes());
	}

	toString(): string {
		return this.representation;
	}
}
