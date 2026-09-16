//! Library surface of the node, so integration tests can build the router
//! in-process against temporary stores.

pub mod api;
pub mod auth;
pub mod config;
pub mod evm;
pub mod ledger_actor;
pub mod problem;
pub mod product;
pub mod settlement;
pub mod watcher;
