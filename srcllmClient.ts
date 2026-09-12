// src/llmClient.ts
export class MultiModelLLMClient {
  private baseUrl: string;
  private apiKey: string;
  public models: { planner: string; executor: string; critic: string };

  constructor(config: { baseUrl: string; apiKey: string; models: { planner: string; executor: string; critic: string } }) {
    // Chuẩn hóa Endpoint dạng OpenAI Compatible
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.models = config.models;
  }

  // Hàm gửi prompt tới model được chỉ định
  async generateResponse(type: 'planner' | 'executor' | 'critic', systemPrompt: string, userPrompt: string) {
    const modelName = this.models[type]; // Lấy đúng 1 trong 3 model bạn đã chọn
    
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: type === 'planner' ? 0.7 : 0.2 // Planner sáng tạo hơn, Executor/Critic cần chính xác hơn
      })
    });

    if (!response.ok) {
      throw new Error(`API Error [${type} - ${modelName}]: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}
