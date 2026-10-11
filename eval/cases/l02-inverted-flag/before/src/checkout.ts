import { legacyCheckout } from "./checkout/legacy";
import type { Cart, User } from "./types";

export async function checkout(cart: Cart, user: User) {
  return legacyCheckout(cart, user);
}
