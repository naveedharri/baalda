/**
 * What the sign-in form's error box says. The server answers "Invalid email or
 * password" for a wrong password AND for an account created through Google
 * (which has no password at all) and gives no signal telling them apart, so the
 * Google hint is held back until it can plausibly be the cause: Google sign-in
 * is offered on this server and the same email has failed at least twice.
 */
export interface SignInErrorCopy {
  message: string;
  hint: string | null;
}

const INVALID_CREDENTIALS = /invalid email or password/i;

export const GOOGLE_NO_PASSWORD_HINT =
  "Signed up with Google? Use Continue with Google, or reset your password.";

export function isInvalidCredentials(error: string): boolean {
  return INVALID_CREDENTIALS.test(error);
}

export function signInErrorCopy(
  error: string,
  opts: { googleEnabled: boolean; attempts: number },
): SignInErrorCopy {
  if (!isInvalidCredentials(error)) return { message: error, hint: null };
  return {
    message: "Invalid email or password.",
    hint: opts.googleEnabled && opts.attempts >= 2 ? GOOGLE_NO_PASSWORD_HINT : null,
  };
}
