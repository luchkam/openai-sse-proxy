// === searchToursTest.js ===
const axios = require('axios');
require('dotenv').config();

const TOURVISOR_CONFIG = {
  auth: {
    authlogin: process.env.TOURVISOR_LOGIN || 'info@meridiantt.com',
    authpass: process.env.TOURVISOR_PASS || 'Mh4GdKPUtwZT'
  },
  timeout: 15000,
  retries: 6
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTourvisorData(url, attempt = 1) {
  try {
    const response = await axios.get(url, {
      timeout: TOURVISOR_CONFIG.timeout,
      responseType: 'json'
    });

    if (!response.data) throw new Error('Пустой ответ от Tourvisor');
    return response.data;
  } catch (err) {
    if (attempt >= TOURVISOR_CONFIG.retries) throw err;
    await wait(2000 * attempt);
    return fetchTourvisorData(url, attempt + 1);
  }
}

async function searchTours(params) {
  try {
    const formatDate = (str) => str.split('.').reverse().join('-');

    const searchUrl = `http://tourvisor.ru/xml/search.php?${new URLSearchParams({
      ...TOURVISOR_CONFIG.auth,
      departure: params.departure,
      country: params.country,
      datefrom: params.datefrom,
      dateto: params.dateto,
      nightsfrom: params.nightsfrom || 7,
      nightsto: params.nightsto || 10,
      adults: params.adults || 2,
      child: params.child || 0,
      format: 'json'
    })}`;

    const searchResp = await fetchTourvisorData(searchUrl);
    const requestId = searchResp?.result?.requestid;
    process.stdout.write(`\n📩 Получен requestid: ${requestId}\n`);

    if (!requestId) throw new Error('Не удалось получить requestid');

    let status = null;
    let timepassed = null;
    let resultData = null;

    for (let i = 1; i <= 6; i++) {
      await wait(2000);

      const statusUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
        ...TOURVISOR_CONFIG.auth,
        requestid: requestId,
        type: 'status',
        format: 'json'
      })}`;

      const statusResp = await fetchTourvisorData(statusUrl);
      process.stdout.write(`\n🔍 Ответ от Tourvisor (status): ${JSON.stringify(statusResp)}\n`);

      status = statusResp?.status?.state;
      timepassed = statusResp?.status?.timepassed;
      process.stdout.write(`⏱️ Попытка ${i}: state=${status}, timepassed=${timepassed}s\n`);

      if (status === 'finished') {
        const resultUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
          ...TOURVISOR_CONFIG.auth,
          requestid: requestId,
          format: 'json',
          onpage: 50
        })}`;
        resultData = await fetchTourvisorData(resultUrl);
        break;
      }
    }

    if (!resultData || !resultData.result || !resultData.result.hotel) {
      throw new Error('Поиск не завершен за отведенное время');
    }

    const hotels = resultData.result.hotel;
    process.stdout.write(`✅ Найдено отелей: ${hotels.length}\n`);
    return hotels;

  } catch (err) {
    process.stdout.write(`🔥 Ошибка в searchToursTest: ${err.message}\n`);
    return { error: err.message };
  }
}

module.exports = searchTours;
