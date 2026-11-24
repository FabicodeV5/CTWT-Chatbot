import express from 'express';
import { env } from './config/env.js';
import { supabase } from './db/supabase.js';

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .limit(5);

  if (error) {
    res.status(500).json({ status: 'error', db: error.message });
    return;
  }

  res.json({
    status: 'ok',
    service: 'ctw-whatsapp-bot',
    settingsLoaded: data?.length ?? 0,
  });
});

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}`);
});
