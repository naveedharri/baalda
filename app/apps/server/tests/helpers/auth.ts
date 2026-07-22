import { auth } from "../../src/auth/auth.js";

export interface TestUser {
  userId: string;
  email: string;
  /** Bearer token (value from `set-auth-token`) for Authorization headers. */
  token: string;
}

/** Sign up a new user and return their bearer session token. */
export async function signUp(
  email: string,
  password = "password12345",
  name = email.split("@")[0],
): Promise<TestUser> {
  const res = await auth.api.signUpEmail({
    body: { email, password, name },
    asResponse: true,
  });
  const token = res.headers.get("set-auth-token");
  if (!token) throw new Error("signUp: no set-auth-token header");
  const body = (await res.json()) as { user: { id: string } };
  return { userId: body.user.id, email, token };
}

/** Sign in an existing user and return a fresh bearer token. */
export async function signIn(
  email: string,
  password = "password12345",
): Promise<TestUser> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const token = res.headers.get("set-auth-token");
  if (!token) throw new Error("signIn: no set-auth-token header");
  const body = (await res.json()) as { user: { id: string } };
  return { userId: body.user.id, email, token };
}

/** Plain-object headers for fetch Request init. */
export function authHeaders(user: TestUser): Record<string, string> {
  return { authorization: `Bearer ${user.token}`, "content-type": "application/json" };
}

/** Headers instance for auth.api.* calls. */
export function bearerHeaders(user: TestUser): Headers {
  return new Headers({ authorization: `Bearer ${user.token}` });
}

/** Create an organization (vault) owned by the given user. */
export async function createOrg(
  user: TestUser,
  name: string,
  slug: string,
): Promise<{ id: string }> {
  const org = await auth.api.createOrganization({
    headers: bearerHeaders(user),
    body: { name, slug },
  });
  if (!org) throw new Error("createOrganization returned null");
  return { id: (org as { id: string }).id };
}
