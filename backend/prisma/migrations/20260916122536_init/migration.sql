-- CreateEnum
CREATE TYPE "KycTier" AS ENUM ('NONE', 'STANDARD', 'ENHANCED');

-- CreateEnum
CREATE TYPE "AttestationStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'SUSPENDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AgentAlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "TopUpRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'CLAIMED', 'REFUNDED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "stellarAddress" TEXT,
    "displayName" TEXT,
    "email" TEXT,
    "phoneE164" TEXT,
    "countryCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycAttestation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "KycTier" NOT NULL,
    "providerId" TEXT NOT NULL,
    "attestationHash" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "status" "AttestationStatus" NOT NULL DEFAULT 'PENDING',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokeReason" TEXT,
    "publishTxHash" TEXT,
    "revokeTxHash" TEXT,
    "providerRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KycAttestation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "minBond" DECIMAL(39,0) NOT NULL,
    "maxAgents" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Corridor" (
    "id" TEXT NOT NULL,
    "sourceCurrency" TEXT NOT NULL,
    "destCurrency" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "tier1Max" DECIMAL(39,0) NOT NULL,
    "tier2Max" DECIMAL(39,0) NOT NULL,
    "dailyLimit" DECIMAL(39,0) NOT NULL,
    "spreadBps" INTEGER NOT NULL DEFAULT 75,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Corridor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "stellarAddress" TEXT NOT NULL,
    "settlementAddress" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradingName" TEXT,
    "regionId" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'PENDING',
    "bondAmount" DECIMAL(39,0) NOT NULL,
    "bondTxHash" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorizedAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "slashCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentExposure" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "drawnAmount" DECIMAL(39,0) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentExposure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentFloatAlert" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "thresholdBps" INTEGER NOT NULL,
    "observedBps" INTEGER NOT NULL,
    "status" "AgentAlertStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "AgentFloatAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiquidityTopUpRequest" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "amountRequested" DECIMAL(39,0) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TopUpRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "decisionNote" TEXT,
    "txHash" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "LiquidityTopUpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiquidityPoolSnapshot" (
    "id" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "totalDeposited" DECIMAL(39,0) NOT NULL,
    "totalDrawn" DECIMAL(39,0) NOT NULL,
    "available" DECIMAL(39,0) NOT NULL,
    "utilizationBps" INTEGER NOT NULL,
    "depositorCount" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LiquidityPoolSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transfer" (
    "id" BIGINT NOT NULL,
    "senderId" TEXT NOT NULL,
    "agentId" TEXT,
    "corridorId" TEXT NOT NULL,
    "amount" DECIMAL(39,0) NOT NULL,
    "fee" DECIMAL(39,0) NOT NULL DEFAULT 0,
    "payout" DECIMAL(39,0) NOT NULL DEFAULT 0,
    "tokenAddress" TEXT NOT NULL,
    "claimHash" TEXT NOT NULL,
    "expiry" TIMESTAMP(3) NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "createTxHash" TEXT,
    "settleTxHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainEvent" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "rawXdr" TEXT,
    "transferId" BIGINT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "lastLedger" INTEGER NOT NULL,
    "lastEventId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quote" (
    "id" TEXT NOT NULL,
    "corridorId" TEXT NOT NULL,
    "midRate" TEXT NOT NULL,
    "spreadBps" INTEGER NOT NULL,
    "clientRate" TEXT NOT NULL,
    "amount" DECIMAL(39,0) NOT NULL,
    "fee" DECIMAL(39,0) NOT NULL,
    "total" DECIMAL(39,0) NOT NULL,
    "oracleSource" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "signingKey" TEXT NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "consumedByTransfer" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL DEFAULT 'operator',
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_stellarAddress_key" ON "User"("stellarAddress");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneE164_key" ON "User"("phoneE164");

-- CreateIndex
CREATE INDEX "User_countryCode_idx" ON "User"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "KycAttestation_attestationHash_key" ON "KycAttestation"("attestationHash");

-- CreateIndex
CREATE INDEX "KycAttestation_userId_status_idx" ON "KycAttestation"("userId", "status");

-- CreateIndex
CREATE INDEX "KycAttestation_expiresAt_idx" ON "KycAttestation"("expiresAt");

-- CreateIndex
CREATE INDEX "Corridor_regionId_idx" ON "Corridor"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_stellarAddress_key" ON "Agent"("stellarAddress");

-- CreateIndex
CREATE INDEX "Agent_regionId_status_idx" ON "Agent"("regionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentExposure_agentId_regionId_key" ON "AgentExposure"("agentId", "regionId");

-- CreateIndex
CREATE INDEX "AgentFloatAlert_status_kind_idx" ON "AgentFloatAlert"("status", "kind");

-- CreateIndex
CREATE INDEX "AgentFloatAlert_agentId_status_idx" ON "AgentFloatAlert"("agentId", "status");

-- CreateIndex
CREATE INDEX "LiquidityTopUpRequest_status_idx" ON "LiquidityTopUpRequest"("status");

-- CreateIndex
CREATE INDEX "LiquidityTopUpRequest_agentId_status_idx" ON "LiquidityTopUpRequest"("agentId", "status");

-- CreateIndex
CREATE INDEX "LiquidityPoolSnapshot_regionId_capturedAt_idx" ON "LiquidityPoolSnapshot"("regionId", "capturedAt");

-- CreateIndex
CREATE INDEX "Transfer_status_expiry_idx" ON "Transfer"("status", "expiry");

-- CreateIndex
CREATE INDEX "Transfer_corridorId_createdAt_idx" ON "Transfer"("corridorId", "createdAt");

-- CreateIndex
CREATE INDEX "Transfer_agentId_createdAt_idx" ON "Transfer"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "Transfer_senderId_createdAt_idx" ON "Transfer"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "ChainEvent_topic_ledger_idx" ON "ChainEvent"("topic", "ledger");

-- CreateIndex
CREATE INDEX "ChainEvent_transferId_idx" ON "ChainEvent"("transferId");

-- CreateIndex
CREATE UNIQUE INDEX "ChainEvent_contractId_ledger_eventIndex_key" ON "ChainEvent"("contractId", "ledger", "eventIndex");

-- CreateIndex
CREATE UNIQUE INDEX "IndexerCursor_contractId_key" ON "IndexerCursor"("contractId");

-- CreateIndex
CREATE INDEX "Quote_corridorId_createdAt_idx" ON "Quote"("corridorId", "createdAt");

-- CreateIndex
CREATE INDEX "Quote_validUntil_idx" ON "Quote"("validUntil");

-- CreateIndex
CREATE INDEX "AuditLog_subjectType_subjectId_createdAt_idx" ON "AuditLog"("subjectType", "subjectId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "KycAttestation" ADD CONSTRAINT "KycAttestation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Corridor" ADD CONSTRAINT "Corridor_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentExposure" ADD CONSTRAINT "AgentExposure_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentExposure" ADD CONSTRAINT "AgentExposure_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentFloatAlert" ADD CONSTRAINT "AgentFloatAlert_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiquidityTopUpRequest" ADD CONSTRAINT "LiquidityTopUpRequest_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiquidityPoolSnapshot" ADD CONSTRAINT "LiquidityPoolSnapshot_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transfer" ADD CONSTRAINT "Transfer_corridorId_fkey" FOREIGN KEY ("corridorId") REFERENCES "Corridor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChainEvent" ADD CONSTRAINT "ChainEvent_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_corridorId_fkey" FOREIGN KEY ("corridorId") REFERENCES "Corridor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
