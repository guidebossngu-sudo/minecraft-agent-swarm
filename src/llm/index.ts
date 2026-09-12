/**
 * Public LLM query facade for strategic, reactive, critic, legacy decision,
 * and conversational calls.
 */
import { chat } from "./provider.js";
import { config } from "../config.js";
import { getSkillPromptLines } from "../skills/registry.js";
import { getDynamicSkillNames } from "../skills/dynamic-loader.js";
import { getSeasonGoal } from "../bot/memory.js";
import {
  buildStrategicPrompt,
  buildReactivePrompt,
  buildCriticPrompt,
  buildChatPrompt,
  type RoleContext,
} from "./prompts.js";
import { createLogger } from "../util/logger.js";
import { recordLlmCall, UNHEALTHY_AFTER } from "./health.js";

/** 
 * Model-aware think option safely guarded against undefined values.
 */
function thinkFor(model?: string | null): boolean | "low" | "medium" | "high" {
  const safeModel = (model || "").toLowerCase();
  return safeModel.includes("gpt-oss") ? "low" : false;
}

const llmLog = createLogger();

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string }>;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function extractJSON(raw: string): string | null {
  let content = raw.trim();
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  content = content.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");

  const startIdx = content.indexOf("{");
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < content.length; i++) {
    const ch = content[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return content.slice(startIdx, i + 1);
    }
  }

  let s = content.slice(startIdx);
  s = s.replace(/,?\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, "");
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  s += "}".repeat(Math.max(0, opens - closes));
  try {
    JSON.parse(s);
    return s;
  } catch {
    return null;
  }
}

const ACTION_ALIASES: Record<string, string> = {
  "go to": "go_to",
  goto: "go_to",
  move: "explore",
  walk: "explore",
  travel: "explore",
  teleport: "go_to",
  mine: "mine_block",
  "mine block": "mine_block",
  mine_blocks: "mine_block",
  gather: "gather_wood",
  "gather wood": "gather_wood",
  gatherwood: "gather_wood",
  chop: "gather_wood",
  "place block": "place_block",
  placeblock: "place_block",
  message: "chat",
  say: "chat",
  speak: "chat",
  "respond to chat": "respond_to_chat",
  "invoke skill": "invoke_skill",
  invokeskill: "invoke_skill",
  "generate skill": "generate_skill",
  generateskill: "generate_skill",
  "neural combat": "neural_combat",
  "build house": "build_house",
  "build farm": "build_farm",
  "craft gear": "craft_gear",
  "strip mine": "strip_mine",
  craft_item: "craft",
  crafting: "craft",
};

function parseDecision(
  raw: string,
  botName: string,
): {
  thought: string;
  action: string;
  params: Record<string, any>;
  goal?: string;
  goalSteps?: number;
} {
  const jsonStr = extractJSON(raw);
  if (!jsonStr) {
    llmLog.warn("LLM", `No JSON found in response (${raw.length} chars): "${raw.slice(0, 800)}"`);
    llmLog.debug("LLM", "Full raw response:", raw);
    return { thought: "Brain buffering...", action: "idle", params: {} };
  }

  const parsed = JSON.parse(jsonStr);

  if (!parsed.action) {
    if (parsed.invoke_skill !== undefined) {
      parsed.action = "invoke_skill";
      const v = parsed.invoke_skill;
      parsed.params = { skill: typeof v === "string" ? v : (v?.skill ?? String(v)) };
    } else if (parsed.generate_skill !== undefined) {
      parsed.action = "generate_skill";
      const v = parsed.generate_skill;
      parsed.params = { task: typeof v === "string" ? v : (v?.task ?? String(v)) };
    } else if (parsed.neural_combat !== undefined) {
      parsed.action = "neural_combat";
      parsed.params = { duration: parsed.neural_combat };
    }
  }

  const rawAction = (typeof parsed.action === "string" ? parsed.action : "idle").toLowerCase().trim();
  let action = ACTION_ALIASES[rawAction] ?? (typeof parsed.action === "string" ? parsed.action : "idle");

  const params = parsed.params ?? parsed.parameters ?? {};

  for (const field of ["direction", "item", "block", "blockType", "count", "skill", "task", "message"]) {
    if (parsed[field] !== undefined && params[field] === undefined) {
      params[field] = parsed[field];
    }
  }

  if (/^(look|scan|observe|survey|search_for|check_surroundings)/.test(action)) {
    action = "explore";
  }

  if (action !== "mine_block" && /^mine_\w+$/.test(action)) {
    params.blockType = params.blockType || action.slice(5);
    action = "mine_block";
  }

  if (/^craft_\w+$/.test(action) && action !== "craft_gear") {
    params.item = params.item || action.slice(6);
    action = "craft";
  }

  if (/^manually(build|construct)|^build.*(shelter|hut)|^construct.*(shelter|house)/i.test(action)) {
    action = "build_house";
  }

  if (action === "invoke_skill" && !params.skill && parsed.skill) {
    params.skill = parsed.skill;
  }

  let thought = String(parsed.thought || parsed.reason || parsed.reasoning || "...");
  thought =
    thought
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/<think>[\s\S]*/g, "")
      .trim() || "...";

  return {
    thought,
    action,
    params,
    goal: parsed.goal,
    goalSteps: parsed.goalSteps,
  };
}

