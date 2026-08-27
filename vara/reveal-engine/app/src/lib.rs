#![no_std]

//! Peal reveal engine: the committee's reveal-root computation, on Vara.eth.
//!
//! ## What this is for
//!
//! In AuctionKit today, the committee computes a merkle root over every
//! revealed bid, signs it, and posts it to Ethereum. The chain checks the
//! signatures but cannot check the arithmetic: a committee that builds the tree
//! wrongly, or omits a bid, produces a root that verifies as *signed* while
//! being *wrong*, and the only thing that catches it is a bidder noticing their
//! own bid was voided and disputing.
//!
//! This program recomputes the root from the revealed bids, deterministically,
//! where anyone can query it. It turns "trust that the committee did the
//! arithmetic right" into "check that they did", which is the same move the
//! rest of Peal makes everywhere else.
//!
//! ## What this is deliberately NOT
//!
//! It holds no funds and settles nothing. Escrow, allocation and refunds stay
//! in the Ethereum contract, which is Gear's own recommended pattern for
//! anything carrying value: "funds stay in Solidity until a Vara.eth callback
//! confirms release" (`examples/escrow/README.md`). Moving custody here would
//! put bidder escrow behind a different validator set for no benefit the
//! mechanism can use.
//!
//! It also does not verify threshold shares. That needs BLS12-381 pairings, and
//! measured against gear's own gas ceiling a batch of 64 costs 3.83e12 against
//! a hard limit of 1e12 that funding cannot raise. Until `gr_crypto` lands
//! (gear-tech/gear #5582, still draft), share verification stays on Ethereum
//! where EIP-2537 makes it 6.5M gas.
//!
//! What is left is exactly the workload Vara.eth is good at: verifiable
//! computation over data that is already public, answered fast.

use sails_rs::{cell::RefCell, collections::HashMap, prelude::*};

mod merkle;
pub use merkle::{reveal_leaf, root as merkle_root, Hash};

/// One revealed bid.
///
/// Internal only, and that is a constraint rather than a style choice. An
/// ethexe program's exported signatures have to be expressible in Solidity's
/// ABI, because Solidity calls into them, and a Rust struct is not. So this
/// never appears in a method signature: the service takes parallel arrays of
/// primitives instead, the way a Solidity function would.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevealedBid {
    pub bid_id: u32,
    pub quantity: u128,
    pub tick: u16,
    pub salt: [u8; 32],
}

/// A reveal in progress, keyed by the Ethereum auction it belongs to.
pub struct AuctionReveal {
    /// Who opened it. Only they may add to it, so two committees cannot
    /// interleave submissions into one tree.
    committee: ActorId,
    /// How many bids the Ethereum contract says were committed. The root is
    /// not final until exactly this many have been submitted, which is what
    /// makes omission detectable rather than silent.
    expected: u32,
    bids: Vec<RevealedBid>,
    sealed: bool,
}

pub struct State {
    reveals: HashMap<[u8; 20], AuctionReveal>,
}

impl State {
    fn new() -> Self {
        Self { reveals: HashMap::new() }
    }
}

#[event]
#[derive(Clone, Debug, PartialEq, Eq, Encode, TypeInfo, ReflectHash)]
#[codec(crate = sails_rs::scale_codec)]
#[type_info(crate = sails_rs::type_info)]
#[reflect_hash(crate = sails_rs)]
pub enum RevealEvents {
    /// A committee opened a reveal for an Ethereum auction.
    Opened([u8; 20], u32),
    /// A bid was added. Carries the running count so a watcher can see
    /// progress without querying.
    BidAdded([u8; 20], u32, u32),
    /// Every expected bid is in and the root is final.
    Sealed([u8; 20], [u8; 32], u32),
}

pub struct RevealService<'a> {
    state: &'a RefCell<State>,
}

impl<'a> RevealService<'a> {
    pub fn new(state: &'a RefCell<State>) -> Self {
        Self { state }
    }
}

