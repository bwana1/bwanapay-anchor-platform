# This repository contains development/testnet infrastructure and does not represent a live regulated financial service.

# BwanaPay Anchor Platform

## Overview
Complete SEP-24 anchor platform for African cross-border payments, serving as the technical foundation for SCF Build Award implementation.

## Architecture
- **SEP Server:** Stellar protocol endpoints (port 8080)
- **Platform Server:** Core anchor platform API (port 8085)
- **Business Server:** Custom business logic (port 8081)
- **Stellar Observer:** Blockchain monitoring
- **Database:** PostgreSQL with initialization

## Project Structure
- **config/** - Stellar anchor platform configuration files
- **static_resources/** - Interactive flow assets and UI components (planned)
- **server.js** - Business logic and transaction processing
- **docker-compose.yml** - Multi-service orchestration
- **dev.env.template** - Environment configuration template
- **init.sql** - Database initialization script

## Quick Start
1. Copy `dev.env.template` to `dev.env`
2. Fill in your database password and JWT secrets
3. Run `docker-compose up`
4. Access anchor at `http://localhost:8080`

## Features
- Complete SEP-24 implementation (deposit/withdrawal)
- Multi-secret JWT validation
- Background transaction monitoring
- Docker orchestration
- Production-ready error handling
- Interactive flow support (UI components planned)

## Technical Implementation
- **Multi-service Docker architecture** with proper service dependencies
- **Advanced JWT token validation** supporting multiple secret rotation
- **Background transaction polling** for real-time blockchain monitoring
- **Comprehensive error handling** with detailed logging
- **Production-ready configuration** with environment variable management

## SCF Build Award
This platform serves as the foundation for implementing comprehensive cross-border payment infrastructure across Africa, extending to SEP-31 and mobile applications.

## Development Status
- ✅ SEP-24 complete and functional
- ✅ Docker orchestration implemented
- ✅ Business logic and transaction processing
- ✅ Database integration and initialization
- 🔄 SEP-31 cross-border routing implementation planned
- 🔄 SEP-12 KYC/AML compliance integration planned
- 🔄 Interactive UI components development planned
- 🔄 Mobile application development planned

## Environment Setup
Generate secure secrets for your environment:
```bash
# Generate JWT secrets
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Services
- **SEP Server (8080):** Handles SEP-24 protocol endpoints
- **Platform Server (8085):** Core anchor platform API
- **Business Server (8081):** Custom business logic and transaction processing
- **Database (5432):** PostgreSQL with automatic initialization
- **Stellar Observer:** Monitors blockchain for transaction updates