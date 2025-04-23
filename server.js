const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// CORS
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

// Конфигурация Tourvisor API
const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
    authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
  },
  timeout: 15000,
  retries: 6
};

// Функция для получения данных из Tourvisor API
async function fetchTourvisorData(url, attempt = 1) {
  try {
    const res = await axios.get(url, { timeout: TOURVISOR_CONFIG.timeout });
    return res.data;
  } catch (err) {
    if (attempt >= TOURVISOR_CONFIG.retries) throw err;
    await delay(2000);
    return fetchTourvisorData(url, attempt + 1);
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchTours(params) {
  const formatDate = (dateStr) => {
    const [day, month, year] = dateStr.split('.');
    return `${day}.${month}.${year}`;
  };

  const searchParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    departure: params.departure,
    country: params.country,
    datefrom: formatDate(params.datefrom),
    dateto: formatDate(params.dateto),
    nightsfrom: params.nightsfrom,
    nightsto: params.nightsto,
    adults: params.adults,
    child: params.child,
    format: 'json'
  });

  const searchUrl = `http://tourvisor.ru/xml/search.php?${searchParams}`;
  const searchData = await fetchTourvisorData(searchUrl);
  const requestId = searchData?.result?.requestid;
  if (!requestId) throw new Error('Не удалось получить requestid');

  const resultParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    requestid: requestId,
    format: 'json',
    type: 'status',
    operatorstatus: 1
  });

  const resultUrl = `http://tourvisor.ru/xml/result.php?${resultParams}`;
  let status;

  while (status?.state !== 'finished') {
    await delay(2000);
    const result = await fetchTourvisorData(resultUrl);
    status = result?.data?.status;

    if (status?.state !== 'finished') continue;
    break;
  }

  const finalResultParams = new URLSearchParams({
    ...TOURVISOR_CONFIG.auth,
    requestid: requestId,
    format: 'json',
    type: 'result',
    onpage: 5
  });

  const finalUrl = `http://tourvisor.ru/xml/result.php?${finalResultParams}`;
  const finalData = await fetchTourvisorData(finalUrl);
  const result = finalData?.data?.result?.hotel;

  if (!result || result.length === 0) {
    throw new Error('Нет результатов поиска');
  }

  return result;
}

// Эндпоинт для обработки поиска туров
app.post('/search-tours', async (req, res) => {
  const { country, datefrom, dateto, adults, child } = req.body;

  try {
    // Отправляем данные в Tourvisor API для поиска
    const searchData = {
      departure: 59, // Примерная информация для теста
      country: country,
      datefrom: datefrom,
      dateto: dateto,
      nightsfrom: 7,
      nightsto: 10,
      adults: adults,
      child: child,
    };

    const result = await searchTours(searchData); // Вызов функции поиска
    res.json(result); // Отправляем результат обратно в чат
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Порт по умолчанию
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
