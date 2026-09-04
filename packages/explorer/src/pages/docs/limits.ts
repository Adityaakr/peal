import type { DocsPage } from '../../docs';

export const limits: DocsPage = {
  title: 'Limits and errors',
  lede: 'What the server enforces and what it returns when you cross it.',
  html: `
<h2>Limits and trust</h2>
        <p>The parts worth knowing before you put something real on this.</p>
        <div class="dev-limits">
          <div><span>payload</span><strong>5 MB</strong><p>Per sealed blob.</p></div>
          <div><span>rate</span><strong>50/s</strong><p>Per IP, bursting to 400.</p></div>
          <div><span>batch</span><strong>64</strong><p>Padded with decoys, so a quiet condition
          does not announce how few sealed to it.</p></div>
          <div><span>committee</span><strong>3 of 5</strong><p>Any three operators can open a
          batch. Any two cannot.</p></div>
        </div>
        <h3>Security model</h3>
        <p>Payloads are encrypted in your process against the committee's public parameters, whose
        digest the client verifies before using them, so a coordinator serving inconsistent
        parameters fails loudly. The coordinator stores ciphertexts and never holds a key that
        opens one on its own. Opening a batch takes three of the five operators; two cannot.</p>
        <p>Every reveal is checkable after the fact: payloads come back with their positions and a
        merkle root over the set, and positions are derived from the ciphertext hashes rather than
        arrival order, so a batch cannot be reordered or quietly edited. The
        <a href="#/protocol">protocol reference</a> documents the committee, the ceremony and the
        full threat model, and the <a href="#/developers/network">activity dashboard</a> counts every reveal the
        network has performed.</p>
        <p>This is the v0 devnet. Parameters, addresses and endpoints are stable, and the committee
        composition is documented in the protocol reference.</p>`,
};
