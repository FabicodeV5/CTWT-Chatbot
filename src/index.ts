import crypto from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { env } from './config/env.js';
import { supabase } from './db/supabase.js';
import { whatsappRouter } from './whatsapp/webhook.js';
import { crmRouter } from './crm/routes.js';

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

function requireCrmAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  const a = Buffer.from(token);
  const b = Buffer.from(env.CRM_API_KEY);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

app.get('/health', async (_req, res) => {
  const { count, error } = await supabase
    .from('bot_settings')
    .select('*', { count: 'exact', head: true });

  if (error) {
    console.error('❌ [/health] Supabase error:', error.message);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
    return;
  }

  res.json({
    status: 'ok',
    service: 'ctw-whatsapp-bot',
    settingsLoaded: count ?? 0,
  });
});

app.use('/webhook/whatsapp', whatsappRouter);
app.use('/crm', requireCrmAuth, crmRouter);

app.listen(env.PORT, () => {
  console.log(`🚀 CTW WhatsApp Bot listening on http://localhost:${env.PORT}`);
});
