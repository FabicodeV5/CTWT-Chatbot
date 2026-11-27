import { supabase } from '../db/supabase.js';

export type SellerType = 'bot' | 'human';
export type SaleStatus = 'pending' | 'confirmed' | 'cancelled' | 'refunded';
export type SaleSource = 'whatsapp_bot' | 'whatsapp_human' | 'staff_command' | 'manual_api' | 'whatsapp';

let warnedMissingTables = false;

export function isMissingCrmTableError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const msg = error.message || '';
  return (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    msg.includes('Could not find the table') ||
    msg.includes('does not exist')
  );
}

function warnMissingTablesOnce(context: string, error: { message?: string }) {
  if (warnedMissingTables) return;
  warnedMissingTables = true;
  console.warn(
    `⚠️ [CRM] ${context}: ${error.message}. Run supabase/migrations/001_whatsapp_customers_and_sales.sql in Supabase SQL Editor to enable CRM tables.`
  );
}

export function normalizePhone(raw: string): string {
  return raw.replace(/[^0-9]/g, '').trim();
}

export async function ensureCustomer(params: {
  waUserId: string;
  customerName?: string | null;
  preferredLanguage?: string;
  handledBy?: SellerType;
}): Promise<{ id: string; wa_user_id: string } | null> {
  const cleanId = params.waUserId.trim();
  const phone = normalizePhone(cleanId) || cleanId;
  const now = new Date().toISOString();

  const { data: existing, error: fetchErr } = await supabase
    .from('customers')
    .select('id, wa_user_id, customer_name, total_messages')
    .eq('wa_user_id', cleanId)
    .maybeSingle();

  if (fetchErr) {
    if (isMissingCrmTableError(fetchErr)) {
      warnMissingTablesOnce('customers lookup skipped', fetchErr);
      return null;
    }
    throw new Error(`Failed to fetch customer: ${fetchErr.message}`);
  }

  if (existing) {
    const updates: Record<string, unknown> = { last_seen_at: now };
    if (params.customerName && !existing.customer_name) {
      updates.customer_name = params.customerName;
    }
    if (params.handledBy) {
      updates.last_handled_by = params.handledBy;
    }

    const { error: updateErr } = await supabase
      .from('customers')
      .update(updates)
      .eq('id', existing.id);

    if (updateErr) {
      console.warn('⚠️ [CRM] Failed to update customer metadata:', updateErr.message);
    }

    return { id: existing.id, wa_user_id: existing.wa_user_id };
  }

  const { data: created, error: insertErr } = await supabase
    .from('customers')
    .insert({
      wa_user_id: cleanId,
      phone_number: phone,
      customer_name: params.customerName ?? null,
      preferred_language: params.preferredLanguage ?? 'en',
      first_seen_at: now,
      last_seen_at: now,
      last_handled_by: params.handledBy ?? 'bot',
    })
    .select('id, wa_user_id')
    .single();

  if (insertErr) {
    if (isMissingCrmTableError(insertErr)) {
      warnMissingTablesOnce('customers insert skipped', insertErr);
      return null;
    }
    throw new Error(`Failed to create customer: ${insertErr.message}`);
  }

  return created;
}

export async function syncCustomerOnMessage(params: {
  waUserId: string;
  customerName?: string | null;
  sender: 'customer' | 'bot' | 'staff';
  messageBody: string;
  mode?: SellerType;
}): Promise<void> {
  try {
    const handledBy: SellerType | undefined =
      params.sender === 'staff' || params.mode === 'human'
        ? 'human'
        : params.sender === 'bot'
          ? 'bot'
          : undefined;

    const customer = await ensureCustomer({
      waUserId: params.waUserId,
      customerName: params.customerName,
      handledBy,
    });

    if (!customer) return;

    const { data: current } = await supabase
      .from('customers')
      .select('total_messages')
      .eq('id', customer.id)
      .single();

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      last_seen_at: now,
      total_messages: Number(current?.total_messages ?? 0) + 1,
    };

    if (params.sender === 'customer') {
      updates.last_message_text = params.messageBody.slice(0, 1000);
      updates.last_message_at = now;
    }

    if (handledBy) {
      updates.last_handled_by = handledBy;
    }

    const { error: syncErr } = await supabase
      .from('customers')
      .update(updates)
      .eq('id', customer.id);

    if (syncErr) {
      console.warn('⚠️ [CRM] Failed to sync customer message count:', syncErr.message);
    }
  } catch (err) {
    console.warn('⚠️ [CRM] Non-blocking customer sync error:', err);
  }
}

export interface RecordSaleInput {
  waUserId: string;
  customerName?: string | null;
  conversationId?: string | null;
  productHandle?: string | null;
  productQuery?: string | null;
  productTitle?: string | null;
  variantTitle?: string | null;
  sku?: string | null;
  productUrl?: string | null;
  quantity?: number;
  unitPrice?: number | null;
  totalAmount?: number | null;
  currency?: string;
  soldAt?: string;
  soldByType: SellerType;
  soldByName?: string | null;
  soldByPhone?: string | null;
  source?: SaleSource;
  status?: SaleStatus;
  notes?: string | null;
}