export async function queryStrategic(
  context: string,
  recentMessages: LLMMessage[],
  memoryContext: string,
  role: RoleContext,
): Promise<{ thought: string; action: string; params: Record<string, any>; goal?: string; goalSteps?: number }> {
  const memorySection = memoryContext ? `\nYOUR MEMORY:\n${memoryContext}\n` : "";
  const messages: LLMMessage[] = [
    { role: "system", content: buildStrategicPrompt(role) },
    ...recentMessages.slice(-4),
    { role: "user", content: `${memorySection}${context}\n\nWhat should you do next? Respond with JSON.` },
  ];

  try {
    const targetModel = config.llm?.model || config.llm?.fastModel;
    const response = await chat({
      model: targetModel,
      messages,
      think: thinkFor(targetModel),
      format: "json",
      options: {
        temperature: 0.8,
        repeat_penalty: 1.15,
        num_predict: 1024,
      },
    });

    llmLog.info(
      "LLM:strategic",
      `(${response.message.content.length} chars): ${response.message.content.slice(0, 200)}`,
    );
    const recovered = recordLlmCall(true);
    if (recovered.justRecovered) {
      console.log(
        `\n${"=".repeat(72)}\n[LLM] RECOVERED — the model is answering again.\n${"=".repeat(72)}\n`,
      );
    }
    return parseDecision(response.message.content, role.name);
  } catch (err) {
    llmLog.error("LLM:strategic", "Error:", err);
    const outcome = recordLlmCall(false);
    if (outcome.justTripped) {
      console.error(
        `\n${"=".repeat(72)}\n` +
          `[LLM] BRAIN UNREACHABLE — ${UNHEALTHY_AFTER} consecutive strategic calls failed.\n` +
          `Last error: ${(err as Error)?.message ?? String(err)}\n` +
          `${"=".repeat(72)}\n`,
      );
    }
    return { thought: "Planning...", action: "idle", params: {} };
  }
}

export async function queryReactive(
  name: string,
  situation: string,
  allowedActions?: string[],
): Promise<{ thought: string; action: string; params: Record<string, any> }> {
  const messages: LLMMessage[] = [
    { role: "system", content: buildReactivePrompt(name, allowedActions) },
    { role: "user", content: situation },
  ];

  try {
    const targetModel = config.llm?.fastModel || config.llm?.model;
    const response = await chat({
      model: targetModel,
      messages,
      think: thinkFor(targetModel),
      format: "json",
      options: {
        temperature: 0.5,
        repeat_penalty: 1.15,
        num_predict: 384,
      },
    });

    return parseDecision(response.message.content, name);
  } catch (err) {
    llmLog.error("LLM:reactive", "Error:", err);
    return { thought: "Danger!", action: "flee", params: {} };
  }
}

export async function queryCritic(
  name: string,
  actionContext: string,
  allowedActions?: string[],
): Promise<{
  success: boolean;
  thought: string;
  nextAction: string | null;
  nextParams: Record<string, any>;
  goalComplete: boolean;
}> {
  const messages: LLMMessage[] = [
    { role: "system", content: buildCriticPrompt(name, allowedActions) },
    { role: "user", content: actionContext },
  ];

  try {
    const targetModel = config.llm?.fastModel || config.llm?.model;
    const response = await chat({
      model: targetModel,
      messages,
      think: thinkFor(targetModel),
      format: "json",
      options: {
        temperature: 0.4,
        repeat_penalty: 1.15,
        num_predict: 384,
      },
    });

    const jsonStr = extractJSON(response.message.content);
    if (!jsonStr) {
      return { success: false, thought: "Hmm...", nextAction: null, nextParams: {}, goalComplete: true };
    }
    const parsed = JSON.parse(jsonStr);

    let nextAction = parsed.nextAction ?? null;
    if (nextAction) {
      const lower = nextAction.toLowerCase().trim();
      nextAction = ACTION_ALIASES[lower] ?? nextAction;
    }

    return {
      success: parsed.success ?? false,
      thought: parsed.thought || "...",
      nextAction,
      nextParams: parsed.nextParams ?? parsed.params ?? {},
      goalComplete: parsed.goalComplete ?? false,
    };
  } catch (err) {
    llmLog.error("LLM:critic", "Error:", err);
    return { success: false, thought: "Error evaluating", nextAction: null, nextParams: {}, goalComplete: true };
  }
}

