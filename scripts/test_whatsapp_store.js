const ws = require('../services/whatsapp');
const db = require('../services/db');

async function inspectStore() {
  await db.init();
  const session = ws.getSessionMap().get('tenant_rkv_busy_gmail__8d0dcc');
  if (!session || !session.client || !session.client.pupPage) {
    console.error('Session or pupPage not available for tenant_rkv_busy_gmail__8d0dcc');
    process.exit(1);
  }

  console.log('Inspecting window.Store keys in Puppeteer...');
  const keys = await session.client.pupPage.evaluate(() => {
    if (!window.Store) return 'window.Store is undefined';
    return Object.keys(window.Store);
  });
  console.log('Store keys:', keys);

  const chatInfo = await session.client.pupPage.evaluate(() => {
    if (!window.Store || !window.Store.Chat) return 'window.Store.Chat is undefined';
    const models = window.Store.Chat.models || window.Store.Chat._models || [];
    return {
      modelsLength: models.length,
      sample: models.slice(0, 3).map(c => ({
        id: c.id ? c.id._serialized : null,
        name: c.name || c.formattedTitle || c.header || c.pushname,
        snippet: c.snippet || c.lastMsgSnippet
      }))
    };
  });

  console.log('Chat Info:', chatInfo);
  process.exit(0);
}

inspectStore().catch(e => { console.error(e); process.exit(1); });
