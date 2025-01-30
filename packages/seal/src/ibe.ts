// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { IBEEncryptionsType, VerifiedKeyServerInfo } from './api.js';
import type { GTElement } from './bls12381.js';
import { G1Element, G2Element, Scalar } from './bls12381.js';
import { kdf } from './kdf.js';
import { xor } from './utils.js';

export interface IBEServers {
	get_object_ids(): string[];
	encrypt_batched(id: Uint8Array, msgs: Uint8Array[], infos: Uint8Array[]): IBEEncryptionsType;
	size(): number;
}

/**
 * Identity-based encryption based on the Boneh-Franklin IBE scheme.
 * This object represents a set of key servers that can be used to encrypt messages for a given identity.
 */
export class BonehFranklinBLS12381Services implements IBEServers {
	public readonly public_keys: G2Element[];
	private readonly object_ids: string[];

	constructor(services: VerifiedKeyServerInfo[]) {
		this.public_keys = services.map((service) => G2Element.fromBytes(service.pk));
		this.object_ids = services.map((service) => service.id);
	}

	get_object_ids(): string[] {
		return this.object_ids;
	}

	size(): number {
		return this.public_keys.length;
	}

	encrypt_batched(id: Uint8Array, msgs: Uint8Array[], infos: Uint8Array[]): IBEEncryptionsType {
		if (
			this.public_keys.length === 0 ||
			this.public_keys.length !== msgs.length ||
			this.public_keys.length !== infos.length
		) {
			throw new Error('Invalid input');
		}
		const [nonce, keys] = encap_batched(this.public_keys, id);
		keys.map((key, i) => (msgs[i] = xor(msgs[i], kdf(key, infos[i]))));

		return {
			BonehFranklinBLS12381: {
				encapsulation: nonce.toBytes(),
				shares: msgs,
			},
			$kind: 'BonehFranklinBLS12381',
		};
	}

	/**
	 * Returns true if the user secret key is valid for the given public key and id.
	 * @param user_secret_key
	 * @param id
	 * @param public_key
	 */
	static verify_user_secret_key(
		user_secret_key: G1Element,
		id: Uint8Array,
		public_key: G2Element,
	): boolean {
		const lhs = user_secret_key.pairing(G2Element.generator()).toBytes();
		const rhs = G1Element.hashToCurve(id).pairing(public_key).toBytes();
		return lhs.length === rhs.length && lhs.every((value, index) => value === rhs[index]);
	}

	/**
	 * Identity-based decryption.
	 *
	 * @param nonce The encryption nonce.
	 * @param sk The user secret key.
	 * @param ciphertext The encrypted message.
	 * @param info An info parameter also included in the KDF.
	 * @returns The decrypted message.
	 */
	static decrypt(
		nonce: G2Element,
		sk: G1Element,
		ciphertext: Uint8Array,
		info: Uint8Array,
	): Uint8Array {
		return xor(ciphertext, kdf(decap(nonce, sk), info));
	}
}

/**
 * Batched identity-based key-encapsulation mechanism: encapsulate multiple keys for given identity using different key servers.
 *
 * @param public_keys Public keys for a set of key servers.
 * @param id The identity used to encapsulate the keys.
 * @returns A common nonce of the keys and a list of keys, 32 bytes each.
 */
function encap_batched(public_keys: G2Element[], id: Uint8Array): [G2Element, GTElement[]] {
	if (public_keys.length === 0) {
		throw new Error('Invalid input');
	}
	const r = Scalar.random();
	const nonce = G2Element.generator().multiply(r);
	const gid = G1Element.hashToCurve(id).multiply(r);
	return [nonce, public_keys.map((public_key) => gid.pairing(public_key))];
}

/**
 * Decapsulate a key using a user secret key and the nonce.
 *
 * @param usk The user secret key.
 * @param nonce The nonce.
 * @returns The encapsulated key.
 */
function decap(nonce: G2Element, usk: G1Element): GTElement {
	return usk.pairing(nonce);
}
