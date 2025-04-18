const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Увеличиваем лимиты для обработки больших JSON
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Настройка CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Конфигурация Tourvisor
const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
    authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
  },
  timeout: 20000,
  retries: 3
};

const activeRequests = new Set();

app.get('/new-thread', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'OpenAI-Beta': 'assistants=v2',
        },
        timeout: 5000
      }
    );
    res.json({ thread_id: response.data.id });
  } catch (err) {
    console.error('Ошибка при создании треда:', err.message);
    res.status(500).json({ error: 'Не удалось создать thread_id' });
  }
});

const { searchTours } = require('./searchToursTest');

app.get('/test-search', async (req, res) => {
  const payload = {
    departure: 59,
    country: 4,
    datefrom: '20.05.2025',
    dateto: '25.05.2025',
    nightsfrom: 7,
    nightsto: 10,
    adults: 2,
    child: 0
  };

  process.stdout.write('📤 Тестовый payload: ' + JSON.stringify(payload, null, 2) + '\n');

  const result = await searchTours(payload);
  process.stdout.write('📥 Результат из searchToursTest: ' + JSON.stringify(result, null, 2) + '\n');

  res.json(result);
});
