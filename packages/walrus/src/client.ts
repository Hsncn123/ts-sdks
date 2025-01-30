// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { SuiClient } from '@mysten/sui/client';

import { TESTNET_WALRUS_PACKAGE_CONFIG } from './constants.js';
import { StakingInnerV1 } from './contracts/staking_inner.js';
import { StakingPool } from './contracts/staking_pool.js';
import { Staking } from './contracts/staking.js';
import { SystemStateInnerV1 } from './contracts/system_state_inner.js';
import { System } from './contracts/system.js';
import { BlobMetadataWithId, SliverData } from './utils/bcs.js';
import {
	getMaxConcurrentSliverReads,
	getShardIndicesByNodeId,
	getSliverSizeForBlob,
	getSourceSymbols,
	toShardIndex,
} from './utils/index.js';
import { SuiObjectDataLoader } from './utils/object-loader.js';
import { TaskPool } from './utils/task-pool.js';
import { decodePrimarySlivers } from './wasm.js';

export interface WalrusPackageConfig {
	packageId: string;
	systemObjectId: string;
	stakingPoolId: string;
	exchangeIds?: string[];
}

export interface WalrusCommunicationConfig {
	maxDataInFlight?: number;
	maxConcurrentSliverReads?: number;
}

type SuiClientOrRpcUrl =
	| {
			suiClient: SuiClient;
			suiRpcUrl?: never;
	  }
	| {
			suiRpcUrl: string;
			suiClient?: never;
	  };

type WalrusNetworkOrPackageConfig =
	| {
			network: 'testnet';
			packageConfig?: WalrusPackageConfig;
	  }
	| {
			network?: never;
			packageConfig: WalrusPackageConfig;
	  };

export type WalrusClientConfig = {
	communicationConfig?: WalrusCommunicationConfig;
} & WalrusNetworkOrPackageConfig &
	SuiClientOrRpcUrl;

interface StorageNode {
	networkAddress: string;
	shardIndices: number[];
	id: string;
}

