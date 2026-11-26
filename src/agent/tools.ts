import { sendWhatsAppText, sendWhatsAppDirectUtility } from '../whatsapp/client.js';
import { supabase } from '../db/supabase.js';
import { env } from '../config/env.js';

export async function searchProducts(params: {
  query: string;
  maxPrice?: number;
  limit?: number;
}) {
  const limit = Math.min(params.limit ?? 5, 10);
  const cleanQuery = params.query.trim();

  let dbQuery = supabase
    .from('products')
    .select(`
      id,
      handle,
      title,
      vendor,
      product_type,
      tags,
      description,
      url,
      price_min,
      price_max,
      currency,
      product_variants (
        id,
        title,
        sku,
        price,
        compare_at_price,
        inventory_tracked,
        inventory_levels (
          quantity,
          locations ( name, is_active )
        )
      )
    `)
    .eq('status', 'ACTIVE')
    .eq('is_published', true)
    .gt('price_min', 0)
    .limit(limit);

  if (cleanQuery) {
    const tokens = cleanQuery
      .split(/\s+/)
      .map((t) => t.replace(/[,()]/g, "").trim())
      .filter((t) => t.length >= 2);
    for (const token of tokens) {
      const pattern = `%${token}%`;
      dbQuery = dbQuery.or(
        `title.ilike.${pattern},vendor.ilike.${pattern},product_type.ilike.${pattern},description.ilike.${pattern}`
      );
    }
  }

  if (typeof params.maxPrice === 'number' && params.maxPrice > 0) {
    dbQuery = dbQuery.lte('price_min', params.maxPrice);
  }

  const { data, error } = await dbQuery;
  if (error) {
    return { error: `Database search error: ${error.message}` };
  }

  if (!data || data.length === 0) {
    return {
      found: 0,
      message: 'No active published products matched that query.',
      products: [],
    };
  }

  const formatted = data.map((p: any) => {
    const productUrl =
      p.url || `https://ctwtech.store/products/${p.handle}`;

    const variants = (p.product_variants ?? []).map((v: any) => {
      const stockByLocation = (v.inventory_levels ?? [])
        .filter((lvl: any) => lvl.locations?.is_active)
        .map((lvl: any) => ({
          location: lvl.locations.name,
          available: v.inventory_tracked ? lvl.quantity : 'untracked_confirm_in_store',
        }));

      return {
        variantTitle: v.title,
        sku: v.sku,
        price: v.price,
        compareAtPrice: v.compare_at_price,
        inventoryTracked: v.inventory_tracked,
        stockByLocation,
      };
    });

    return {
      title: p.title,
      brand: p.vendor,
      category: p.product_type,
      currency: p.currency || 'GYD',
      priceMin: p.price_min,
      priceMax: p.price_max,
      url: productUrl,
      summary: p.description ? p.description.slice(0, 280) : null,
      variants,
    };
  });

  return {
    found: formatted.length,
    products: formatted,
  };
}

export async function getStorePolicies(topic?: string) {
  let query = supabase.from('store_pages').select('handle, title, body');

  if (topic && topic.trim()) {
    const pattern = `%${topic.trim()}%`;
    query = query.or(`title.ilike.${pattern},handle.ilike.${pattern},body.ilike.${pattern}`);
  }

  const { data, error } = await query.limit(5);
  if (error) {
    return { error: `Policy lookup error: ${error.message}` };
  }

  const { data: settings } = await supabase
    .from('bot_settings')
    .select('key, value');

  return {
    settings: settings ?? [],
    pages: (data ?? []).map((page: any) => ({
      title: page.title,
      handle: page.handle,
      content: page.body ? page.body.slice(0, 1500) : '',
    })),
  };
}

export async function escalateToHuman(params: {
  conversationId: string;
  reason: string;
  customerSummary: string;
}) {
  console.log("🔔 [escalateToHuman] Triggered for:", params.conversationId);

  const { data: conv, error } = await supabase
    .from("conversations")
    .update({
      mode: "human",
      last_message_at: new Date().toISOString(),
    })
    .eq("id", params.conversationId)
    .select("*")
    .single();

  if (error) {
    console.error("❌ [escalateToHuman] Supabase error:", error.message);
    return { escalated: false, error: error.message };
  }

  const staffPhones = (process.env.STAFF_ALERT_PHONE || "")
    .split(",")
    .map((p) => p.replace(/[^0-9]/g, "").trim())
    .filter(Boolean);

  const customerPhone =
    conv?.wa_user_id ||
    conv?.phone_number ||
    conv?.phone ||
    conv?.wa_id ||
    conv?.whatsapp_number ||
    "unknown";
  const customerName =
    conv?.customer_name || conv?.profile_name || conv?.name || "Customer";

  if (staffPhones.length > 0) {
    const cleanCustomerPhone = String(customerPhone).replace(/[^0-9]/g, "");
    const alertText = [
      "🚨 *CTW Tech — Human Support Needed*",
      `*Customer:* ${customerName} (+${cleanCustomerPhone})`,
      `*Reason:* ${params.reason}`,
      `*Summary:* ${params.customerSummary}`,
      `*Open chat:* https://wa.me/${cleanCustomerPhone}`,
    ].join("\n");

    for (const staffPhone of staffPhones) {
      try {
        await sendWhatsAppDirectUtility(staffPhone, alertText);
        console.log(`✅ [escalateToHuman] Direct Send utility alert sent to ${staffPhone}`);
      } catch (directErr) {
        console.error(`⚠️ Direct Send failed for ${staffPhone}, trying standard text:`, directErr);
        try {
          await sendWhatsAppText(staffPhone, alertText);
          console.log(`✅ [escalateToHuman] Fallback text alert sent to ${staffPhone}`);
        } catch (notifyErr) {
          console.error(`⚠️ Failed to notify staff (${staffPhone}) via WhatsApp:`, notifyErr);
        }
      }
    }
  } else {
    console.warn("⚠️ STAFF_ALERT_PHONE is empty in .env");
  }

  return {
    escalated: true,
    notifiedStaff: staffPhones.length > 0,
    notifiedPhones: staffPhones,
    reason: params.reason,
    summary: params.customerSummary,
    storeDomain: env.SHOPIFY_STORE_DOMAIN,
  };
}
