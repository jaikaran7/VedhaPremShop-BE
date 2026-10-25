// Ported verbatim from the frontend (src/utils/products.ts (lotBelongsToProduct only)) so the server computes exactly what the screens used to compute in the browser.
// Only import paths differ. Keep the two in step; the ported tests below prove parity.
import type { Product } from './frontend-types';

export const ONIONS_PRODUCT_CODE = 'ONIONS';

/** Older lots have no product id and are the onion stock already in the yard. */
export function lotBelongsToProduct(
  lot: { productId?: string },
  product: Pick<Product, 'id' | 'code'>,
): boolean {
  if (lot.productId) return lot.productId === product.id;
  return product.code === ONIONS_PRODUCT_CODE;
}
