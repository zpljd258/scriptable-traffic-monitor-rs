# Build stage
FROM rust:alpine AS builder

WORKDIR /usr/src/app

RUN apk add --no-cache musl-dev

# Cache dependencies
COPY Cargo.toml ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

# Build application
COPY src ./src
RUN touch src/main.rs && cargo build --release && strip target/release/scriptable-traffic-monitor

# Runtime stage
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /usr/src/app/target/release/scriptable-traffic-monitor /usr/local/bin/scriptable-traffic-monitor

CMD ["scriptable-traffic-monitor"]
