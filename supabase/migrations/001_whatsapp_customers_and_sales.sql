-- WhatsApp CRM: Customers, Conversation Activity, and Sales Tracking
-- Run this migration in the Supabase SQL Editor.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Customers table: one profile per WhatsApp user
CREATE TABLE IF NOT EXISTS public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_user_id text NOT NULL UNIQUE,
  phone_number text NOT NULL,
  customer_name text,
  preferred_language text NOT NULL DEFAULT 'en',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_message_text text,
  last_message_at timestamptz,
  total_messages integer NOT NULL DEFAULT 0,
  last_handled_by text NOT NULL DEFAULT 'bot' CHECK (last_handled_by IN ('bot', 'human')),
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_phone_number ON public.customers (phone_number);
CREATE INDEX IF NOT EXISTS idx_customers_last_seen_at ON public.customers (last_seen_at DESC);

-- 2. Customer sales / orders compiled from WhatsApp (bot or human advisor)
CREATE TABLE IF NOT EXISTS public.customer_sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  wa_user_id text NOT NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  product_id uuid REFERENCES public.products(id) ON DELETE SET NULL,
  variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,
  product_title text NOT NULL,
  variant_title text,
  sku text,
  product_url text,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(12, 2),
  total_amount numeric(12, 2),
  currency text NOT NULL DEFAULT 'GYD',
  sold_at timestamptz NOT NULL DEFAULT now(),
  sold_by_type text NOT NULL CHECK (sold_by_type IN ('bot', 'human')),
  sold_by_name text NOT NULL DEFAULT 'CTW WhatsApp Bot',
  sold_by_phone text,
  source text NOT NULL DEFAULT 'whatsapp' CHECK (source IN ('whatsapp_bot', 'whatsapp_human', 'staff_command', 'manual_api', 'whatsapp')),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'refunded')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_sales_customer_id ON public.customer_sales (customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_sales_wa_user_id ON public.customer_sales (wa_user_id);
CREATE INDEX IF NOT EXISTS idx_customer_sales_sold_at ON public.customer_sales (sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_sales_sold_by_type ON public.customer_sales (sold_by_type);
CREATE INDEX IF NOT EXISTS idx_customer_sales_status ON public.customer_sales (status);

-- 3. Automatic updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customers_updated_at ON public.customers;
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_customer_sales_updated_at ON public.customer_sales;
CREATE TRIGGER trg_customer_sales_updated_at
  BEFORE UPDATE ON public.customer_sales
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- 4. Row Level Security (service_role only, matching existing tables)
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_customers" ON public.customers;
CREATE POLICY "service_role_all_customers"
  ON public.customers
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "service_role_all_customer_sales" ON public.customer_sales;
CREATE POLICY "service_role_all_customer_sales"
  ON public.customer_sales
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 5. Backfill existing WhatsApp conversations & messages into customers
INSERT INTO public.customers (
  wa_user_id,
  phone_number,
  customer_name,
  preferred_language,
  first_seen_at,
  last_seen_at,
  last_message_text,
  last_message_at,
  total_messages,
  last_handled_by
)
SELECT
  c.wa_user_id,
  regexp_replace(c.wa_user_id, '[^0-9]', '', 'g') AS phone_number,
  MAX(c.customer_name) AS customer_name,
  COALESCE(MAX(c.language), 'en') AS preferred_language,
  MIN(c.created_at) AS first_seen_at,
  MAX(c.last_message_at) AS last_seen_at,
  (
    SELECT m.body
    FROM public.messages m
    JOIN public.conversations c2 ON c2.id = m.conversation_id
    WHERE c2.wa_user_id = c.wa_user_id AND m.sender = 'customer'
    ORDER BY m.created_at DESC
    LIMIT 1
  ) AS last_message_text,
  (
    SELECT MAX(m.created_at)
    FROM public.messages m
    JOIN public.conversations c2 ON c2.id = m.conversation_id
    WHERE c2.wa_user_id = c.wa_user_id AND m.sender = 'customer'
  ) AS last_message_at,
  (
    SELECT COUNT(*)::integer
    FROM public.messages m
    JOIN public.conversations c2 ON c2.id = m.conversation_id
    WHERE c2.wa_user_id = c.wa_user_id
  ) AS total_messages,
  CASE
    WHEN BOOL_OR(c.mode = 'human') THEN 'human'
    ELSE 'bot'
  END AS last_handled_by
FROM public.conversations c
GROUP BY c.wa_user_id
ON CONFLICT (wa_user_id) DO UPDATE SET
  customer_name = COALESCE(EXCLUDED.customer_name, public.customers.customer_name),
  last_seen_at = GREATEST(public.customers.last_seen_at, EXCLUDED.last_seen_at),
  last_message_text = COALESCE(EXCLUDED.last_message_text, public.customers.last_message_text),
  last_message_at = COALESCE(EXCLUDED.last_message_at, public.customers.last_message_at),
  total_messages = GREATEST(public.customers.total_messages, EXCLUDED.total_messages),
  last_handled_by = EXCLUDED.last_handled_by;

-- 6. Unified CRM reporting view: what each customer wrote, bought, when, and who sold it
CREATE OR REPLACE VIEW public.customer_crm_overview AS
SELECT
  cu.id AS customer_id,
  cu.wa_user_id,
  cu.phone_number,
  cu.customer_name,
  cu.preferred_language,
  cu.first_seen_at,
  cu.last_seen_at,
  cu.last_message_text,
  cu.last_message_at,
  cu.total_messages,
  cu.last_handled_by,
  COALESCE(sales_agg.total_orders, 0) AS total_orders,
  COALESCE(sales_agg.total_spent_gyd, 0) AS total_spent_gyd,
  sales_agg.last_purchase_at,
  sales_agg.last_sold_by_type,
  sales_agg.last_sold_by_name,
  COALESCE(sales_agg.purchases, '[]'::jsonb) AS purchases
FROM public.customers cu
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE cs.status IN ('pending', 'confirmed'))::integer AS total_orders,
    COALESCE(SUM(cs.total_amount) FILTER (WHERE cs.status IN ('pending', 'confirmed')), 0)::numeric(12, 2) AS total_spent_gyd,
    MAX(cs.sold_at) AS last_purchase_at,
    (
      SELECT cs2.sold_by_type
      FROM public.customer_sales cs2
      WHERE cs2.customer_id = cu.id
      ORDER BY cs2.sold_at DESC
      LIMIT 1
    ) AS last_sold_by_type,
    (
      SELECT cs2.sold_by_name
      FROM public.customer_sales cs2
      WHERE cs2.customer_id = cu.id
      ORDER BY cs2.sold_at DESC
      LIMIT 1
    ) AS last_sold_by_name,
    jsonb_agg(
      jsonb_build_object(
        'saleId', cs.id,
        'productTitle', cs.product_title,
        'variantTitle', cs.variant_title,
        'quantity', cs.quantity,
        'totalAmount', cs.total_amount,
        'currency', cs.currency,
        'soldAt', cs.sold_at,
        'soldByType', cs.sold_by_type,
        'soldByName', cs.sold_by_name,
        'status', cs.status
      )
      ORDER BY cs.sold_at DESC
    ) AS purchases
  FROM public.customer_sales cs
  WHERE cs.customer_id = cu.id
) sales_agg ON true;
