import express from 'express';
import { env } from './config/env.js';
import { supabase } from './db/supabase.js';
import { whatsappRouter } from './whatsapp/webhook.js';
import { crmRouter } from './crm/routes.js';

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  const { count, error } = await supabase
    .from('bot_settings')
    .select('*', { count: 'exact', head: true });

  if (error) {
    res.status(500).json({ status: 'error', message: error.message });
    return;
  }

  res.json({
    status: 'ok',
    service: 'ctw-whatsapp-bot',
    settingsLoaded: count ?? 0,
  });
});

app.use('/webhook/whatsapp', whatsappRouter);
app.use('/crm', crmRouter);

app.listen(env.PORT, () => {
  console.log(`🚀 CTW WhatsApp Bot listening on http://localhost:${env.PORT}`);
});