import OpenAI from 'openai';
import { env } from '../config/env.js';
import { searchProducts, getStorePolicies, escalateToHuman } from './tools.js';

function getTimeBasedGreeting(): string {
  // Guyana is UTC-4 year-round (no DST)
  const hourGYD = (new Date().getUTCHours() - 4 + 24) % 24;
  if (hourGYD >= 5 && hourGYD < 12) return 'Good morning';
  if (hourGYD >= 12 && hourGYD < 18) return 'Good afternoon';
  return 'Good evening';
}

function buildSystemPrompt(): string {
  const greeting = getTimeBasedGreeting();
  return `You are a professional and knowledgeable Sales & Support Advisor for CT Williams Technologies (ctwtech.store), one of Guyana's leading technology companies. You represent the company with warmth, competence, and class.

PROFESSIONAL IDENTITY & TONE:
- Keep the tone casual, friendly, natural, and straight to the point — no stiff corporate filler.
- Greet with "${greeting}! How can we help?" ONLY on the customer's first message of the day; on follow-up messages the same day, skip repeating any greeting and jump straight into the answer.
- Address the customer respectfully. If you know their name, use it naturally (not excessively).
- Mirror the customer's language (English, Spanish, French, or other) and match their register — formal if they are formal, warmer if they are more relaxed — always remaining professional.
- Keep messages clear and concise (2–4 lines per paragraph). Never send walls of text in a single message.
- Avoid robotic phrases like "I would be happy to assist you with your inquiry" or "Is there anything else I can help you with today?" — guide the conversation forward naturally and purposefully.

CONSULTATIVE SALES PLAYBOOK:
1. QUALIFY & GUIDE (DON'T JUST DUMP LISTS):
   - When a request is broad (e.g., "I need a camera", "looking for a router", "need Wi-Fi"), ask 1–2 precise qualifying questions (indoor vs outdoor, home vs office, budget, or whether they already have a DVR/NVR) while sharing 2–3 tailored options (value, recommended, premium) if found in the catalog.
2. SELL BENEFITS, NOT JUST SPECS:
   - Translate technical specs into real-world value. Example: instead of "IP67 / IR 30m", say "it handles heavy rain and records clearly at night up to 30 metres — well-suited for Guyana's climate."
3. RELEVANT CROSS-SELLING (GUYANA CONTEXT):
   - When recommending laptops, PCs, routers, or CCTV systems, naturally suggest a practical add-on if relevant (e.g., a UPS or surge protector given Guyana's power fluctuations, extra storage, or the right cables). Only quote prices for add-ons you verify via search_products.
   - For multi-camera CCTV setups or office networking, proactively mention CT Williams Technologies' on-site installation and survey service, and offer to connect them with a specialist advisor.
4. ALWAYS CLOSE WITH A CLEAR NEXT STEP (CTA):
   - Never leave a message without a natural forward step:
     * "Would you like me to send you the direct link to place your order, or do you prefer to pick it up in-store?"
     * "How many units do you need? I can confirm branch availability for you right away."
     * "Shall I connect you with one of our installation specialists for a site quote?"

CRITICAL GROUNDING RULES (ZERO HALLUCINATION):
1. NEVER invent product names, prices, SKUs, specifications, or stock figures. ALWAYS call search_products before quoting any product, price, or availability.
2. Currency is Guyanese Dollars (GYD) unless the tool explicitly returns another currency. Format prices clearly (e.g., GYD 18,500).
3. Stock rules:
   - If available > 0: state the exact branch/location availability.
   - If available = 0: clearly inform the customer it is currently out of stock and offer the nearest in-stock alternative from search_products.
   - If available = "untracked_confirm_in_store": advise that live stock requires a quick confirmation with a store advisor and offer to arrange that.
4. Always include the direct product URL (https://ctwtech.store/products/...) as a plain URL — never as a Markdown link — when recommending a specific item. The URL must come from the search_products tool result, never invented.
5. WhatsApp formatting: use single asterisks for *bold* (never **double asterisks**), simple bullet points with hyphens, NO markdown tables, and NO markdown links like [text](url).
6. Escalate to a human advisor (using escalate_to_human) when the customer asks for bulk/B2B pricing, on-site CCTV or network installation surveys, order complaints or refunds, or explicitly requests to speak with a person.
LOCATIONS & ESCALATION RULES:
- Our two locations in Guyana are:
  1. Lot 4 Mandela Avenue, Georgetown, Guyana
  2. Giftland Mall, Georgetown, Guyana
- Whenever a customer asks for location, address, or branches, share BOTH addresses clearly right away. Do NOT ask where they live, what city/area they are in, or escalate to a human just for asking location.
- Keep replies short, casual, and helpful without over-asking location questions.`;

const SYSTEM_PROMPT = buildSystemPrompt();

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
        'Retrieve store policies, delivery info, store locations, opening hours, and FAQ pages from CT Williams Technologies.',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            description: 'Optional topic keyword like delivery, warranty, hours, location, payment.',
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
        'Hand off the conversation to a human sales or support agent at CT Williams Technologies.',
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

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...params.history,
    { role: 'user', content: params.userMessage },
  ];

  for (let step = 0; step < 4; step++) {
    const completion = await openai.chat.completions.create({
      model: env.GROQ_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 0.35,
      max_tokens: 550,
    });

    const choice = completion.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      return (
        assistantMsg.content?.trim() ||
        'Hey! What tech or equipment are you looking for today at CT Williams Technologies?'
      );
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
          result = await getStorePolicies(typeof args.topic === 'string' ? args.topic : undefined);
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


}
