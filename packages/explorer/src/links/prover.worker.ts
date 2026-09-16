// The proving worker: loads the wallet wasm off the UI thread and serves the
// SDK's prover calls. Created by links/session.ts.
import { serveProver } from 'peal-links/worker';

serveProver(self as unknown as { onmessage: ((ev: MessageEvent) => void) | null; postMessage: (m: unknown) => void });
