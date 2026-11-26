import { runPublicStoreSync } from './public-sync.js';

runPublicStoreSync()
  .then((summary) => {
    console.log('✅ Public storefront sync completed:', summary);
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Public storefront sync failed:', err);
    process.exit(1);
  });
