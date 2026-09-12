import { createBot } from "./bot/index.js";
import { createTwitchChat } from "./stream/twitch.js";
import { startOverlay, addChatMessage } from "./stream/overlay.js";
import { config, setupCLIConfig } from "./config.js";
import { loadDynamicSkills } from "./skills/dynamic-loader.js";
import { BOT_ROSTER, BotRoleConfig } from "./bot/role.js";
import { startUnifiedViewer } from "./stream/unified-viewer.js";
import { abortActiveSkill, getActiveSkillName } from "./skills/executor.js";
import type { Bot } from "mineflayer";
import { assertProviderConfigured } from "./llm/provider.js";
import { startSkillHotReload } from "./skills/hot-reload.js";
import { getGeneratedStoreRoot } from "./skills/generator.js";
import { loadApprovedGeneratedSkills } from "./skills/generated-runtime.js";
import { assertGeneratedSandboxAvailable, getSandboxPolicyHash } from "./skills/generated-sandbox.js";

/** Live bot handles, so the heap guard can abort a runaway skill. */
const LIVE_BOTS = new Map<string, Bot>();

loadDynamicSkills();

// Registry of active bot stop functions for clean multi-bot shutdown
const activeStops: (() => void)[] = [];
if (process.argv.includes("--hot-reload-skills")) {
  activeStops.push(startSkillHotReload());
}

function shutdownAll() {
  console.log("\n[Main] Shutting down all bots...");
  for (const fn of activeStops) {
    try {
      fn();
    } catch {
      /* ignore errors during shutdown */
    }
  }
  process.exit(0);
}

// Register once — never overwritten
process.on("SIGINT", shutdownAll);
process.on("SIGTERM", shutdownAll);

const MAX_RESTARTS = 50;
const RESTART_DELAY_MS = 30000;
const DUPLICATE_LOGIN_DELAY_MS = 60000;

// Catch unhandled promise rejections so they don't crash the entire process
process.on("unhandledRejection", (reason) => {
  console.error("[Main] Unhandled rejection (caught — process kept alive):", reason);
});

// Prevent TTS/WebSocket internal errors from crashing the entire process.
process.on("uncaughtException", (err) => {
  console.error("[Main] Uncaught exception (non-fatal — process kept alive):", err.message || err);
});

async function startBot(
  roleConfig: BotRoleConfig,
  restartCount: number,
  overlayStarted: { value: boolean },
): Promise<string> {
  console.log(`\n=== ${roleConfig.name} (${roleConfig.role}) (restart #${restartCount}) ===`);
  const fastLabel = config.llm.models.executor !== config.llm.models.planner ? ` (fast decisions: ${config.llm.models.executor})` : "";
  const endpoint = config.llm.baseUrl;
  console.log(`LLM Planner: ${config.llm.models.planner}${fastLabel} @ ${endpoint} [${config.llm.provider}]`);
  console.log(`LLM Executor: ${config.llm.models.executor}`);
  console.log(`LLM Critic: ${config.llm.models.critic}`);
  console.log(`Server: ${config.mc.host}:${config.mc.port} (MC ${config.mc.version}, Auth: ${config.mc.auth})`);
  console.log(`Idle re-plan interval: ${config.bot.idleIntervalMs}ms`);
  console.log("");

  // Start overlay only once per bot (persists across restarts)
  if (!overlayStarted.value) {
    startOverlay(roleConfig.overlayPort, roleConfig.name);
    overlayStarted.value = true;
  }

  const { bot, queueChat, stop } = await createBot(
    {
      onThought: (thought) => console.log(`[${roleConfig.name}] 💭 ${thought}`),
      onAction: (action, result) => console.log(`[${roleConfig.name}] 🎮 [${action}] ${result}`),
      onChat: (message) => console.log(`[${roleConfig.name}] 💬 ${message}`),
    },
    roleConfig,
  );

  // Register for the heap guard
  LIVE_BOTS.set(roleConfig.name, bot);

  // Set up Twitch chat (Atlas only)
  const twitch =
    roleConfig.name === "Atlas"
      ? createTwitchChat((msg) => {
          queueChat(msg);
          addChatMessage(msg.username, msg.message, (msg as any).tier ?? "free");
        })
      : null;

  let lastKickReason = "";

  return new Promise<string>((resolve) => {
    // Register this bot's cleanup in the shared shutdown registry
    const cleanup = () => {
      stop();
      twitch?.client.disconnect();
    };
    activeStops.push(cleanup);

    const removeCleanup = () => {
      const idx = activeStops.indexOf(cleanup);
      if (idx !== -1) activeStops.splice(idx, 1);
    };

    bot.on("kicked", (reason) => {
      const reasonStr = typeof reason === "string" ? reason : JSON.stringify(reason);
      console.log(`[${roleConfig.name}] Kicked: ${reasonStr}`);
      lastKickReason = reasonStr;
      removeCleanup();
      stop();
      twitch?.client.disconnect();
      resolve(lastKickReason);
    });

    bot.on("end", () => {
      console.log(`[${roleConfig.name}] Connection ended.`);
      removeCleanup();
      stop();
      twitch?.client.disconnect();
      resolve(lastKickReason);
    });

    bot.on("error", (err) => {
      console.error(`[${roleConfig.name}] Error:`, err);
    });

    console.log(`[Main] ${roleConfig.name} is starting up. Waiting for spawn...`);
  });
}

