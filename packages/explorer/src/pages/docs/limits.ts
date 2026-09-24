import type { DocsPage } from '../../docs';
import { DEVNET_RING } from '../../operators';

export const limits: DocsPage = {
  title: 'Limits and errors',
  lede: 'What the server enforces and what it returns when you cross it.',
  html: `
<h2>Limits and trust</h2>
        <p>The parts worth knowing before you put something real on this.</p>
        <div class="dev-limits">
          <div><span>payload</span><strong>5 MB</strong><p>Per sealed blob.</p></div>
          <div><span>rate</span><strong>50/s</strong><p>Per IP, bursting to 400.</p></div>
          <div><span>batch</span><strong>64 (v0)</strong><p>Padded with decoys; a v1 committee
          has no fixed size. The count is not published at all until a round opens, and padded
          once it has.</p></div>
          <div><span>committee</span><strong>3 of 5 (v0)</strong><p>Independent operators, none
          trusted: on the hosted v0 committee any three open a batch, two cannot; a v1 committee
          reports its own t of n. ${DEVNET_RING}.</p></div>
        </div>
        <h3>Security model</h3>
        <p>Payloads are encrypted in your process against the committee's public parameters, whose
        digest the client verifies before using them, so a coordinator serving inconsistent
        parameters fails loudly. The coordinator stores ciphertexts and never holds a key that
        opens one on its own. Opening a batch takes the committee's threshold of operators (three
        of the five on the hosted v0 committee); fewer cannot.</p>
        <p>Every reveal is checkable after the fact: payloads come back with their positions and a
        merkle root over the set, and positions are derived from the ciphertext hashes rather than
        arrival order, so a batch cannot be reordered or quietly edited. The
        <a href="#/protocol">protocol reference</a> documents the committee, the ceremony and the
        full threat model, and the <a href="#/developers/network">activity dashboard</a> counts every reveal the
        network has performed.</p>
        <p><strong>The hosted committee is v0, and its keys come from a single offline
        dealer.</strong> The committee is ${DEVNET_RING}, five independent operators, none of
        them trusted. A v0 committee had its key shares dealt by one ceremony rather than a
        distributed key generation, so whoever ran the ceremony could have kept the trapdoor; a
        v1 committee takes its key from a DKG, with no dealer and no machine ever holding the
        whole key, and which one a committee runs is shown by its scheme. The threshold, the
        pairing checks and the merkle root are real and verifiable today; on v0 the ceremony is
        the assumption that remains, and v1 is unaudited. Build and integrate against this. Do
        not put value behind it.</p>
        <p>This is the v0 devnet. Parameters, addresses and endpoints are stable, and the committee
        parameters are documented in the protocol reference.</p>`,
};
