import "dotenv/config";
import readline from "readline";

export type LLMProvider = "ollama" | "openai";

// Hàm hỗ trợ hỏi câu hỏi trong Terminal nếu chưa có biến môi trường
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

// Chạy prompt hỏi thông tin nếu chưa được định nghĩa trong file .env
async function resolveRuntimeConfig() {
  console.log("\n==================================================");
  console.log("   CẤU HÌNH THÔNG SỐ KHỞI ĐỘNG AGENT SWARM");
  console.log("==================================================\n");

  // 1. Hỏi Server Minecraft (Chế độ Crack mặc định)
  const mcHost = process.env.MC_HOST || (await askQuestion("1. IP Server Minecraft (mặc định: localhost): ")) || "localhost";
  const mcPort = parseInt(process.env.MC_PORT || (await askQuestion("2. Port Server (mặc định: 25565): ")) || "25565");
  const mcVersion = process.env.MC_VERSION || (await askQuestion("3. Phiên bản Minecraft (mặc định: 1.21.4): ")) || "1.21.4";

  // 2. Hỏi LLM Provider & Endpoint
  const providerInput = process.env.LLM_PROVIDER || (await askQuestion("4. Chọn Provider ('openai' hoặc 'ollama', mặc định: openai): ")) || "openai";
  const llmProvider = providerInput.toLowerCase() as LLMProvider;

  let baseUrl = process.env.OPENAI_BASE_URL || "";
  let apiKey = process.env.OPENAI_API_KEY || "";

  if (llmProvider === "openai") {
    if (!baseUrl) {
      baseUrl = (await askQuestion("5. API Endpoint Base URL (vd: https://api.openai.com/v1 hoặc custom URL): ")) || "https://api.openai.com/v1";
    }
    if (!apiKey) {
      apiKey = await askQuestion("6. Nhập API Key: ");
    }
  }

  // 3. Hỏi 3 Model riêng biệt (Strategic Planner, Fast Action Executor, Critic)
  console.log("\n--- Thiết lập 3 Models ---");
  const plannerModel =
    process.env.STRATEGIC_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.OLLAMA_MODEL ||
    (await askQuestion("7. Model Lập kế hoạch (Strategic Planner): "));

  const executorModel =
    process.env.FAST_MODEL ||
    process.env.OPENAI_FAST_MODEL ||
    process.env.OLLAMA_FAST_MODEL ||
    (await askQuestion("8. Model Thực thi nhanh (Fast Executor): "));

  const criticModel =
    process.env.CRITIC_MODEL ||
    (await askQuestion("9. Model Đánh giá (Critic): ")) ||
    plannerModel;

  console.log("\n==================================================\n");

  return {
    mcHost,
    mcPort,
    mcVersion,
    llmProvider,
    baseUrl,
    apiKey,
    plannerModel,
    executorModel,
    criticModel,
  };
}

// Khởi chạy hàm thu thập cấu hình
const runtime = await resolveRuntimeConfig();

const ollamaConfig = {
  host: process.env.OLLAMA_HOST || "http://localhost:11434",
  model: runtime.plannerModel || "qwen3.6:35b-a3b",
  fastModel: runtime.executorModel || "qwen3.6:35b-a3b",
  criticModel: runtime.criticModel || "qwen3.6:35b-a3b",
};

const openaiConfig = {
  baseUrl: runtime.baseUrl || "https://api.openai.com/v1",
  apiKey: runtime.apiKey,
  model: runtime.plannerModel,
  fastModel: runtime.executorModel,
  criticModel: runtime.criticModel,
};

export const config = {
  mc: {
    host: runtime.mcHost,
    port: runtime.mcPort,
    username: process.env.MC_USERNAME || "AIBot",
    version: runtime.mcVersion,
    auth: "offline" as "offline" | "microsoft", // Ép buộc chế độ Offline (Crack)
  },
  ollama: ollamaConfig,
  openai: openaiConfig,
  
  /** Cấu hình LLM đa model đã giải mã */
  llm: {
    provider: runtime.llmProvider,
    baseUrl: runtime.llmProvider === "openai" ? openaiConfig.baseUrl : ollamaConfig.host,
    apiKey: runtime.llmProvider === "openai" ? openaiConfig.apiKey : "",
    models: {
      planner: runtime.llmProvider === "openai" ? openaiConfig.model : ollamaConfig.model,
      executor: runtime.llmProvider === "openai" ? openaiConfig.fastModel : ollamaConfig.fastModel,
      critic: runtime.llmProvider === "openai" ? openaiConfig.criticModel : ollamaConfig.criticModel,
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
