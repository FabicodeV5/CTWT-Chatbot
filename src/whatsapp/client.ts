import { env } from '../config/env.js';

export async function sendWhatsAppText(to: string, body: string) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`📤 [DRY-RUN WhatsApp -> ${to}]:\n${body}\n`);
    return { dryRun: true };
  }

  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: true, body },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp Cloud API error (${res.status}): ${errText}`);
  }

  return res.json();
}

function sanitizeTemplateParam(value: string): string {
  // Meta rechaza parámetros de plantilla con saltos de línea, tabs o más de 4 espacios seguidos
  const cleaned = String(value ?? '-')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 900);
  return cleaned || '-';
}

export async function sendWhatsAppTemplate(params: {
  to: string;
  templateName: string;
  languageCode?: string;
  bodyVariables: string[];
}) {
  if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log(`📤 [DRY-RUN Template ${params.templateName} -> ${params.to}]:`, params.bodyVariables);
    return { dryRun: true };
  }

  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: params.to,
      type: 'template',
      template: {
        name: params.templateName,
        language: { code: params.languageCode || 'en_US' },
        components: [
          {
            type: 'body',
            parameters: params.bodyVariables.map((v) => ({
              type: 'text',
              text: sanitizeTemplateParam(v),
            })),
          },
        ],
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WhatsApp Template API error (${res.status}): ${errText}`);
  }

  return res.json();
}
