# BwanaPay Anchor Platform

This repository contains local development infrastructure for BwanaPay’s anchor-based cross-border payment implementation. It does not represent a live regulated financial service.

## Overview

BwanaPay is a Zambia-first cross-border payment infrastructure project using Stellar anchor architecture. The goal is to support regulated fiat on- and off-ramp workflows, custodial transaction services, interoperable settlement, and future anchor-to-anchor coordination across African payment corridors.

This repository contains a local Anchor Platform setup used to validate core protocol flows and business-server integration before testnet deployment.

## Current Development Status

The current local implementation includes:

- SEP-1 service discovery
- SEP-10 challenge-response authentication
- SEP-24 interactive deposit flow handling
- Custom business-server session handling
- Transaction-state progression through the Anchor Platform
- Dockerized multi-service local environment

The current demo validates a local authenticated SEP-24 deposit flow progressing to `pending_user_transfer_start`.

Demo: https://youtu.be/_umo4bxZgA4

## Architecture

The local environment includes:

- **SEP Server:** Stellar protocol endpoints on port 8080
- **Platform Server:** Anchor Platform API on port 8085
- **Business Server:** Custom business logic on port 8081
- **Stellar Observer:** Transaction monitoring
- **Database:** PostgreSQL for platform state and transaction data

## Project Structure

- `config/` - Stellar Anchor Platform configuration files
- `static_resources/` - Interactive flow assets and UI components
- `server.js` - Business-server logic for local session and transaction-flow handling
- `docker-compose.yml` - Multi-service orchestration
- `dev.env.template` - Environment configuration template
- `init.sql` - Database initialization script

## Quick Start

1. Copy `dev.env.template` to `dev.env`
2. Fill in local development values for database and JWT configuration
3. Run:

```bash
docker-compose up --build
```

4. Access the local anchor at:

```text
http://localhost:8080
```

## Implemented Local Flows

- SEP-1 discovery through `.well-known/stellar.toml`
- SEP-10 challenge retrieval, signing, and JWT issuance
- SEP-24 interactive deposit initiation
- Business-session creation from a platform-issued token
- Transaction-state progression to `pending_user_transfer_start`
- Transaction inspection through a local business-server route

## Planned Development

Planned next steps include:

- Stellar testnet deployment
- SEP-12 KYC/AML workflow support
- SEP-31 cross-border payment orchestration
- Further transaction-flow hardening
- Corridor-specific pilot preparation
- Interactive UI and mobile application development

## Environment Setup

Generate secure secrets for local development:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Do not commit real environment secrets, private keys, JWTs, or production credentials.

## Services

- **SEP Server (8080):** Handles SEP protocol endpoints
- **Platform Server (8085):** Core Anchor Platform API
- **Business Server (8081):** Custom local business logic and transaction-flow handling
- **Database (5432):** PostgreSQL with initialization
- **Stellar Observer:** Monitors Stellar transaction activity

## Important Notice

This repository is for development and testnet preparation only. BwanaPay is not currently live, does not process production transactions, and does not represent a regulated financial service in operation.
