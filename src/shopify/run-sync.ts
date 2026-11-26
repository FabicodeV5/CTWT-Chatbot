import { runFullSync } from './sync.js';

runFullSync()
  .then((summary) => {
    console.log('✅ Sync completed:', summary);
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Sync failed:', err);
    process.exit(1);
  });
