const axios = require('axios');
require('dotenv').config();

const TOURVISOR_AUTH = {
  authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
  authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT',
};

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchTours(params) {
  const baseParams = {
    ...TOURVISOR_AUTH,
    departure: params.departure,
    country: params.country,
    datefrom: params.datefrom,
    dateto: params.dateto,
    nightsfrom: params.nightsfrom,
    nightsto: params.nightsto,
    adults: params.adults,
    child: params.child,
    format: 'json'
  };

  // 1. Получаем requestid
  const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams(baseParams)}`;
  const searchResponse = await axios.get(searchUrl);
  const requestId = searchResponse.data?.result?.requestid;

  process.stdout.write(`📨 Получен requestid: ${requestId}\n`);
  if (!requestId) throw new Error('Не удалось получить requestid');

  // 2. Периодически проверяем статус поиска
  const resultParams = new URLSearchParams({
    ...TOURVISOR_AUTH,
    requestid: requestId,
    format: 'json',
    type: 'status',
  });

  let status = {};
  const maxAttempts = 6;
  let attempt = 0;

  while (attempt < maxAttempts) {
    const statusRes = await axios.get(`http://tourvisor.ru/xml/result.php?${resultParams}`);
    status = statusRes.data?.status;

    process.stdout.write(`⏱️ Попытка ${attempt + 1}: state=${status?.state}, timepassed=${status?.timepassed}s\n`);

    if (status?.state === 'finished') break;

    await delay(2000);
    attempt++;
  }

  if (status?.state !== 'finished') {
    throw new Error('Поиск не завершен за отведенное время');
  }

  // 3. Получаем результаты (минимум, 5 отелей)
  const finalParams = new URLSearchParams({
    ...TOURVISOR_AUTH,
    requestid: requestId,
    format: 'json',
    type: 'result',
    onpage: 5,
    page: 1,
  });

  const resultResponse = await axios.get(`http://tourvisor.ru/xml/result.php?${finalParams}`);
  const hotels = resultResponse.data?.result?.hotel;

  if (!hotels || hotels.length === 0) {
    throw new Error('Нет результатов поиска');
  }

  process.stdout.write(`✅ Найдено отелей: ${hotels.length}\n`);
  return hotels;
}

module.exports = searchTours;
