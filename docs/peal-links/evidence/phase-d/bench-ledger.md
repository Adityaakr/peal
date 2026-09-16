## Ledger benchmark (Apple silicon, 10 threads, release)

| measurement | value |
|---|---|
| keygen R_op + R_dep | 684 ms |
| R_op prove, 10 threads, median of 64 | 521 ms |
| R_op prove, 1 thread | 1780 ms |
| single verify incl. strict decode (mean of 50) | 937 us |
| apply_batch of 1 (batch verify + sqlite writes) | 1.7 ms total, 1.67 ms per op |
| apply_batch of 8 (batch verify + sqlite writes) | 8.0 ms total, 1.00 ms per op |
| apply_batch of 32 (batch verify + sqlite writes) | 25.2 ms total, 0.79 ms per op |
| apply_batch of 23 (batch verify + sqlite writes) | 18.2 ms total, 0.79 ms per op |
| full replay of 195 ops (re-verifying every proof) | 239 ms |
