import mineflayer from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
const { pathfinder, goals } = pathfinderPkg;
import customPvpPkg from "@nxg-org/mineflayer-custom-pvp";
const customPvp = (customPvpPkg as any).default ?? customPvpPkg;
import { loader as autoEat } from "mineflayer-auto-eat";
import { config } from "../config.js";
import { registerBot as registerViewerBot, isUnifiedViewerStarted } from "../stream/unified-viewer.js";
import { startViewer } from "../stream/viewer.js";
import { addChatMessage, setCurrentBot } from "../stream/overlay.js";
import { abortActiveSkill, getActiveSkillName } from "../skills/executor.js";
import { registerBotMemory } from "./memory-registry.js";
import { skillRegistry } from "../skills/registry.js";
import { BotMemoryStore } from "./memory.js";
import { BotRoleConfig, ATLAS_CONFIG } from "./role.js";
import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { isNeuralServerRunning } from "../neural/bridge.js";
import { appendSnapshot } from "./advancement-log.js";
import { BOT_ROSTER } from "./role.js";
import { BotBrain, type ChatMessage, type BrainEvents } from "./brain.js";
import { parseChatCommand } from "./chat-commands.js";
import { executeChatCommand } from "./chat-command-handler.js";
import { bumpNavGeneration, safeGoto, safeMoves } from "./navigation.js";
import { recordDeath, startScoreboard } from "./scoreboard.js";
import { createFallTracker, isFallDeath } from "./fall-tracker.js";
import { shouldFleeOnRespawn } from "./respawn-safety.js";
import { isHostile } from "./perception.js";
import { executeAction } from "./actions.js";
import { mineflayer as mineflayerViewer } from "prismarine-viewer";

// Re-export types used by src/index.ts
export type { ChatMessage, BrainEvents as BotEvents };

async function ensureNeuralServer(): Promise<void> {
  if (await isNeuralServerRunning()) {
    console.log("[Bot] Neural server already running.");
    return;
  }
  console.log("[Bot] Starting neural server...");
  const proc = spawn("python3", [path.resolve(__dirname, "../../neural_server.py")], { stdio: "pipe" });
  proc.stdout?.on("data", (d) => console.log(`[Neural] ${d.toString().trim()}`));
  proc.stderr?.on("data", (d) => console.log(`[Neural] ${d.toString().trim()}`));
  proc.on("exit", (code) => console.log(`[Neural] Server exited (${code})`));

  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isNeuralServerRunning()) {
      console.log("[Bot] Neural server ready.");
      return;
    }
  }
  console.warn("[Bot] Neural server timed out — combat fallback active.");
}

let advancementSnapshotLogged = false;

