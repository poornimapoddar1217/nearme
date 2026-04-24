import { setTimeout as sleep } from "node:timers/promises";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ log: ["error", "warn"] });

const WORKER_ID = process.env.WORKER_ID || `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS || 750);
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 4));

async function heartbeat() {
  await prisma.workerHeartbeat.upsert({
    where: { workerId: WORKER_ID },
    create: { workerId: WORKER_ID, lastHeartbeat: new Date(), metaJson: JSON.stringify({ pid: process.pid }) },
    update: { lastHeartbeat: new Date(), metaJson: JSON.stringify({ pid: process.pid }) },
  });
}

async function emit(jobId, type, payload) {
  await prisma.scrapeJobEvent.create({
    data: {
      jobId,
      type,
      payloadJson: payload ? JSON.stringify(payload) : null,
    },
  });
}

async function claimNextJob() {
  const now = new Date();
  const jobs = await prisma.scrapeJob.findMany({
    where: {
      status: "queued",
      nextRunAt: { lte: now },
      lockedAt: null,
    },
    orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
    take: 1,
  });
  const job = jobs[0];
  if (!job) return null;

  // optimistic lock
  const updated = await prisma.scrapeJob.updateMany({
    where: { id: job.id, lockedAt: null, status: "queued" },
    data: { lockedAt: new Date(), lockedBy: WORKER_ID, status: "running" },
  });
  if (updated.count !== 1) return null;
  return prisma.scrapeJob.findUnique({ where: { id: job.id } });
}

async function handleJob(job) {
  await emit(job.id, "job_started", { type: job.type });

  // For now, this worker manages retries/monitoring and leaves source-specific scraping
  // to the API streaming endpoints. You can extend this to call official APIs per source.
  await prisma.scrapeJob.update({
    where: { id: job.id },
    data: {
      status: "succeeded",
      resultJson: JSON.stringify({ ok: true }),
      lockedAt: null,
      lockedBy: null,
    },
  });

  await emit(job.id, "job_succeeded", null);
}

async function failJob(job, error) {
  const attempts = job.attempts + 1;
  const backoffSeconds = Math.min(300, 2 ** Math.min(attempts, 8));
  const nextRunAt = new Date(Date.now() + backoffSeconds * 1000);

  const willRetry = attempts < job.maxAttempts;
  await prisma.scrapeJob.update({
    where: { id: job.id },
    data: {
      attempts,
      status: willRetry ? "queued" : "failed",
      nextRunAt: willRetry ? nextRunAt : job.nextRunAt,
      lastError: String(error?.message || error),
      lockedAt: null,
      lockedBy: null,
    },
  });

  await emit(job.id, willRetry ? "job_retry_scheduled" : "job_failed", {
    attempts,
    maxAttempts: job.maxAttempts,
    nextRunAt: willRetry ? nextRunAt.toISOString() : null,
    error: String(error?.message || error),
  });
}

async function workerLoop() {
  const inFlight = new Set();

  // keep heartbeat fresh
  setInterval(() => {
    heartbeat().catch(() => {});
  }, 5000).unref?.();

  for (;;) {
    try {
      await heartbeat();

      while (inFlight.size < CONCURRENCY) {
        const job = await claimNextJob();
        if (!job) break;

        const p = (async () => {
          try {
            await handleJob(job);
          } catch (e) {
            await failJob(job, e);
          }
        })().finally(() => inFlight.delete(p));

        inFlight.add(p);
      }
    } catch {
      // keep process alive; supervisor should restart on hard crashes
    }

    await sleep(POLL_MS);
  }
}

process.on("SIGINT", async () => {
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await prisma.$disconnect().catch(() => {});
  process.exit(0);
});

workerLoop().catch(async () => {
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});