export class WalrusClient {
	#communicationConfig?: WalrusCommunicationConfig;
	#packageConfig: WalrusPackageConfig;

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
					this.#packageConfig = TESTNET_WALRUS_PACKAGE_CONFIG;
					break;
				default:
					throw new Error(`Unsupported network: ${network}`);
			}
		} else {
			this.#packageConfig = config.packageConfig!;
		}

		this.#communicationConfig = config.communicationConfig;

		this.#suiClient =
			config.suiClient ??
			new SuiClient({
				url: config.suiRpcUrl,
			});
		this.#objectLoader = new SuiObjectDataLoader(this.#suiClient);
	}

	#systemObject() {
		return this.#objectLoader.load(this.#packageConfig.systemObjectId, System());
	}

	#stakingObject() {
		return this.#objectLoader.load(this.#packageConfig.stakingPoolId, Staking());
	}

	async #getNodesWithoutCache() {
		const nodes = await this.#stakingPool();
		const shardIndicesByNodeId = getShardIndicesByNodeId((await this.stakingState()).committee);
		const byShardIndex = new Map<number, StorageNode>();
		const committee = nodes.map(({ node_info }) => {
			const shardIndices = shardIndicesByNodeId.get(node_info.node_id) ?? [];
			const node: StorageNode = {
				id: node_info.node_id,
				networkAddress: node_info.network_address,
				shardIndices,
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

	async #getNodeByShardIndex(index: number) {
		const nodes = await this.#getNodes();
		const node = nodes.byShardIndex.get(index);

		if (!node) {
			throw new Error(`Node for shard index ${index} not found`);
		}

		return node;
	}

	async #stakingPool() {
		return this.#objectLoader.loadManyOrThrow(
			(await this.systemState()).committee.members.map((member) => member.node_id),
			StakingPool(),
		);
	}

	async #fetchFromRandomNode(path: string, init: RequestInit) {
		const nodes = await this.#stakingPool();
		const nodeAddress = nodes[Math.floor(Math.random() * nodes.length)].node_info.network_address;

		const response = await fetch(`https://${nodeAddress}${path}`, init);

		if (!response.ok) {
			throw new Error(`Failed to fetch from node ${nodeAddress}: ${response.statusText}`);
		}

		return response;
	}

	async #fetchFromShard(index: number, path: string, init: RequestInit) {
		const node = await this.#getNodeByShardIndex(index);

		const response = await fetch(`https://${node.networkAddress}${path}`, init);

		if (!response.ok) {
			throw new Error(`Failed to fetch from node ${node.networkAddress}: ${response.statusText}`);
		}

		return response;
	}

	async systemState() {
		const systemState = await this.#objectLoader.loadFieldObject(
			this.#packageConfig.systemObjectId,
			{ type: 'u64', value: (await this.#stakingObject()).version },
			SystemStateInnerV1(),
		);

		return systemState;
	}

	async stakingState() {
		return this.#objectLoader.loadFieldObject(
			this.#packageConfig.stakingPoolId,
			{
				type: 'u64',
				value: (await this.#systemObject()).version,
			},
			StakingInnerV1(),
		);
	}

	async getBlobMetadata(blobId: string) {
		const res = await this.#fetchFromRandomNode(`/v1/blobs/${blobId}/metadata`, {
			method: 'GET',
		});

		return BlobMetadataWithId.parse(new Uint8Array(await res.arrayBuffer()));
	}

	async getSliver({
		blobId,
		sliverPairIndex,
		sliverType = 'primary',
		signal,
	}: {
		blobId: string;
		sliverPairIndex: number;
		sliverType?: 'primary' | 'secondary';
		signal?: AbortSignal;
	}) {
		const systemState = await this.systemState();
		const numShards = systemState.committee.n_shards;
		const shardIndex = toShardIndex(sliverPairIndex, blobId, numShards);

		const response = await this.#fetchFromShard(
			shardIndex,
			`/v1/blobs/${blobId}/slivers/${sliverPairIndex}/${sliverType}`,
			{
				method: 'GET',
				signal,
			},
		);

		return SliverData.parse(new Uint8Array(await response.arrayBuffer()));
	}

	async readBlob(blobId: string) {
		const systemState = await this.systemState();
		const numShards = systemState.committee.n_shards;
		const { primary: minSymbols } = getSourceSymbols(numShards);

		const slivers: (typeof SliverData.$inferType)[] = [];
		const blobMetadata = await this.getBlobMetadata(blobId);

		const unencodedLength = Number(blobMetadata.metadata.V1.unencoded_length);
		const concurrencyLimit = this.#getConcurrencyLimitForSliverReads(unencodedLength, numShards);
		const taskPool = new TaskPool(concurrencyLimit);

		// TODO: implement better shard selection logic
		const sliverPromises = new Array(numShards).fill(null).map((_, sliverPairIndex) =>
			taskPool
				.runTask((signal) => {
					return this.getSliver({ blobId, sliverPairIndex, signal }).then((response) => {
						slivers.push(response);

						if (slivers.length === minSymbols) {
							taskPool.abortPendingTasks();
						}
					});
				})
				.catch((error) => {
					// handle abort signal
					if (error.name === 'AbortError') {
						return;
					}

					throw error;
				}),
		);

		// TODO: implement retry/scheduling logic
		await Promise.allSettled(sliverPromises);

		if (slivers.length < minSymbols) {
			throw new Error('Not enough slivers to decode');
		}

		return decodePrimarySlivers(numShards, blobMetadata.metadata.V1.unencoded_length, slivers);
	}

	#getConcurrencyLimitForSliverReads(unencodedLength: number, nShards: number) {
		const maxDataInFlight = this.#communicationConfig?.maxDataInFlight ?? 12_500_000;
		const requestSize = getSliverSizeForBlob(unencodedLength, nShards);
		const sizeBasedLimit = maxDataInFlight / requestSize;

		const maxConcurrentSliverReads = this.#communicationConfig?.maxConcurrentSliverReads;
		const defaultLimit = maxConcurrentSliverReads ?? getMaxConcurrentSliverReads(nShards);

		return Math.max(1, Math.min(sizeBasedLimit, defaultLimit));
	}
}