export async function createBot(events: BrainEvents, roleConfig: BotRoleConfig = ATLAS_CONFIG) {
  startScoreboard();
  ensureNeuralServer().catch((e) => console.warn("[Bot] Neural spawn error:", e));

  if (!advancementSnapshotLogged) {
    advancementSnapshotLogged = true;
    const snap = () => {
      try {
        appendSnapshot(
          BOT_ROSTER.map((b) => b.name),
          new Date(),
        );
      } catch (e) {
        console.warn("[Bot] Advancement snapshot failed:", e);
      }
    };
    snap();
    setInterval(snap, 60 * 60 * 1000).unref();
  }

  // Load memory — register with executor so skill results go to this bot's file.
  const memStore = new BotMemoryStore(roleConfig.memoryFile);
  memStore.load();
  memStore.healBrokenSkillsFromRegistry(new Set(skillRegistry.keys()));

  console.log(`[Bot] Connecting to ${config.mc.host}:${config.mc.port} as ${roleConfig.username}...`);

  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: roleConfig.username,
    version: config.mc.version,
    auth: config.mc.auth,
    checkTimeoutInterval: 120_000,
  });

  registerBotMemory(bot, memStore);

  if (roleConfig.stashPos) {
    (bot as unknown as { swarmBaseY?: number }).swarmBaseY = roleConfig.stashPos.y;
  }

  // Load plugins
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(customPvp);
  bot.loadPlugin(autoEat);

  const capPathfinder = (): boolean => {
    const pf = bot.pathfinder as unknown as { searchRadius: number; thinkTimeout: number } | undefined;
    if (!pf) return false;
    pf.searchRadius = 256;
    pf.thinkTimeout = 1500;
    return true;
  };
  if (!capPathfinder()) {
    bot.once("inject_allowed", () => {
      capPathfinder();
    });
  }

  {
    const net = { posSent: 0, confirmSent: 0, tpRecv: 0, last: "" };
    const client = bot._client as unknown as {
      write: (name: string, params: unknown) => void;
      on: (ev: string, fn: (p: any) => void) => void;
    };
    const origWrite = client.write.bind(client);
    client.write = (name: string, params: unknown) => {
      if (name === "position" || name === "position_look" || name === "look") net.posSent++;
      else if (name === "teleport_confirm") net.confirmSent++;
      return origWrite(name, params);
    };
    client.on("position", (p: any) => {
      net.tpRecv++;
      net.last = `${Number(p?.x).toFixed(1)},${Number(p?.y).toFixed(1)},${Number(p?.z).toFixed(1)} id=${p?.teleportId}`;
      if (net.tpRecv <= 3 || net.tpRecv % 25 === 0) {
        console.log(`[NetDebug] ${roleConfig.name} server teleport #${net.tpRecv}: ${net.last}`);
      }
    });
    const timer = setInterval(() => {
      const e = bot.entity?.position;
      console.log(
        `[NetDebug] ${roleConfig.name}: sent pos=${net.posSent} confirm=${net.confirmSent} recv teleports=${net.tpRecv} (last ${net.last || "none"}) client at ${e ? e.floored() : "?"}`,
      );
      net.posSent = 0;
      net.confirmSent = 0;
    }, 120_000);
    bot.once("end", () => clearInterval(timer));
  }

  bot.once("spawn", () => {
    capPathfinder();
  });

  // ── Create the event-driven brain ──
  const brain = new BotBrain(bot, roleConfig, events, memStore);

  // ── Spawn safety ──────────────────────────────────────────────────────────
  let spawnSafetyRunning = false;
  let resolveSpawnSafetyDone!: () => void;
  const spawnSafetyDone = new Promise<void>((r) => {
    resolveSpawnSafetyDone = r;
  });

  async function runSpawnSafety() {
    if (spawnSafetyRunning) return;
    spawnSafetyRunning = true;
    await new Promise((r) => setTimeout(r, 800));
    const p = bot.entity.position;
    console.log(
      `[Bot] ${roleConfig.name} spawned at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} — no spawn commands (honest-spawn era)`,
    );
    spawnSafetyRunning = false;
    resolveSpawnSafetyDone();
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  const BOT_USERNAMES = new Set(["Atlas", "Flora", "Forge", "Mason", "Blade"]);
  const BOT_CHAT_COOLDOWN_MS = 45_000;
  const lastBotChatHeard = new Map<string, number>();
  bot.on("chat", async (username, message) => {
    if (!username || username === bot.username) return;
    if (BOT_USERNAMES.has(username)) {
      const mentionsMe = message.toLowerCase().includes(roleConfig.name.toLowerCase());
      const last = lastBotChatHeard.get(username) ?? 0;
      if (!mentionsMe || Date.now() - last < BOT_CHAT_COOLDOWN_MS) return;
      lastBotChatHeard.set(username, Date.now());
      brain.queueChat({ source: "minecraft", username, message, timestamp: Date.now() });
      return;
    }
    if (message.startsWith("Gamerule ") || message.startsWith("Set spawn") || message.startsWith("Teleported ")) return;
    console.log(`[MC Chat] ${username}: ${message}`);

    if (message.startsWith("/eval ") || message === "/eval") {
      if (!config.bot.commandWhitelist.includes(username)) {
        console.warn(`[EVAL] Ignored untrusted eval request from ${username}`);
        return;
      }
      const parts = message.trim().split(/\s+/);
      const { evalSkill, evalAll } = await import("../eval/runner.js");
      if (parts[1] === "all") {
        evalAll(bot, parts[2]).catch((e: any) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else if (parts[1]) {
        evalSkill(bot, parts[1]).catch((e: any) => bot.chat(`[EVAL] Error: ${e.message}`));
      } else {
        bot.chat("[EVAL] Usage: /eval <skillname>  or  /eval all [filter]");
      }
      return;
    }

    const parsedCommand = parseChatCommand(username, message, config.bot.commandWhitelist);
    if (parsedCommand.kind === "denied") return;
    if (parsedCommand.kind === "invalid") {
      bot.chat(parsedCommand.message);
      return;
    }
    if (parsedCommand.kind === "command") {
      await executeChatCommand(parsedCommand.command, username, {
        bot,
        brain,
        memory: memStore,
        abortActiveSkill: () => abortActiveSkill(bot),
        stopMovement: () => {
          bumpNavGeneration(bot);
          bot.pathfinder.setGoal(null);
          bot.clearControlStates();
        },
        goToPlayer: async (playerName) => {
          const player = bot.players[playerName]?.entity;
          if (!player) throw new Error("player is not visible");
          const { x, y, z } = player.position;
          bot.pathfinder.setMovements(safeMoves(bot));
          await safeGoto(bot, new goals.GoalNear(x, y, z, 2), 15_000);
        },
      });
      return;
    }

    brain.queueChat({
      source: "minecraft",
      username,
      message,
      timestamp: Date.now(),
    });
    addChatMessage(username, message, "free");
  });

  let lastDeathMessage = "";
  const recentDeathTimes: number[] = [];
  const DEATH_RE =
    /\b(drowned|suffocat|fell|hit the ground|tried to swim in lava|burned|went up in flames|walked into fire|was slain|was shot|was blown up|blew up|was killed|starv|was pricked|was squashed|was impaled|was struck|froze|magma|withered|didn'?t want to live)/i;
  bot.on("messagestr", (msg: string) => {
    if (msg.includes(roleConfig.username) && DEATH_RE.test(msg)) lastDeathMessage = msg.trim();
  });

  let recentDeaths: number[] = [];
  let respawnFixing = false;
  const LOOP_WINDOW_MS = 900_000;
  const LOOP_THRESHOLD = 4;

  const fallTracker = createFallTracker(bot.entity?.position.y ?? 0);

  const ASCENT_TRIGGER_ABOVE_BASE = 30;
  let wasHigh = false;
  bot.on("move", () => {
    if (!bot.entity) return;
    const baseY = roleConfig.stashPos?.y;
    if (baseY !== undefined) {
      const p = bot.entity.position;
      const high = p.y > baseY + ASCENT_TRIGGER_ABOVE_BASE;
      if (high && !wasHigh) {
        console.log(
          `[Ascent] ${roleConfig.name} rose to y=${p.y.toFixed(0)} at ${p.x.toFixed(0)},${p.z.toFixed(0)} ` +
            `(${(p.y - baseY).toFixed(0)} above base) onGround=${bot.entity.onGround}`,
        );
      } else if (!high && wasHigh) {
        console.log(`[Ascent] ${roleConfig.name} back down to y=${p.y.toFixed(0)}`);
      }
      wasHigh = high;
    }

    const held = Object.entries(bot.controlState)
      .filter(([, on]) => on)
      .map(([k]) => k)
      .join("+");

    const p = bot.entity.position;
    const at = bot.blockAt(p)?.name ?? "?";
    const below = bot.blockAt(p.offset(0, -1, 0))?.name ?? "?";
    const ctx = `controls=${held || "none"} pathing=${bot.pathfinder?.isMoving?.() ?? "?"} vel=${bot.entity.velocity.y.toFixed(2)} at=${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)} in=${at} on=${below}`;

    const belowBlock = bot.blockAt(p.offset(0, -1, 0));
    const onSolid = belowBlock?.boundingBox === "block";
    fallTracker.update(bot.entity.position.y, bot.entity.onGround, Date.now(), ctx, onSolid);
  });

  bot.on("spawn", () => {
    setTimeout(() => {
      try {
        if (!bot.entity) return;
        const hostile = bot.nearestEntity((e) => e !== bot.entity && isHostile(e));
        const dist = hostile ? hostile.position.distanceTo(bot.entity.position) : null;
        if (shouldFleeOnRespawn(dist)) {
          console.log(
            `[Respawn] ${roleConfig.name} woke up ${dist!.toFixed(1)} blocks from ${hostile!.name ?? "a hostile"} — fleeing before resuming`,
          );
          executeAction(bot, "flee", {}).catch(() => {});
        } else {
          console.log(
            `[Respawn] ${roleConfig.name} spawn check: nearest hostile ${dist === null ? "none" : dist.toFixed(1) + " blocks"} — resuming`,
          );
        }
      } catch (err) {
        console.log(`[Respawn] ${roleConfig.name} spawn check failed: ${(err as Error).message}`);
      }
    }, 1200);
  });

  bot.on("death", () => {
    const pos = bot.entity.position;
    const cause = lastDeathMessage || "unknown";
    memStore.recordDeath(pos.x, pos.y, pos.z, cause);
    recordDeath(roleConfig.name);
    recentDeathTimes.push(Date.now());
    while (recentDeathTimes.length > 12) recentDeathTimes.shift();

    const worn = [5, 6, 7, 8].map((slot) => bot.inventory.slots[slot]?.name ?? "-").join(",");
    const drop = fallTracker.dropFrom(pos.y);
    const fallInfo =
      drop > 1 || isFallDeath(cause)
        ? ` Fell ${drop.toFixed(1)} blocks from y=${fallTracker.originY().toFixed(0)} ` +
          `(airborne ${(fallTracker.airborneMs(Date.now()) / 1000).toFixed(1)}s, ${fallTracker.originContext()})` +
          ` [stood ${fallTracker.originFooting() || "NEVER ON SOLID GROUND"}` +
          ` ${fallTracker.footingAgeMs(Date.now())}ms before leaving]`
        : "";
    console.log(`[Bot] I died! Cause: ${cause}. Armor: ${worn}.${fallInfo} Respawning...`);
    lastDeathMessage = "";
    abortActiveSkill(bot);

    setTimeout(() => {
      void (async () => {
        try {
          const chest = bot.findBlock({ matching: (b) => b.name === "chest", maxDistance: 12 });
          if (!chest) return;
          const win = await bot.openContainer(chest);
          await new Promise((r) => setTimeout(r, 500));
          win.close();
          console.log(`[Bot] ${roleConfig.name} post-death inventory resync via chest at ${chest.position}`);
        } catch {
          /* best effort */
        }
      })();
    }, 4000);

    const now = Date.now();
    recentDeaths = recentDeaths.filter((t) => now - t < LOOP_WINDOW_MS);
    recentDeaths.push(now);

    if (recentDeaths.length >= LOOP_THRESHOLD && !respawnFixing) {
      respawnFixing = true;
      console.warn(
        `[Bot] ${roleConfig.name} died ${recentDeaths.length}x in ${LOOP_WINDOW_MS / 1000}s — respawn point looks lethal, resetting it`,
      );
      recentDeaths = [];
      setTimeout(() => {
        runSpawnSafety()
          .catch((e) => console.warn(`[Bot] respawn reset failed:`, e))
          .finally(() => {
            respawnFixing = false;
          });
      }, 2000);
    }
  });

  bot.on("kicked", (reason) => {
    console.log(`[Bot] Kicked: ${JSON.stringify(reason)}`);
    brain.stop();
  });

  bot.on("error", (err) => {
    console.error("[Bot] Error:", err);
  });

  bot.on("spawn", async () => {
    if (roleConfig.username === "Atlas") {
      bot.chat("/gamerule keepInventory true");
      await new Promise((r) => setTimeout(r, 500));
      bot.chat("/gamerule doMobSpawning true");
      await new Promise((r) => setTimeout(r, 500));
    }
    runSpawnSafety().catch((e) => console.warn("[Bot] Spawn safety error:", e));

    const rapidDeaths = recentDeathTimes.filter((t) => Date.now() - t < 300_000).length;
    if (rapidDeaths >= 3) {
      setTimeout(() => {
        try {
          const HOSTILES = new Set(["zombie", "skeleton", "pillager", "creeper", "spider", "drowned", "husk"]);
          const hostile = bot.nearestEntity((e) => HOSTILES.has(e.name ?? ""));
          const p = bot.entity.position;
          let dx = 25;
          let dz = 0;
          if (hostile && p.distanceTo(hostile.position) < 20) {
            const vx = p.x - hostile.position.x;
            const vz = p.z - hostile.position.z;
            const m = Math.hypot(vx, vz) || 1;
            dx = (vx / m) * 25;
            dz = (vz / m) * 25;
          }
          console.log(
            `[CampBreaker] ${roleConfig.name}: ${rapidDeaths} deaths in 5min — sprinting clear` +
              (hostile ? ` of the ${hostile.name}` : ""),
          );
          bot.pathfinder.setMovements(safeMoves(bot));
          bot.pathfinder.setGoal(new goals.GoalXZ(p.x + dx, p.z + dz));
        } catch (e) {
          console.log(`[CampBreaker] failed: ${(e as Error).message}`);
        }
      }, 2_500);
    }
  });

  // One-time setup on first spawn
  bot.once("spawn", () => {
    console.log("[Bot] Spawned! Starting event-driven brain...");

    const KIT_ITEMS = new Set([
      "bucket",
      "water_bucket",
      "lava_bucket",
      "flint_and_steel",
      "iron_ingot",
      "flint",
      "gold_ingot",
      "golden_boots",
      "copper_block",
      "honeycomb",
      "shears",
      "campfire",
    ]);
    bot.inventory.on("updateSlot", (slot: number, oldItem: any, newItem: any) => {
      const was = oldItem && KIT_ITEMS.has(oldItem.name) ? `${oldItem.count}x ${oldItem.name}` : null;
      const now = newItem && KIT_ITEMS.has(newItem.name) ? `${newItem.count}x ${newItem.name}` : null;
      if (!was && !now) return;
      if (was === now) return;
      const p = bot.entity?.position?.floored();
      const doing = getActiveSkillName(bot) ?? "no-skill";
      console.log(
        `[Kit] ${roleConfig.name} slot ${slot}: ${was ?? "(empty)"} -> ${now ?? "(empty)"} at ${p?.x},${p?.y},${p?.z} during ${doing}`,
      );
    });

    // Start browser viewer
    if (isUnifiedViewerStarted()) {
      registerViewerBot(roleConfig.name, bot);
    } else {
      startViewer(bot, roleConfig.viewerPort);
    }

    // 🎥 TÍCH HỢP VIEW 3D F5 BẰNG PRISMARINE-VIEWER
    try {
      const portOffset = BOT_ROSTER.findIndex((b) => b.name === roleConfig.name);
      const vPort = 3000 + (portOffset >= 0 ? portOffset : 0);

      mineflayerViewer(bot, {
        port: vPort,
        firstPerson: false,
        viewDistance: 6,
      });
      console.log(`[3D-Viewer] 🎥 ${roleConfig.name} View 3D live at http://localhost:${vPort}`);
    } catch (vErr) {
      console.warn(`[3D-Viewer] Cannot start prismarine-viewer for ${roleConfig.name}:`, vErr);
    }

    // Pathfinder config
    bot.pathfinder.thinkTimeout = 10000;
    (bot.pathfinder as unknown as { searchRadius: number }).searchRadius = 96;
    console.log(`[Pathfinder] ${roleConfig.name}: searchRadius=96 thinkTimeout=${bot.pathfinder.thinkTimeout}ms`);

    // Auto-eat config
    bot.autoEat.opts = {
      priority: "foodPoints",
      minHunger: 14,
      minHealth: 6,
      bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato"],
      returnToLastItem: true,
      offhand: false,
      eatingTimeout: 3000,
      strictErrors: false,
    };

    // Start the brain after spawn safety completes
    spawnSafetyDone
      .then(() => {
        brain.start();
      })
      .catch((e) => {
        console.error("[Bot] Brain start failed:", e);
      });
  });

  return {
    bot,
    queueChat: (msg: ChatMessage) => brain.queueChat(msg),
    stop: () => {
      brain.stop();
      bot.quit();
    },
  };
}
