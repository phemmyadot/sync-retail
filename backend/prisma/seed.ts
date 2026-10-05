/**
 * Demo data: staff (with PINs), a small café/convenience catalog, loyalty
 * customers and ~60 days of sales history so the reports have something to show.
 *
 *   Admin    admin@syncretail.dev   / admin1234   PIN 1111
 *   Manager  manager@syncretail.dev / manager1234 PIN 2222
 *   Agent    agent@syncretail.dev   / agent1234   PIN 3333
 */
import { PrismaClient, type PaymentMethod, type Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEFAULT_SETTINGS, pointsEarned, priceCart } from '@sync-retail/shared';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Deterministic PRNG so every seed produces the same demo store.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const CATEGORIES = [
  { name: 'Coffee', color: '#FFB547' },
  { name: 'Bakery', color: '#F28C6B' },
  { name: 'Grocery', color: '#8BE28B' },
  { name: 'Drinks', color: '#6FC9F2' },
  { name: 'Snacks', color: '#E7A6F0' },
  { name: 'Household', color: '#D9D1BF' },
];

const PRODUCTS: [string, string, number, number, number][] = [
  // category, name, price, cost, tax bps
  ['Coffee', 'Espresso', 300, 60, 825],
  ['Coffee', 'Flat White', 450, 95, 825],
  ['Coffee', 'Oat Latte', 520, 120, 825],
  ['Coffee', 'Cold Brew 16oz', 495, 90, 825],
  ['Coffee', 'Whole Bean — Ethiopia 340g', 1800, 950, 0],
  ['Coffee', 'Whole Bean — House Blend 1kg', 3600, 1900, 0],
  ['Bakery', 'Butter Croissant', 375, 110, 825],
  ['Bakery', 'Pain au Chocolat', 425, 130, 825],
  ['Bakery', 'Sourdough Loaf', 850, 260, 0],
  ['Bakery', 'Cardamom Bun', 450, 120, 825],
  ['Bakery', 'Banana Bread Slice', 395, 90, 825],
  ['Grocery', 'Free-range Eggs (12)', 699, 410, 0],
  ['Grocery', 'Organic Whole Milk 1L', 349, 190, 0],
  ['Grocery', 'Oat Milk 1L', 429, 230, 0],
  ['Grocery', 'Wildflower Honey 500g', 1250, 720, 0],
  ['Grocery', 'Olive Oil 750ml', 1599, 980, 0],
  ['Grocery', 'Strawberry Jam', 699, 330, 0],
  ['Drinks', 'Sparkling Water 500ml', 199, 60, 825],
  ['Drinks', 'Cold-pressed OJ', 650, 290, 825],
  ['Drinks', 'Kombucha — Ginger', 475, 210, 825],
  ['Drinks', 'Matcha Tonic', 595, 180, 825],
  ['Snacks', 'Sea Salt Chips', 299, 110, 825],
  ['Snacks', 'Dark Chocolate 70%', 450, 190, 825],
  ['Snacks', 'Trail Mix', 599, 260, 825],
  ['Snacks', 'Protein Bar', 349, 150, 825],
  ['Household', 'Reusable Cup 12oz', 1500, 520, 825],
  ['Household', 'Beeswax Wraps (3)', 1800, 700, 825],
  ['Household', 'Dish Soap — Refill', 899, 410, 825],
];

const FIRST = ['Ada', 'Bola', 'Chen', 'Dami', 'Elena', 'Femi', 'Grace', 'Hiro', 'Ife', 'Jonas', 'Kemi', 'Luca', 'Maya', 'Nia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sade', 'Tomás'];
const LAST = ['Adeyemi', 'Brooks', 'Carter', 'Diaz', 'Eze', 'Fischer', 'Gupta', 'Hassan', 'Ito', 'Johnson', 'Okafor', 'Novak'];

