const express = require("express");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const fetch = require("node-fetch");
const StellarSdk = require("@stellar/stellar-sdk");
const { Pool } = require("pg");

const app = express();
const port = process.env.BUSINESS_SERVER_PORT;

const sessions = {};
const transactionMemos = {};
const demoTransactions = {};
const corridorTransactions = {};
const sep10TokenCache = new Map();
let businessDbPool = null;
let businessDbReadyPromise = null;
let anchorHealthSnapshot = {
  sep24_info_ok: null,
  platform_api_ok: null,
  platform_api_status: null,
  last_checked_at: null,
  mode: "fast_path"
};
let demoAccountsReadyPromise = null;

const DEFAULT_SEP_SERVER_URL = "http://sep-server:8080";
const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
const TESTNET_FRIENDBOT_URL = "https://friendbot.stellar.org";
const TESTNET_EXPERT_BASE_URL = "https://stellar.expert/explorer/testnet/tx";
const DEFAULT_DEMO_DESTINATION_ACCOUNT =
  "GBXNUYF3J6LCYBC33CKDDJUPRSVEURKTGGP2CBSV6JNTP7BU766UMAX7";
const BUSINESS_DB_SCHEMA = "bwanapay";
const BUSINESS_TABLES = {
  demoTransactions: `${BUSINESS_DB_SCHEMA}.bp_demo_transactions`,
  corridorTransactions: `${BUSINESS_DB_SCHEMA}.bp_corridor_transactions`
};

app.use(express.json());

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getPlatformApiBaseUrl() {
  return requireEnv("PLATFORM_API_BASE_URL");
}

function getSepServerBaseUrl() {
  return process.env.ANCHOR_SEP_SERVER_URL || DEFAULT_SEP_SERVER_URL;
}

function getPublicAnchorBaseUrl() {
  return process.env.PUBLIC_ANCHOR_BASE_URL || null;
}

function toPublicAnchorUrl(rawUrl) {
  const publicBaseUrl = getPublicAnchorBaseUrl();

  if (!rawUrl || !publicBaseUrl) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl);
    const publicBase = new URL(publicBaseUrl);

    if (["localhost", "127.0.0.1", "sep-server"].includes(url.hostname)) {
      url.protocol = publicBase.protocol;
      url.host = publicBase.host;
    }

    return url.toString();
  } catch {
    return rawUrl;
  }
}

function getDemoSourceSeed() {
  return process.env.SECRET_STELLAR_DEMO_SOURCE_SEED || requireEnv("SECRET_SEP10_SIGNING_SEED");
}

function getDemoSourceKeypair() {
  return StellarSdk.Keypair.fromSecret(getDemoSourceSeed());
}

function getDemoDestinationAccount() {
  return process.env.STELLAR_DEMO_DESTINATION_ACCOUNT || DEFAULT_DEMO_DESTINATION_ACCOUNT;
}

function getDemoUsdcIssuerSeed() {
  return process.env.SECRET_STELLAR_DEMO_USDC_ISSUER_SEED || requireEnv("SECRET_SEP10_SIGNING_SEED");
}

function getDemoUsdcIssuerAccount() {
  return (
    process.env.STELLAR_DEMO_USDC_ISSUER_ACCOUNT ||
    StellarSdk.Keypair.fromSecret(getDemoUsdcIssuerSeed()).publicKey()
  );
}

function getAnchorUsdcAssetId() {
  return `stellar:USDC:${getDemoUsdcIssuerAccount()}`;
}

function getDemoProofDestinationAccount() {
  return process.env.STELLAR_DEMO_PROOF_DESTINATION_ACCOUNT || getDemoSourceKeypair().publicKey();
}

function getDemoExchangeRate() {
  return Number(process.env.DEMO_ZMW_PER_USDC || "28");
}

function getDemoZmwToMwkRate() {
  return Number(process.env.DEMO_ZMW_TO_MWK_RATE || "65");
}

function getProofMemoText(transactionId) {
  return `BP-${transactionId}`.slice(0, 28);
}

function getCachedAnchorBackend() {
  return {
    ...anchorHealthSnapshot,
    proof_mode: "async_background_usdc"
  };
}

function getBusinessDbPool() {
  if (!businessDbPool) {
    businessDbPool = new Pool({
      host: process.env.BUSINESS_DB_HOST || process.env.DATA_SERVER || "db",
      port: Number(process.env.BUSINESS_DB_PORT || process.env.DATA_PORT || "5432"),
      database: process.env.BUSINESS_DB_NAME || process.env.DATA_DATABASE || "platform",
      user: process.env.BUSINESS_DB_USER || process.env.SECRET_DATA_USERNAME || process.env.POSTGRES_USER,
      password:
        process.env.BUSINESS_DB_PASSWORD ||
        process.env.SECRET_DATA_PASSWORD ||
        process.env.POSTGRES_PASSWORD,
      max: 4
    });
  }

  return businessDbPool;
}

async function ensureBusinessDbReady() {
  if (!businessDbReadyPromise) {
    businessDbReadyPromise = (async () => {
      const pool = getBusinessDbPool();

      await pool.query(`
        CREATE SCHEMA IF NOT EXISTS ${BUSINESS_DB_SCHEMA}
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${BUSINESS_TABLES.demoTransactions} (
          transaction_id TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${BUSINESS_TABLES.corridorTransactions} (
          corridor_id TEXT PRIMARY KEY,
          anchor_transaction_id TEXT,
          payload JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS bp_bwanapay_corridor_anchor_transaction_idx
        ON ${BUSINESS_TABLES.corridorTransactions}(anchor_transaction_id)
      `);
      await pool.query(`
        DO $$
        BEGIN
          IF to_regclass('public.bp_demo_transactions') IS NOT NULL THEN
            INSERT INTO ${BUSINESS_TABLES.demoTransactions}(
              transaction_id,
              payload,
              created_at,
              updated_at
            )
            SELECT transaction_id, payload, created_at, updated_at
            FROM public.bp_demo_transactions
            ON CONFLICT (transaction_id) DO NOTHING;
          END IF;

          IF to_regclass('public.bp_corridor_transactions') IS NOT NULL THEN
            INSERT INTO ${BUSINESS_TABLES.corridorTransactions}(
              corridor_id,
              anchor_transaction_id,
              payload,
              created_at,
              updated_at
            )
            SELECT corridor_id, anchor_transaction_id, payload, created_at, updated_at
            FROM public.bp_corridor_transactions
            ON CONFLICT (corridor_id) DO NOTHING;
          END IF;
        END $$;
      `);

      return true;
    })().catch((error) => {
      businessDbReadyPromise = null;
      throw error;
    });
  }

  return businessDbReadyPromise;
}

