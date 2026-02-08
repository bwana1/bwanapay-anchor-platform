/** Complete Anchor Platform Business Server Implementation */

const express = require("express");
const jwt = require("jsonwebtoken");
const fetch = require('node-fetch');
const app = express();
const port = process.env.BUSINESS_SERVER_PORT;

/*
 * We'll store user session data in memory for this example, but production systems
 * should store this data somewhere more persistent.
 */
const sessions = {};

// Production systems should either let the Anchor Platform generate its own memos
// or have your custodial service generate a memo for each transaction.
const transactionMemos = {};

app.use(express.json());

/*
 * Create an authenticated session for the user.
 *
 * Return a session token to be used in future requests as well as the
 * user data. Note that you may not have a user for the stellar account
 * provided, in which case the user should go through your onboarding
 * process.
*/
app.post("/session", async (req, res) => {
  let decodedPlatformToken;
  try {
    decodedPlatformToken = validatePlatformToken(req.body.platformToken);
  } catch (err) {
    res.status(400).send({ "error": err });
    return;
  }

  // The stellar account of the authenticated user
  let stellarAccount = decodedPlatformToken.sub;
  console.log("Authenticated stellar account:", stellarAccount);

  // Get the user data for this account
  let user = getUser(stellarAccount);

  // Create a new session
  let sessionToken = jwt.sign(
    { "jti": decodedPlatformToken.jti },
    process.env.SESSION_JWT_SECRET
  );
  sessions[sessionToken] = {
    timestamp: new Date(),
    account: stellarAccount,
  };

  // Return the session token and user data
  res.send({
    "token": sessionToken,
    "user": user
  });
});

/* 
 * Process transaction details and update the Platform
 */
app.post("/transaction", async (req, res) => {
  let sessionToken;
  try {
    sessionToken = validateSessionToken(req.headers.authorization);
  } catch (err) {
    res.status(400).send({ "error": err });
    return;
  }
  // assuming this is a withdrawal transaction, we'll provide a memo, which is
  // required by our third-party custodian to credit us the payment. When the
  // payment is made with this memo, we can match the on-chain payment with the
  // transaction in the Anchor Platform's database.
  transactionMemos[req.body.transaction.id] = parseInt(Math.random() * 100000);
  let rpcRequestBody = [
    {
      "id": 1,
      "jsonrpc": "2.0",
      "method": "request_onchain_funds",
      "params": {
        "transaction_id": req.body.transaction.id,
        "message": "waiting for the user to provide off-chain funds.",
        "amount_in": {
          "amount": req.body.amount_in.amount,
          "asset": "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        "amount_out": {
          "amount": req.body.amount_out.amount,
          "asset": "iso4217:USD"
        },
        "fee_details": {
          "total": req.body.fee_details.total,
          "asset": "stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        "destination_account": "GD...G",
        "memo": transactionMemos[req.body.transaction.id],
        "memo_type": "id"
      }
    }
  ];
  
  let platformResponse;
  try {
    platformResponse = await updatePlatformTransaction(rpcRequestBody);
  } catch (err) {
    res.status(500).send({ "error": err });
    return;
  }
  res.send({
    "transaction": platformResponse.records[0]
  });
});

// Add a testing endpoint for JWT verification
app.get("/test-jwt", (req, res) => {
  const testJwt = jwt.sign(
    { "test": "data" }, 
    process.env.SECRET_SEP10_JWT_SECRET,
    { algorithm: "HS256" }
  );
  
  try {
    const verified = jwt.verify(
      testJwt, 
      process.env.SECRET_SEP10_JWT_SECRET,
      { algorithms: ["HS256"] }
    );
    res.send({
      "success": true,
      "message": "JWT signing and verification works correctly",
      "jwt": testJwt,
      "verified": verified
    });
  } catch (err) {
    res.status(500).send({
      "success": false,
      "message": "JWT verification failed",
      "error": err.toString()
    });
  }
});

/*
 * Validate the signature and contents of the platform's token
 */
function validatePlatformToken(token) {
  if (!token) {
    throw "missing 'platformToken'";
  }

  let decodedToken;
  
  // Try both secrets
  try {
    // First try with interactive URL secret
    try {
      decodedToken = jwt.verify(token, process.env.SECRET_SEP24_INTERACTIVE_URL_JWT_SECRET, { algorithms: ["HS256"] });
      console.log("Verified with INTERACTIVE_URL secret");
    } catch (err1) {
      console.error("Interactive URL verification failed:", err1);
      
      // If that fails, try with more info URL secret
      try {
        decodedToken = jwt.verify(token, process.env.SECRET_SEP24_MORE_INFO_URL_JWT_SECRET, { algorithms: ["HS256"] });
        console.log("Verified with MORE_INFO_URL secret");
      } catch (err2) {
        console.error("More info URL verification failed:", err2);
        throw new Error("Failed with both secrets");
      }
    }
  } catch (err) {
    console.error("JWT verification error:", err);
    throw "invalid 'platformToken'";
  }
  
  if (!decodedToken.jti) {
    throw "invalid 'platformToken': missing 'jti'";
  }
  return decodedToken;
}

/*
 * Validate the session token from the authorization header
 */
function validateSessionToken(authorizationHeader) {
  if (!authorizationHeader) {
    throw "missing authorization header";
  }
  
  let parts = authorizationHeader.split(" ");
  if (parts.length != 2 || parts[0] != "Bearer") {
    throw "invalid authorization header format";
  }
  
  let sessionToken = parts[1];
  try {
    jwt.verify(sessionToken, process.env.SESSION_JWT_SECRET);
  } catch {
    throw "invalid session token";
  }
  
  if (!sessions[sessionToken]) {
    throw "expired session";
  }
  
  return sessionToken;
}

/*
 * Send a transaction update to the Platform API
 */
async function updatePlatformTransaction(requestBody) {
  let response = await fetch(
    `${process.env.PLATFORM_API_BASE_URL}/transactions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    }
  );
  
  if (response.status != 200) {
    throw `unexpected status code: ${response.status}`;
  }
  
  return await response.json();
}

/*
 * Fetch transaction data from the Platform API
 */
async function getPlatformTransaction(transactionId) {
  let response = await fetch(`${process.env.PLATFORM_API_BASE_URL}/transactions/${transactionId}`);
  
  if (response.status != 200) {
    throw `unexpected status code: ${response.status}`;
  }
  
  return await response.json();
}

/*
 * Query your own database for the user based on account:memo string (sub).
 * Returns null in this example.
 */
function getUser(sub) {
  return null;
}

app.listen(port, () => {
  console.log(`Business server listening on port ${port}`);
});

// Background polling process for transaction updates
(async () => {
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    
    // Skip if there are no transactions to check
    if (Object.keys(transactionMemos).length === 0) {
      continue;
    }
    
    let requestPromises = [];
    for (const transactionId in transactionMemos) {
      requestPromises.push(getPlatformTransaction(transactionId));
    }
    
    try {
      let transactions = await Promise.all(requestPromises);
      for (const transaction of transactions) {
        // assuming all requests were successful
        if (transaction.status == "pending_anchor") {
          // initiate off-chain delivery of funds
          console.log(`received payment for transaction ${transaction.id}`);
          // In production, you would trigger your business logic here
        }
      }
    } catch (error) {
      console.error("Error polling for transactions:", error);
    }
  }
})();
