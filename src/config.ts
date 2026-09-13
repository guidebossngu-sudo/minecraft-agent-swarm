import "dotenv/config";
import readline from "readline";

export type LLMProvider = "ollama" | "openai";

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

export function parseCommandWhitelist(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((player) => player.trim())
    .filter(Boolean);
}

export const config = {
  mc: {
    host: process.env.MC_HOST || "anhkhoaai.seedloaf.gg",
    port: parseInt(process.env.MC_PORT || "25565"),
    username: process.env.MC_USERNAME || "Atlas",
    version: process.env.MC_VERSION || "1.21.1",
    auth: "offline" as "offline" | "microsoft",
  },
  ollama: {
    host: process.env.OLLAMA_HOST || "http://localhost:11434",
    model: "qwen3.6:35b-a3b",
    fastModel: "qwen3.6:35b-a3b",
    criticModel: "qwen3.6:35b-a3b",
  },
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL || "https://silver-anchor-7552.steadip.com/v1",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.STRATEGIC_MODEL || "agy/gemini-3.7-flash-high",
    fastModel: process.env.FAST_MODEL || "agy/gpt-oss-120b-medium",
    reactiveModel: process.env.REACTIVE_MODEL || process.env.FAST_MODEL || "agy/gpt-oss-120b-medium",
    criticModel: process.env.CRITIC_MODEL || "agy/claude-sonnet-4-6",
  },
  llm: {
    provider: (process.env.LLM_PROVIDER || "openai").toLowerCase() as LLMProvider,
    baseUrl: process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || "https://silver-anchor-7552.steadip.com/v1",
    apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || "",
    models: {
      planner: process.env.STRATEGIC_MODEL || "agy/gemini-3.7-flash-high",
      executor: process.env.FAST_MODEL || "agy/gpt-oss-120b-medium",
      reactive: process.env.REACTIVE_MODEL || process.env.FAST_MODEL || "agy/gpt-oss-120b-medium",
      critic: process.env.CRITIC_MODEL || "agy/claude-sonnet-4-6",
    },
  },
  twitch: {
    channel: process.env.TWITCH_CHANNEL || "",
    botUsername: process.env.TWITCH_BOT_USERNAME || "",
    oauthToken: process.env.TWITCH_OAUTH_TOKEN || "",
    enabled: !!process.env.TWITCH_CHANNEL,
  },
  bot: {
    name: process.env.BOT_NAME || "Atlas",
    decisionIntervalMs: parseInt(process.env.BOT_DECISION_INTERVAL_MS || "500"),
    chatCooldownMs: parseInt(process.env.BOT_CHAT_COOLDOWN_MS || "3000"),
    commandWhitelist: parseCommandWhitelist(process.env.BOT_COMMAND_WHITELIST),
    allowInterventions: process.env.ALLOW_INTERVENTIONS === "true",
    allowStrategyOverrides: process.env.ALLOW_STRATEGY_OVERRIDES !== "false",
    idleIntervalMs: parseInt(process.env.BOT_IDLE_INTERVAL_MS || "10000"),
    criticEnabled: process.env.BOT_CRITIC_ENABLED !== "false",
  },
  multiBot: {
    // Tự động bật Multi-Bot nếu ENABLE_MULTI_BOT=true hoặc BOT_COUNT > 1
    enabled: process.env.ENABLE_MULTI_BOT === "true" || parseInt(process.env.BOT_COUNT || "1") > 1,
    count: parseInt(process.env.BOT_COUNT || "5"),
  },
  generatedSkills: {
    enabled: process.env.GENERATED_SKILLS_ENABLED === "true",
    storeDir: process.env.GENERATED_SKILLS_DIR || "",
    bwrapPath: process.env.GENERATED_SKILLS_BWRAP || "/usr/bin/bwrap",
    nodePath: process.env.GENERATED_SKILLS_NODE || process.execPath,
  },
};

export async function setupCLIConfig() {
  console.log("\n==================================================");
  console.log("   TỰ ĐỘNG KHỞI ĐỘNG AGENT SWARM TỪ CẤU HÌNH .ENV");
  console.log("==================================================\n");

  config.mc.host = process.env.MC_HOST || "anhkhoaai.seedloaf.gg";
  config.mc.port = parseInt(process.env.MC_PORT || "25565");
  config.mc.version = process.env.MC_VERSION || "1.21.1";
  config.mc.auth = "offline";

  config.llm.provider = ((process.env.LLM_PROVIDER || "openai").toLowerCase()) as LLMProvider;

  if (config.llm.provider === "openai") {
    config.llm.baseUrl = process.env.OPENAI_BASE_URL || "https://silver-anchor-7552.steadip.com/v1";
    config.llm.apiKey = process.env.OPENAI_API_KEY || "";
  } else {
    config.llm.baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434";
  }

  config.llm.models.planner = process.env.STRATEGIC_MODEL || "agy/gemini-3.7-flash-high";
  config.llm.models.executor = process.env.FAST_MODEL || "agy/gpt-oss-120b-medium";
  config.llm.models.reactive = process.env.REACTIVE_MODEL || process.env.FAST_MODEL || "agy/gpt-oss-120b-medium";
  config.llm.models.critic = process.env.CRITIC_MODEL || "agy/claude-sonnet-4-6";

  console.log("[Config] Đã load xong cấu hình Swarm. Đang kết nối server...\n");
}
