// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { bcs, fromBase64 } from '@mysten/bcs';
import { SuiClient } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { coinWithBalance, Transaction } from '@mysten/sui/transactions';
import { bls12381_min_pk_verify } from '@mysten/walrus-wasm';

import { TESTNET_WALRUS_PACKAGE_CONFIG } from './constants.js';
import { Blob } from './contracts/blob.js';
import { StakingInnerV1 } from './contracts/staking_inner.js';
import { StakingPool } from './contracts/staking_pool.js';
import { Staking } from './contracts/staking.js';
import { Storage } from './contracts/storage_resource.js';
import { SystemStateInnerV1 } from './contracts/system_state_inner.js';
import { init as initSystemContract, System } from './contracts/system.js';
import { StorageNodeClient } from './storage-node/client.js';
import { LegallyUnavailableError, NotFoundError } from './storage-node/error.js';
import type {
	CertifyBlobOptions,
	DeleteBlobOptions,
	ExtendBlobOptions,
	GetStorageConfirmationOptions,
	ReadBlobOptions,
	RegisterBlobOptions,
	SliversForNode,
	StorageNode,
	StorageWithSizeOptions,
	WalrusClientConfig,
	WalrusPackageConfig,
	WriteBlobOptions,
	WriteEncodedBlobOptions,
	WriteMetadataOptions,
	WriteSliverOptions,
	WriteSliversToNodeOptions,
} from './types.js';
import { blobIdToInt, IntentType, SliverData, StorageConfirmation } from './utils/bcs.js';
import {
	encodedBlobLength,
	getPrimarySourceSymbols,
	getShardIndicesByNodeId,
	isQuorum,
	signersToBitmap,
	storageUnitsFromSize,
	toPairIndex,
	toShardIndex,
} from './utils/index.js';
import { SuiObjectDataLoader } from './utils/object-loader.js';
import { shuffle } from './utils/randomness.js';
import { combineSignatures, decodePrimarySlivers, encodeBlob } from './wasm.js';

export class WalrusClient {
	#storageNodeClient: StorageNodeClient;

	packageConfig: WalrusPackageConfig;
	#suiClient: SuiClient;
	#objectLoader: SuiObjectDataLoader;
	#nodes?:
		| {
				byShardIndex: Map<number, StorageNode>;
				committee: StorageNode[];
		  }
		| Promise<{
				byShardIndex: Map<number, StorageNode>;
				committee: StorageNode[];
		  }>;

	constructor(config: WalrusClientConfig) {
		if (config.network && !config.packageConfig) {
			const network = config.network;
			switch (network) {
				case 'testnet':
					this.packageConfig = TESTNET_WALRUS_PACKAGE_CONFIG;
					break;
				default:
					throw new Error(`Unsupported network: ${network}`);
			}
		} else {
			this.packageConfig = config.packageConfig!;
		}

		this.#suiClient =
			config.suiClient ??
			new SuiClient({
				url: config.suiRpcUrl,
			});

		this.#storageNodeClient = new StorageNodeClient(config.storageNodeClientOptions);
		this.#objectLoader = new SuiObjectDataLoader(this.#suiClient);
	}

	get walType() {
		return `${this.packageConfig.walPackageId}::wal::WAL`;
	}

	get blobType() {
		return `${this.packageConfig.packageId}::blob::Blob`;
	}

	get storageType() {
		return `${this.packageConfig.packageId}::storage_resource::Storage`;
	}

	get systemContract() {
		return initSystemContract(this.packageConfig.packageId);
	}

	systemObject() {
		return this.#objectLoader.load(this.packageConfig.systemObjectId, System());
	}

	stakingObject() {
		return this.#objectLoader.load(this.packageConfig.stakingPoolId, Staking());
	}

	async systemState() {
		const systemState = await this.#objectLoader.loadFieldObject(
			this.packageConfig.systemObjectId,
			{ type: 'u64', value: (await this.stakingObject()).version },
			SystemStateInnerV1(),
		);

