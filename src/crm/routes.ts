import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  getCustomerProfile,
  listCustomersOverview,
  normalizePhone,
  recordCustomerSale,
} from './customers.js';

export const crmRouter = Router();

const recordSaleSchema = z.object({
  phone: z.string().min(3, 'phone is required'),
  customerName: z.string().optional(),
  conversationId: z.string().uuid().optional(),
  productHandle: z.string().optional(),
  productQuery: z.string().optional(),
  productTitle: z.string().optional(),
  variantTitle: z.string().optional(),
  sku: z.string().optional(),
  productUrl: z.string().url().optional(),
  quantity: z.coerce.number().int().positive().default(1),
  unitPrice: z.coerce.number().nonnegative().optional(),
  totalAmount: z.coerce.number().nonnegative().optional(),
  currency: z.string().default('GYD'),
  soldAt: z.string().datetime().optional(),
  soldByType: z.enum(['bot', 'human']),
  soldByName: z.string().optional(),
  soldByPhone: z.string().optional(),
  source: z
    .enum(['whatsapp_bot', 'whatsapp_human', 'staff_command', 'manual_api', 'whatsapp'])
    .optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'refunded']).default('confirmed'),
  notes: z.string().optional(),
});

crmRouter.get('/customers', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const customers = await listCustomersOverview(Number.isFinite(limit) ? limit : 50);
    res.json({ count: customers.length, customers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

crmRouter.get('/customers/:phone', async (req: Request, res: Response) => {
  try {
    const phoneParam = String(req.params.phone || '');
    const profile = await getCustomerProfile(phoneParam);
    if (!profile) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }
    res.json(profile);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

crmRouter.post('/sales', async (req: Request, res: Response) => {
  const parsed = recordSaleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid sale payload',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const body = parsed.data;
    const cleanPhone = normalizePhone(body.phone) || body.phone.trim();
    const sale = await recordCustomerSale({
      waUserId: cleanPhone,
      customerName: body.customerName,
      conversationId: body.conversationId,
      productHandle: body.productHandle,
      productQuery: body.productQuery,
      productTitle: body.productTitle,
      variantTitle: body.variantTitle,
      sku: body.sku,
      productUrl: body.productUrl,
      quantity: body.quantity,
      unitPrice: body.unitPrice,
      totalAmount: body.totalAmount,
      currency: body.currency,
      soldAt: body.soldAt,
      soldByType: body.soldByType,
      soldByName: body.soldByName,
      soldByPhone: body.soldByPhone,
      source: body.source ?? 'manual_api',
      status: body.status,
      notes: body.notes,
    });

    res.status(201).json({ recorded: true, sale });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
