// === searchToursTest.js ===

const axios = require('axios');
require('dotenv').config();

const TOURVISOR_AUTH = {
  authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
  authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function searchTours(params) {
  const formatDate = (str) => str.split('-').reverse().join('.');
  const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams({
    ...TOURVISOR_AUTH,
    departure: params.departure,
    country: params.country,
    datefrom: formatDate(params.datefrom),
    dateto: formatDate(params.dateto),
    nightsfrom: params.nightsfrom || 7,
    nightsto: params.nightsto || 10,
    adults: params.adults || 2,
    child: params.child || 0,
    format: 'json'
  })}`;

  try {
    const start = Date.now();
    const searchRes = await axios.get(searchUrl);
    const requestid = searchRes.data?.result?.requestid;
    if (!requestid) throw new Error('RequestID не получен');
    process.stdout.write(`📩 Получен requestid: ${requestid}\n`);

    const statusUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
      ...TOURVISOR_AUTH,
      requestid,
      type: 'status',
      format: 'json'
    })}`;

    let state = 'searching';
    let timepassed = 0;
    let attempts = 0;

    while (state !== 'finished' && timepassed < 12) {
      const statusRes = await axios.get(statusUrl);
      state = statusRes.data?.status?.state;
      timepassed = Number(statusRes.data?.status?.timepassed);
      attempts++;
      process.stdout.write(`⏱️ Попытка ${attempts}: state=${state}, timepassed=${timepassed}s\n`);
      if (state === 'finished' || timepassed > 7) break;
      await sleep(2000);
    }

    const resultUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
      ...TOURVISOR_AUTH,
      requestid,
      format: 'json',
      onpage: 5
    })}`;

    const resultRes = await axios.get(resultUrl);
    const result = resultRes.data?.result?.hotel;

    if (!result || result.length === 0) {
      throw new Error('Нет результатов поиска');
    }

    process.stdout.write(`✅ Найдено отелей: ${result.length}\n`);
    return result;
  } catch (err) {
    process.stdout.write(`🔥 Ошибка в searchToursTest: ${err.message}\n`);
    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  }
}

module.exports = searchTours;