function buildSystemPrompt(roleConfig?: {
  name: string;
  personality: string;
  seasonGoal?: string;
  role?: string;
  allowedActions?: string[];
  allowedSkills?: string[];
  priorities?: string;
}): string {
  const name = roleConfig?.name ?? config.bot.name;
  const seasonGoal = roleConfig?.seasonGoal ?? getSeasonGoal();
  const missionBanner = seasonGoal
    ? `🎯 YOUR MISSION THIS SEASON: ${seasonGoal}\nEvery decision should inch toward this mission.\n\n`
    : "";

  const personalityOverride = roleConfig?.personality ? `${roleConfig.personality}\n\n` : "";
  const roleStr = roleConfig?.role ? `YOUR ROLE: ${roleConfig.role}\n\n` : "";

  const roleOverride =
    roleConfig?.allowedActions && roleConfig.allowedActions.length > 0
      ? `
ROLE OVERRIDE — USE ONLY THESE ACTIONS AND SKILLS:
AVAILABLE ACTIONS (${roleConfig.name}'s toolkit):
${roleConfig.allowedActions.map((a) => `- ${a}`).join("\n")}
- idle: Do nothing.
- respond_to_chat: Reply to a player message.
- invoke_skill: Run a dynamic skill.

SKILLS (${roleConfig.name}'s specialties):
${(roleConfig.allowedSkills ?? []).map((s) => `- ${s}`).join("\n") || "- (none)"}
${roleConfig.priorities ?? ""}
`
      : null;

  return `${missionBanner}${personalityOverride}${roleStr}You are ${name}, an AI playing Minecraft.
RULES: Respond ONLY with valid JSON.
RESPONSE FORMAT: {"thought":"...","action":"action_name","params":{...}}
${
  roleOverride
    ? `IMPORTANT RULES:\n${roleOverride}`
    : `SKILLS:\n${getSkillPromptLines()}`
}`;
}

export async function queryLLM(
  context: string,
  recentMessages: LLMMessage[] = [],
  memoryContext: string = "",
  roleConfig?: {
    name: string;
    personality: string;
    seasonGoal?: string;
    role?: string;
    allowedActions?: string[];
    allowedSkills?: string[];
    priorities?: string;
  },
): Promise<{ thought: string; action: string; params: Record<string, any>; goal?: string; goalSteps?: number }> {
  const memorySection = memoryContext ? `\n\nYOUR MEMORY: ${memoryContext}\n` : "";
  const messages: LLMMessage[] = [
    { role: "system", content: buildSystemPrompt(roleConfig) },
    ...recentMessages,
    { role: "user", content: `${memorySection}${context}` },
  ];

  try {
    const targetModel = config.llm?.fastModel || config.llm?.model;
    let response = await chat({
      model: targetModel,
      messages,
      think: thinkFor(targetModel),
      format: "json",
      options: {
        temperature: 0.85,
        repeat_penalty: 1.15,
        num_predict: 1024,
      },
    });

    if (response.message.content.trim().length < 20) {
      response = await chat({
        model: targetModel,
        think: thinkFor(targetModel),
        messages: [
          {
            role: "system",
            content: `You are ${roleConfig?.name ?? config.bot.name}, an AI playing Minecraft. Respond ONLY with valid JSON.`,
          },
          {
            role: "user",
            content: `Quick decision needed. Context: ${context.slice(0, 500)}\nRespond with JSON only.`,
          },
        ],
        options: { temperature: 0.6, num_predict: 512 },
      });
    }

    return parseDecision(response.message.content, roleConfig?.name ?? config.bot.name);
  } catch (err) {
    llmLog.error("LLM", "Error:", err);
    return { thought: "Brain freeze...", action: "idle", params: {} };
  }
}

export async function chatWithLLM(prompt: string, context: string, roleConfig?: { name: string }): Promise<string> {
  try {
    const targetModel = config.llm?.fastModel || config.llm?.model;
    const response = await chat({
      model: targetModel,
      think: thinkFor(targetModel),
      messages: [
        {
          role: "system",
          content: buildChatPrompt(roleConfig?.name ?? config.bot.name, context),
        },
        { role: "user", content: prompt },
      ],
      options: {
        temperature: 0.9,
        num_predict: 150,
      },
    });
    let text = response.message.content.trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    text = text.replace(/<think>[\s\S]*/g, "").trim();
    return text || "Hmm...";
  } catch (err) {
    llmLog.error("LLM", "Chat error:", err);
    return "Sorry, my brain lagged for a sec.";
  }
}
