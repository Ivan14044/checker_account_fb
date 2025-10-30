import express from 'express';
import fetch from 'node-fetch';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple health check / wake-up
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

// Proxy endpoint to avoid CORS issues from the browser
app.post('/api/check/account', async (req, res) => {
  try {
    const body = req.body;
    const response = await fetch('https://check.fb.tools/api/check/account', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    res.status(response.status).send(text);
  } catch (error) {
    res.status(500).json({ error: 'Proxy request failed', details: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


