// === searchToursTest.js ===
const axios = require('axios');
require('dotenv').config();

const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
    authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
  },
  timeout: 20000,
  retries: 6,
  delay: 2000 // мс между попытками
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function searchTours(params) {
  try {
    const formatDate = (str) => {
      const [day, month, year] = str.split('.');
      return `${day}.${month}.${year}`;
    };

    const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams({
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
    })}`;

    const searchResponse = await axios.get(searchUrl, { timeout: TOURVISOR_CONFIG.timeout });
    const requestId = searchResponse.data?.result?.requestid;

    if (!requestId) {
      throw new Error('Не удалось получить requestid');
    }

    process.stdout.write(`\n📩 Получен requestid: ${requestId}\n`);

    // Повторные запросы к status/result
    for (let attempt = 1; attempt <= TOURVISOR_CONFIG.retries; attempt++) {
      await delay(TOURVISOR_CONFIG.delay);

      const resultUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
        ...TOURVISOR_CONFIG.auth,
        requestid: requestId,
        format: 'json',
        type: 'status'
      })}`;

      const resultResponse = await axios.get(resultUrl, { timeout: TOURVISOR_CONFIG.timeout });
      const result = resultResponse.data;
      const state = result?.data?.status?.state;
      const timepassed = result?.data?.status?.timepassed;

      process.stdout.write(`\n🔍 Ответ от Tourvisor (status): ${JSON.stringify(result)}\n`);
      process.stdout.write(`⏱️ Попытка ${attempt}: state=${state}, timepassed=${timepassed}s\n`);

      if (state === 'finished') {
        const dataUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
          ...TOURVISOR_CONFIG.auth,
          requestid: requestId,
          format: 'json',
          onpage: 5
        })}`;

        const dataResponse = await axios.get(dataUrl, { timeout: TOURVISOR_CONFIG.timeout });
        const hotels = dataResponse.data?.result?.hotel || [];

        if (!hotels.length) {
          throw new Error('Нет результатов поиска');
        }

        process.stdout.write(`✅ Найдено отелей: ${hotels.length}\n`);
        return hotels;
      }
    }

    throw new Error('Поиск не завершен за отведенное время');
  } catch (err) {
    process.stdout.write(`🔥 Ошибка в searchToursTest: ${err.message}\n`);
    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  }
}

module.exports = searchTours;
