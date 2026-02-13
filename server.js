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

// Прокси к getuid.live: один запрос на один ID аккаунта
// Ответ {"uid":null} — аккаунт заблокирован, иначе — валиден
app.get('/api/get_uid/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const url = 'https://getuid.live/get_uid/' + encodeURIComponent(id);
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    const text = await response.text();
    res.status(response.status).set('Content-Type', 'application/json').send(text);
  } catch (error) {
    res.status(500).json({ error: 'Proxy request failed', details: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


