// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Experimental_CoreClient } from '../core.js';
import type { Experimental_SuiClientTypes } from '../types.js';
import type { GraphQLQueryOptions, SuiGraphQLClient } from '../../graphql/client.js';
import type {
	Object_Owner_FieldsFragment,
	Object_FieldsFragment,
	Transaction_FieldsFragment,
} from '../../graphql/generated/queries.js';
import {
	DryRunTransactionBlockDocument,
	ExecuteTransactionBlockDocument,
	GetAllBalancesDocument,
	GetBalanceDocument,
	GetCoinsDocument,
	GetDynamicFieldsDocument,
	GetOwnedObjectsDocument,
	GetReferenceGasPriceDocument,
	GetTransactionBlockDocument,
	MultiGetObjectsDocument,
	ResolveNameServiceNamesDocument,
	VerifyZkLoginSignatureDocument,
	ZkLoginIntentScope,
} from '../../graphql/generated/queries.js';
import { ObjectError } from '../errors.js';
import { fromBase64, toBase64 } from '@mysten/utils';
import { normalizeStructTag, normalizeSuiAddress } from '../../utils/sui-types.js';
import { deriveDynamicFieldID } from '../../utils/dynamic-fields.js';
import { parseTransactionBcs, parseTransactionEffectsBcs } from './utils.js';

export class GraphQLTransport extends Experimental_CoreClient {
	#graphqlClient: SuiGraphQLClient;

	constructor({
		graphqlClient,
		mvr,
	}: {
		graphqlClient: SuiGraphQLClient;
		mvr?: Experimental_SuiClientTypes.MvrOptions;
	}) {
		super({ network: graphqlClient.network, base: graphqlClient, mvr });
		this.#graphqlClient = graphqlClient;
	}

	async #graphqlQuery<
		Result = Record<string, unknown>,
		Variables = Record<string, unknown>,
		Data = Result,
	>(
		options: GraphQLQueryOptions<Result, Variables>,
		getData?: (result: Result) => Data,
	): Promise<NonNullable<Data>> {
		const { data, errors } = await this.#graphqlClient.query(options);

		handleGraphQLErrors(errors);

		const extractedData = data && (getData ? getData(data) : data);

		if (extractedData == null) {
			throw new Error('Missing response data');
		}

		return extractedData as NonNullable<Data>;
	}

	async getObjects(
		options: Experimental_SuiClientTypes.GetObjectsOptions,
	): Promise<Experimental_SuiClientTypes.GetObjectsResponse> {
		const objects: Object_FieldsFragment[] = [];

		let hasNextPage = true;
		let cursor: string | null = null;

		while (hasNextPage) {
			const objectsPage = await this.#graphqlQuery(
				{
					query: MultiGetObjectsDocument,
					variables: {
						objectIds: options.objectIds,
						cursor,
					},
				},
				(result) => result.objects,
			);

			objects.push(...objectsPage.nodes);
			hasNextPage = objectsPage.pageInfo.hasNextPage;
			cursor = (objectsPage.pageInfo.endCursor ?? null) as string | null;
		}

