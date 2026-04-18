/**
 * AI Router — standalone implementation.
 *
 * Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, or NVIDIA_API_KEY.
 * Model prefix determines provider: claude-* = Anthropic, llama-* = Groq, etc.
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentPart[];
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface StreamChunk {
  type?: 'text' | 'content_block_delta' | 'error' | 'done';
  content?: string;
  done?: boolean;
  error?: string;
  model?: string;
}

export interface StreamOptions {
  systemPrompt?: string;
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function* streamChat(
  messages: ChatMessage[],
  model: string,
  context?: string | null,
  options: StreamOptions = {}
): AsyncGenerator<StreamChunk> {
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.7;
  const system = options.systemPrompt || options.system;

  const allMessages: ChatMessage[] = [
    ...(context ? [{ role: 'user' as const, content: `Context:\n${context}` }, { role: 'assistant' as const, content: 'Understood.' }] : []),
    ...messages,
  ];

  // Anthropic
  if (model.startsWith('claude') || model.includes('anthropic')) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { yield { type: 'error', error: 'ANTHROPIC_API_KEY not set' }; return; }

    const anthropicMessages = allMessages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
    const sysMsg = system || allMessages.find(m => m.role === 'system')?.content as string | undefined;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: sysMsg, messages: anthropicMessages, stream: true }),
    });

    if (!res.ok || !res.body) { yield { type: 'error', error: `Anthropic error ${res.status}` }; return; }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') { yield { type: 'done', done: true }; return; }
        try {
          const evt = JSON.parse(data);
          if (evt.type === 'content_block_delta' && evt.delta?.text) {
            yield { type: 'content_block_delta', content: evt.delta.text };
          }
          if (evt.type === 'message_stop') { yield { type: 'done', done: true }; return; }
        } catch {}
      }
    }
    yield { type: 'done', done: true };
    return;
  }

  // OpenAI-compatible (OpenAI, Groq, NVIDIA)
  let baseUrl = 'https://api.openai.com/v1';
  let apiKey = process.env.OPENAI_API_KEY || '';

  if (model.startsWith('llama') || model.includes('groq') || model.includes('mixtral') || model.includes('gemma')) {
    baseUrl = 'https://api.groq.com/openai/v1';
    apiKey = process.env.GROQ_API_KEY || '';
  } else if (model.includes('nvidia') || model.includes('minimax') || model.includes('kimi') || model.includes('deepseek')) {
    baseUrl = 'https://integrate.api.nvidia.com/v1';
    apiKey = process.env.NVIDIA_API_KEY || '';
  }

  if (!apiKey) { yield { type: 'error', error: `No API key for model: ${model}` }; return; }

  const finalMessages: ChatMessage[] = [
    ...(system ? [{ role: 'system' as const, content: system }] : []),
    ...allMessages.filter(m => m.role !== 'system'),
  ];

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: finalMessages, temperature, max_tokens: maxTokens, stream: true }),
  });

  if (!res.ok || !res.body) { yield { type: 'error', error: `AI error ${res.status}` }; return; }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') { yield { type: 'done', done: true }; return; }
      try {
        const chunk = JSON.parse(data);
        const text = chunk.choices?.[0]?.delta?.content;
        if (text) yield { type: 'text', content: text };
      } catch {}
    }
  }
  yield { type: 'done', done: true };
}
