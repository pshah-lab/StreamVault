import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const urlEncode = (value: Buffer) => value.toString("base64url");

export function createPkceState(secret: string) {
  const state = urlEncode(randomBytes(24));
  const verifier = urlEncode(randomBytes(48));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const signature = createHmac("sha256", secret).update(`${state}.${verifier}`).digest("base64url");
  return { state, verifier, challenge, cookieValue: `${state}.${verifier}.${signature}` };
}

export function verifyPkceState(cookieValue: string | undefined, returnedState: string | undefined, secret: string) {
  if (!cookieValue || !returnedState) return undefined;
  const [state, verifier, signature] = cookieValue.split(".");
  if (!state || !verifier || !signature || state !== returnedState) return undefined;

  const expected = createHmac("sha256", secret).update(`${state}.${verifier}`).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return undefined;
  return verifier;
}

export function parseCookies(cookieHeader: string | undefined) {
  return Object.fromEntries(
    (cookieHeader ?? "")
      .split(";")
      .map((item) => item.trim().split(/=(.*)/s, 2))
      .filter(([key]) => Boolean(key)),
  );
}