		return systemState;
	}

	async stakingState() {
		return this.#objectLoader.loadFieldObject(
			this.packageConfig.stakingPoolId,
			{
				type: 'u64',
				value: (await this.systemObject()).version,
			},
			StakingInnerV1(),
		);
	}

	async #retrieveBlobMetadata({ blobId, signal }: ReadBlobOptions) {
		const systemState = await this.systemState();
		const nodes = await this.#getNodes();

		const numShards = systemState.committee.n_shards;
		// TODO: Fix in-place shuffle
		const randomizedNodes = shuffle([...nodes.committee]);

		let numNotFoundErrors = 0;
		let numBlockedErrors = 0;

		const controller = new AbortController();
		signal?.addEventListener('abort', () => {
			controller.abort();
		});

		function chunk(array: any[], size: number) {
			return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
				array.slice(i * size, (i + 1) * size),
			);
		}

		// Chunk an array of nodes into arrays of size 15
		const chunkedNodes = chunk(randomizedNodes, 15);

		const result = await Promise.any(
			chunkedNodes.map(async (nodes) => {
				for (const node of nodes) {
					controller.signal.throwIfAborted();
					try {
						return await this.#storageNodeClient.getBlobMetadata(
							{ blobId },
							{ nodeUrl: node.networkUrl, signal: controller.signal },
						);
					} catch (error) {
						if (error instanceof NotFoundError) {
							numNotFoundErrors += node.shardIndices.length;
						} else if (error instanceof LegallyUnavailableError) {
							numBlockedErrors += node.shardIndices.length;
						} else if (controller.signal.aborted) {
							throw error;
						}

						if (isQuorum(numBlockedErrors + numNotFoundErrors, numShards)) {
							if (numNotFoundErrors > numBlockedErrors) {
								const abortError = new Error('customize dis (not found)');
								controller.abort(abortError);
								throw abortError;
							} else {
								const abortError = new Error('customize dis (blocked)');
								controller.abort(abortError);
								throw abortError;
							}
						}
					}
				}

				throw new Error('TODO: Write error message');
			}),
		);

		// Cancel any existing in-flight requests:
		controller.abort();

		return result;
	}

	async readBlob({ blobId, signal }: ReadBlobOptions) {
		const systemState = await this.systemState();
		const numShards = systemState.committee.n_shards;
		const minSymbols = getPrimarySourceSymbols(numShards);

		const blobMetadata = await this.#retrieveBlobMetadata({ blobId, signal });
		console.log('META', blobMetadata);

		// TODO: implement better shard selection logic
		const sliverPromises = Array.from({ length: minSymbols }).map(async (_, shardIndex) => {
			const storageNode = await this.#getNodeByShardIndex(shardIndex);
			const sliverPairIndex = toPairIndex(shardIndex, blobId, numShards);

			return await this.#storageNodeClient.getSliver(
				{ blobId, sliverPairIndex, sliverType: 'primary' },
				{ nodeUrl: storageNode.networkUrl, signal },
			);
		});

		// TODO: implement retry/scheduling logic
		const sliverResults = await Promise.allSettled(sliverPromises);
		const slivers = sliverResults
			.map((result) => (result.status === 'fulfilled' ? result.value : null))
			.filter((sliver) => !!sliver);

		if (slivers.length < minSymbols) {
			throw new Error('Not enough slivers to decode');
		}

		return decodePrimarySlivers(numShards, blobMetadata.metadata.V1.unencoded_length, slivers);
	}

	async storageCost(size: number, epochs: number) {
		const systemState = await this.systemState();
		const encodedSize = encodedBlobLength(size, systemState.committee.n_shards);
		const storageUnits = storageUnitsFromSize(encodedSize);
		const storageCost =
			BigInt(storageUnits) * BigInt(systemState.storage_price_per_unit_size) * BigInt(epochs);
		BigInt(epochs);

		const writeCost = BigInt(storageUnits) * BigInt(systemState.write_price_per_unit_size);

		return { storageCost, writeCost, totalCost: storageCost + writeCost };
	}

	async createStorage({ size, epochs, walCoin }: StorageWithSizeOptions) {
		const systemObject = await this.systemObject();
		const systemState = await this.systemState();
		const encodedSize = encodedBlobLength(size, systemState.committee.n_shards);
		const { storageCost } = await this.storageCost(size, epochs);

		return (tx: Transaction) => {
			const coin = walCoin
				? tx.splitCoins(walCoin, [storageCost])[0]
				: tx.add(
						coinWithBalance({
							balance: storageCost,
							type: this.walType,
						}),
					);

			const storage = tx.add(
				this.systemContract.reserve_space({
					arguments: [systemObject.id.id, encodedSize, epochs, coin],
				}),
			);
			tx.moveCall({
				target: '0x2::coin::destroy_zero',
				typeArguments: [this.walType],
				arguments: [coin],
			});

			return storage;
		};
	}

	async createStorageTransaction({
		transaction = new Transaction(),
		size,
		epochs,
		owner,
	}: StorageWithSizeOptions & { transaction?: Transaction; owner: string }) {
		transaction.transferObjects([await this.createStorage({ size, epochs })], owner);

		return transaction;
	}

	async executeCreateStorageTransaction({
		signer,
		...options
	}: StorageWithSizeOptions & { transaction?: Transaction; signer: Signer }) {
		const transaction = await this.createStorageTransaction({
			...options,
			owner: options.transaction?.getData().sender ?? signer.toSuiAddress(),
		});

		const { digest, effects } = await this.#executeTransaction(
			transaction,
			signer,
			'create storage',
		);

		const createdObjectIds = effects?.created?.map((effect) => effect.reference.objectId) ?? [];

		const createdObjects = await this.#suiClient.multiGetObjects({
			ids: createdObjectIds,
			options: {
				showType: true,
				showBcs: true,
			},
		});

		const suiBlobObject = createdObjects.find((object) => object.data?.type === this.blobType);

		if (!suiBlobObject || suiBlobObject.data?.bcs?.dataType !== 'moveObject') {
			throw new Error('Storage object not found in transaction effects');
		}

		return {
			digest,
			blob: Storage().fromBase64(suiBlobObject.data.bcs.bcsBytes),
		};
	}

	async registerBlob({ size, epochs, blobId, rootHash, deletable, walCoin }: RegisterBlobOptions) {
		const storage = await this.createStorage({ size, epochs, walCoin });
		const { writeCost } = await this.storageCost(size, epochs);

		return (tx: Transaction) => {
			const writeCoin = walCoin
				? tx.splitCoins(walCoin, [writeCost])[0]
				: tx.add(
						coinWithBalance({
							balance: writeCost,
							type: this.walType,
						}),
					);

			const blob = tx.add(
				this.systemContract.register_blob({
					arguments: [
						tx.object(this.packageConfig.systemObjectId),
						storage,
						blobIdToInt(blobId),
						BigInt(bcs.u256().parse(rootHash)),
						size,
						0,
						deletable,
						writeCoin,
					],
				}),
			);

			tx.moveCall({
				target: '0x2::coin::destroy_zero',
				typeArguments: [this.walType],
				arguments: [writeCoin],
			});

			return blob;
		};
	}

	async registerBlobTransaction({
		transaction = new Transaction(),
		owner,
		...options
	}: RegisterBlobOptions & { transaction?: Transaction; owner: string }) {
		const registration = transaction.add(await this.registerBlob(options));

		transaction.transferObjects([registration], owner);

		return transaction;
	}

	async executeRegisterBlobTransaction({
		signer,
		...options
	}: RegisterBlobOptions & { transaction?: Transaction; signer: Signer; owner?: string }): Promise<{
		blob: ReturnType<typeof Blob>['$inferType'];
		digest: string;
	}> {
		const transaction = await this.registerBlobTransaction({
			...options,
			owner: options.owner ?? options.transaction?.getData().sender ?? signer.toSuiAddress(),
		});

		const { digest, effects } = await this.#executeTransaction(
			transaction,
			signer,
			'register blob',
		);

		const createdObjectIds = effects?.created?.map((effect) => effect.reference.objectId) ?? [];

		const createdObjects = await this.#suiClient.multiGetObjects({
			ids: createdObjectIds,
			options: {
				showType: true,
				showBcs: true,
			},
		});

		const suiBlobObject = createdObjects.find((object) => object.data?.type === this.blobType);

		if (!suiBlobObject || suiBlobObject.data?.bcs?.dataType !== 'moveObject') {
			throw new Error('Blob object not found in transaction effects');
		}

		return {
			digest,
			blob: Blob().fromBase64(suiBlobObject.data.bcs.bcsBytes),
		};
	}

	async certifyBlob({ blobId, blobObjectId, confirmations }: CertifyBlobOptions) {
		const systemState = await this.systemState();
		const nodes = await this.#getNodes();

		if (confirmations.length !== systemState.committee.members.length) {
			throw new Error(
				'Invalid number of confirmations. Confirmations array must contain an entry for each node',
			);
		}

		const confirmationMessage = StorageConfirmation.serialize({
			intent: IntentType.BLOB_CERT_MSG,
			epoch: systemState.committee.epoch,
			messageContents: {
				blobId,
				blobType: {
					Permanent: null,
				},
			},
		}).toBase64();

		const filteredConfirmations = confirmations
			.map((confirmation, index) => {
				const isValid =
					confirmation?.serializedMessage === confirmationMessage &&
					bls12381_min_pk_verify(
						fromBase64(confirmation.signature),
						new Uint8Array(nodes.committee[index].info.public_key.bytes),
						fromBase64(confirmation.serializedMessage),
					);

				return isValid
					? {
							index,
							...confirmation,
						}
					: null;
			})
			.filter((confirmation) => confirmation !== null);

		const combinedSignature = combineSignatures(
			filteredConfirmations,
			filteredConfirmations.map(({ index }) => index),
		);

		return (tx: Transaction) => {
			this.systemContract.certify_blob({
				arguments: [
					tx.object(this.packageConfig.systemObjectId),
					tx.object(blobObjectId),
					tx.pure.vector('u8', fromBase64(combinedSignature.signature)),
					tx.pure.vector(
						'u8',
						signersToBitmap(combinedSignature.signers, systemState.committee.members.length),
					),
					tx.pure.vector('u8', combinedSignature.serializedMessage),
				],
			});
		};
	}

	async certifyBlobTransaction({
		transaction = new Transaction(),
		blobId,
		blobObjectId,
		confirmations,
	}: CertifyBlobOptions & {
		transaction?: Transaction;
	}) {
		transaction.add(await this.certifyBlob({ blobId, blobObjectId, confirmations }));

		return transaction;
	}

	async executeCertifyBlobTransaction({
		signer,
		...options
	}: CertifyBlobOptions & {
		transaction?: Transaction;
		signer: Signer;
	}) {
		const transaction = await this.certifyBlobTransaction(options);

		const { digest } = await this.#executeTransaction(transaction, signer, 'certify blob');

		return { digest };
	}

	deleteBlob({ blobObjectId }: DeleteBlobOptions) {
		return (tx: Transaction) =>
			tx.moveCall({
				package: this.packageConfig.systemObjectId,
				module: 'system',
				function: 'delete_blob',
				arguments: [tx.object(this.packageConfig.systemObjectId), tx.object(blobObjectId)],
			});
	}

	deleteBlobTransaction({
		owner,
		blobObjectId,
		transaction = new Transaction(),
	}: DeleteBlobOptions & { transaction?: Transaction; owner: string }) {
		transaction.transferObjects([this.deleteBlob({ blobObjectId })], owner);

		return transaction;
	}

	async executeDeleteBlobTransaction({
		signer,
		transaction = new Transaction(),
		blobObjectId,
	}: DeleteBlobOptions & { signer: Signer; transaction?: Transaction }) {
		const { digest } = await this.#executeTransaction(
			this.deleteBlobTransaction({
				blobObjectId,
				transaction,
				owner: transaction.getData().sender ?? signer.toSuiAddress(),
			}),
			signer,
			'delete blob',
		);

		return { digest };
	}

	async extendBlob({ blobObjectId, epochs, endEpoch, walCoin }: ExtendBlobOptions) {
		const blob = await this.#objectLoader.load(blobObjectId, Blob());
		const numEpochs = typeof epochs === 'number' ? epochs : endEpoch - blob.storage.end_epoch;

		if (numEpochs <= 0) {
			return (_tx: Transaction) => {};
		}

		const { storageCost } = await this.storageCost(Number(blob.storage.storage_size), numEpochs);

		return (tx: Transaction) => {
			const coin = walCoin
				? tx.splitCoins(walCoin, [storageCost])[0]
				: tx.add(
						coinWithBalance({
							balance: storageCost,

							type: this.walType,
						}),
					);

			tx.add(
				this.systemContract.extend_blob({
					arguments: [
						tx.object(this.packageConfig.systemObjectId),
						tx.object(blobObjectId),
						numEpochs,
						coin,
					],
				}),
			);

			tx.moveCall({
				target: '0x2::coin::destroy_zero',
				typeArguments: [this.walType],
				arguments: [coin],
			});
		};
	}

	async extendBlobTransaction({
		transaction = new Transaction(),
		...options
	}: ExtendBlobOptions & { transaction?: Transaction }) {
		transaction.add(await this.extendBlob(options));

		return transaction;
	}

	async executeExtendBlobTransaction({
		signer,
		...options
	}: ExtendBlobOptions & { signer: Signer; transaction?: Transaction }) {
		const { digest } = await this.#executeTransaction(
			await this.extendBlobTransaction(options),
			signer,
			'extend blob',
		);

		return { digest };
	}

	async writeSliver({ blobId, sliverPairIndex, sliverType, sliver, signal }: WriteSliverOptions) {
		const systemState = await this.systemState();
		const shardIndex = toShardIndex(sliverPairIndex, blobId, systemState.committee.n_shards);
		const node = await this.#getNodeByShardIndex(shardIndex);

		return await this.#storageNodeClient.storeSliver(
			{ blobId, sliverPairIndex, sliverType, sliver },
			{ nodeUrl: node.networkUrl, signal },
		);
	}

	async writeMetadataToNode({ nodeIndex, blobId, metadata, signal }: WriteMetadataOptions) {
		const nodes = await this.#getNodes();
		const node = nodes.committee[nodeIndex];

		return await this.#storageNodeClient.storeBlobMetadata(
			{ blobId, metadata },
			{ nodeUrl: node.networkUrl, signal },
		);
	}

	async getStorageConfirmationFromNode({
		nodeIndex,
		blobId,
		deletable,
		objectId,
		signal,
	}: GetStorageConfirmationOptions) {
		const nodes = await this.#getNodes();
		const node = nodes.committee[nodeIndex];

		const result = deletable
			? await this.#storageNodeClient.getDeletableBlobConfirmation(
					{ blobId, objectId },
					{ nodeUrl: node.networkUrl, signal },
				)
			: await this.#storageNodeClient.getPermanentBlobConfirmation(
					{ blobId },
					{ nodeUrl: node.networkUrl, signal },
				);

		return result;
	}

	async encodeBlob(blob: Uint8Array) {
		const systemState = await this.systemState();
		const numShards = systemState.committee.n_shards;
		const { blobId, metadata, sliverPairs, rootHash } = encodeBlob(numShards, blob);

		const sliversByNodeMap = new Map<number, SliversForNode>();

		while (sliverPairs.length > 0) {
			// remove from list so we don't preserve references to the original data
			const { primary, secondary } = sliverPairs.pop()!;
			const sliverPairIndex = primary.index;

			const shardIndex = toShardIndex(sliverPairIndex, blobId, numShards);
			const node = await this.#getNodeByShardIndex(shardIndex);

			if (!sliversByNodeMap.has(node.nodeIndex)) {
				sliversByNodeMap.set(node.nodeIndex, { primary: [], secondary: [] });
			}

			sliversByNodeMap.get(node.nodeIndex)!.primary.push({
				sliverIndex: primary.index,
				sliverPairIndex,
				shardIndex,
				sliver: SliverData.serialize(primary).toBytes(),
			});

			sliversByNodeMap.get(node.nodeIndex)!.secondary.push({
				sliverIndex: secondary.index,
				sliverPairIndex,
				shardIndex,
				sliver: SliverData.serialize(secondary).toBytes(),
			});
		}

		const sliversByNode = new Array<SliversForNode>();

		for (let i = 0; i < systemState.committee.members.length; i++) {
			sliversByNode.push(sliversByNodeMap.get(i) ?? { primary: [], secondary: [] });
		}

		return { blobId, metadata, rootHash, sliversByNode };
	}

	async writeSliversToNode({ blobId, slivers, signal }: WriteSliversToNodeOptions) {
		const controller = new AbortController();

		signal?.addEventListener('abort', () => {
			controller.abort();
		});

		const primarySliverWrites = slivers.primary.map(({ sliverPairIndex, sliver }) => {
			return this.writeSliver({
				blobId,
				sliverPairIndex,
				sliverType: 'primary',
				sliver,
				signal: controller.signal,
			});
		});

		const secondarySliverWrites = slivers.secondary.map(({ sliverPairIndex, sliver }) => {
			return this.writeSliver({
				blobId,
				sliverPairIndex,
				sliverType: 'secondary',
				sliver,
				signal: controller.signal,
			});
		});

		await Promise.all([...primarySliverWrites, ...secondarySliverWrites]).catch((error) => {
			controller.abort();
			throw error;
		});
	}

	async writeEncodedBlobToNode({
		nodeIndex,
		blobId,
		metadata,
		slivers,
		signal,
		...options
	}: WriteEncodedBlobOptions) {
		await this.writeMetadataToNode({
			nodeIndex,
			blobId,
			metadata,
			signal,
		});

		await this.writeSliversToNode({ blobId, slivers, signal, nodeIndex });

		return this.getStorageConfirmationFromNode({
			nodeIndex,
			blobId,
			...options,
		});
	}

	async writeBlob({ blob, deletable, epochs, signer, signal, owner }: WriteBlobOptions) {
		const systemState = await this.systemState();
		const nodes = await this.#getNodes();
		const controller = new AbortController();

		signal?.addEventListener('abort', () => {
			controller.abort();
		});

		const { sliversByNode, blobId, metadata, rootHash } = await this.encodeBlob(blob);

		const suiBlobObject = await this.executeRegisterBlobTransaction({
			signer,
			size: blob.length,
			epochs,
			blobId,
			rootHash,
			deletable,
			owner,
		});

		const blobObjectId = suiBlobObject.blob.id.id;

		const maxFaulty = Math.floor((systemState.committee.n_shards - 1) / 3);
		let failures = 0;

		const confirmations = await Promise.all(
			sliversByNode.map((slivers, nodeIndex) => {
				return this.writeEncodedBlobToNode({
					blobId,
					nodeIndex,
					metadata,
					slivers,
					deletable: false,
					signal: controller.signal,
				}).catch(() => {
					failures += nodes.committee[nodeIndex].shardIndices.length;

					if (failures > maxFaulty) {
						controller.abort();

						throw new Error(`Too many failures while writing blob ${blobId} to nodes`);
					}

					return null;
				});
			}),
		);

		await this.executeCertifyBlobTransaction({
			signer,
			blobId,
			blobObjectId,
			confirmations,
		});

		return {
			blobId,
			blobObject: await this.#objectLoader.load(blobObjectId, Blob()),
		};
	}

	async #executeTransaction(transaction: Transaction, signer: Signer, action: string) {
		const { digest, effects } = await this.#suiClient.signAndExecuteTransaction({
			transaction,
			signer,
			options: {
				showEffects: true,
			},
		});

		if (effects?.status.status !== 'success') {
			throw new Error(`Failed to ${action}: ${effects?.status.error}`);
		}

		await this.#suiClient.waitForTransaction({
			digest,
		});

		return { digest, effects };
	}

	async #getNodesWithoutCache() {
		const nodes = await this.#stakingPool();
		const shardIndicesByNodeId = getShardIndicesByNodeId((await this.stakingState()).committee);
		const byShardIndex = new Map<number, StorageNode>();
		const committee = nodes.map(({ node_info }, nodeIndex) => {
			const shardIndices = shardIndicesByNodeId.get(node_info.node_id) ?? [];
			const node: StorageNode = {
				id: node_info.node_id,
				info: node_info,
				networkUrl: `https://${node_info.network_address}`,
				shardIndices,
				nodeIndex,
			};

			for (const shardIndex of shardIndices) {
				byShardIndex.set(shardIndex, node);
			}

			return node;
		});

		return {
			byShardIndex,
			committee,
		};
	}

	async #getNodes() {
		if (!this.#nodes) {
			this.#nodes = this.#getNodesWithoutCache();
			this.#nodes = await this.#nodes;
		}

		return this.#nodes;
	}

	async #stakingPool() {
		return this.#objectLoader.loadManyOrThrow(
			(await this.systemState()).committee.members.map((member) => member.node_id),
			StakingPool(),
		);
	}

	async #getNodeByShardIndex(index: number) {
		const nodes = await this.#getNodes();
		const node = nodes.byShardIndex.get(index);

		if (!node) {
			throw new Error(`Node for shard index ${index} not found`);
		}

		return node;
	}
}
