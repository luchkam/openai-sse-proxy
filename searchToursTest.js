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

  process.stdout.write('\n🔧 Отправляем параметры в Tourvisor:\n' + JSON.stringify(searchParams, null, 2) + '\n');

  try {
    // 1. Получаем requestid
    const { data } = await axios.get('https://tourvisor.ru/xml/search.php', {
      params: searchParams
    });

    process.stdout.write('\n📩 Ответ от Tourvisor (search.php):\n' + JSON.stringify(data, null, 2) + '\n');

    const requestid = data?.result?.requestid;
    if (!requestid) {
      process.stdout.write('\n❌ RequestID не получен\n');
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

      const status = res.data?.status;
      const result = res.data?.result;

      const state = status?.state;
      const hotelCount = result?.hotel?.length || 0;

      process.stdout.write(`\n⏱️ Попытка ${i + 1} — статус: ${state}, найдено отелей: ${hotelCount}\n`);

      if (state === 'finished' && hotelCount > 0) {
        return result.hotel.slice(0, 3); // топ-3 отеля
      }

      await new Promise((r) => setTimeout(r, 2000)); // Ждём 2 сек
    }

    return { error: 'Не удалось получить результат поиска за 12 секунд' };
  } catch (error) {
    process.stdout.write('\n💥 Ошибка в searchToursTest:\n' + error.message + '\n');
    return { error: error.message };
  }
}

module.exports = { searchToursTest };
