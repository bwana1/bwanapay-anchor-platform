const express = require("express");
const jwt = require("jsonwebtoken");
const fetch = require("node-fetch");

const app = express();
const port = process.env.BUSINESS_SERVER_PORT;

const sessions = {};
const transactionMemos = {};

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
            asset: "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
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

app.get("/platform-transaction/:id", async (req, res) => {
  try {
    const tx = await getPlatformTransaction(req.params.id);
    return res.send(tx);
  } catch (err) {
    console.error("Platform transaction inspection error:", err);
    return res.status(500).send({ error: String(err.message || err) });
  }
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