async function upsertDemoTransaction(transactionId, payload) {
  await ensureBusinessDbReady();
  await getBusinessDbPool().query(
    `
      INSERT INTO ${BUSINESS_TABLES.demoTransactions}(transaction_id, payload, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (transaction_id)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
    `,
    [transactionId, JSON.stringify(payload)]
  );
}

async function getPersistedDemoTransaction(transactionId) {
  await ensureBusinessDbReady();
  const result = await getBusinessDbPool().query(
    `SELECT payload FROM ${BUSINESS_TABLES.demoTransactions} WHERE transaction_id = $1`,
    [transactionId]
  );

  return result.rows[0]?.payload || null;
}

async function upsertCorridorTransaction(corridorId, payload) {
  await ensureBusinessDbReady();
  await getBusinessDbPool().query(
    `
      INSERT INTO ${BUSINESS_TABLES.corridorTransactions}(corridor_id, anchor_transaction_id, payload, updated_at)
      VALUES ($1, $2, $3::jsonb, NOW())
      ON CONFLICT (corridor_id)
      DO UPDATE SET
        anchor_transaction_id = EXCLUDED.anchor_transaction_id,
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `,
    [corridorId, payload.anchorTransactionId || null, JSON.stringify(payload)]
  );
}

async function getPersistedCorridorTransaction(corridorId) {
  await ensureBusinessDbReady();
  const result = await getBusinessDbPool().query(
    `SELECT payload FROM ${BUSINESS_TABLES.corridorTransactions} WHERE corridor_id = $1`,
    [corridorId]
  );

  return result.rows[0]?.payload || null;
}

function isDemoEnabled() {
  return process.env.ENABLE_DEMO_ENDPOINTS === "true";
}

function getDemoApiKeyFromRequest(req) {
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return req.get("x-bwanapay-demo-key") || bearer || "";
}

function hasValidDemoApiKey(req) {
  const expected = process.env.DEMO_API_KEY;

  if (!expected) {
    return true;
  }

  const supplied = getDemoApiKeyFromRequest(req);
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);

  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function requireDemoAccess(req, res, next) {
  if (!isDemoEnabled()) {
    return res.status(403).json({
      success: false,
      message: "Demo endpoints are disabled"
    });
  }

  if (!hasValidDemoApiKey(req)) {
    return res.status(401).json({
      success: false,
      message: "Demo access denied"
    });
  }

  return next();
}

function getPlatformApiAuthToken() {
  const secret = requireEnv("SECRET_PLATFORM_API_AUTH_SECRET");

  return jwt.sign(
    {
      sub: "business-server",
      iss: "business-server",
      aud: "platform-server"
    },
    secret,
    {
      algorithm: "HS256",
      expiresIn: "5m"
    }
  );
}

