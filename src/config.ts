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
    host: process.env.MC_HOST || "localhost",
    port: parseInt(process.env.MC_PORT || "25565"),
    username: process.env.MC_USERNAME || "AIBot",
    version: process.env.MC_VERSION || "1.21.4",
    auth: "offline" as "offline" | "microsoft",
  },
  ollama: {
    host: process.env.OLLAMA_HOST || "http://localhost:11434",
    model: "qwen3.6:35b-a3b",
    fastModel: "qwen3.6:35b-a3b",
    criticModel: "qwen3.6:35b-a3b",
  },
  openai: {
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY || "",
    model: "",
    fastModel: "",
    criticModel: "",
  },
  llm: {
    provider: (process.env.LLM_PROVIDER || "openai").toLowerCase() as LLMProvider,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: {
      planner: "",
      executor: "",
      critic: "",
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
    enabled: process.env.ENABLE_MULTI_BOT === "true",
    count: parseInt(process.env.BOT_COUNT || "1"),
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
  console.log("   CẤU HÌNH THÔNG SỐ KHỞI ĐỘNG AGENT SWARM");
  console.log("==================================================\n");

  config.mc.host = process.env.MC_HOST || (await askQuestion("1. IP Server Minecraft (mặc định: localhost): ")) || "localhost";
  config.mc.port = parseInt(process.env.MC_PORT || (await askQuestion("2. Port Server (mặc định: 25565): ")) || "25565");
  config.mc.version = process.env.MC_VERSION || (await askQuestion("3. Phiên bản Minecraft (mặc định: 1.21.4): ")) || "1.21.4";
  config.mc.auth = "offline"; // Server Crack

  const providerInput = process.env.LLM_PROVIDER || (await askQuestion("4. Provider ('openai' hoặc 'ollama', mặc định: openai): ")) || "openai";
  config.llm.provider = providerInput.toLowerCase() as LLMProvider;

  if (config.llm.provider === "openai") {
    config.llm.baseUrl = process.env.OPENAI_BASE_URL || (await askQuestion("5. API Endpoint Base URL (mặc định: https://api.openai.com/v1): ")) || "https://api.openai.com/v1";
    config.llm.apiKey = process.env.OPENAI_API_KEY || (await askQuestion("6. Nhập API Key: "));
  } else {
    config.llm.baseUrl = process.env.OLLAMA_HOST || (await askQuestion("5. Ollama Host (mặc định: http://localhost:11434): ")) || "http://localhost:11434";
  }

  console.log("\n--- Thiết lập 3 Models ---");
  config.llm.models.planner = process.env.STRATEGIC_MODEL || (await askQuestion("7. Model Strategic Planner (Lập kế hoạch): "));
  config.llm.models.executor = process.env.FAST_MODEL || (await askQuestion("8. Model Fast Executor (Thực thi ngắn): "));
  config.llm.models.critic = process.env.CRITIC_MODEL || (await askQuestion("9. Model Critic (Đánh giá & sửa lỗi): ")) || config.llm.models.planner;

  console.log("\n==================================================\n");
}
