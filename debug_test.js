// Copy pull function from converter/index.js
const pRetry = require('p-retry');

// Try different ways to define pull
const pull = pRetry(async (url, dest) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}, { retries: 3, minTimeout: 500 });

// Test if pull works
(async () => {
  try {
    console.log('Testing pull function:');
    await pull('http://example.com/test.jpg', 'test.jpg');
    console.log('Success!');
  } catch (e) {
    console.log('Error:', e.message);
  }
})();