function getPlatformAuthHeaders(includeJson = false) {
  const headers = {
    Authorization: `Bearer ${getPlatformApiAuthToken()}`
  };

  if (includeJson) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

app.post("/session", async (req, res) => {
  let decodedPlatformToken;

  try {
    decodedPlatformToken = validatePlatformToken(req.body.platformToken);
  } catch (err) {
    return res.status(400).send({ error: String(err) });
  }

  const stellarAccount = decodedPlatformToken.sub;
  console.log("Authenticated stellar account:", stellarAccount);

  const user = getUser(stellarAccount);

  const sessionToken = jwt.sign(
    { jti: decodedPlatformToken.jti },
    requireEnv("SESSION_JWT_SECRET")
  );

  sessions[sessionToken] = {
    timestamp: new Date(),
    account: stellarAccount
  };

  return res.send({
    token: sessionToken,
    user
  });
});

app.post("/transaction", async (req, res) => {
  try {
    validateSessionToken(req.headers.authorization);

    if (!req.body?.transaction?.id) {
      throw new Error("missing transaction.id");
    }
    if (!req.body?.amount_in?.amount) {
      throw new Error("missing amount_in.amount");
    }
    if (!req.body?.amount_out?.amount) {
      throw new Error("missing amount_out.amount");
    }
    if (!req.body?.fee_details?.total) {
      throw new Error("missing fee_details.total");
    }

    const transactionId = req.body.transaction.id;
    transactionMemos[transactionId] = parseInt(Math.random() * 100000, 10);

    // For SEP-24 deposit transactions in "incomplete" state, use request_offchain_funds.
    // Keep the payload aligned to the Platform example and omit "instructions".
    const rpcRequestBody = [
      {
        id: 1,
        jsonrpc: "2.0",
        method: "request_offchain_funds",
        params: {
          transaction_id: transactionId,
          message: "Request offchain funds",
          amount_in: {
            amount: req.body.amount_in.amount,
            asset: "iso4217:USD"
          },
          amount_out: {
            amount: req.body.amount_out.amount,
            asset: getAnchorUsdcAssetId()
          },
          fee_details: {
            total: req.body.fee_details.total,
            asset: "iso4217:USD"
          },
          amount_expected: {
            amount: req.body.amount_in.amount
          }
        }
      }
    ];

    const platformResponse = await updatePlatformTransaction(rpcRequestBody);

    const transaction = Array.isArray(platformResponse)
      ? platformResponse[0]?.result || platformResponse[0]
      : platformResponse?.result || platformResponse;

    return res.send({ transaction });
  } catch (err) {
    console.error("Transaction route error:", err);
    return res.status(500).send({ error: String(err.message || err) });
  }
});

app.get("/platform-transaction/:id", requireDemoAccess, async (req, res) => {
  try {
    const tx = await getPlatformTransaction(req.params.id);
    const demoTransaction =
      demoTransactions[req.params.id] ||
      (await getPersistedDemoTransaction(req.params.id));
    const stellarProof =
      demoTransaction?.stellar_proof || buildStellarProofFromPlatformTransaction(tx);
    const stellarProofStatus =
      demoTransaction?.stellar_proof_status ||
      (stellarProof ? "confirmed" : "pending");

    if (demoTransaction) {
      return res.send({
        transaction: {
          ...tx,
          anchor_backend: demoTransaction.anchor_backend,
          interactive_url: demoTransaction.interactive_url,
          interactive_type: demoTransaction.interactive_type,
          stellar_proof: stellarProof,
          stellar_proof_status: stellarProofStatus,
          stellar_proof_error: demoTransaction.stellar_proof_error
        },
        source: "anchor-platform-with-business-server-proof"
      });
    }

    return res.send({
      transaction: {
        ...tx,
        stellar_proof: stellarProof,
        stellar_proof_status: stellarProofStatus
      },
      source: "anchor-platform"
    });
  } catch (err) {
    console.error("Platform transaction inspection error:", err);
    return res.status(500).send({ error: String(err.message || err) });
  }
});

app.get("/health", async (req, res) => {
  const health = {
    business_server: "ok",
    sep24_info: null,
    platform_api: null,
    stellar_testnet: null
  };

  try {
    health.sep24_info = await getSep24Info();
  } catch (err) {
    health.sep24_info = { ok: false, error: String(err.message || err) };
  }

  try {
    health.platform_api = await checkPlatformApi();
  } catch (err) {
    health.platform_api = { ok: false, error: String(err.message || err) };
  }

  try {
    health.stellar_testnet = await checkStellarTestnet();
  } catch (err) {
    health.stellar_testnet = { ok: false, error: String(err.message || err) };
  }

  anchorHealthSnapshot = {
    sep24_info_ok: health.sep24_info?.ok === true,
    platform_api_ok: health.platform_api?.ok === true,
    platform_api_status: health.platform_api?.status || null,
    last_checked_at: new Date().toISOString(),
    mode: "cached"
  };

  const ok =
    health.sep24_info?.ok &&
    health.platform_api?.ok &&
    health.stellar_testnet?.ok;

  return res.status(ok ? 200 : 503).send({
    ok,
    network_passphrase: "Test SDF Network ; September 2015",
    health
  });
});

app.get("/demo-readiness", requireDemoAccess, async (req, res) => {
  const checks = {
    business_server: { ok: true },
    demo_auth: {
      ok: hasValidDemoApiKey(req),
      mode: process.env.DEMO_API_KEY ? "api_key" : "open_dev"
    },
    persistence: null,
    sep24_info: null,
    platform_api: null,
    stellar_testnet: null,
    proof_asset: null
  };

  try {
    checks.persistence = await checkBusinessPersistence();
  } catch (err) {
    checks.persistence = { ok: false, error: String(err.message || err) };
  }

  try {
    checks.sep24_info = await getSep24Info();
  } catch (err) {
    checks.sep24_info = { ok: false, error: String(err.message || err) };
  }

  try {
    checks.platform_api = await checkPlatformApi();
  } catch (err) {
    checks.platform_api = { ok: false, error: String(err.message || err) };
  }

  try {
    checks.stellar_testnet = await checkStellarTestnet();
  } catch (err) {
    checks.stellar_testnet = { ok: false, error: String(err.message || err) };
  }

  try {
    checks.proof_asset = await checkProofAssetReadiness();
  } catch (err) {
    checks.proof_asset = { ok: false, error: String(err.message || err) };
  }

  const ok = Object.values(checks).every((check) => check?.ok === true);

  return res.status(ok ? 200 : 503).json({
    ok,
    network_passphrase: StellarSdk.Networks.TESTNET,
    checks
  });
});

app.get("/test-jwt", (req, res) => {
  try {
    const testJwt = jwt.sign(
      { test: "data" },
      requireEnv("SECRET_SEP10_JWT_SECRET"),
      { algorithm: "HS256" }
    );

    const verified = jwt.verify(
      testJwt,
      requireEnv("SECRET_SEP10_JWT_SECRET"),
      { algorithms: ["HS256"] }
    );

    return res.send({
      success: true,
      message: "JWT signing and verification works correctly",
      jwt: testJwt,
      verified
    });
  } catch (err) {
    return res.status(500).send({
      success: false,
      message: "JWT verification failed",
      error: err.toString()
    });
  }
});

function validatePlatformToken(token) {
  if (!token) {
    throw "missing 'platformToken'";
  }

  let decodedToken;

  try {
    try {
      decodedToken = jwt.verify(
        token,
        requireEnv("SECRET_SEP24_INTERACTIVE_URL_JWT_SECRET"),
        { algorithms: ["HS256"] }
      );
      console.log("Verified with INTERACTIVE_URL secret");
    } catch {
      decodedToken = jwt.verify(
        token,
        requireEnv("SECRET_SEP24_MORE_INFO_URL_JWT_SECRET"),
        { algorithms: ["HS256"] }
      );
      console.log("Verified with MORE_INFO_URL secret");
    }
  } catch (err) {
    console.error("Platform token verification error:", err.message || err);
    throw "invalid 'platformToken'";
  }

  if (!decodedToken.jti) {
    throw "invalid 'platformToken': missing 'jti'";
  }

  return decodedToken;
}

function validateSessionToken(authorizationHeader) {
  if (!authorizationHeader) {
    throw "missing authorization header";
  }

  const parts = authorizationHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw "invalid authorization header format";
  }

  const sessionToken = parts[1];

  try {
    jwt.verify(sessionToken, requireEnv("SESSION_JWT_SECRET"));
  } catch {
    throw "invalid session token";
  }

  if (!sessions[sessionToken]) {
    throw "expired session";
  }

  return sessionToken;
}

