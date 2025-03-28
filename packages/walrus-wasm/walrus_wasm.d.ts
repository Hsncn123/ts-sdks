/* tslint:disable */
/* eslint-disable */
export function from_signed_messages_and_indices(message_type: MessageType, signed_messages: any, signer_indices: Uint16Array): any;
export function bls12381_min_pk_verify(signature: Uint8Array, public_key: Uint8Array, msg: Uint8Array): boolean;
/**
 * Aggregate a list of signatures.
 * The signatures must be of the type Vec<Vec<u8>> with each signature being a 96 bytes long serialized signature.
 */
export function bls12381_min_pk_aggregate(signatures: any): Uint8Array;
/**
 * Verify an aggregate signature.
 */
export function bls12381_min_pk_verify_aggregate(public_keys: any, msg: Uint8Array, signature: Uint8Array): boolean;
export function blake2b256(msg: Uint8Array): Uint8Array;
/**
 * The message type for the [ProtocolMessageCertificate].
 */
export enum MessageType {
  /**
   * Corresponds to [Confirmation]
   */
  Confirmation = 0,
  /**
   * Corresponds to [InvalidBlobIdMsg]
   */
  InvalidBlobIdMsg = 1,
}
export class BlobEncoder {
  free(): void;
  constructor(n_shards: number);
  /**
   * WASM wrapper for [walrus_core::encoding::blob_encoding::BlobEncoder::encode_with_metadata].
   * Returns a tuple with a vector of [walrus_core::encoding::slivers::SliverPair]´s and a [walrus_core::metadata::VerifiedBlobMetadataWithId]`.
   */
  encode_with_metadata(data: Uint8Array, encoding_type: number): any;
  /**
   * WASM wrapper for [walrus_core::encoding::blob_encoding::BlobEncoder::compute_metadata].
   * Returns [walrus_core::metadata::VerifiedBlobMetadataWithId].
   */
  compute_metadata(data: Uint8Array, encoding_type: number): any;
  /**
   * WASM wrapper for [walrus_core::encoding::blob_encoding::BlobEncoder::decode].
   * The input `slivers` is expected to be a `Vec<SliverData<Primary>>`.
   * See also [BlobEncoder::decode_secondary].
   * Returns `Vec<u8>`.
   */
  decode_primary(blob_id: any, blob_size: bigint, slivers: any, encoding_type: number): any;
}
