-- CreateEnum
CREATE TYPE "DeviceKind" AS ENUM ('HOST', 'REGISTER', 'DISPLAY');

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DeviceKind" NOT NULL DEFAULT 'REGISTER',
    "tokenHash" TEXT NOT NULL,
    "appVersion" TEXT,
    "pairedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pairedById" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "lastIp" TEXT,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Device_code_key" ON "Device"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE INDEX "Device_revokedAt_idx" ON "Device"("revokedAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_pairedById_fkey" FOREIGN KEY ("pairedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
