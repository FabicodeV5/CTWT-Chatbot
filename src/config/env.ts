import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  CRM_API_KEY: z.string().min(24, 'CRM_API_KEY must be at least 24 characters'),

  SHOPIFY_STORE_DOMAIN: z.string().min(1, 'SHOPIFY_STORE_DOMAIN is required'),
  SHOPIFY_API_VERSION: z.string().default('2026-01'),
  SHOPIFY_ADMIN_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_CLIENT_ID: z.string().optional(),
  SHOPIFY_CLIENT_SECRET: z.string().optional(),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),

  WHATSAPP_VERIFY_TOKEN: z.string().min(16, 'WHATSAPP_VERIFY_TOKEN must be at least 16 characters'),
  WHATSAPP_APP_SECRET: z.string().min(16).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
}).refine(
  (data) => Boolean(data.SHOPIFY_ADMIN_ACCESS_TOKEN || (data.SHOPIFY_CLIENT_ID && data.SHOPIFY_CLIENT_SECRET)),
  {
    message: 'Provide either SHOPIFY_ADMIN_ACCESS_TOKEN or both SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET',
    path: ['SHOPIFY_ADMIN_ACCESS_TOKEN'],
  }
);

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
