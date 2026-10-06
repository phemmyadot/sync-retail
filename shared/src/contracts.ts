/** Wire-level DTOs shared by the API and the client. */
import type { OverrideAction, PaymentMethod, Role, SaleStatus } from './domain';
import type { DiscountType, LineDiscount } from './pricing';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  color: string | null;
}

export interface StaffTile {
  id: string;
  name: string;
  role: Role;
  color: string | null;
}

export interface AuthResponse {
  token: string;
  user: SessionUser;
}

export interface CategoryDTO {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
}

export interface ProductDTO {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  costCents: number;
  priceCents: number;
  /** Resolved from the product's tax class (kept for older clients / offline caches). */
  taxRateBps: number;
  taxClassId: string;
  taxClassName: string;
  stockQty: number;
  lowStockThreshold: number;
  active: boolean;
  updatedAt: string;
}

export interface CustomerDTO {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  lifetimeSpendCents: number;
  pointsBalance: number;
  createdAt: string;
}

export interface SaleLineInput {
  productId: string;
  quantity: number;
  discount?: LineDiscount | null;
}

export interface SaleTenderInput {
  method: PaymentMethod;
  amountCents: number;
  tenderedCents?: number;
  pointsUsed?: number;
  reference?: string;
}

export interface CreateSaleInput {
  /** Client-generated UUID — idempotency key for offline replay. */
  clientId: string;
  receiptNo: string;
  terminalId?: string;
  customerId?: string | null;
  lines: SaleLineInput[];
  tenders: SaleTenderInput[];
  /** Override tokens approving above-limit discounts / in-cart removals. */
  approvals?: string[];
  /** ISO timestamp from the terminal clock (used for offline sales). */
  createdAt?: string;
}

export interface SaleItemDTO {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  returnedQty: number;
  discountType: DiscountType | null;
  discountValue: number;
  discountCents: number;
  taxRateBps: number;
  taxClassId: string | null;
  taxClassName: string | null;
  taxCents: number;
  totalCents: number;
}

export interface PaymentDTO {
  id: string;
  method: PaymentMethod;
  amountCents: number;
  tenderedCents: number | null;
  changeCents: number;
  pointsUsed: number;
  reference: string | null;
}

export interface SaleDTO {
  id: string;
  receiptNo: string;
  clientId: string;
  status: SaleStatus;
  cashier: { id: string; name: string };
  customer: { id: string; name: string; pointsBalance: number } | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  refundedCents: number;
  pointsEarned: number;
  pointsRedeemed: number;
  offline: boolean;
  voidReason: string | null;
  createdAt: string;
  items: SaleItemDTO[];
  payments: PaymentDTO[];
}

export interface OverrideRequest {
  pin: string;
  action: OverrideAction;
  reason?: string;
  saleId?: string;
  context?: Record<string, unknown>;
}

export interface OverrideGrant {
  overrideToken: string;
  overrideId: string;
  approvedBy: { id: string; name: string };
  expiresAt: string;
}

export type ReportGranularity = 'day' | 'week' | 'month';

export interface ReportSummary {
  range: { from: string; to: string; granularity: ReportGranularity };
  totals: {
    grossCents: number;
    netCents: number;
    taxCents: number;
    discountCents: number;
    refundedCents: number;
    transactions: number;
    averageTicketCents: number;
    itemsSold: number;
    grossMarginCents: number;
  };
  series: { bucket: string; totalCents: number; transactions: number }[];
  topProducts: { productId: string; name: string; sku: string; quantity: number; revenueCents: number }[];
  categories: { name: string; revenueCents: number; quantity: number }[];
  /** Tax collected by class for the period (net of returns). */
  taxes: { name: string; rateBps: number; taxableCents: number; taxCents: number }[];
  payments: { method: PaymentMethod; amountCents: number; count: number }[];
  workers: { userId: string; name: string; transactions: number; revenueCents: number; averageTicketCents: number; voids: number; overrides: number }[];
}

/** Messages pushed from the agent terminal to the customer display. */
export type DisplayMessage =
  | {
      type: 'cart';
      lines: { name: string; quantity: number; unitPriceCents: number; discountCents: number; totalCents: number }[];
      subtotalCents: number;
      discountCents: number;
      taxCents: number;
      /** Per-class tax lines (VAT 7.5% …), largest rate first. */
      taxes: { name: string; rateBps: number; taxCents: number }[];
      totalCents: number;
      customer: { name: string; pointsBalance: number } | null;
      loyaltyAppliedCents: number;
    }
  | { type: 'checkout'; totalCents: number; paidCents: number; remainingCents: number }
  | { type: 'complete'; receiptNo: string; totalCents: number; changeCents: number; pointsEarned: number; pointsBalance: number | null }
  | { type: 'idle' }
  | { type: 'hello' };
