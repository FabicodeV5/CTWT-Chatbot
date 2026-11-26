import { supabase } from '../db/supabase.js';
import { Router, Request, Response } from 'express';
import { env } from '../config/env.js';
import {
  getOrCreateConversation,
  isDuplicateInboundMessage,
  saveMessage,
  getRecentMessages,
} from '../agent/memory.js';
import { generateAgentReply } from '../agent/brain.js';
import { sendWhatsAppText } from './client.js';
import { syncCustomerOnMessage } from '../crm/customers.js';

export const whatsappRouter = Router();

// Verificación del webhook de Meta (GET)
whatsappRouter.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified');
    res.status(200).send(challenge);
    return;
  }

  res.sendStatus(403);
});

// Recepción de mensajes entrantes de Meta (POST)
whatsappRouter.post('/', async (req: Request, res: Response) => {
  // Responder 200 de inmediato para evitar reintentos de Meta
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return;
    }

    const from: string = message.from;
    const waMessageId: string = message.id;
    const profileName: string | undefined = value?.contacts?.[0]?.profile?.name;

    if (await isDuplicateInboundMessage(waMessageId)) {
      return;
    }

    // Extraer texto si es mensaje normal o respuesta de botón/lista interactiva
    let textBody = '';
    if (message.type === 'text') {
      textBody = message.text?.body ?? '';
    } else if (message.type === 'interactive') {
      textBody =
        message.interactive?.button_reply?.title ??
        message.interactive?.list_reply?.title ??
        '';
    } else if (['image', 'audio', 'video', 'document', 'voice'].includes(message.type)) {
      const conversation = await getOrCreateConversation(from, profileName);
      await saveMessage({
        conversationId: conversation.id,
        role: 'user',
        content: `[${message.type} attachment]`,
        whatsappMessageId: waMessageId,
      });

      if (conversation.mode === 'human') return;

      const mediaNotice =
        'Hi! 👋 Right now I can only read text messages. Please type what product or help you need, or let me know if you want to speak with a store advisor.';
      await saveMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: mediaNotice,
      });
      await sendWhatsAppText(from, mediaNotice);
      return;
    } else {
      return;
    }

    if (!textBody.trim()) return;

    const conversation = await getOrCreateConversation(from, profileName);
    const history = await getRecentMessages(conversation.id, 12);

    await saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: textBody,
      whatsappMessageId: waMessageId,
    });

    // Track customer activity in CRM (non-blocking)
    syncCustomerOnMessage({
      waUserId: from,
      customerName: profileName,
      sender: 'customer',
      messageBody: textBody,
      mode: conversation.mode as 'bot' | 'human',
    }).catch(() => {});

    // Si la conversación fue escalada a un humano, guardar el mensaje pero no responder con IA
    if (conversation.mode === 'human') {
      return;
    }

    const reply = await generateAgentReply({
      conversationId: conversation.id,
      history,
      userMessage: textBody,
    });

    await saveMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: reply,
    });

    // Track bot reply in CRM (non-blocking)
    syncCustomerOnMessage({
      waUserId: from,
      customerName: profileName,
      sender: 'bot',
      messageBody: reply,
      mode: 'bot',
    }).catch(() => {});

    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error('❌ Error processing WhatsApp webhook:', err);
  }
});

// Endpoint de simulación local (POST /webhook/whatsapp/simulate)
whatsappRouter.post('/simulate', async (req: Request, res: Response) => {
  try {
    const phone = String(req.body?.phone || '5920000000');
    const text = String(req.body?.message || '').trim();

    if (!text) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const conversation = await getOrCreateConversation(phone, 'Local Tester');
    const history = await getRecentMessages(conversation.id, 12);

    await saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: text,
    });

    // Track customer in CRM (non-blocking)
    syncCustomerOnMessage({
      waUserId: phone,
      customerName: 'Local Tester',
      sender: 'customer',
      messageBody: text,
      mode: conversation.mode as 'bot' | 'human',
    }).catch(() => {});

    if (conversation.mode === 'human') {
      res.json({
        conversationId: conversation.id,
        mode: conversation.mode,
        reply: '[Human takeover active — bot paused]',
      });
      return;
    }

    const reply = await generateAgentReply({
      conversationId: conversation.id,
      history,
      userMessage: text,
    });

    await saveMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: reply,
    });

    // Track bot reply in CRM (non-blocking)
    syncCustomerOnMessage({
      waUserId: phone,
      customerName: 'Local Tester',
      sender: 'bot',
      messageBody: reply,
      mode: 'bot',
    }).catch(() => {});

    res.json({
      conversationId: conversation.id,
      status: conversation.status,
      reply,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// Reactivar el bot en una conversación en modo humano (POST /webhook/whatsapp/resume-bot)
whatsappRouter.post('/resume-bot', async (req: Request, res: Response) => {
  try {
    const phone = req.body?.phone ? String(req.body.phone).replace(/[^0-9]/g, "") : "";
    const conversationId = req.body?.conversationId ? String(req.body.conversationId).trim() : "";

    if (!phone && !conversationId) {
      res.status(400).json({ error: "Provide either phone or conversationId" });
      return;
    }

    let query = supabase
      .from("conversations")
      .update({
        mode: "bot",
        last_message_at: new Date().toISOString(),
      });

    if (conversationId) {
      query = query.eq("id", conversationId);
    } else {
      query = query.eq("wa_user_id", phone);
    }

    const { data, error } = await query.select("id, wa_user_id, mode");

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    if (!data || data.length === 0) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    console.log("🤖 [resume-bot] Reactivated bot for:", data);
    res.json({ resumed: true, conversations: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