async function updatePlatformTransaction(requestBody) {
  const response = await fetch(`${getPlatformApiBaseUrl()}`, {
    method: "POST",
    headers: getPlatformAuthHeaders(true),
    body: JSON.stringify(requestBody)
  });

  if (response.status !== 200) {
    const body = await safeReadBody(response);
    throw new Error(`platform JSON-RPC POST failed: ${response.status} ${body}`);
  }

  return await response.json();
}

async function getPlatformTransaction(transactionId) {
  const response = await fetch(
    `${getPlatformApiBaseUrl()}/transactions/${transactionId}`,
    {
      method: "GET",
      headers: getPlatformAuthHeaders(false)
    }
  );

  if (response.status !== 200) {
    const body = await safeReadBody(response);
    throw new Error(`platform GET /transactions/${transactionId} failed: ${response.status} ${body}`);
  }

  return await response.json();
}

async function patchPlatformTransactions(requestBody) {
  const response = await fetch(`${getPlatformApiBaseUrl()}/transactions?sep=24`, {
    method: "PATCH",
    headers: getPlatformAuthHeaders(true),
    body: JSON.stringify(requestBody)
  });

  if (response.status !== 200) {
    const body = await safeReadBody(response);
    throw new Error(`platform PATCH /transactions?sep=24 failed: ${response.status} ${body}`);
  }

  return await response.json();
}

async function getSep24Info() {
  const response = await fetch(`${getSepServerBaseUrl()}/sep24/info`);

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`SEP-24 info failed: ${response.status} ${body}`);
  }

  return {
    ok: true,
    data: await response.json()
  };
}

async function getSep10Token(accountKeypair) {
  const account = accountKeypair.publicKey();
  const cached = sep10TokenCache.get(account);

  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const challengeResponse = await fetch(
    `${getSepServerBaseUrl()}/auth?account=${encodeURIComponent(account)}`
  );

  if (!challengeResponse.ok) {
    const body = await safeReadBody(challengeResponse);
    throw new Error(`SEP-10 challenge failed: ${challengeResponse.status} ${body}`);
  }

  const challenge = await challengeResponse.json();
  const transaction = new StellarSdk.Transaction(
    challenge.transaction,
    StellarSdk.Networks.TESTNET
  );

  transaction.sign(accountKeypair);

  const authResponse = await fetch(`${getSepServerBaseUrl()}/auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      transaction: transaction.toXDR()
    })
  });

  if (!authResponse.ok) {
    const body = await safeReadBody(authResponse);
    throw new Error(`SEP-10 auth failed: ${authResponse.status} ${body}`);
  }

  const auth = await authResponse.json();

  if (!auth.token) {
    throw new Error("SEP-10 auth response did not include a token");
  }

  const decoded = jwt.decode(auth.token) || {};
  const expiresAt =
    typeof decoded.exp === "number"
      ? decoded.exp * 1000
      : Date.now() + 5 * 60 * 1000;

  sep10TokenCache.set(account, {
    token: auth.token,
    expiresAt
  });

  return auth.token;
}

async function createSep24DepositTransaction(accountKeypair) {
  return createSep24InteractiveTransaction(accountKeypair, "deposit");
}

async function createSep24WithdrawalTransaction(accountKeypair) {
  return createSep24InteractiveTransaction(accountKeypair, "withdraw");
}

async function createSep24InteractiveTransaction(accountKeypair, flow) {
  const account = accountKeypair.publicKey();
  const token = await getSep10Token(accountKeypair);
  const response = await fetch(
    `${getSepServerBaseUrl()}/sep24/transactions/${flow}/interactive`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        asset_code: "USDC",
        account
      })
    }
  );

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`SEP-24 ${flow} create failed: ${response.status} ${body}`);
  }

  const data = await response.json();

  if (!data.id) {
    throw new Error(`SEP-24 ${flow} response missing id: ${JSON.stringify(data)}`);
  }

  return data;
}

async function checkPlatformApi() {
  const response = await fetch(`${getPlatformApiBaseUrl()}/transactions/not-a-real-transaction`, {
    method: "GET",
    headers: getPlatformAuthHeaders(false)
  });

  return {
    ok: response.status === 404 || response.status === 400 || response.status === 200,
    status: response.status
  };
}

async function checkStellarTestnet() {
  const response = await fetch(TESTNET_HORIZON_URL);

  if (!response.ok) {
    throw new Error(`Horizon testnet failed: ${response.status}`);
  }

  return {
    ok: true,
    horizon_url: TESTNET_HORIZON_URL
  };
}

async function checkBusinessPersistence() {
  await ensureBusinessDbReady();
  const result = await getBusinessDbPool().query("SELECT 1 AS ok");

  return {
    ok: result.rows[0]?.ok === 1,
    database: process.env.BUSINESS_DB_NAME || process.env.DATA_DATABASE || "platform"
  };
}

async function checkProofAssetReadiness() {
  await ensureDemoAccountsReady();

  const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
  const issuerAccount = getDemoUsdcIssuerAccount();
  const destinationAccount = getDemoProofDestinationAccount();
  const destination = await server.loadAccount(destinationAccount);
  const hasTrustline = destination.balances.some(
    (balance) =>
      balance.asset_code === "USDC" &&
      balance.asset_issuer === issuerAccount
  );

  return {
    ok: hasTrustline,
    asset: getAnchorUsdcAssetId(),
    issuer_account: issuerAccount,
    destination_account: destinationAccount,
    destination_trustline: hasTrustline
  };
}

async function refreshAnchorHealth() {
  const [sep24InfoResult, platformResult] = await Promise.allSettled([
    getSep24Info(),
    checkPlatformApi()
  ]);

  anchorHealthSnapshot = {
    sep24_info_ok:
      sep24InfoResult.status === "fulfilled"
        ? sep24InfoResult.value.ok
        : false,
    platform_api_ok:
      platformResult.status === "fulfilled"
        ? platformResult.value.ok
        : false,
    platform_api_status:
      platformResult.status === "fulfilled"
        ? platformResult.value.status
        : null,
    last_checked_at: new Date().toISOString(),
    mode: "cached"
  };

  return anchorHealthSnapshot;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withStartupRetry(label, task, attempts = 12, delayMs = 5000) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      if (attempt === attempts) {
        break;
      }

      console.warn(
        `${label} not ready yet (${attempt}/${attempts}): ${error.message || error}`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function roundToSevenDecimals(value) {
  return Number(value).toFixed(7);
}

function roundToTwoDecimals(value) {
  return Number(value).toFixed(2);
}

async function ensureTestnetAccount(publicKey) {
  const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);

  try {
    await server.loadAccount(publicKey);
    return { funded: false, public_key: publicKey };
  } catch (err) {
    if (err?.response?.status !== 404) {
      throw err;
    }
  }

  const response = await fetch(`${TESTNET_FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`friendbot failed for ${publicKey}: ${response.status} ${body}`);
  }

  return { funded: true, public_key: publicKey };
}

