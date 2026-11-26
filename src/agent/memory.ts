import { supabase } from '../db/supabase.js';

export async function getOrCreateConversation(waUserId: string, profileName?: string) {
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('wa_user_id', waUserId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        ...(profileName && !existing.customer_name ? { customer_name: profileName } : {}),
      })
      .eq('id', existing.id);

    return existing;
  }

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      wa_user_id: waUserId,
      customer_name: profileName ?? null,
      last_message_at: new Date().toISOString(),
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create conversation: ${error.message}`);
  }

  return created;
}

export async function isDuplicateInboundMessage(waMessageId: string): Promise<boolean> {
  if (!waMessageId) return false;
  const { data } = await supabase
    .from('messages')
    .select('id')
    .eq('wa_message_id', waMessageId)
    .maybeSingle();

  return Boolean(data);
}

export async function saveMessage(params: {
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  whatsappMessageId?: string;
  metadata?: Record<string, unknown>;
}) {
  const isUser = params.role === 'user';

  const { error } = await supabase.from('messages').insert({
    conversation_id: params.conversationId,
    wa_message_id: params.whatsappMessageId ?? null,
    direction: isUser ? 'in' : 'out',
    sender: params.role === 'user' ? 'customer' : params.role === 'assistant' ? 'bot' : 'staff',
    body: params.content,
    tool_calls: params.metadata ?? null,
  });

  if (error) {
    console.error('Failed to save message:', error.message);
  }
}

export async function getRecentMessages(conversationId: string, limit = 12) {
  const { data, error } = await supabase
    .from('messages')
    .select('sender, body')
    .eq('conversation_id', conversationId)
    .in('sender', ['customer', 'bot'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.reverse().map((row: any) => ({
    role: (row.sender === 'customer' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: row.body,
  }));
}