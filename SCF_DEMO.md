# BwanaPay SCF Demo Flow

This demo proves that the mobile app can initiate BwanaPay corridor wallet flows through the Anchor backend, receive real Anchor Platform transaction IDs, persist corridor transactions, and show correlated Stellar testnet USDC proof transactions.

## Start Anchor

```powershell
cd path\to\bp-anchor
docker-compose up -d --build
```

Confirm the backend:

```powershell
Invoke-RestMethod http://localhost:8081/health
```

## Start Mobile App

```powershell
cd path\to\bp-wallet
npx expo start --dev-client --clear --host localhost --port 8082
```

Press `a` for the emulator, or open the installed development build. The wallet and Anchor public URLs in this demo branch are configured for Android Emulator access through `10.0.2.2`. Host-side PowerShell checks should still use `localhost`.

## Backend Proof Script

Run this before or during the app demo to create a measurable transaction:

```powershell
cd path\to\bp-anchor
.\scripts\demo-flow.ps1 `
  -BusinessServerUrl http://localhost:8081 `
  -DemoApiKey '<demo-api-key>' `
  -Amount 25 `
  -OpenExplorer
```

Expected evidence:

- `Platform transaction ID`
- `Platform status` such as `pending_user_transfer_start`
- `Hosted SEP-24 URL`
- `Stellar proof hash`
- `Stellar proof ledger`

## Mobile Demo Path

1. Open BwanaPay.
2. Go to the authenticated home screen.
3. Show `Send to Malawi`, `Request from Malawi`, and `Transfer Status` under corridor payments.
4. Open side-menu `Testnet Status` to confirm the local testnet demo environment is healthy.
5. Use `Send to Malawi` to show corridor quote, transaction creation, status, and persisted activity.
6. Confirm `Transfer Status` shows the transaction lifecycle, Anchor Platform status, and Stellar testnet proof.
7. Optionally show `Add Money`, `Cash Out`, or `Testnet Proof` as supporting Anchor-backed wallet actions.

## Review Notes

- Demo uses Stellar Testnet and testnet-only controlled accounts.
- SEP-24 hosted flow is reachable from the Android Emulator through the host bridge at `10.0.2.2`.
- KYC/AML, fiat collection, and payout-provider integrations remain compliance-gated and partner-dependent roadmap items. They are intentionally not part of this demo branch.