async function runBotLoop(roleConfig: BotRoleConfig): Promise<void> {
  let restartCount = 0;
  const overlayStarted = { value: false };

  while (restartCount < MAX_RESTARTS) {
    let lastKickReason = "";
    try {
      lastKickReason = await startBot(roleConfig, restartCount, overlayStarted);
    } catch (err) {
      console.error(`[${roleConfig.name}] Bot crashed:`, err);
    }

    restartCount++;
    if (restartCount >= MAX_RESTARTS) {
      console.error(`[${roleConfig.name}] Max restarts (${MAX_RESTARTS}) reached. Giving up.`);
      return;
    }

    const delay =
      lastKickReason.includes("duplicate_login") || lastKickReason.includes("You logged in from another location")
        ? DUPLICATE_LOGIN_DELAY_MS
        : RESTART_DELAY_MS;
    console.log(`[${roleConfig.name}] Restarting in ${delay / 1000}s... (attempt ${restartCount}/${MAX_RESTARTS})`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

async function main() {
  // BẮT BUỘC HỎI CẤU HÌNH TRÊN CLI TRƯỚC KHI KẾT NỐI BẤT KỲ ĐÂU
  await setupCLIConfig();

  assertProviderConfigured();

  if (config.generatedSkills.enabled) {
    await assertGeneratedSandboxAvailable(config.generatedSkills.bwrapPath, config.generatedSkills.nodePath);
    const policyHash = await getSandboxPolicyHash({ nodePath: config.generatedSkills.nodePath });
    const loaded = await loadApprovedGeneratedSkills({
      enabled: true,
      root: getGeneratedStoreRoot(),
      policyHash,
      bwrapPath: config.generatedSkills.bwrapPath,
      nodePath: config.generatedSkills.nodePath,
    });
    console.log(`[GeneratedSkill] Loaded ${loaded.length} approved isolated skill(s)`);
  }

  // Start the unified viewer server
  await startUnifiedViewer().catch((err) => {
    console.warn("[Main] Unified viewer failed to start:", err);
  });

  if (!config.multiBot.enabled) {
    // Single bot mode — Atlas
    await runBotLoop(BOT_ROSTER[0]);
    return;
  }

  const count = Math.min(config.multiBot.count, BOT_ROSTER.length);
  console.log(`[Main] Multi-bot mode: launching ${count} bots...`);

  const loops: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const role = BOT_ROSTER[i];
    console.log(`[Main] Starting ${role.name} (${role.role})...`);
    loops.push(runBotLoop(role));
    // Stagger each bot by 10 seconds to avoid login collisions
    if (i < count - 1) {
      await new Promise((r) => setTimeout(r, 10000));
    }
  }

  // Start dashboard after all bots are connecting
  try {
    const { startDashboard } = await import("./stream/dashboard.js");
    startDashboard(BOT_ROSTER.slice(0, count));
  } catch {
    console.log("[Main] Dashboard module not available — skipping.");
  }

  await Promise.all(loops);
}

/** Heap watchdog */
const HEAP_LOG_MS = 120_000;
const HEAP_WARN_MB = 2048;
setInterval(() => {
  const mb = (n: number) => Math.round(n / 1048576);
  const { heapUsed, heapTotal, external, rss } = process.memoryUsage();
  const line = `[Heap] used=${mb(heapUsed)}MB total=${mb(heapTotal)}MB ext=${mb(external)}MB rss=${mb(rss)}MB`;
  if (mb(heapUsed) >= HEAP_WARN_MB) console.warn(`${line} — CLIMBING toward the ~4GB ceiling`);
  else console.log(line);
}, HEAP_LOG_MS).unref();

/** Fast heap guard */
const HEAP_GUARD_MS = 2_000;
const HEAP_ABORT_MB = 1500;
let heapGuardTripped = false;

setInterval(() => {
  const usedMb = Math.round(process.memoryUsage().heapUsed / 1048576);

  if (usedMb < HEAP_ABORT_MB) {
    heapGuardTripped = false;
    return;
  }
  if (heapGuardTripped) return;
  heapGuardTripped = true;

  console.error(`[HeapGuard] heapUsed=${usedMb}MB crossed ${HEAP_ABORT_MB}MB — aborting active skills`);
  for (const [name, bot] of LIVE_BOTS) {
    const skill = getActiveSkillName(bot);
    if (skill) {
      console.error(`[HeapGuard] aborting "${skill}" on ${name}`);
      try {
        abortActiveSkill(bot);
      } catch {
        /* best effort */
      }
    }
  }
}, HEAP_GUARD_MS).unref();

main().catch((err) => {
  console.error("[Main] Fatal error:", err);
  process.exit(1);
});
