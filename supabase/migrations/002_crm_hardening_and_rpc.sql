-- 002_crm_hardening_and_rpc.sql
-- Adds atomic message counter RPC and supporting CRM/history indexes.

CREATE OR REPLACE FUNCTION public.increment_customer_messages(
  p_customer_id uuid,
  p_last_seen_at timestamptz,
  p_last_message_text text DEFAULT NULL,
  p_last_message_at timestamptz DEFAULT NULL,
  p_last_handled_by text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.customers
  SET
    total_messages = COALESCE(total_messages, 0) + 1,
    last_seen_at = p_last_seen_at,
    last_message_text = COALESCE(p_last_message_text, last_message_text),
    last_message_at = COALESCE(p_last_message_at, last_message_at),
    last_handled_by = COALESCE(p_last_handled_by, last_handled_by)
  WHERE id = p_customer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_customer_messages(uuid, timestamptz, text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.increment_customer_messages(uuid, timestamptz, text, timestamptz, text) TO service_role;

CREATE INDEX IF NOT EXISTS idx_customer_sales_customer_sold_at
  ON public.customer_sales (customer_id, sold_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_sales_customer_status
  ON public.customer_sales (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created_at
  ON public.messages (conversation_id, created_at DESC);
