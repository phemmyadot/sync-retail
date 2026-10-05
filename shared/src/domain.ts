/**
 * Domain enums and role-based permissions shared by API and client.
 * Keep these string values in lock-step with the Prisma enums.
 */

export const ROLES = ['ADMIN', 'MANAGER', 'SALES_AGENT'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  SALES_AGENT: 'Sales Agent',
};

export const PAYMENT_METHODS = ['CASH', 'CARD', 'LOYALTY'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  LOYALTY: 'Loyalty points',
};

export const OVERRIDE_ACTIONS = [
  'REMOVE_ITEM',
  'DECREASE_QTY',
  'CLEAR_CART',
  'PRICE_DISCOUNT',
  'VOID_SALE',
  'RETURN_ITEM',
  'EDIT_SALE',
] as const;
export type OverrideAction = (typeof OVERRIDE_ACTIONS)[number];

export const OVERRIDE_LABEL: Record<OverrideAction, string> = {
  REMOVE_ITEM: 'Remove scanned item',
  DECREASE_QTY: 'Reduce scanned quantity',
  CLEAR_CART: 'Void open transaction',
  PRICE_DISCOUNT: 'Discount above agent limit',
  VOID_SALE: 'Void completed sale',
  RETURN_ITEM: 'Return / refund item',
  EDIT_SALE: 'Edit completed sale',
};

export type SaleStatus = 'COMPLETED' | 'VOIDED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

const ALL: readonly Role[] = ROLES;
const MGMT: readonly Role[] = ['ADMIN', 'MANAGER'];
const ADMIN_ONLY: readonly Role[] = ['ADMIN'];

export const PERMISSIONS = {
  'sales:create': ALL,
  'sales:read': ALL,
  'sales:void': MGMT,
  'sales:return': MGMT,
  'sales:edit': MGMT,
  'cart:remove': MGMT,
  'cart:discount-unlimited': MGMT,
  'products:read': ALL,
  'products:write': MGMT,
  'inventory:import': MGMT,
  'customers:read': ALL,
  'customers:create': ALL,
  'customers:write': MGMT,
  'reports:read': MGMT,
  'overrides:approve': MGMT,
  'audit:read': MGMT,
  'users:manage': ADMIN_ONLY,
  'settings:write': ADMIN_ONLY,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | undefined | null, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

/** Which permission lets a user skip a given override prompt entirely. */
export const OVERRIDE_BYPASS: Record<OverrideAction, Permission> = {
  REMOVE_ITEM: 'cart:remove',
  DECREASE_QTY: 'cart:remove',
  CLEAR_CART: 'cart:remove',
  PRICE_DISCOUNT: 'cart:discount-unlimited',
  VOID_SALE: 'sales:void',
  RETURN_ITEM: 'sales:return',
  EDIT_SALE: 'sales:edit',
};

export interface StoreSettings {
  storeName: string;
  currency: string;
  locale: string;
  loyalty: LoyaltyConfig;
  /** Max line discount (basis points) an agent may give without an override. */
  agentMaxDiscountBps: number;
  receiptFooter: string;
  promoBanners: { title: string; subtitle: string }[];
}

export interface LoyaltyConfig {
  /** Points earned per whole dollar paid with non-loyalty tenders. */
  pointsPerDollar: number;
  /** Points are redeemed in blocks: e.g. 100 points … */
  redeemBlockPoints: number;
  /** … are worth this many cents (e.g. 500 = $5). */
  redeemBlockValueCents: number;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  storeName: 'Sync Retail',
  currency: 'USD',
  locale: 'en-US',
  loyalty: { pointsPerDollar: 1, redeemBlockPoints: 100, redeemBlockValueCents: 500 },
  agentMaxDiscountBps: 1000,
  receiptFooter: 'Thank you — come back soon.',
  promoBanners: [
    { title: 'Members earn on every dollar', subtitle: 'Ask to join the rewards club today.' },
    { title: '100 points = $5 off', subtitle: 'Redeem at any register.' },
  ],
};