		return {
			objects: options.objectIds
				.map((id) => normalizeSuiAddress(id))
				.map(
					(id) =>
						objects.find((obj) => obj.address === id) ??
						new ObjectError('notFound', `Object ${id} not found`),
				)
				.map((obj) => {
					if (obj instanceof ObjectError) {
						return obj;
					}
					return {
						id: obj.address,
						version: obj.version.toString(),
						digest: obj.digest!,
						owner: mapOwner(obj.owner!),
						type: obj.asMoveObject?.contents?.type?.repr!,
						content: Promise.resolve(
							obj.asMoveObject?.contents?.bcs
								? fromBase64(obj.asMoveObject.contents.bcs)
								: new Uint8Array(),
						),
					};
				}),
		};
	}
	async getOwnedObjects(
		options: Experimental_SuiClientTypes.GetOwnedObjectsOptions,
	): Promise<Experimental_SuiClientTypes.GetOwnedObjectsResponse> {
		const objects = await this.#graphqlQuery(
			{
				query: GetOwnedObjectsDocument,
				variables: {
					owner: options.address,
					limit: options.limit,
					cursor: options.cursor,
					filter: options.type ? { type: options.type } : undefined,
				},
			},
			(result) => result.address?.objects,
		);

		return {
			objects: objects.nodes.map((obj) => ({
				id: obj.address,
				version: obj.version.toString(),
				digest: obj.digest!,
				owner: mapOwner(obj.owner!),
				type: obj.contents?.type?.repr!,
				content: Promise.resolve(
					obj.contents?.bcs ? fromBase64(obj.contents.bcs) : new Uint8Array(),
				),
			})),
			hasNextPage: objects.pageInfo.hasNextPage,
			cursor: objects.pageInfo.endCursor ?? null,
		};
	}
	async getCoins(
		options: Experimental_SuiClientTypes.GetCoinsOptions,
	): Promise<Experimental_SuiClientTypes.GetCoinsResponse> {
		const coins = await this.#graphqlQuery(
			{
				query: GetCoinsDocument,
				variables: {
					owner: options.address,
					cursor: options.cursor,
					first: options.limit,
					type: options.coinType,
				},
			},
			(result) => result.address?.coins,
		);

		return {
			cursor: coins.pageInfo.endCursor ?? null,
			hasNextPage: coins.pageInfo.hasNextPage,
			objects: coins.nodes.map((coin) => ({
				id: coin.address,
				version: coin.version.toString(),
				digest: coin.digest!,
				owner: mapOwner(coin.owner!),
				type: coin.contents?.type?.repr!,
				balance: coin.coinBalance,
				content: Promise.resolve(
					coin.contents?.bcs ? fromBase64(coin.contents.bcs) : new Uint8Array(),
				),
			})),
		};
	}

	async getBalance(
		options: Experimental_SuiClientTypes.GetBalanceOptions,
	): Promise<Experimental_SuiClientTypes.GetBalanceResponse> {
		const result = await this.#graphqlQuery(
			{
				query: GetBalanceDocument,
				variables: { owner: options.address, type: options.coinType },
			},
			(result) => result.address?.balance,
		);

		return {
			balance: {
				coinType: result.coinType.repr,
				balance: result.totalBalance,
			},
		};
	}
	async getAllBalances(
		options: Experimental_SuiClientTypes.GetAllBalancesOptions,
	): Promise<Experimental_SuiClientTypes.GetAllBalancesResponse> {
		const balances = await this.#graphqlQuery(
			{
				query: GetAllBalancesDocument,
				variables: { owner: options.address },
			},
			(result) => result.address?.balances,
		);

		return {
			cursor: balances.pageInfo.endCursor ?? null,
			hasNextPage: balances.pageInfo.hasNextPage,
			balances: balances.nodes.map((balance) => ({
				coinType: balance.coinType.repr,
				balance: balance.totalBalance,
			})),
		};
	}
	async getTransaction(
		options: Experimental_SuiClientTypes.GetTransactionOptions,
	): Promise<Experimental_SuiClientTypes.GetTransactionResponse> {
		const result = await this.#graphqlQuery(
			{
				query: GetTransactionBlockDocument,
				variables: { digest: options.digest },
			},
			(result) => result.transactionBlock,
		);

		return {
			transaction: parseTransaction(result),
		};
	}
	async executeTransaction(
		options: Experimental_SuiClientTypes.ExecuteTransactionOptions,
	): Promise<Experimental_SuiClientTypes.ExecuteTransactionResponse> {
		const result = await this.#graphqlQuery(
			{
				query: ExecuteTransactionBlockDocument,
				variables: { txBytes: toBase64(options.transaction), signatures: options.signatures },
			},
			(result) => result.executeTransactionBlock,
		);

		if (result.errors) {
			if (result.errors.length === 1) {
				throw new Error(result.errors[0]);
			}
			throw new AggregateError(result.errors.map((error) => new Error(error)));
		}

		return {
			transaction: parseTransaction(result.effects.transactionBlock!),
		};
	}
	async dryRunTransaction(
		options: Experimental_SuiClientTypes.DryRunTransactionOptions,
	): Promise<Experimental_SuiClientTypes.DryRunTransactionResponse> {
		const result = await this.#graphqlQuery(
			{
				query: DryRunTransactionBlockDocument,
				variables: { txBytes: toBase64(options.transaction) },
			},
			(result) => result.dryRunTransactionBlock,
		);

		if (result.error) {
			throw new Error(result.error);
		}

		return {
			transaction: parseTransaction(result.transaction!),
		};
	}
	async getReferenceGasPrice(): Promise<Experimental_SuiClientTypes.GetReferenceGasPriceResponse> {
		const result = await this.#graphqlQuery(
			{
				query: GetReferenceGasPriceDocument,
			},
			(result) => result.epoch?.referenceGasPrice,
		);

		return {
			referenceGasPrice: result.referenceGasPrice,
		};
	}

	async getDynamicFields(
		options: Experimental_SuiClientTypes.GetDynamicFieldsOptions,
	): Promise<Experimental_SuiClientTypes.GetDynamicFieldsResponse> {
		const result = await this.#graphqlQuery(
			{
				query: GetDynamicFieldsDocument,
				variables: { parentId: options.parentId },
			},
			(result) => result.owner?.dynamicFields,
		);

		return {
			dynamicFields: result.nodes.map((dynamicField) => {
				const valueType =
					dynamicField.value?.__typename === 'MoveObject'
						? dynamicField.value.contents?.type?.repr!
						: dynamicField.value?.type.repr!;
				return {
					id: deriveDynamicFieldID(
						options.parentId,
						dynamicField.name?.type.repr!,
						dynamicField.name?.bcs!,
					),
					type: normalizeStructTag(
						dynamicField.value?.__typename === 'MoveObject'
							? `0x2::dynamic_field::Field<0x2::dynamic_object_field::Wrapper<${dynamicField.name?.type.repr}>,0x2::object::ID>`
							: `0x2::dynamic_field::Field<${dynamicField.name?.type.repr},${valueType}>`,
					),
					name: {
						type: dynamicField.name?.type.repr!,
						bcs: fromBase64(dynamicField.name?.bcs!),
					},
					valueType,
				};
			}),
			cursor: result.pageInfo.endCursor ?? null,
			hasNextPage: result.pageInfo.hasNextPage,
		};
	}

	async verifyZkLoginSignature(
		options: Experimental_SuiClientTypes.VerifyZkLoginSignatureOptions,
	): Promise<Experimental_SuiClientTypes.ZkLoginVerifyResponse> {
		const intentScope =
			options.intentScope === 'TransactionData'
				? ZkLoginIntentScope.TransactionData
				: ZkLoginIntentScope.PersonalMessage;

		const result = await this.#graphqlQuery(
			{
				query: VerifyZkLoginSignatureDocument,
				variables: {
					bytes: options.bytes,
					signature: options.signature,
					intentScope,
					author: options.author,
				},
			},
			(result) => result.verifyZkloginSignature,
		);

		return {
			success: result.success,
			errors: result.errors,
		};
	}

	async resolveNameServiceNames(
		options: Experimental_SuiClientTypes.ResolveNameServiceNamesOptions,
	): Promise<Experimental_SuiClientTypes.ResolveNameServiceNamesResponse> {
		const suinsRegistrations = await this.#graphqlQuery(
			{
				query: ResolveNameServiceNamesDocument,
				signal: options.signal,
				variables: {
					address: options.address,
					cursor: options.cursor,
					limit: options.limit,
				},
			},
			(result) => result.address?.suinsRegistrations,
		);

		return {
			hasNextPage: suinsRegistrations.pageInfo.hasNextPage,
			nextCursor: suinsRegistrations.pageInfo.endCursor ?? null,
			data: suinsRegistrations.nodes.map((node) => node.domain) ?? [],
		};
	}

	resolveTransactionPlugin(): never {
		throw new Error('GraphQL client does not support transaction resolution yet');
	}
}
export type GraphQLResponseErrors = Array<{
	message: string;
	locations?: { line: number; column: number }[];
	path?: (string | number)[];
}>;