/** Wipes and reloads demo data. With `ifEmpty`, does nothing when users already exist. */
export async function seedDemo(prisma: PrismaClient, opts: { ifEmpty?: boolean } = {}) {
  seed = 42;
  if (opts.ifEmpty && (await prisma.user.count()) > 0) {
    console.log('Database already has data — skipping demo seed.');
    return;
  }
  console.log('Resetting tables…');
  await prisma.$transaction([
    prisma.refund.deleteMany(),
    prisma.loyaltyTransaction.deleteMany(),
    prisma.overrideLog.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.saleItem.deleteMany(),
    prisma.sale.deleteMany(),
    prisma.stockMovement.deleteMany(),
    prisma.importBatch.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.product.deleteMany(),
    prisma.category.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.user.deleteMany(),
    prisma.setting.deleteMany(),
  ]);

  console.log('Staff…');
  const mkUser = async (name: string, email: string, password: string, pin: string, role: 'ADMIN' | 'MANAGER' | 'SALES_AGENT', color: string) =>
    prisma.user.create({
      data: { name, email, role, color, passwordHash: await bcrypt.hash(password, 12), pinHash: await bcrypt.hash(pin, 10) },
    });
  const admin = await mkUser('Avery Admin', 'admin@syncretail.dev', 'admin1234', '1111', 'ADMIN', '#FFB547');
  const manager = await mkUser('Morgan Lee', 'manager@syncretail.dev', 'manager1234', '2222', 'MANAGER', '#8BE28B');
  const agent = await mkUser('Sam Rivera', 'agent@syncretail.dev', 'agent1234', '3333', 'SALES_AGENT', '#6FC9F2');
  const agent2 = await mkUser('Jordan Okoye', 'jordan@syncretail.dev', 'agent1234', '4444', 'SALES_AGENT', '#E7A6F0');
  const cashiers = [agent, agent, agent2, agent2, manager];

  await prisma.setting.create({ data: { key: 'store', value: { ...DEFAULT_SETTINGS, storeName: 'Night Shift Market' } as object } });

  console.log('Catalog…');
  const cats = new Map<string, string>();
  for (const [i, c] of CATEGORIES.entries()) {
    const row = await prisma.category.create({ data: { ...c, sortOrder: i } });
    cats.set(c.name, row.id);
  }
  const products: Prisma.ProductGetPayload<{ include: { category: true } }>[] = [];
  for (const [i, [cat, name, price, cost, tax]] of PRODUCTS.entries()) {
    products.push(
      await prisma.product.create({
        data: {
          sku: `${cat.slice(0, 3).toUpperCase()}-${String(i + 1).padStart(4, '0')}`,
          barcode: `0${String(7_000_000_000_00 + i * 7919).padStart(12, '0')}`.slice(-12),
          name,
          categoryId: cats.get(cat),
          priceCents: price,
          costCents: cost,
          taxRateBps: tax,
          stockQty: between(15, 140),
          lowStockThreshold: 10,
        },
        include: { category: true },
      }),
    );
  }

  console.log('Customers…');
  const customers = [];
  for (let i = 0; i < 24; i++) {
    const first = FIRST[i % FIRST.length];
    const last = pick(LAST);
    customers.push(
      await prisma.customer.create({
        data: {
          name: `${first} ${last}`,
          phone: `555${String(1_000_000 + i * 3571).slice(-7)}`,
          email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
        },
      }),
    );
  }

  console.log('Sales history (60 days)…');
  const loyalty = DEFAULT_SETTINGS.loyalty;
  const balances = new Map(customers.map((c) => [c.id, { points: 0, spend: 0 }]));
  let receipt = 1000;

  for (let day = 60; day >= 0; day--) {
    const weekend = [0, 6].includes(new Date(Date.now() - day * 864e5).getDay());
    const count = between(weekend ? 10 : 6, weekend ? 18 : 12);
    for (let s = 0; s < count; s++) {
      const createdAt = new Date(Date.now() - day * 864e5);
      createdAt.setHours(between(7, 19), between(0, 59), between(0, 59));
      if (createdAt > new Date()) continue;

      const lines = Array.from({ length: between(1, 4) }, () => ({ product: pick(products), quantity: between(1, 3) }));
      const merged = [...new Map(lines.map((l) => [l.product.id, l])).values()];
      const totals = priceCart(merged.map((l) => ({ unitPriceCents: l.product.priceCents, quantity: l.quantity, taxRateBps: l.product.taxRateBps })));
      const customer = rand() < 0.45 ? pick(customers) : null;
      const method: PaymentMethod = rand() < 0.62 ? 'CARD' : 'CASH';
      const tendered = method === 'CASH' ? Math.ceil(totals.totalCents / 500) * 500 : null;
      const earned = customer ? pointsEarned(totals.totalCents, loyalty) : 0;
      const voided = rand() < 0.015;

      await prisma.sale.create({
        data: {
          receiptNo: `T1-${String(receipt++).padStart(6, '0')}`,
          clientId: randomUUID(),
          terminalId: 'T1',
          cashierId: pick(cashiers).id,
          customerId: customer?.id,
          subtotalCents: totals.subtotalCents,
          discountCents: totals.discountCents,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          pointsEarned: voided ? 0 : earned,
          status: voided ? 'VOIDED' : 'COMPLETED',
          voidReason: voided ? 'Customer changed mind' : null,
          voidedAt: voided ? createdAt : null,
          refundedCents: voided ? totals.totalCents : 0,
          createdAt,
          items: {
            create: merged.map((l, i) => ({
              productId: l.product.id,
              sku: l.product.sku,
              name: l.product.name,
              categoryName: l.product.category?.name,
              costCents: l.product.costCents,
              unitPriceCents: l.product.priceCents,
              quantity: l.quantity,
              taxRateBps: l.product.taxRateBps,
              taxCents: totals.lines[i].taxCents,
              totalCents: totals.lines[i].totalCents,
            })),
          },
          payments: {
            create: [{ method, amountCents: totals.totalCents, tenderedCents: tendered, changeCents: tendered ? tendered - totals.totalCents : 0 }],
          },
        },
      });
      if (customer && !voided) {
        const b = balances.get(customer.id)!;
        b.points += earned;
        b.spend += totals.totalCents;
      }
    }
  }

  for (const [id, b] of balances) {
    await prisma.customer.update({ where: { id }, data: { pointsBalance: b.points, lifetimeSpendCents: b.spend } });
    if (b.points) await prisma.loyaltyTransaction.create({ data: { customerId: id, points: b.points, reason: 'Opening balance (seed)' } });
  }

  await prisma.auditLog.create({ data: { actorId: admin.id, action: 'seed', entity: 'System', details: { products: products.length, customers: customers.length } } });
  console.log(`✔ Seeded ${products.length} products, ${customers.length} customers, ${receipt - 1000} sales.`);
}

// CLI: `tsx prisma/seed.ts [--if-empty]` (Docker passes --if-empty so restarts never wipe data).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const prisma = new PrismaClient();
  seedDemo(prisma, { ifEmpty: process.argv.includes('--if-empty') })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