function hasTrustline(account, asset) {
  return account.balances.some(
    (balance) =>
      balance.asset_code === asset.code &&
      balance.asset_issuer === asset.issuer
  );
}

async function ensureTrustline(accountKeypair, asset) {
  const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
  const account = await server.loadAccount(accountKeypair.publicKey());

  if (hasTrustline(account, asset)) {
    return { created: false, account: accountKeypair.publicKey() };
  }

  const fee = await server.fetchBaseFee();
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: String(fee),
    networkPassphrase: StellarSdk.Networks.TESTNET
  })
    .addOperation(
      StellarSdk.Operation.changeTrust({
        asset,
        limit: "1000000"
      })
    )
    .setTimeout(60)
    .build();

  transaction.sign(accountKeypair);
  await server.submitTransaction(transaction);

  return { created: true, account: accountKeypair.publicKey() };
}

async function ensureDemoAccountsReady() {
  if (!demoAccountsReadyPromise) {
    demoAccountsReadyPromise = (async () => {
      const sourceKeypair = getDemoSourceKeypair();
      const issuerKeypair = StellarSdk.Keypair.fromSecret(getDemoUsdcIssuerSeed());
      const usdcAsset = new StellarSdk.Asset("USDC", getDemoUsdcIssuerAccount());

      await Promise.all([
        ensureTestnetAccount(sourceKeypair.publicKey()),
        ensureTestnetAccount(issuerKeypair.publicKey()),
        ensureTestnetAccount(getDemoDestinationAccount())
      ]);

      if (sourceKeypair.publicKey() !== usdcAsset.issuer) {
        await ensureTrustline(sourceKeypair, usdcAsset);
      }

      return true;
    })().catch((error) => {
      demoAccountsReadyPromise = null;
      throw error;
    });
  }

  return demoAccountsReadyPromise;
}

async function submitTestnetProofPayment(transactionId, amount) {
  const issuerKeypair = StellarSdk.Keypair.fromSecret(getDemoUsdcIssuerSeed());
  const sourcePublicKey = issuerKeypair.publicKey();
  const destinationPublicKey = getDemoProofDestinationAccount();
  const usdcAsset = new StellarSdk.Asset("USDC", getDemoUsdcIssuerAccount());
  const server = new StellarSdk.Horizon.Server(TESTNET_HORIZON_URL);
  const proofAmount = roundToSevenDecimals(Math.max(0.0000001, Number(amount) / getDemoExchangeRate()));
  const memo = StellarSdk.Memo.text(getProofMemoText(transactionId));

  await ensureDemoAccountsReady();

  const account = await server.loadAccount(sourcePublicKey);
  const fee = await server.fetchBaseFee();
  const transaction = new StellarSdk.TransactionBuilder(account, {
    fee: String(fee),
    networkPassphrase: StellarSdk.Networks.TESTNET
  })
    .addMemo(memo)
    .addOperation(
      StellarSdk.Operation.payment({
        destination: destinationPublicKey,
        asset: usdcAsset,
        amount: proofAmount
      })
    )
    .setTimeout(60)
    .build();

  transaction.sign(issuerKeypair);

  const result = await server.submitTransaction(transaction);

  return {
    network: "testnet",
    network_passphrase: StellarSdk.Networks.TESTNET,
    horizon_url: TESTNET_HORIZON_URL,
    explorer_url: `${TESTNET_EXPERT_BASE_URL}/${result.hash}`,
    hash: result.hash,
    ledger: result.ledger,
    source_account: sourcePublicKey,
    destination_account: destinationPublicKey,
    asset: "USDC",
    asset_issuer: usdcAsset.issuer,
    amount: proofAmount,
    memo: memo.value
  };
}

function buildStellarProofFromPlatformTransaction(transaction) {
  const hash =
    transaction?.external_transaction_id ||
    transaction?.stellar_transactions?.[0]?.id;

  if (!hash) {
    return null;
  }

  return {
    network: "testnet",
    network_passphrase: StellarSdk.Networks.TESTNET,
    horizon_url: TESTNET_HORIZON_URL,
    explorer_url: `${TESTNET_EXPERT_BASE_URL}/${hash}`,
    hash,
    memo: transaction?.memo || transaction?.stellar_transactions?.[0]?.memo
  };
}

