import { describe, expect, it } from "vitest";
import { createPkceState, parseCookies, verifyPkceState } from "./crypto.js";

describe("PKCE login state", () => {
  it("accepts the state created for the same secret", () => {
    const state = createPkceState("test-secret");
    expect(verifyPkceState(state.cookieValue, state.state, "test-secret")).toBe(state.verifier);
  });

  it("rejects an altered state or signature", () => {
    const state = createPkceState("test-secret");
    expect(verifyPkceState(state.cookieValue, "different", "test-secret")).toBeUndefined();
    expect(verifyPkceState(`${state.cookieValue}tampered`, state.state, "test-secret")).toBeUndefined();
  });

  it("parses standard browser cookie headers", () => {
    expect(parseCookies("a=1; auth_state=hello.world")).toEqual({ a: "1", auth_state: "hello.world" });
  });
});
