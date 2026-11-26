import OpenAI from 'openai';
import { env } from '../config/env.js';
import { searchProducts, getStorePolicies, escalateToHuman } from './tools.js';

const lastGreetedDay = new Map<string, string>();

function getGuyanaTimeInfo(): { dateKey: string; greeting: string } {
  // Guyana is UTC-4 year-round (no DST)
  const guyanaDate = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const yyyy = guyanaDate.getUTCFullYear();
  const mm = String(guyanaDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(guyanaDate.getUTCDate()).padStart(2, '0');
  const hour = guyanaDate.getUTCHours();

  let greeting = 'Good evening';
  if (hour >= 5 && hour < 12) greeting = 'Good morning';
  else if (hour >= 12 && hour < 18) greeting = 'Good afternoon';

  return { dateKey: `${yyyy}-${mm}-${dd}`, greeting };
}

function stripLeadingGreeting(text: string): string {
  const cleaned = text
    .replace(
      /^(good\s+(morning|afternoon|evening)|hello|hi(\s+there)?|hey(\s+there)?|hola|buenos\s+d[ií]as|buenas\s+(tardes|noches))[,!.\s—-]*(it\s+is\s+a\s+pleasure\s+to\s+assist\s+you(\s+today)?(\s+at\s+ct\s+williams\s+technologies)?[,!.\s]*)?(how\s+can\s+(i|we)\s+help(\s+you)?(\s+today)?\??\s*)?/i,
      ''
    )
    .trim();

  if (!cleaned) return text.trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function buildSystemPrompt(alreadyGreetedToday: boolean, greeting: string): string {
  const greetingRule = alreadyGreetedToday
    ? `- CRITICAL: You ALREADY greeted this customer today. Do NOT say "${greeting}", "Hello", "Hi", or "it is a pleasure to assist you". Jump straight into a casual, helpful answer.`
    : `- This is the customer's FIRST message today: open casually with "${greeting}!" (or mirror their language naturally) and answer right away. NEVER use stiff corporate lines like "it is a pleasure to assist you today at CT Williams Technologies."`;

  return `You are a friendly, casual, and direct Sales & Support Advisor for CT Williams Technologies (ctwtech.store) in Guyana.

TONE & GREETING RULES:
- Sound natural, warm, and straight to the point — like a real person texting on WhatsApp, never robotic or overly formal.
${greetingRule}
- Mirror the customer's language (English, Spanish, French, etc.).
- Keep messages short and easy to read (1–3 short lines per paragraph). Never send walls of text.

STORE LOCATIONS (MEMORIZED — ANSWER IMMEDIATELY):
- CT Williams Technologies has TWO store locations in Guyana:
  1. *Lot 4 Mandela Avenue, Georgetown, Guyana*
  2. *Giftland Mall, Georgetown, Guyana*
- Whenever a customer asks where you are located, your address, stores, or branches, share BOTH addresses clearly right away.
- NEVER ask where the customer lives, what city or area they are in, or which branch is closer before giving the addresses.
- NEVER call escalate_to_human or get_store_policies just to answer a store location or address question.
- Ignore any older messages in the conversation history that asked for the customer's location — always provide the two Georgetown addresses directly.

CONSULTATIVE SALES PLAYBOOK:
1. QUALIFY LIGHTLY (DO NOT INTERROGATE):
   - When a product request is broad (e.g., "I need a camera", "looking for a router"), share 2–3 tailored options from search_products right away and ask at most 1 quick question (e.g., indoor vs outdoor, or budget). Do NOT ask personal location questions.
2. SELL REAL-WORLD BENEFITS:
   - Mention practical value briefly (e.g., handles heavy rain, or pairing with a UPS/surge protector for power fluctuations). Only quote prices verified via search_products.
3. CLEAR NEXT STEP:
   - Close product recommendations casually (e.g., "Want the link to order, or do you prefer picking it up at Mandela Ave or Giftland Mall?").

CRITICAL GROUNDING RULES (ZERO HALLUCINATION):
1. NEVER invent product names, prices, SKUs, specifications, or stock figures. ALWAYS call search_products before quoting any product, price, or availability.
2. Currency is Guyanese Dollars (GYD) unless the tool explicitly returns another currency (e.g., GYD 18,500).
3. Stock rules:
   - If available > 0: state branch availability clearly.
   - If available = 0: let them know it is currently out of stock and suggest the closest in-stock alternative from search_products.
   - If available = "untracked_confirm_in_store": mention live stock needs a quick confirmation with a store advisor and offer to arrange that.
4. Always include the direct product URL (https://ctwtech.store/products/...) as a plain URL — never as a Markdown link [text](url).
5. WhatsApp formatting: use single asterisks for *bold* (never **double asterisks**), simple hyphens for bullets, NO markdown tables, and NO markdown links.
6. Escalate to a human advisor (using escalate_to_human) ONLY for bulk/B2B pricing, on-site CCTV or network installation surveys, order complaints or refunds, untracked stock confirmation when requested, or when the customer explicitly asks to speak with a person.`;
}

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_products',
      description:
        'Search active published products in the CT Williams Technologies catalog by keyword, brand, category, or SKU, and check branch inventory.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search term such as product name, brand (e.g. Hikvision, TP-Link), or SKU.',
          },
          maxPrice: {
            type: 'number',
            description: 'Optional maximum budget filter in store currency.',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default 5).',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_store_policies',
      description:
        'Retrieve store policies, delivery info, warranty, opening hours, and FAQ pages from CT Williams Technologies. Do not call this for store addresses.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Optional topic keyword like delivery, warranty, hours, payment.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Hand off the conversation to a human sales or support agent at CT Williams Technologies. Never use this for store location or address questions.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Short category: b2b_quote, installation_site_visit, complaint, stock_confirmation, or customer_request.',
          },
          customerSummary: {
            type: 'string',
            description: 'Brief summary of what the customer needs so the human agent can follow up immediately.',
          },
        },
        required: ['reason', 'customerSummary'],
      },
    },
  },
];

