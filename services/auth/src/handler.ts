import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { createPkceState, parseCookies, verifyPkceState } from "./crypto.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
};

const config = {
  viewerDomain: required("VIEWER_DOMAIN"),
  cognitoDomain: required("COGNITO_DOMAIN"),
  userPoolId: required("USER_POOL_ID"),
  clientId: required("USER_POOL_CLIENT_ID"),
  signingKeyPairId: required("CLOUDFRONT_KEY_PAIR_ID"),
  signingKeySecretArn: required("SIGNING_KEY_SECRET_ARN"),
  stateSecretArn: required("STATE_SECRET_ARN"),
};
const secrets = new SecretsManagerClient({});
const authCallback = `https://${config.viewerDomain}/auth/callback`;
const appUrl = `https://${config.viewerDomain}/app/index.html`;
const verifier = CognitoJwtVerifier.create({ userPoolId: config.userPoolId, clientId: config.clientId, tokenUse: "id" });

function getSecurityHeaders() {
  return {
    "cache-control": "no-store",
    "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; media-src 'self' blob: https://${config.viewerDomain}; img-src 'self' data:; connect-src 'self' https://${config.viewerDomain} http://localhost:8000;`,
  };
}

function redirect(location: string, cookies: string[] = []): APIGatewayProxyResultV2 {
  return {
    statusCode: 302,
    headers: {
      location,
      ...getSecurityHeaders(),
    },
    cookies,
  };
}

function securityCookie(name: string, value: string, maxAge: number, path = "/", sameSite = "Strict") {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`;
}

async function getSecretValue(secretArn: string) {
  const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error(`Secret ${secretArn} has no string value.`);
  return response.SecretString;
}

async function getSecretField(secretArn: string, field: string) {
  const raw = await getSecretValue(secretArn);
  const value = JSON.parse(raw)[field];
  if (!value || typeof value !== "string") throw new Error(`Secret ${secretArn} is missing ${field}.`);
  return value;
}

function hostedUiUrl(state: string, challenge: string) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: authCallback,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://${config.cognitoDomain}/login?${params}`;
}

async function redeemCode(code: string, codeVerifier: string) {
  const response = await fetch(`https://${config.cognitoDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code,
      redirect_uri: authCallback,
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) throw new Error(`Cognito token exchange failed (${response.status}).`);
  return response.json() as Promise<{ id_token?: string }>;
}

async function login() {
  const stateSecret = await getSecretField(config.stateSecretArn, "stateSecret");
  const state = createPkceState(stateSecret);
  return redirect(hostedUiUrl(state.state, state.challenge), [securityCookie("auth_state", state.cookieValue, 600, "/auth", "Lax")]);
}

async function callback(event: APIGatewayProxyEventV2) {
  const params = event.queryStringParameters ?? {};
  const stateSecret = await getSecretField(config.stateSecretArn, "stateSecret");
  const requestCookies = event.cookies?.join("; ") ?? event.headers.cookie;
  const pkceVerifier = verifyPkceState(parseCookies(requestCookies).auth_state, params.state, stateSecret);
  if (!pkceVerifier || !params.code) return redirect(`${appUrl}?error=invalid-login`, [securityCookie("auth_state", "", 0, "/auth", "Lax")]);

  const tokens = await redeemCode(params.code, pkceVerifier);
  if (!tokens.id_token) throw new Error("Cognito response did not include an ID token.");
  await verifier.verify(tokens.id_token);

  const privateKey = await getSecretField(config.signingKeySecretArn, "privateKey");
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const policy = JSON.stringify({ Statement: [{ Resource: `https://${config.viewerDomain}/*`, Condition: { DateLessThan: { "AWS:EpochTime": Math.floor(expiresAt.getTime() / 1000) } } }] });
  const signed = getSignedCookies({ keyPairId: config.signingKeyPairId, privateKey, policy });
  const signedCookies = Object.entries(signed).map(([name, value]) => securityCookie(name, value, 4 * 60 * 60, "/", "Lax"));
  return redirect(appUrl, [securityCookie("auth_state", "", 0, "/auth", "Lax"), ...signedCookies]);
}

function logout() {
  const params = new URLSearchParams({ client_id: config.clientId, logout_uri: appUrl });
  const clear = ["CloudFront-Policy", "CloudFront-Signature", "CloudFront-Key-Pair-Id", "auth_state"].map((name) => securityCookie(name, "", 0, name === "auth_state" ? "/auth" : "/", name === "auth_state" ? "Lax" : "Strict"));
  return redirect(`https://${config.cognitoDomain}/logout?${params}`, clear);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    if (event.rawPath === "/auth/login") return await login();
    if (event.rawPath === "/auth/callback") return await callback(event);
    if (event.rawPath === "/auth/logout") return logout();
    return {
      statusCode: 404,
      headers: SECURITY_HEADERS,
      body: JSON.stringify({ error: "Not found" })
    };
  } catch (error) {
    console.error("Authentication request failed", error);
    return redirect(`${appUrl}?error=authentication-failed`);
  }
}