async function attachStellarProofToDemoTransaction({
  transactionId,
  amount,
  kind = "deposit",
  status = "pending_user_transfer_start",
  anchorBackend,
  interactiveUrl,
  interactiveType
}) {
  demoTransactions[transactionId] = {
    ...demoTransactions[transactionId],
    stellar_proof_status: "submitting"
  };
  await upsertDemoTransaction(transactionId, demoTransactions[transactionId]);

  try {
    const stellarProof = await submitTestnetProofPayment(transactionId, amount);
    const proofCreatedAt = new Date().toISOString();
    const platformPatch = await patchPlatformTransactions({
      records: [
        {
          transaction: {
            id: transactionId,
            sep: "24",
            kind,
            status,
            memo: stellarProof.memo,
            memo_type: "text",
            external_transaction_id: stellarProof.hash,
            updated_at: proofCreatedAt,
            stellar_transactions: [
              {
                id: stellarProof.hash,
                memo: stellarProof.memo,
                memo_type: "text",
                created_at: proofCreatedAt
              }
            ]
          }
        }
      ]
    });

    const patchedTransaction =
      platformPatch?.records?.[0]?.transaction ||
      platformPatch?.records?.[0] ||
      await getPlatformTransaction(transactionId);

    demoTransactions[transactionId] = {
      ...demoTransactions[transactionId],
      ...patchedTransaction,
      anchor_backend: anchorBackend,
      interactive_url: interactiveUrl,
      interactive_type: interactiveType,
      stellar_proof: stellarProof,
      stellar_proof_status: "confirmed",
      stellar_proof_error: null
    };
    await upsertDemoTransaction(transactionId, demoTransactions[transactionId]);

    console.log(
      `Attached Stellar testnet proof for ${transactionId}; proof=${stellarProof.hash}`
    );
  } catch (error) {
    const message = String(error.message || error);

    demoTransactions[transactionId] = {
      ...demoTransactions[transactionId],
      stellar_proof_status: "failed",
      stellar_proof_error: message
    };
    await upsertDemoTransaction(transactionId, demoTransactions[transactionId]);

    console.error(`Stellar proof failed for ${transactionId}:`, message);
  }
}

function parsePositiveAmount(value, label = "Amount") {
  const amount = Number(value || "0");

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`${label} must be a positive number`);
  }

  return amount;
}

function roundCurrencyAmount(value, currency) {
  const decimals = currency === "MWK" ? 2 : 2;
  return Number(Number(value).toFixed(decimals));
}

function getCorridorDefinition(fromCurrency, toCurrency) {
  const from = String(fromCurrency || "").toUpperCase();
  const to = String(toCurrency || "").toUpperCase();

  if (from === "ZMW" && to === "MWK") {
    return {
      fromCountry: "ZM",
      toCountry: "MW",
      fromCurrency: "ZMW",
      toCurrency: "MWK",
      exchangeRate: getDemoZmwToMwkRate(),
      direction: "zambia_to_malawi",
      anchorFlow: "deposit"
    };
  }

  if (from === "MWK" && to === "ZMW") {
    return {
      fromCountry: "MW",
      toCountry: "ZM",
      fromCurrency: "MWK",
      toCurrency: "ZMW",
      exchangeRate: 1 / getDemoZmwToMwkRate(),
      direction: "malawi_to_zambia",
      anchorFlow: "withdrawal"
    };
  }

  throw new Error("Unsupported corridor. Use ZMW to MWK or MWK to ZMW.");
}

function buildCorridorQuote({ fromCurrency, toCurrency, amount }) {
  const corridor = getCorridorDefinition(fromCurrency, toCurrency);
  const sendAmount = roundCurrencyAmount(parsePositiveAmount(amount), corridor.fromCurrency);
  const fee = roundCurrencyAmount(sendAmount * 0.02, corridor.fromCurrency);
  const netSendAmount = Math.max(0, sendAmount - fee);
  const recipientAmount = roundCurrencyAmount(
    netSendAmount * corridor.exchangeRate,
    corridor.toCurrency
  );

  return {
    id: `bp-quote-${crypto.randomUUID()}`,
    fromCountry: corridor.fromCountry,
    toCountry: corridor.toCountry,
    fromCurrency: corridor.fromCurrency,
    toCurrency: corridor.toCurrency,
    sendAmount,
    fee,
    netSendAmount: roundCurrencyAmount(netSendAmount, corridor.fromCurrency),
    exchangeRate: Number(corridor.exchangeRate.toFixed(corridor.toCurrency === "ZMW" ? 6 : 2)),
    recipientAmount,
    estimatedDelivery: "Testnet demo",
    settlementAsset: getAnchorUsdcAssetId(),
    settlementMode: "single-anchor-testnet-simulation",
    disclaimer: "Demo quote only. Not a live FX quote."
  };
}

async function createDemoDepositRecord(amount, message = "BwanaPay custodial mobile deposit initiated") {
  const sourceKeypair = StellarSdk.Keypair.fromSecret(getDemoSourceSeed());
  const createdAt = new Date().toISOString();
  const amountOut = roundToTwoDecimals(amount / getDemoExchangeRate());
  console.log(`Creating BwanaPay demo deposit for ${amount} ZMW`);
  const sep24Transaction = await createSep24DepositTransaction(sourceKeypair);
  const publicSep24Transaction = {
    ...sep24Transaction,
    url: toPublicAnchorUrl(sep24Transaction.url)
  };
  const transactionId = sep24Transaction.id;
  const memo = getProofMemoText(transactionId);
  const anchorBackend = getCachedAnchorBackend();

  const platformPatch = await patchPlatformTransactions({
    records: [
      {
        transaction: {
          id: transactionId,
          sep: "24",
          kind: "deposit",
          status: "pending_user_transfer_start",
          type: "USDC",
          amount_expected: {
            amount: String(amount),
            asset: "iso4217:ZMW"
          },
          amount_in: {
            amount: String(amount),
            asset: "iso4217:ZMW"
          },
          amount_out: {
            amount: amountOut,
            asset: getAnchorUsdcAssetId()
          },
          fee_details: {
            total: "0",
            asset: "iso4217:ZMW"
          },
          message,
          memo,
          memo_type: "text",
          updated_at: createdAt
        }
      }
    ]
  });

  const patchedTransaction =
    platformPatch?.records?.[0]?.transaction ||
    platformPatch?.records?.[0] ||
    await getPlatformTransaction(transactionId);

  const transaction = {
    ...patchedTransaction,
    anchor_backend: anchorBackend,
    stellar_proof: null,
    stellar_proof_status: "pending",
    interactive_url: publicSep24Transaction.url,
    interactive_type: publicSep24Transaction.type
  };

  demoTransactions[transactionId] = transaction;
  await upsertDemoTransaction(transactionId, transaction);
  console.log(
    `Created BwanaPay demo deposit ${transactionId}; status=${transaction.status}; proof=pending`
  );

  attachStellarProofToDemoTransaction({
    transactionId,
    amount,
    kind: "deposit",
    anchorBackend,
    interactiveUrl: publicSep24Transaction.url,
    interactiveType: publicSep24Transaction.type
  });

  return {
    transaction,
    anchor: anchorBackend,
    sep24: publicSep24Transaction,
    stellar_proof: null,
    stellar_proof_status: "pending"
  };
}