let groqClient: OpenAI | null = null;

function getGroqClient(): OpenAI {
  if (!groqClient) {
    groqClient = new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: env.GROQ_API_KEY,
    });
  }
  return groqClient;
}

function toOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function generateAgentReply(params: {
  conversationId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  userMessage: string;
}): Promise<string> {
  if (!env.GROQ_API_KEY) {
    return '⚠️ GROQ_API_KEY is not configured yet. Please add it to your .env file to enable AI responses.';
  }

  const openai = getGroqClient();
  const { dateKey, greeting } = getGuyanaTimeInfo();
  const recordedDate = lastGreetedDay.get(params.conversationId);
  const hasAssistantHistory = params.history.some((m) => m.role === 'assistant');

  const alreadyGreetedToday =
    recordedDate === dateKey || (!recordedDate && hasAssistantHistory);

  lastGreetedDay.set(params.conversationId, dateKey);

  const sanitizedHistory: Array<{ role: 'user' | 'assistant'; content: string }> =
    params.history.map((msg) => ({
      role: msg.role,
      content: msg.role === 'assistant' ? stripLeadingGreeting(msg.content) : msg.content,
    }));

  const systemPrompt = buildSystemPrompt(alreadyGreetedToday, greeting);

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...sanitizedHistory,
    { role: 'user', content: params.userMessage },
  ];

  for (let step = 0; step < 4; step++) {
    const completion = await openai.chat.completions.create({
      model: env.GROQ_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 550,
    });

    const choice = completion.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const rawReply =
        assistantMsg.content?.trim() ||
        'How can we help you today at CT Williams Technologies?';

      return alreadyGreetedToday ? stripLeadingGreeting(rawReply) : rawReply;
    }

    for (const toolCall of assistantMsg.tool_calls) {
      if (toolCall.type !== 'function') continue;

      let args: Record<string, any> = {};
      try {
        args = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        args = {};
      }

      let result: unknown;
      try {
        if (toolCall.function.name === 'search_products') {
          result = await searchProducts({
            query: String(args.query ?? ''),
            maxPrice: toOptionalNumber(args.maxPrice),
            limit: toOptionalNumber(args.limit),
          });
        } else if (toolCall.function.name === 'get_store_policies') {
          const policyData = await getStorePolicies(
            typeof args.topic === 'string' ? args.topic : undefined
          );
          result = {
            official_locations: [
              'Lot 4 Mandela Avenue, Georgetown, Guyana',
              'Giftland Mall, Georgetown, Guyana',
            ],
            ...policyData,
          };
        } else if (toolCall.function.name === 'escalate_to_human') {
          result = await escalateToHuman({
            conversationId: params.conversationId,
            reason: String(args.reason ?? 'customer_request'),
            customerSummary: String(args.customerSummary ?? params.userMessage),
          });
        } else {
          result = { error: `Unknown tool: ${toolCall.function.name}` };
        }
      } catch (toolErr: any) {
        console.error(`❌ [brain] Tool ${toolCall.function.name} failed:`, toolErr);
        result = { error: toolErr?.message || 'Tool execution failed' };
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  try {
    await escalateToHuman({
      conversationId: params.conversationId,
      reason: 'agent_step_limit',
      customerSummary: `Agent reached max tool steps while handling: "${params.userMessage}"`,
    });
  } catch (err) {
    console.error('⚠️ Fallback escalation failed:', err);
  }

  return 'Let me connect you with one of our advisors at CT Williams Technologies so they can help you right away.';
}