export async function recordCustomerSale(input: RecordSaleInput) {
  const cleanId = input.waUserId.trim();
  const customer = await ensureCustomer({
    waUserId: cleanId,
    customerName: input.customerName,
    handledBy: input.soldByType,
  });

  if (!customer) {
    throw new Error(
      'CRM tables are not created yet in Supabase. Run supabase/migrations/001_whatsapp_customers_and_sales.sql first.'
    );
  }

  let matchedProduct: {
    id: string;
    title: string;
    handle: string;
    url: string | null;
    price_min: number | null;
    currency: string | null;
    product_variants?: Array<{ id: string; title: string; sku: string | null; price: number | null }>;
  } | null = null;

  const lookupTerm = input.productHandle?.trim() || input.productQuery?.trim() || input.productTitle?.trim();
  if (lookupTerm) {
    const cleanHandle = lookupTerm.replace(/^https?:\/\/[^/]+\/products\//i, '').split('?')[0].trim();
    const { data: byHandle } = await supabase
      .from('products')
      .select('id, title, handle, url, price_min, currency, product_variants(id, title, sku, price)')
      .eq('handle', cleanHandle)
      .maybeSingle();

    if (byHandle) {
      matchedProduct = byHandle;
    } else {
      const { data: byTitle } = await supabase
        .from('products')
        .select('id, title, handle, url, price_min, currency, product_variants(id, title, sku, price)')
        .ilike('title', `%${lookupTerm}%`)
        .limit(1)
        .maybeSingle();
      if (byTitle) matchedProduct = byTitle;
    }
  }

  let conversationId = input.conversationId ?? null;
  if (!conversationId) {
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('wa_user_id', cleanId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    conversationId = conv?.id ?? null;
  }

  const quantity = Math.max(1, Math.trunc(input.quantity ?? 1));
  const firstVariant = matchedProduct?.product_variants?.[0];
  const resolvedUnitPrice =
    input.unitPrice ??
    (firstVariant?.price !== null && firstVariant?.price !== undefined ? Number(firstVariant.price) : null) ??
    (matchedProduct?.price_min !== null && matchedProduct?.price_min !== undefined
      ? Number(matchedProduct.price_min)
      : null);

  const resolvedTotal =
    input.totalAmount ??
    (resolvedUnitPrice !== null && Number.isFinite(resolvedUnitPrice)
      ? resolvedUnitPrice * quantity
      : null);

  const resolvedTitle = input.productTitle?.trim() || matchedProduct?.title || lookupTerm || 'Custom Product';
  const resolvedUrl =
    input.productUrl?.trim() ||
    matchedProduct?.url ||
    (matchedProduct?.handle ? `https://ctwtech.store/products/${matchedProduct.handle}` : null);

  const sellerName =
    input.soldByName?.trim() ||
    (input.soldByType === 'bot' ? 'CTW WhatsApp Bot' : input.soldByPhone ? `Staff (${input.soldByPhone})` : 'Human Advisor');

  const source: SaleSource =
    input.source ?? (input.soldByType === 'bot' ? 'whatsapp_bot' : 'whatsapp_human');

  const { data: sale, error } = await supabase
    .from('customer_sales')
    .insert({
      customer_id: customer.id,
      wa_user_id: cleanId,
      conversation_id: conversationId,
      product_id: matchedProduct?.id ?? null,
      variant_id: firstVariant?.id ?? null,
      product_title: resolvedTitle,
      variant_title: input.variantTitle ?? firstVariant?.title ?? null,
      sku: input.sku ?? firstVariant?.sku ?? null,
      product_url: resolvedUrl,
      quantity,
      unit_price: resolvedUnitPrice,
      total_amount: resolvedTotal,
      currency: input.currency || matchedProduct?.currency || 'GYD',
      sold_at: input.soldAt ?? new Date().toISOString(),
      sold_by_type: input.soldByType,
      sold_by_name: sellerName,
      sold_by_phone: input.soldByPhone ?? null,
      source,
      status: input.status ?? 'confirmed',
      notes: input.notes ?? null,
    })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to record customer sale: ${error.message}`);
  }

  return sale;
}

export async function listCustomersOverview(limit = 50) {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const { data, error } = await supabase
    .from('customer_crm_overview')
    .select('*')
    .order('last_seen_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    throw new Error(`Failed to query customer_crm_overview: ${error.message}`);
  }

  return data ?? [];
}

export async function getCustomerProfile(phoneOrWaId: string) {
  const safeId = phoneOrWaId.replace(/[^0-9+a-zA-Z_-]/g, '').trim();
  const cleanPhone = normalizePhone(phoneOrWaId);

  if (!safeId && !cleanPhone) {
    return null;
  }

  const orFilters: string[] = [];
  if (safeId) orFilters.push(`wa_user_id.eq.${safeId}`);
  if (cleanPhone) orFilters.push(`phone_number.eq.${cleanPhone}`);

  const { data: customer, error: custErr } = await supabase
    .from('customers')
    .select('*')
    .or(orFilters.join(','))
    .maybeSingle();

  if (custErr) {
    throw new Error(`Failed to fetch customer: ${custErr.message}`);
  }

  if (!customer) {
    return null;
  }

  const { data: conversations } = await supabase
    .from('conversations')
    .select('id, mode, language, created_at, last_message_at')
    .eq('wa_user_id', customer.wa_user_id)
    .order('created_at', { ascending: false });

  const convIds = (conversations ?? []).map((c) => c.id);
  let messages: Array<{
    id: string;
    conversation_id: string;
    direction: string;
    sender: string;
    body: string | null;
    created_at: string;
  }> = [];

  if (convIds.length > 0) {
    const { data: msgRows } = await supabase
      .from('messages')
      .select('id, conversation_id, direction, sender, body, created_at')
      .in('conversation_id', convIds)
      .order('created_at', { ascending: true });
    messages = msgRows ?? [];
  }

  const { data: sales } = await supabase
    .from('customer_sales')
    .select('*')
    .eq('customer_id', customer.id)
    .order('sold_at', { ascending: false });

  return {
    customer,
    conversations: conversations ?? [],
    messages,
    sales: sales ?? [],
  };
}
