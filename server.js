// === server.js ===
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();
const { searchTours } = require('./searchToursTest');

const app = express();

// CORS
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// 🔹 Новый тестовый эндпоинт для изоляции searchTours
app.get('/test-search', async (req, res) => {
  const testPayload = {
    departure: 59,
    country: 4,
    datefrom: '20.05.2025',
    dateto: '25.05.2025',
    nightsfrom: 7,
    nightsto: 10,
    adults: 2,
    child: 0
  };

  try {
    const result = await searchTours(testPayload);
    process.stdout.write('\n📥 Результат из searchToursTest: ' + JSON.stringify(result) + '\n');
    res.json(result);
  } catch (err) {
    process.stdout.write('🔥 Ошибка в /test-search: ' + err.message + '\n');
    res.status(500).json({ error: err.message });
  }
});

// Порт по умолчанию (Render сам определяет его через process.env.PORT)
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  process.stdout.write(`\n✅ Сервер запущен на порту ${PORT}\n`);
});
