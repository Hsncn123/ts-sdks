// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { InferBcsType } from '@mysten/bcs';
import { bcs, fromBase64 } from '@mysten/bcs';
import { SuiClient } from '@mysten/sui/client';
import type { Signer } from '@mysten/sui/cryptography';
import { coinWithBalance, Transaction } from '@mysten/sui/transactions';
import { bls12381_min_pk_verify } from '@mysten/walrus-wasm';

import { TESTNET_WALRUS_PACKAGE_CONFIG } from './constants.js';
import { Blob } from './contracts/blob.js';
import type { Committee } from './contracts/committee.js';
import { StakingInnerV1 } from './contracts/staking_inner.js';
import { StakingPool } from './contracts/staking_pool.js';
import { Staking } from './contracts/staking.js';
import { Storage } from './contracts/storage_resource.js';
import { SystemStateInnerV1 } from './contracts/system_state_inner.js';
import { init as initSystemContract, System } from './contracts/system.js';
import {
	BehindCurrentEpochError,
	BlobNotCertifiedError,
	NoBlobMetadataReceivedError,
	NotEnoughBlobConfirmationsError,
	NotEnoughSliversReceivedError,
	WalrusClientError,
} from './error.js';
import { StorageNodeClient } from './storage-node/client.js';
import { NotFoundError, UserAbortError } from './storage-node/error.js';
import type { BlobStatus } from './storage-node/types.js';
import type {
	CertifyBlobOptions,
	DeleteBlobOptions,
	ExtendBlobOptions,
	GetCertificationEpochOptions,
	GetStorageConfirmationOptions,
	GetVerifiedBlobStatusOptions,
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
	getMaxFaultyNodes,
	getPrimarySourceSymbols,
	getShardIndicesByNodeId,
	isQuorum,
	signersToBitmap,
	storageUnitsFromSize,
	toPairIndex,
	toShardIndex,
} from './utils/index.js';
import { SuiObjectDataLoader } from './utils/object-loader.js';
import { PromiseQueue } from './utils/promise-queue.js';
import { getRandom } from './utils/randomness.js';
import { combineSignatures, decodePrimarySlivers, encodeBlob } from './wasm.js';

export class WalrusClient {
	#storageNodeClient: StorageNodeClient;

	packageConfig: WalrusPackageConfig;
	#suiClient: SuiClient;
	#objectLoader: SuiObjectDataLoader;
	activeCommittee?:
		| {
				byShardIndex: Map<number, StorageNode>;
				nodes: StorageNode[];
		  }
		| Promise<{
				byShardIndex: Map<number, StorageNode>;
				nodes: StorageNode[];
		  }>;

	constructor(config: WalrusClientConfig) {
		if (config.network && !config.packageConfig) {
			const network = config.network;
			switch (network) {
				case 'testnet':
					this.packageConfig = TESTNET_WALRUS_PACKAGE_CONFIG;
					break;
				default:
					throw new WalrusClientError(`Unsupported network: ${network}`);
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

	readBlob = this.#retryOnPossibleEpochChange(this.#internalReadBlob);

	async #internalReadBlob({ blobId, signal }: ReadBlobOptions) {
		const certificationEpoch = await this.getCertificationEpoch({ blobId, signal });
		const committee = await this.#getReadCommittee(certificationEpoch);

		const systemState = await this.systemState();
		const numShards = systemState.committee.n_shards;
		const minSymbols = getPrimarySourceSymbols(numShards);

		const randomStorageNode = getRandom(committee.nodes);

		const blobMetadata = await this.#storageNodeClient.getBlobMetadata(
			{ blobId },
			{ nodeUrl: randomStorageNode.networkUrl, signal },
		);

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
			throw new NotEnoughSliversReceivedError('Not enough slivers to decode');
		}

		return decodePrimarySlivers(numShards, blobMetadata.metadata.V1.unencoded_length, slivers);
	}

	/**
	 * Gets the blob status from multiple storage nodes the returns the latest status that can be verified.
	 */
	async getVerifiedBlobStatus({ blobId, signal }: GetVerifiedBlobStatusOptions) {
		const controller = new AbortController();
		signal?.addEventListener('abort', () => {
			controller.abort();
		});

		// Read from the latest committee because, during epoch change, it is the committee
		// that will have the most up-to-date information on old and newly certified blobs:
		const committee = await this.#getActiveCommittee();

		const stakingState = await this.stakingState();
		const numShards = stakingState.n_shards;

		const queue = new PromiseQueue<BlobStatus>({ maxConcurrency: 10 });
		const executors = committee.nodes.map((node) => ({
			weight: node.shardIndices.length,
			executor: async () => {
				const result = await this.#storageNodeClient.getBlobStatus(
					{ blobId },
					{ nodeUrl: node.networkUrl, signal: controller.signal },
				);
				return result.success.data;
			},
		}));

		const statuses = await new Promise<{ status: BlobStatus; weight: number }[]>(
			(resolve, reject) => {
				const results: { status: BlobStatus; weight: number }[] = [];
				let successWeight = 0;
				let numNotFoundWeight = 0;
				let settledCount = 0;

				executors.forEach(({ executor, weight }) => {
					queue
						.add(executor)
						.then((status) => {
							if (isQuorum(successWeight, numShards)) {
								controller.abort('Blob statuses retrieved successfully.');
								resolve(results);
							} else {
								successWeight += weight;
								results.push({ status, weight });
							}
						})
						.catch((error) => {
							if (error instanceof NotFoundError) {
								numNotFoundWeight += weight;
							} else if (error instanceof UserAbortError) {
								reject(error);
							}

							if (isQuorum(numNotFoundWeight, numShards)) {
								const abortError = new BlobNotCertifiedError('Blob does not exist');
								controller.abort(abortError);
								reject(abortError);
							}
						})
						.finally(() => {
							settledCount += 1;
							if (settledCount === executors.length) {
								reject(new NoBlobMetadataReceivedError('fb'));
							}
						});
				});
			},
		);

