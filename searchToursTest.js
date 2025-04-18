const axios = require('axios');

async function searchToursTest(payload) {
  const {
    departure,
    country,
    datefrom,
    dateto,
    nightsfrom,
    nightsto,
    adults,
    child
  } = payload;

  const searchParams = {
    format: 'json',
    departure,
    country,
    datefrom,
    dateto,
    nightsfrom,
    nightsto,
    adults,
    child: child || 0,
    authlogin: 'info@meridiantt.com',
    authpass: 'Mh4GdKPUtwZT'
  };

  console.log('🔧 Параметры отправки в Tourvisor:', searchParams);

  try {
    // 1. Получаем requestid
    const { data } = await axios.get('https://tourvisor.ru/xml/search.php', {
      params: searchParams
    });

    console.log('📩 Ответ от Tourvisor (search.php):', JSON.stringify(data));

    const requestid = data.requestid;
    if (!requestid) {
      console.log('❌ RequestID отсутствует');
      throw new Error('Не получен requestid');
    }

    // 2. Ждём завершения поиска
    for (let i = 0; i < 6; i++) {
      const res = await axios.get('https://tourvisor.ru/xml/result.php', {
        params: {
          requestid,
          format: 'json',
          authlogin: searchParams.authlogin,
          authpass: searchParams.authpass
        }
      });

      if (
        res.data.status?.state === 'finished' &&
        res.data.result?.hotel?.length > 0
      ) {
        console.log('✅ Получено туров:', res.data.result.hotel.length);
        return res.data.result.hotel.slice(0, 3); // топ-3 отеля
      }

      console.log(`⏳ Попытка ${i + 1}: поиск не завершён...`);
      await new Promise((r) => setTimeout(r, 2000)); // Ждём 2 сек
    }

    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  } catch (error) {
    console.log('💥 Ошибка во время поиска:', error.message);
    return { error: error.message };
  }
}

module.exports = { searchToursTest };