async function createDemoWithdrawalRecord(amount, message = "BwanaPay custodial mobile withdrawal initiated") {
  const sourceKeypair = StellarSdk.Keypair.fromSecret(getDemoSourceSeed());
  const createdAt = new Date().toISOString();
  const amountIn = roundToTwoDecimals(amount / getDemoExchangeRate());
  console.log(`Creating BwanaPay demo withdrawal for ${amount} ZMW`);
  const sep24Transaction = await createSep24WithdrawalTransaction(sourceKeypair);
  const publicSep24Transaction = {
    ...sep24Transaction,
    url: toPublicAnchorUrl(sep24Transaction.url)
  };
  const transactionId = sep24Transaction.id;
  const memo = getProofMemoText(transactionId);
  const anchorBackend = getCachedAnchorBackend();

  const platformPatch = await patchPlatformTransactions({
    records: [
      {
        transaction: {
          id: transactionId,
          sep: "24",
          kind: "withdrawal",
          status: "pending_user_transfer_start",
          type: "USDC",
          amount_expected: {
            amount: amountIn,
            asset: getAnchorUsdcAssetId()
          },
          amount_in: {
            amount: amountIn,
            asset: getAnchorUsdcAssetId()
          },
          amount_out: {
            amount: String(amount),
            asset: "iso4217:ZMW"
          },
          fee_details: {
            total: "0",
            asset: "iso4217:ZMW"
          },
          message,
          memo,
          memo_type: "text",
          updated_at: createdAt
        }
      }
    ]
  });

  const patchedTransaction =
    platformPatch?.records?.[0]?.transaction ||
    platformPatch?.records?.[0] ||
    await getPlatformTransaction(transactionId);

  const transaction = {
    ...patchedTransaction,
    anchor_backend: anchorBackend,
    stellar_proof: null,
    stellar_proof_status: "pending",
    interactive_url: publicSep24Transaction.url,
    interactive_type: publicSep24Transaction.type
  };

  demoTransactions[transactionId] = transaction;
  await upsertDemoTransaction(transactionId, transaction);
  console.log(
    `Created BwanaPay demo withdrawal ${transactionId}; status=${transaction.status}; proof=pending`
  );

  attachStellarProofToDemoTransaction({
    transactionId,
    amount,
    kind: "withdrawal",
    anchorBackend,
    interactiveUrl: publicSep24Transaction.url,
    interactiveType: publicSep24Transaction.type
  });

  return {
    transaction,
    anchor: anchorBackend,
    sep24: publicSep24Transaction,
    stellar_proof: null,
    stellar_proof_status: "pending"
  };
}

async function createCorridorTransactionRecord(body) {
  const quote = buildCorridorQuote({
    fromCurrency: body.fromCurrency,
    toCurrency: body.toCurrency,
    amount: body.amount
  });
  const corridor = getCorridorDefinition(quote.fromCurrency, quote.toCurrency);
  const createdAt = new Date().toISOString();
  const anchorAmount =
    corridor.anchorFlow === "deposit" ? quote.sendAmount : quote.recipientAmount;
  const anchorMessage =
    corridor.direction === "zambia_to_malawi"
      ? "BwanaPay Zambia-Malawi corridor transfer initiated"
      : "BwanaPay Malawi-Zambia corridor transfer initiated";
  const anchorResult =
    corridor.anchorFlow === "deposit"
      ? await createDemoDepositRecord(anchorAmount, anchorMessage)
      : await createDemoWithdrawalRecord(anchorAmount, anchorMessage);
  const anchorTransaction = anchorResult.transaction;
  const id = `bp-corridor-${crypto.randomUUID()}`;

  const transaction = {
    id,
    status: anchorTransaction.status || "pending_user_transfer_start",
    corridor: `${quote.fromCountry}-${quote.toCountry}`,
    direction: corridor.direction,
    fromCountry: quote.fromCountry,
    toCountry: quote.toCountry,
    fromCurrency: quote.fromCurrency,
    toCurrency: quote.toCurrency,
    sendAmount: quote.sendAmount,
    fee: quote.fee,
    netSendAmount: quote.netSendAmount,
    exchangeRate: quote.exchangeRate,
    recipientAmount: quote.recipientAmount,
    recipientName: body.recipientName || "Grace Banda",
    recipientPhone: body.recipientPhone || "+265991234567",
    payoutMethod: body.payoutMethod || "Mobile Money",
    estimatedDelivery: quote.estimatedDelivery,
    settlementAsset: quote.settlementAsset,
    settlementMode: quote.settlementMode,
    anchorTransactionId: anchorTransaction.id,
    anchorStatus: anchorTransaction.status,
    anchorKind: anchorTransaction.kind,
    anchorInteractiveUrl: anchorTransaction.interactive_url,
    anchorInteractiveType: anchorTransaction.interactive_type,
    anchorBackend: anchorTransaction.anchor_backend || anchorResult.anchor,
    stellarProof: null,
    stellarProofStatus: anchorTransaction.stellar_proof_status || "pending",
    stellarProofError: null,
    quote,
    createdAt,
    updatedAt: createdAt,
    disclaimer: "Single-anchor testnet corridor simulation. Not a live FX or payout transaction."
  };

  corridorTransactions[id] = transaction;
  await upsertCorridorTransaction(id, transaction);

  return transaction;
}