function handleGraphQLErrors(errors: GraphQLResponseErrors | undefined): void {
	if (!errors || errors.length === 0) return;

	const errorInstances = errors.map((error) => new GraphQLResponseError(error));

	if (errorInstances.length === 1) {
		throw errorInstances[0];
	}

	throw new AggregateError(errorInstances);
}

class GraphQLResponseError extends Error {
	locations?: Array<{ line: number; column: number }>;

	constructor(error: GraphQLResponseErrors[0]) {
		super(error.message);
		this.locations = error.locations;
	}
}

function mapOwner(owner: Object_Owner_FieldsFragment): Experimental_SuiClientTypes.ObjectOwner {
	switch (owner.__typename) {
		case 'AddressOwner':
			return { $kind: 'AddressOwner', AddressOwner: owner.owner?.asAddress?.address };
		case 'ConsensusAddressOwner':
			return {
				$kind: 'ConsensusAddressOwner',
				ConsensusAddressOwner: {
					owner: owner.owner?.address,
					startVersion: owner.startVersion,
				},
			};
		case 'Immutable':
			return { $kind: 'Immutable', Immutable: true };
		case 'Parent':
			return { $kind: 'ObjectOwner', ObjectOwner: owner.parent?.address };
		case 'Shared':
			return { $kind: 'Shared', Shared: owner.initialSharedVersion };
	}
}

function parseTransaction(
	transaction: Transaction_FieldsFragment,
): Experimental_SuiClientTypes.TransactionResponse {
	const objectTypes: Record<string, string> = {};

	transaction.effects?.unchangedSharedObjects.nodes.forEach((node) => {
		if (node.__typename === 'SharedObjectRead') {
			const type = node.object?.asMoveObject?.contents?.type.repr;
			const address = node.object?.asMoveObject?.address;

			if (type && address) {
				objectTypes[address] = type;
			}
		}
	});

	transaction.effects?.objectChanges.nodes.forEach((node) => {
		const address = node.address;
		const type =
			node.inputState?.asMoveObject?.contents?.type.repr ??
			node.outputState?.asMoveObject?.contents?.type.repr;

		if (address && type) {
			objectTypes[address] = type;
		}
	});

	return {
		digest: transaction.digest!,
		effects: parseTransactionEffectsBcs(new Uint8Array(transaction.effects?.bcs!)),
		epoch: transaction.effects?.epoch?.epochId ?? null,
		objectTypes: Promise.resolve(objectTypes),
		transaction: parseTransactionBcs(transaction.bcs!),
		signatures: transaction.signatures!,
	};
}