#[service(events = RevealEvents)]
impl RevealService<'_> {
    /// Open a reveal for an Ethereum auction, declaring how many bids it has.
    ///
    /// `expected` comes from the auction's `committedBidCount`. Fixing it up
    /// front is what lets omission be caught: a root can only be produced once
    /// that many bids are in, so a committee cannot quietly drop one and
    /// present the result as complete.
    #[export(unwrap_result)]
    pub fn open(&mut self, auction: [u8; 20], expected: u32) -> Result<(), String> {
        if expected == 0 {
            return Err("an auction with no bids has no reveal".into());
        }
        let mut state = self.state.borrow_mut();
        if state.reveals.contains_key(&auction) {
            return Err("this auction already has a reveal open".into());
        }
        state.reveals.insert(
            auction,
            AuctionReveal {
                committee: Syscall::message_source(),
                expected,
                bids: Vec::new(),
                sealed: false,
            },
        );
        self.emit_event(RevealEvents::Opened(auction, expected))
            .expect("emit Opened");
        Ok(())
    }

    /// Add revealed bids. Callable repeatedly, so a large auction can be
    /// submitted in chunks that fit the message payload budget.
    ///
    /// Bids must arrive in ascending `bid_id` with no gaps and no repeats. The
    /// contract checks a proof against a leaf built from `bidId`, so a tree
    /// built in any other order produces proofs that do not verify. Rejecting
    /// bad order here is cheaper than discovering it as a failed reveal.
    #[export(unwrap_result)]
    pub fn add_bids(
        &mut self,
        auction: [u8; 20],
        bid_ids: Vec<u32>,
        quantities: Vec<u128>,
        ticks: Vec<u16>,
        // Salts arrive as one flat `bytes`, 32 per bid, rather than as
        // `bytes32[]`. Not a style choice: a plain `[u8; 32]` has no SolValue
        // impl so it cannot cross the Solidity ABI, and alloy's `FixedBytes<32>`
        // has no SCALE `Decode` so it cannot cross the native one. `bytes` is
        // the one shape both encodings agree on.
        salts: Vec<u8>,
    ) -> Result<u32, String> {
        let n = bid_ids.len();
        if quantities.len() != n || ticks.len() != n {
            return Err("bid fields must all be the same length".into());
        }
        if salts.len() != n * 32 {
            return Err("salts must be exactly 32 bytes per bid".into());
        }
        let bids: Vec<RevealedBid> = (0..n)
            .map(|i| RevealedBid {
                bid_id: bid_ids[i],
                quantity: quantities[i],
                tick: ticks[i],
                salt: {
                    let mut b = [0u8; 32];
                    b.copy_from_slice(&salts[i * 32..(i + 1) * 32]);
                    b
                },
            })
            .collect();

        let mut state = self.state.borrow_mut();
        let reveal = state
            .reveals
            .get_mut(&auction)
            .ok_or_else(|| "no reveal is open for this auction".to_string())?;

        if reveal.sealed {
            return Err("this reveal is already sealed".into());
        }
        if Syscall::message_source() != reveal.committee {
            return Err("only the committee that opened this reveal may add to it".into());
        }

        for bid in bids {
            let want = reveal.bids.len() as u32;
            if bid.bid_id != want {
                return Err("bids must be submitted in ascending bidId with no gaps".into());
            }
            if want >= reveal.expected {
                return Err("more bids than this auction committed".into());
            }
            reveal.bids.push(bid);
        }

        let count = reveal.bids.len() as u32;
        let expected = reveal.expected;
        let complete = count == expected;

        if complete {
            reveal.sealed = true;
        }
        drop(state);

        self.emit_event(RevealEvents::BidAdded(auction, count, expected))
            .expect("emit BidAdded");

        if complete {
            let r = self.root_of(auction)?;
            self.emit_event(RevealEvents::Sealed(auction, r, expected))
                .expect("emit Sealed");
        }
        Ok(count)
    }

    /// The reveal root, once every expected bid is in.
    ///
    /// Errors while incomplete rather than returning a zero or a sentinel.
    /// Solidity has no Option, and a root over a partial set would be a number
    /// that looks authoritative and is not. Somebody would eventually sign it.
    /// Use `progress` to ask whether it is ready.
    #[export(unwrap_result)]
    pub fn root_of(&self, auction: [u8; 20]) -> Result<[u8; 32], String> {
        let state = self.state.borrow();
        let reveal = state
            .reveals
            .get(&auction)
            .ok_or_else(|| "no reveal is open for this auction".to_string())?;

        if (reveal.bids.len() as u32) < reveal.expected {
            return Err("the reveal is not complete, so there is no final root".into());
        }
        let leaves: Vec<Hash> = reveal
            .bids
            .iter()
            .map(|b| reveal_leaf(b.bid_id, b.quantity, b.tick, &b.salt))
            .collect();
        merkle_root(&leaves).ok_or_else(|| "no leaves".to_string())
    }

    /// The sibling path for one bid, ready to pass to `processReveals`.
    #[export(unwrap_result)]
    pub fn proof_for(&self, auction: [u8; 20], bid_id: u32) -> Result<Vec<[u8; 32]>, String> {
        let state = self.state.borrow();
        let reveal = state
            .reveals
            .get(&auction)
            .ok_or_else(|| "no reveal is open for this auction".to_string())?;
        if (reveal.bids.len() as u32) < reveal.expected {
            return Err("the reveal is not complete, so no proof is final".into());
        }
        let leaves: Vec<Hash> = reveal
            .bids
            .iter()
            .map(|b| reveal_leaf(b.bid_id, b.quantity, b.tick, &b.salt))
            .collect();
        Ok(merkle::proof(&leaves, bid_id as usize))
    }

    /// How many bids have been submitted for this auction.
    #[export(unwrap_result)]
    pub fn submitted(&self, auction: [u8; 20]) -> Result<u32, String> {
        let state = self.state.borrow();
        Ok(state
            .reveals
            .get(&auction)
            .ok_or_else(|| "no reveal is open for this auction".to_string())?
            .bids
            .len() as u32)
    }

    /// How many the Ethereum contract said were committed.
    #[export(unwrap_result)]
    pub fn expected(&self, auction: [u8; 20]) -> Result<u32, String> {
        let state = self.state.borrow();
        Ok(state
            .reveals
            .get(&auction)
            .ok_or_else(|| "no reveal is open for this auction".to_string())?
            .expected)
    }

    /// Whether the root is final.
    #[export(unwrap_result)]
    pub fn is_sealed(&self, auction: [u8; 20]) -> Result<bool, String> {
        let state = self.state.borrow();
        Ok(state
            .reveals
            .get(&auction)
            .ok_or_else(|| "no reveal is open for this auction".to_string())?
            .sealed)
    }

    /// A leaf, computed without opening a reveal. Lets anyone check one bid's
    /// contribution independently.
    #[export(unwrap_result)]
    pub fn leaf(&self, bid_id: u32, quantity: u128, tick: u16, salt: [u8; 32]) -> Result<[u8; 32], String> {
        Ok(reveal_leaf(bid_id, quantity, tick, &salt))
    }
}

pub struct Program {
    state: RefCell<State>,
}

#[program]
impl Program {
    pub fn create() -> Self {
        Self { state: RefCell::new(State::new()) }
    }

    pub fn reveal(&self) -> RevealService<'_> {
        RevealService::new(&self.state)
    }
}
