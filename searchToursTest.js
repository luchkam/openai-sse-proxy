const axios = require('axios');

const TOURVISOR_CONFIG = {
  authlogin: 'info@meridiantt.com',
  authpass: 'Mh4GdKPUtwZT',
  timeout: 20000,
  retries: 5
};

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTourvisorData(url, attempt = 1) {
  try {
    const response = await axios.get(url, {
      timeout: TOURVISOR_CONFIG.timeout,
      responseType: 'json',
    });

    if (!response.data) {
      throw new Error('Пустой ответ от Tourvisor');
    }

    return response.data;
  } catch (err) {
    if (attempt >= TOURVISOR_CONFIG.retries) {
      throw err;
    }
    await delay(2000);
    return fetchTourvisorData(url, attempt + 1);
  }
}

async function searchTours(params) {
  try {
    const formatDate = (dateStr) => {
      const [year, month, day] = dateStr.split('.');
      return `${day}.${month}.${year}`;
    };

    const queryParams = new URLSearchParams({
      authlogin: TOURVISOR_CONFIG.authlogin,
      authpass: TOURVISOR_CONFIG.authpass,
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

    const searchUrl = `http://tourvisor.ru/xml/search.php?${queryParams}`;
    const searchRes = await fetchTourvisorData(searchUrl);

    const requestId = searchRes?.result?.requestid;
    process.stdout.write(`\n📩 Получен requestid: ${requestId}\n`);

    if (!requestId) {
      throw new Error('Не удалось получить requestid');
    }

    // Ждем 3 секунды перед первой попыткой (рекомендация Tourvisor)
    await delay(3000);

    const resultUrl = `http://tourvisor.ru/xml/result.php?${new URLSearchParams({
      authlogin: TOURVISOR_CONFIG.authlogin,
      authpass: TOURVISOR_CONFIG.authpass,
      requestid: requestId,
      type: 'result',
      format: 'json',
      onpage: 5
    })}`;

    for (let i = 1; i <= 5; i++) {
      const result = await fetchTourvisorData(resultUrl);
      const state = result?.status?.state;
      const timepassed = result?.status?.timepassed;
      const found = result?.status?.hotelsfound;

      process.stdout.write(`⏱️ Попытка ${i}: state=${state}, timepassed=${timepassed}s, найдено отелей: ${found}\n`);

      if (state === 'finished') {
        const hotels = result?.result?.hotel || [];
        if (!hotels.length) {
          throw new Error('Нет результатов поиска');
        }
        process.stdout.write(`✅ Найдено отелей: ${hotels.length}\n`);
        return hotels;
      }

      await delay(2000);
    }

    throw new Error('Не удалось получить результат поиска за 12 секунд');
  } catch (err) {
    process.stdout.write(`🔥 Ошибка в searchToursTest: ${err.message}\n`);
    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  }
}

module.exports = searchTours;
