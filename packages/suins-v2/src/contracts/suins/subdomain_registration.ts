// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * A wrapper for `SuinsRegistration` subdomain objects.
 *
 * With the wrapper, we are allowing easier distinction between second level names
 * & subdomains in RPC Querying | filtering.
 *
 * We maintain all core functionality unchanged for registry, expiration etc.
 */

import { bcs } from '@mysten/sui/bcs';
import type { Transaction } from '@mysten/sui/transactions';
import { normalizeMoveArguments } from '../utils/index.js';
import type { RawTransactionArgument } from '../utils/index.js';
import * as object from './deps/sui/object.js';
import * as suins_registration from './suins_registration.js';
export function SubDomainRegistration() {
	return bcs.struct('SubDomainRegistration', {
		id: object.UID(),
		nft: suins_registration.SuinsRegistration(),
	});
}
export function init(packageAddress: string) {
	function nft(options: { arguments: [name: RawTransactionArgument<string>] }) {
		const argumentsTypes = [
			`${packageAddress}::subdomain_registration::SubDomainRegistration`,
		] satisfies string[];
		return (tx: Transaction) =>
			tx.moveCall({
				package: packageAddress,
				module: 'subdomain_registration',
				function: 'nft',
				arguments: normalizeMoveArguments(options.arguments, argumentsTypes),
			});
	}
	function nft_mut(options: { arguments: [name: RawTransactionArgument<string>] }) {
		const argumentsTypes = [
			`${packageAddress}::subdomain_registration::SubDomainRegistration`,
		] satisfies string[];
		return (tx: Transaction) =>
			tx.moveCall({
				package: packageAddress,
				module: 'subdomain_registration',
				function: 'nft_mut',
				arguments: normalizeMoveArguments(options.arguments, argumentsTypes),
			});
	}
	return { nft, nft_mut };
}
