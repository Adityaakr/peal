/* tslint:disable */
/* eslint-disable */

/**
 * The fixed instantiation plus loaded keys. Building the instance runs the
 * Poseidon parameter generation once (about a second in wasm), so the SDK
 * keeps one `Prover` per worker.
 */
export class Prover {
    free(): void;
    [Symbol.dispose](): void;
    abort_pending(wallet_json: string): string;
    /**
     * Record an incoming receipt opening (decrypted from the inbox).
     */
    add_receipt(wallet_json: string, position: bigint, opening_json: string, reference?: string | null): string;
    commit_pending(wallet_json: string, position: bigint): string;
    /**
     * The wallet's current commitment (to compare with the ledger's).
     */
    commitment(wallet_json: string): string;
    /**
     * A fresh wallet for `namespace` (hex) under `circuit_id` (hex). Returns
     * the wallet JSON; the SDK encrypts it before storing.
     */
    create_wallet(namespace: string, circuit_id: string): string;
    /**
     * The ledger minted the intent's receipt at `position`.
     */
    deposit_minted(wallet_json: string, receipt: string, position: bigint): string;
    export_backup(wallet_json: string, passphrase: string): string;
    fulfillment_ack(wallet_json: string, request_id: string, position: bigint): string;
    has_keys(): boolean;
    import_backup(backup_json: string, passphrase: string): string;
    inbox_auth(wallet_json: string): string;
    key_binding(wallet_json: string, seq: bigint): string;
    /**
     * Load the four parameter files (downloaded by digest). Verifying keys
     * are point-validated; proving keys are trusted by digest (see
     * `pk_from_bytes_with`). The circuit id is recomputed and must match
     * `expected`.
     */
    load_keys(op_pk: Uint8Array, op_vk: Uint8Array, deposit_pk: Uint8Array, deposit_vk: Uint8Array, expected_circuit_id: string): any;
    /**
     * Encrypt the wallet for local storage under the storage key (cheap;
     * runs on every state change).
     */
    lock_wallet(wallet_json: string, key_hex: string): string;
    /**
     * Mark the wallet registered (after the ledger accepted the envelope).
     */
    mark_registered(wallet_json: string): string;
    constructor();
    new_request_id(): string;
    /**
     * A fresh random storage key (hex). Wrapped with the passphrase by
     * `wrap_key`; used by `lock_wallet` on every save.
     */
    new_storage_key(): string;
    /**
     * Open an inbox envelope with the wallet's key. Returns the delivery
     * JSON `{ opening, position, reference }`.
     */
    open_receipt(wallet_json: string, envelope_json: string): string;
    /**
     * Prepare a deposit intent: returns `{ wallet, intent }`. The wallet JSON
     * must be persisted before the on-chain transfer is signed.
     */
    prepare_deposit(wallet_json: string, amount: string, reference?: string | null): any;
    /**
     * Prepare and prove the claim of held receipt `idx`.
     */
    receive(wallet_json: string, idx: number, path_json: string): any;
    /**
     * Resolve an unknown outcome from the ledger's commitment. Returns
     * `{ wallet, value: "in_sync" | "committed" | "aborted" | "conflict" }`.
     */
    reconcile(wallet_json: string, ledger_com: string, position?: bigint | null): any;
    register_envelope(wallet_json: string): string;
    /**
     * Seal a receipt opening (plus position and reference) to a recipient's
     * encryption key. Returns the envelope JSON to post to the inbox.
     */
    seal_receipt(namespace: string, recipient_enc_key: string, opening_json: string, position: bigint, reference?: string | null): string;
    /**
     * Prepare and prove a send. Returns `{ wallet, envelope, opening }`; the
     * wallet is now pending and must be persisted before submission.
     */
    send(wallet_json: string, amount: string, to: string, root: string, reference?: string | null): any;
    sign_request(wallet_json: string, request_id: string, amount: string, title: string, display_name: string, receiver_address: string, reference?: string | null, expires_at?: bigint | null): string;
    unlock_wallet(locked_json: string, key_hex: string): string;
    unwrap_key(wrapped_json: string, passphrase: string): string;
    /**
     * Verify held receipt `idx` against a served path. Returns the updated
     * wallet JSON; the receipt's status becomes `Unclaimed` or `Invalid`.
     */
    verify_receipt(wallet_json: string, idx: number, path_json: string): any;
    /**
     * Verify a manifest a payer received. Errors describe why it is not
     * trustworthy.
     */
    verify_request(manifest_json: string): void;
    /**
     * Public facts about a wallet: account id, encryption key, balances,
     * receipts, history, pending state. No secrets.
     */
    wallet_view(wallet_json: string): any;
    /**
     * Prepare and prove a withdrawal of `amount` to the EVM `recipient`: a
     * send to the burn identifier. Returns `{ wallet, envelope, opening }`.
     */
    withdraw(wallet_json: string, amount: string, recipient: string, root: string): any;
    /**
     * The signed disclosure for the withdrawal committed at `position`.
     */
    withdrawal_claim(wallet_json: string, position: bigint): string;
    /**
     * Wrap the storage key under a passphrase (argon2id, once per setup).
     */
    wrap_key(key_hex: string, passphrase: string): string;
}

export function start(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_prover_free: (a: number, b: number) => void;
    readonly prover_abort_pending: (a: number, b: number, c: number) => [number, number, number, number];
    readonly prover_add_receipt: (a: number, b: number, c: number, d: bigint, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly prover_commit_pending: (a: number, b: number, c: number, d: bigint) => [number, number, number, number];
    readonly prover_commitment: (a: number, b: number, c: number) => [number, number, number, number];
    readonly prover_create_wallet: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly prover_deposit_minted: (a: number, b: number, c: number, d: number, e: number, f: bigint) => [number, number, number, number];
    readonly prover_export_backup: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly prover_fulfillment_ack: (a: number, b: number, c: number, d: number, e: number, f: bigint) => [number, number, number, number];
    readonly prover_has_keys: (a: number) => number;
    readonly prover_import_backup: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly prover_inbox_auth: (a: number, b: number, c: number) => [number, number, number, number];
    readonly prover_key_binding: (a: number, b: number, c: number, d: bigint) => [number, number, number, number];
    readonly prover_load_keys: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly prover_lock_wallet: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly prover_mark_registered: (a: number, b: number, c: number) => [number, number, number, number];
    readonly prover_new: () => number;
    readonly prover_new_request_id: (a: number) => [number, number];
    readonly prover_new_storage_key: (a: number) => [number, number];
    readonly prover_open_receipt: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly prover_prepare_deposit: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly prover_receive: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly prover_reconcile: (a: number, b: number, c: number, d: number, e: number, f: number, g: bigint) => [number, number, number];
    readonly prover_register_envelope: (a: number, b: number, c: number) => [number, number, number, number];
    readonly prover_seal_receipt: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: bigint, i: number, j: number) => [number, number, number, number];
    readonly prover_send: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
    readonly prover_sign_request: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: bigint) => [number, number, number, number];
    readonly prover_unlock_wallet: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly prover_unwrap_key: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly prover_verify_receipt: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly prover_verify_request: (a: number, b: number, c: number) => [number, number];
    readonly prover_wallet_view: (a: number, b: number, c: number) => [number, number, number];
    readonly prover_withdraw: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly prover_withdrawal_claim: (a: number, b: number, c: number, d: bigint) => [number, number, number, number];
    readonly prover_wrap_key: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly start: () => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
