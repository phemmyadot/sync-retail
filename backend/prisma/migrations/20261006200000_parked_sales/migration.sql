-- Held ("parked") sales. Purely additive: a new enum and table.
CREATE TYPE "ParkedSaleStatus" AS ENUM ('PARKED', 'RESUMED', 'DISCARDED', 'EXPIRED');

CREATE TABLE "ParkedSale" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "ParkedSaleStatus" NOT NULL DEFAULT 'PARKED',
    "reference" VARCHAR(80),
    "terminalId" TEXT NOT NULL,
    "parkedById" TEXT NOT NULL,
    "customerId" TEXT,
    "lines" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "approvalIds" TEXT[],
    "heldOffline" BOOLEAN NOT NULL DEFAULT false,
    "resumedById" TEXT,
    "resumedAt" TIMESTAMP(3),
    "resumedTerminal" TEXT,
    "closedReason" VARCHAR(200),
    "closedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParkedSale_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ParkedSale_clientId_key" ON "ParkedSale"("clientId");
CREATE INDEX "ParkedSale_status_createdAt_idx" ON "ParkedSale"("status", "createdAt");

ALTER TABLE "ParkedSale" ADD CONSTRAINT "ParkedSale_parkedById_fkey" FOREIGN KEY ("parkedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ParkedSale" ADD CONSTRAINT "ParkedSale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ParkedSale" ADD CONSTRAINT "ParkedSale_resumedById_fkey" FOREIGN KEY ("resumedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
