// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { assert } from 'console';
import { fromBase64, fromHex, toBase64, toHex } from '@mysten/bcs';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { describe, expect, it } from 'vitest';

import { AesGcm256 } from '../../src/aes';
import { encrypt } from '../../src/encrypt';
import {
	getAllowlistedKeyServers,
	retrieveKeyServers,
	verifyKeyServer,
} from '../../src/key-server';
import { KeyStore } from '../../src/key-store';
import { RequestFormat, SessionKey } from '../../src/session-key';
import { EncryptedObject } from '../../src/types';

/**
 * Helper function
 * @param packageId
 * @param moduleName
 * @param suiAddress
 * @param suiClient
 * @param innerId
 * @returns
 */
async function constructTxBytes(
	packageId: Uint8Array,
	moduleName: string,
	suiAddress: string,
	suiClient: SuiClient,
	innerId: string,
): Promise<Uint8Array> {
	const tx = new Transaction();
	tx.setSender(suiAddress);
	tx.moveCall({
		target: `${toHex(packageId)}::${moduleName}::seal_approve`,
		arguments: [
			tx.pure.address(suiAddress),
			tx.pure.vector('u8', fromHex(innerId)),
			tx.object(innerId),
		],
	});
	return await tx.build({ client: suiClient, onlyTransactionKind: true });
}

describe('Integration test', () => {
	it('should work', async () => {
		const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
		const TESTNET_PACKAGE_ID = '0xff5127342c89d81ec65ffca43f706c37cb9d938af3b6e15a778820d4f25eee36';
		// This whitelist contains address 0xb743cafeb5da4914cef0cf0a32400c9adfedc5cdb64209f9e740e56d23065100
		const whitelistId = '0x3e49ecd4e6e3e2553cf341f55fb5763ce2b4508be622f611236f923fef845ad1';

		const data = new Uint8Array([1, 2, 3]);
		const keyServers = await retrieveKeyServers({
			objectIds: getAllowlistedKeyServers('testnet'),
			client: suiClient,
		});
		keyServers.map((service) => {
			if (!verifyKeyServer(service)) {
				throw new Error(`Service not verified ${service.name}`);
			}
			return service;
		});
		const { encryptedObject: encryptedBytes } = await encrypt({
			keyServers,
			threshold: keyServers.length,
			packageId: fromHex(TESTNET_PACKAGE_ID),
			id: fromHex(whitelistId),
			encryptionInput: new AesGcm256(data, new Uint8Array()),
		});
		const encryptedObject = EncryptedObject.parse(encryptedBytes);

		const keypair = Ed25519Keypair.fromSecretKey(
			'suiprivkey1qqgzvw5zc2zmga0uyp4rzcgk42pzzw6387zqhahr82pp95yz0scscffh2d8',
		);
		const suiAddress = keypair.getPublicKey().toSuiAddress();
		assert(suiAddress === '0xb743cafeb5da4914cef0cf0a32400c9adfedc5cdb64209f9e740e56d23065100');
		const txBytes = await constructTxBytes(
			fromHex(TESTNET_PACKAGE_ID),
			'whitelist',
			suiAddress,
			suiClient,
			whitelistId,
		);

		const sessionKey = new SessionKey(fromHex(TESTNET_PACKAGE_ID), 1);
		const message = sessionKey.getPersonalMessage();

		const { signature } = await keypair.signPersonalMessage(message);

		sessionKey.setPersonalMessageSignature(signature);

		const keyStore = new KeyStore();
		await keyStore.fetchKeys({
			keyServers,
			threshold: encryptedObject.threshold,
			packageId: new Uint8Array(encryptedObject.package_id),
			ids: [new Uint8Array(encryptedObject.id)],
			txBytes,
			sessionKey,
		});

		const decryptedBytes = await keyStore.decrypt(encryptedObject);
		expect(decryptedBytes).toEqual(data);
	});

	it('request format consistency', async () => {
		const ptb = fromBase64(
			'AwAgc6azwz4tYzg95cZ4bLrKIx/3ifTIU69tVMuIPYeArcAAISDe5uvO0j2U0BiVWEGtjdvQnUC72Sq201YSNqRReUMvBQEB3ubrztI9lNAYlVhBrY3b0J1Au9kqttNWEjakUXlDLwUDAAAAAAAAAAABALHxZ0ncLwzAjQNFRWiOb7wXhst+Zg+aiJfb/iAC64pLCXdoaXRlbGlzdAxzZWFsX2FwcHJvdmUAAwEAAAEBAAECAA==',
		);
		const eg_pk = fromBase64('kYnVekxioRVbLVBBuxK0AkRI5cOqrpsfYF9+MM7U/5mes7Ihn/FPv0alcf2r/W5v');
		const eg_vk = fromBase64(
			'meFzamsJjgsVK0aOOoEZvFgMyRG+bHLHQ3PkTA+FwdiXxivxFpnR0g7nYBo6g8nLCgIHwb+N4UY9A4Vt4yFuRdZIUveHqwqH4n4yGdCOj3nmOAGxQGC7cBR6sQ+0znbm',
		);
		const requestFormat = RequestFormat.serialize({
			ptb: ptb,
			enc_key: eg_pk,
			enc_verification_key: eg_vk,
		}).toBytes();
		expect(toBase64(requestFormat)).toEqual(
			'tQEDACBzprPDPi1jOD3lxnhsusojH/eJ9MhTr21Uy4g9h4CtwAAhIN7m687SPZTQGJVYQa2N29CdQLvZKrbTVhI2pFF5Qy8FAQHe5uvO0j2U0BiVWEGtjdvQnUC72Sq201YSNqRReUMvBQMAAAAAAAAAAAEAsfFnSdwvDMCNA0VFaI5vvBeGy35mD5qIl9v+IALriksJd2hpdGVsaXN0DHNlYWxfYXBwcm92ZQADAQAAAQEAAQIAMJGJ1XpMYqEVWy1QQbsStAJESOXDqq6bH2BffjDO1P+ZnrOyIZ/xT79GpXH9q/1ub2CZ4XNqawmOCxUrRo46gRm8WAzJEb5scsdDc+RMD4XB2JfGK/EWmdHSDudgGjqDycsKAgfBv43hRj0DhW3jIW5F1khS94erCofifjIZ0I6PeeY4AbFAYLtwFHqxD7TOduY=',
		);
	});
});