async function getCorridorTransactionRecord(id) {
  const transaction =
    corridorTransactions[id] ||
    (await getPersistedCorridorTransaction(id));

  if (!transaction) {
    return null;
  }

  if (!transaction.anchorTransactionId) {
    return transaction;
  }

  try {
    const anchorTransaction = await getPlatformTransaction(transaction.anchorTransactionId);
    const demoTransaction =
      demoTransactions[transaction.anchorTransactionId] ||
      (await getPersistedDemoTransaction(transaction.anchorTransactionId));
    const stellarProof =
      demoTransaction?.stellar_proof ||
      buildStellarProofFromPlatformTransaction(anchorTransaction);
    const stellarProofStatus =
      demoTransaction?.stellar_proof_status ||
      (stellarProof ? "confirmed" : transaction.stellarProofStatus || "pending");

    const refreshed = {
      ...transaction,
      status: anchorTransaction.status || transaction.status,
      anchorStatus: anchorTransaction.status || transaction.anchorStatus,
      stellarProof,
      stellarProofStatus,
      stellarProofError:
        demoTransaction?.stellar_proof_error || transaction.stellarProofError || null,
      updatedAt: new Date().toISOString()
    };

    corridorTransactions[id] = refreshed;
    await upsertCorridorTransaction(id, refreshed);
    return refreshed;
  } catch (error) {
    console.warn(
      `Unable to refresh corridor transaction ${id}:`,
      error.message || error
    );
    return transaction;
  }
}

async function safeReadBody(response) {
  try {
    return await response.text();
  } catch {
    return "<unable to read response body>";
  }
}

function getUser(sub) {
  return null;
}

app.listen(port, () => {
  console.log(`Business server listening on port ${port}`);

  if (process.env.ENABLE_DEMO_ENDPOINTS === "true") {
    Promise.allSettled([
      withStartupRetry("Business demo persistence", () => ensureBusinessDbReady()),
      withStartupRetry("Anchor health", () => refreshAnchorHealth()),
      withStartupRetry("Demo testnet accounts", () => ensureDemoAccountsReady()),
      withStartupRetry(
        "SEP-10 token",
        () => getSep10Token(StellarSdk.Keypair.fromSecret(getDemoSourceSeed()))
      )
    ]).then((results) => {
      const rejected = results.filter((result) => result.status === "rejected");

      if (rejected.length > 0) {
        console.warn("Demo backend warmup completed with warnings");
        rejected.forEach((result) => console.warn(result.reason?.message || result.reason));
        return;
      }

      console.log("Demo backend warmup completed");
    });

    const healthRefreshTimer = setInterval(() => {
      refreshAnchorHealth().catch((error) => {
        console.warn("Demo health refresh failed:", error.message || error);
      });
    }, 60000);

    if (typeof healthRefreshTimer.unref === "function") {
      healthRefreshTimer.unref();
    }
  }
});

(async () => {
  while (true) {
    await new Promise((r) => setTimeout(r, 2000));

    if (Object.keys(transactionMemos).length === 0) {
      continue;
    }

    const requestPromises = [];
    for (const transactionId in transactionMemos) {
      requestPromises.push(getPlatformTransaction(transactionId));
    }

    try {
      const transactions = await Promise.all(requestPromises);

      for (const transaction of transactions) {
        if (transaction.status === "pending_user_transfer_start") {
          console.log(`transaction ${transaction.id} is waiting for off-chain funds`);
        }

        if (transaction.status === "pending_anchor") {
          console.log(`received off-chain funds for transaction ${transaction.id}`);
        }
      }
    } catch (error) {
      console.error("Error polling for transactions:", error.message || error);
    }
  }
})();

app.post('/demo-transaction', requireDemoAccess, async (req, res) => {
  try {
    const amount = parsePositiveAmount(req.body.amount || '10');
    const result = await createDemoDepositRecord(amount);

    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Demo transaction error:', error);
    const status = String(error.message || error).includes("positive number") ? 400 : 500;
    return res.status(status).json({
      success: false,
      message: String(error.message || error),
    });
  }
});

app.post('/demo-withdrawal', requireDemoAccess, async (req, res) => {
  try {
    const amount = parsePositiveAmount(req.body.amount || '10');
    const result = await createDemoWithdrawalRecord(amount);

    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Demo withdrawal error:', error);
    const status = String(error.message || error).includes("positive number") ? 400 : 500;
    return res.status(status).json({
      success: false,
      message: String(error.message || error),
    });
  }
});

app.post('/corridor/quote', requireDemoAccess, (req, res) => {
  try {
    const quote = buildCorridorQuote(req.body || {});

    return res.json({
      success: true,
      quote
    });
  } catch (error) {
    console.error('Corridor quote error:', error);
    return res.status(400).json({
      success: false,
      message: String(error.message || error),
    });
  }
});

app.post('/corridor/transaction', requireDemoAccess, async (req, res) => {
  try {
    const transaction = await createCorridorTransactionRecord(req.body || {});

    return res.json({
      success: true,
      transaction,
      quote: transaction.quote
    });
  } catch (error) {
    console.error('Corridor transaction error:', error);
    const message = String(error.message || error);
    const status =
      message.includes("Unsupported corridor") || message.includes("positive number")
        ? 400
        : 500;

    return res.status(status).json({
      success: false,
      message,
    });
  }
});

app.get('/corridor/transaction/:id', requireDemoAccess, async (req, res) => {
  try {
    const transaction = await getCorridorTransactionRecord(req.params.id);

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Corridor transaction not found',
      });
    }

    return res.json({
      success: true,
      transaction
    });
  } catch (error) {
    console.error('Corridor transaction inspection error:', error);
    return res.status(500).json({
      success: false,
      message: String(error.message || error),
    });
  }
});
