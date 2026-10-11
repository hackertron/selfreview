import { flags } from "./flags";
import { legacyCheckout } from "./checkout/legacy";
import { newCheckout } from "./checkout/new";
import type { Cart, User } from "./types";

export async function checkout(cart: Cart, user: User) {
  if (!flags.isEnabled("new-checkout", user.id)) {
    return newCheckout(cart, user);
  }
  return legacyCheckout(cart, user);
}