		const uniqueResults = statuses.reduce((acc, result) => {
			const { status, weight } = result;
			const key = typeof status === 'object' ? Object.keys(status)[0] : status;

			if (acc.has(key)) {
				acc.set(key, acc.get(key) + weight);
			} else {
				acc.set(key, weight);
			}

			return acc;
		}, new Map());

		console.log('ff', uniqueResults);
	}

	async getCertificationEpoch({ blobId, signal }: GetCertificationEpochOptions) {
		const stakingState = await this.stakingState();
		const currentEpoch = stakingState.epoch;

		if (stakingState.epoch_state.$kind === 'EpochChangeSync') {
			const status = await this.getVerifiedBlobStatus({ blobId, signal });
			if (typeof status !== 'object' || 'invalid' in status) {
				throw new BlobNotCertifiedError(
					`The specified blob ${blobId} is either non-existent or invalid.`,
				);
			}

			const data = 'permanent' in status ? status.permanent : status.deletable;
			if (typeof data.initial_certified_epoch !== 'number') {
				throw new BlobNotCertifiedError(`The specified blob ${blobId} is not certified.`);
			}

			if (data.initial_certified_epoch > currentEpoch) {
				throw new BehindCurrentEpochError(
					`The client is at epoch ${currentEpoch} while the specified blob was certified at epoch ${data.initial_certified_epoch}.`,
				);
			}

			return data.initial_certified_epoch;
		}

		return currentEpoch;
	}

	async #getReadCommittee(certificationEpoch: number) {
		const stakingState = await this.stakingState();
		const isTransitioning = stakingState.epoch_state.$kind === 'EpochChangeSync';

		let readCommittee: InferBcsType<ReturnType<typeof Committee>> | undefined;
		if (isTransitioning && certificationEpoch < stakingState.epoch) {
			readCommittee = stakingState.previous_committee;
		} else {
			readCommittee = stakingState.committee;
		}

		return await this.#getCommittee(readCommittee);
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
			throw new WalrusClientError('Storage object not found in transaction effects');
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
			throw new WalrusClientError('Blob object not found in transaction effects');
		}

		return {
			digest,
			blob: Blob().fromBase64(suiBlobObject.data.bcs.bcsBytes),
		};
	}

	async certifyBlob({ blobId, blobObjectId, confirmations }: CertifyBlobOptions) {
		const systemState = await this.systemState();
		const committee = await this.#getActiveCommittee();

		if (confirmations.length !== systemState.committee.members.length) {
			throw new WalrusClientError(
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
						new Uint8Array(committee.nodes[index].info.public_key.bytes),
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
		const committee = await this.#getActiveCommittee();
		const node = committee.nodes[nodeIndex];

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
		const committee = await this.#getActiveCommittee();
		const node = committee.nodes[nodeIndex];

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
		const committee = await this.#getActiveCommittee();
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

		const maxFaulty = getMaxFaultyNodes(systemState.committee.n_shards);
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
					failures += committee.nodes[nodeIndex].shardIndices.length;

					if (failures > maxFaulty) {
						controller.abort();

						throw new NotEnoughBlobConfirmationsError(
							`Too many failures while writing blob ${blobId} to nodes`,
						);
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
			throw new WalrusClientError(`Failed to ${action}: ${effects?.status.error}`);
		}

		await this.#suiClient.waitForTransaction({
			digest,
		});

		return { digest, effects };
	}

	async #getCommittee(committee: InferBcsType<ReturnType<typeof Committee>>) {
		const stakingPool = await this.#stakingPool(committee);
		const shardIndicesByNodeId = getShardIndicesByNodeId(committee);

		const byShardIndex = new Map<number, StorageNode>();
		const nodes = stakingPool.map(({ node_info }, nodeIndex) => {
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
			nodes,
		};
	}

	async #getActiveCommittee() {
		if (!this.activeCommittee) {
			const stakingState = await this.stakingState();
			this.activeCommittee = this.#getCommittee(stakingState.committee);
			this.activeCommittee = await this.activeCommittee;
		}

		return this.activeCommittee;
	}

	async #stakingPool(committee: InferBcsType<ReturnType<typeof Committee>>) {
		const nodeIds = committee.pos0.contents.map((node) => node.key);
		return this.#objectLoader.loadManyOrThrow(nodeIds, StakingPool());
	}

	async #getNodeByShardIndex(index: number) {
		const nodes = await this.#getActiveCommittee();
		const node = nodes.byShardIndex.get(index);

		if (!node) {
			throw new WalrusClientError(`Node for shard index ${index} not found`);
		}

		return node;
	}

	#retryOnPossibleEpochChange<T extends (...args: any[]) => any>(fn: T): T {
		return ((...args: Parameters<T>) => {
			try {
				return fn(...args);
			} catch (error) {
				if (
					error instanceof BlobNotCertifiedError ||
					error instanceof BehindCurrentEpochError ||
					error instanceof NoBlobMetadataReceivedError ||
					error instanceof NotEnoughSliversReceivedError ||
					error instanceof NotEnoughBlobConfirmationsError
				) {
					this.#objectLoader.clearAll();
					return fn(...args);
				}

				throw error;
			}
		}) as T;
	}
}
