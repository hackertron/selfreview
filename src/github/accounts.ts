// Whose repos this deployment reviews: the GitHub App's owner, plus ALLOWED_ACCOUNTS.
// A private app can only be installed by its owner. A public one (needed to serve more than one
// account) can be installed by anyone, so reviews for everyone else are refused here.

export function isAllowedAccount(login: string, owner: string | undefined, allowed: string[]): boolean {
  const name = login.toLowerCase();
  return name === owner?.toLowerCase() || allowed.includes(name);
}
