/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const __wbg_blobencoder_free: (a: number, b: number) => void;
export const blobencoder_new: (a: number) => [number, number, number];
export const blobencoder_encoded_length: (a: number, b: bigint) => [number, number, number];
export const blobencoder_encode: (a: number, b: number, c: number) => [number, number, number];
export const blobencoder_encode_with_metadata: (a: number, b: number, c: number) => [number, number, number];
export const blobencoder_compute_metadata: (a: number, b: number, c: number) => [number, number, number];
export const blobencoder_decode_primary: (a: number, b: bigint, c: any) => [number, number, number];
export const blobencoder_decode_secondary: (a: number, b: bigint, c: any) => [number, number, number];
export const from_signed_messages_and_indices: (a: number, b: any, c: number, d: number) => [number, number, number];
export const bls12381_min_pk_verify: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const bls12381_min_pk_aggregate: (a: any) => [number, number, number, number];
export const bls12381_min_pk_verify_aggregate: (a: any, b: number, c: number, d: number, e: number) => [number, number, number];
export const blake2b256: (a: number, b: number) => [number, number];
export const rustsecp256k1_v0_8_1_context_create: (a: number) => number;
export const rustsecp256k1_v0_8_1_context_destroy: (a: number) => void;
export const rustsecp256k1_v0_8_1_default_illegal_callback_fn: (a: number, b: number) => void;
export const rustsecp256k1_v0_8_1_default_error_callback_fn: (a: number, b: number) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_export_4: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
