# Multi-stage build: one image carrying all three bte binaries.
FROM rust:1.95-slim AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p bte-coordinator -p bte-node -p bte-cli

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -r -u 10001 bte \
    && mkdir -p /data /ceremony \
    && chown bte /data /ceremony
COPY --from=builder /app/target/release/bte-coordinator /usr/local/bin/
COPY --from=builder /app/target/release/bte-node /usr/local/bin/
COPY --from=builder /app/target/release/bte-cli /usr/local/bin/
USER bte
CMD ["bte-coordinator"]
