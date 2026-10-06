-- Store assets (the store logo). Purely additive.
CREATE TABLE "StoreAsset" (
    "key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreAsset_pkey" PRIMARY KEY ("key")
);
