function validateBanReason(ban, rulesDatabase) {
  const result = {
    is_valid: true,
    is_suspicious: false,
    messages: []
  };

  // Нормализация причины бана (убираем лишние пробелы)
  let normalizedReason = ban.reason.trim();

  // Убираем /by формат — валидируем саму причину, а не пропускаем
  const byMatch = normalizedReason.match(/^(.+?)\s*\/by\s+(STEAM:[01]:\d+:\d+|[^\s]+)/i);
  if (byMatch) {
    normalizedReason = byMatch[1].trim();
    if (!normalizedReason) return result;
  }

  // Проверка на стэк правил - поддержка форматов:
  // 1.1+1.8, 1.1 + 1.8, NonRP+Leave, NonRP + Leave, 1.9x2
  // Пробелы НЕ являются разделителем стэка (иначе "1.1 NonRP" = стэк двух правил)
  const hasMultiplier = /x\d+/i.test(normalizedReason);
  const hasPlus = /\+/.test(normalizedReason);

  if (hasPlus || hasMultiplier) {
    // Разбиваем только по +
    const rules = normalizedReason.split(/\+/).map(r => r.trim()).filter(r => r);

    let allRulesValid = true;
    const foundRules = [];
    const invalidRules = [];

    rules.forEach(ruleCode => {
      // Проверяем множитель (1.9x2)
      const multiplierMatch = ruleCode.match(/^(.+?)x(\d+)$/i);
      let actualCode = ruleCode;
      let multiplier = 1;

      if (multiplierMatch) {
        actualCode = multiplierMatch[1];
        multiplier = parseInt(multiplierMatch[2]);
      }

      // Ищем правило по коду или вариантам
      const rule = findRuleByCodeOrVariant(actualCode, rulesDatabase);

      if (rule) {
        // stackable: false означает, что правило НЕЛЬЗЯ УМНОЖАТЬ (x2, x3)
        // но МОЖНО комбинировать с другими правилами
        // stackable: true означает, что правило МОЖНО УМНОЖАТЬ и комбинировать

        // Проверяем, можно ли использовать множитель для этого правила
        if (!rule.stackable && multiplier > 1) {
          result.is_suspicious = true;
          result.messages.push({
            type: "NON_STACKABLE",
            message: ` Правило ${rule.code} не стакается - его нельзя выдавать несколько раз (x${multiplier})`,
            suggestion: `Правило ${rule.code} выдается только один раз, независимо от количества нарушений`,
            admin_info: {
              steamId: ban.adminSteamId,
              name: ban.adminName
            },
            ban_info: {
              target: `${ban.targetName} (${ban.targetSteamId})`,
              date: new Date(ban.banTime * 1000).toLocaleString('ru-RU')
            }
          });
        }

        // Проверяем максимальное количество стаков для правила (например, 1.5 стакается до 2х)
        if (rule.max_stack && multiplier > rule.max_stack) {
          result.is_suspicious = true;
          result.messages.push({
            type: "OVER_STACK",
            message: ` Правило ${rule.code} можно стакать максимум ${rule.max_stack} раза, а указано x${multiplier}`,
            suggestion: `Максимум для ${rule.code}: x${rule.max_stack}`,
            admin_info: {
              steamId: ban.adminSteamId,
              name: ban.adminName
            },
            ban_info: {
              target: `${ban.targetName} (${ban.targetSteamId})`,
              date: new Date(ban.banTime * 1000).toLocaleString('ru-RU')
            }
          });
        }

        foundRules.push({ rule, multiplier });
      } else {
        allRulesValid = false;
        invalidRules.push(actualCode);
      }
    });

    if (!allRulesValid) {
      result.is_valid = false;
      result.messages.push({
        type: "INVALID_REASON",
        message: ` Причина содержит несуществующие правила: "${invalidRules.join(', ')}"`,
        suggestion: "Чет залупа какая-то, дай пизды ему.",
        admin_info: {
          steamId: ban.adminSteamId,
          name: ban.adminName
        },
        ban_info: {
          target: `${ban.targetName} (${ban.targetSteamId})`,
          date: new Date(ban.banTime * 1000).toLocaleString('ru-RU')
        }
      });
    } else if (foundRules.length > 0) {
      // Генерируем все возможные комбинации времени для стака
      const possibleTimes = calculateAllPossibleStackTimes(foundRules);
      const actualBanSeconds = ban.banLen;

      // Проверяем, совпадает ли фактическое время с одной из возможных комбинаций
      if (!possibleTimes.includes(actualBanSeconds)) {
        const expectedTimesStr = possibleTimes.map(s => formatSeconds(s)).join(' или ');
        const actualTime = calculateBanLength(actualBanSeconds);

        result.is_suspicious = true;
        result.messages.push({
          type: "SUSPICIOUS_TIME",
          message: ` Сумма этих правил "${ban.reason}" должена давать ${expectedTimesStr}, а выдано ${actualTime}`,
          suggestion: `Возможные варианты времени: ${expectedTimesStr}`,
          admin_info: {
            steamId: ban.adminSteamId,
            name: ban.adminName
          },
          ban_info: {
            target: `${ban.targetName} (${ban.targetSteamId})`,
            date: new Date(ban.banTime * 1000).toLocaleString('ru-RU')
          }
        });
      }
    }

    return result;
  }

  // Проверка 1: Существует ли правило (по коду или варианту)
  const foundRule = findRuleByCodeOrVariant(normalizedReason, rulesDatabase);

  if (!foundRule) {
    // Проверка на похожие правила (опечатки)
    const similarRule = findSimilarRule(normalizedReason, rulesDatabase);

    if (similarRule) {
      result.is_valid = false;
      result.messages.push({
        type: "INVALID_REASON",
        message: ` Несуществующая причина бана: "${ban.reason}"`,
        suggestion: `Возможно имелось в виду: ${similarRule.code} (${similarRule.variants.slice(0, 3).join(', ')})`,
        admin_info: {
          steamId: ban.adminSteamId,
          name: ban.adminName
        },
        ban_info: {
          target: `${ban.targetName} (${ban.targetSteamId})`,
          date: new Date(ban.banTime * 1000).toLocaleString('ru-RU')
        }
      });
    } else {
      result.is_valid = false;
      result.messages.push({
        type: "UNKNOWN_REASON",
        message: ` Неизвестная причина бана: "${ban.reason}"`,
        suggestion: "Кароче хуйня эта причина, дай пизды ему.",
        admin_info: {
          steamId: ban.adminSteamId,
          name: ban.adminName
        },
        ban_info: {
          target: `${ban.targetName} (${ban.targetSteamId})`,
          date: new Date(ban.banTime * 1000).toLocaleString('ru-RU')
        }
      });
    }
  } else {
    // Проверка 2: Правильное ли время бана
    const suspiciousCheck = checkSuspiciousBanTime(ban, rulesDatabase, foundRule);
    if (suspiciousCheck.is_suspicious) {
      result.is_suspicious = true;
      result.messages.push({
        type: "SUSPICIOUS_TIME",
        message: suspiciousCheck.message,
        suggestion: suspiciousCheck.suggestion,
        admin_info: suspiciousCheck.admin_info,
        ban_info: {
          target: `${ban.targetName} (${ban.targetSteamId})`,
          date: new Date(ban.banTime * 1000).toLocaleString('ru-RU')
        }
      });
    }
  }

  return result;
}

// Функция для расчета всех возможных комбинаций времени при стаке правил
function calculateAllPossibleStackTimes(foundRules) {
  // Если любое правило в стэке = perma, весь стэк = perma
  for (const { rule } of foundRules) {
    const times = Array.isArray(rule.ban_time) ? rule.ban_time : [rule.ban_time];
    if (times.includes('perma')) return [0];
  }

  let possibleTimes = [0];

  // Для каждого правила в стаке
  foundRules.forEach(({ rule, multiplier }) => {
    const newPossibleTimes = [];

    // Получаем все возможные времена для этого правила
    let ruleTimes = [];
    if (Array.isArray(rule.ban_time)) {
      // Если ban_time - массив, берем все варианты
      ruleTimes = rule.ban_time.map(t => parseTimeToSeconds(t));
    } else {
      // Если ban_time - строка, берем одно значение
      ruleTimes = [parseTimeToSeconds(rule.ban_time)];
    }

    // Для каждого текущего возможного времени
    possibleTimes.forEach(currentTime => {
      // Для каждого варианта времени правила
      ruleTimes.forEach(ruleTime => {
        // Добавляем время правила с учетом множителя
        newPossibleTimes.push(currentTime + (ruleTime * multiplier));
      });
    });

    possibleTimes = newPossibleTimes;
  });

  return possibleTimes;
}

// Новая функция для поиска правила по коду или варианту
function findRuleByCodeOrVariant(searchTerm, rulesDatabase) {
  const normalized = searchTerm.toLowerCase().trim();

  return rulesDatabase.rules.find(rule => {
    // Проверяем код правила
    if (rule.code.toLowerCase() === normalized) {
      return true;
    }

    // Проверяем варианты
    return rule.variants.some(variant =>
      variant.toLowerCase() === normalized
    );
  });
}

function checkSuspiciousBanTime(ban, rulesDatabase, foundRule) {
  const actualBanSeconds = ban.banLen;
  const expectedTime = foundRule.ban_time;

  // Проверяем, является ли ban_time массивом вариантов (например, ["1d", "1w", "7d"])
  if (Array.isArray(expectedTime)) {
    // Конвертируем все варианты в секунды
    const validSeconds = expectedTime.map(t => parseTimeToSeconds(t));

    // Проверяем, совпадает ли время бана с одним из вариантов
    if (validSeconds.includes(actualBanSeconds)) {
      return { is_suspicious: false };
    }

    const actualBanLength = calculateBanLength(actualBanSeconds);
    const expectedOptions = expectedTime.join(' или ');
    return {
      is_suspicious: true,
      message: ` Подозрительный бан: правило ${foundRule.code} должно давать ${expectedOptions}, а выдано ${actualBanLength}`,
      suggestion: `Правильное время для ${foundRule.code}: ${expectedOptions}`,
      admin_info: {
        steamId: ban.adminSteamId,
        name: ban.adminName
      }
    };
  }

  // Обычная проверка для точного времени (строка)
  const expectedSeconds = parseTimeToSeconds(expectedTime);

  // Сравниваем время в секундах - форматы эквивалентны если секунды совпадают
  // Например: 1w = 7d = 604800 секунд, 1h = 60mi = 3600 секунд
  if (actualBanSeconds !== expectedSeconds) {
    const actualBanLength = calculateBanLength(actualBanSeconds);

    return {
      is_suspicious: true,
      message: ` Подозрительный бан: правило ${foundRule.code} должно давать ${expectedTime}, а выдано ${actualBanLength}`,
      suggestion: `Правильное время для ${foundRule.code}: ${expectedTime}`,
      admin_info: {
        steamId: ban.adminSteamId,
        name: ban.adminName
      }
    };
  }

  return { is_suspicious: false };
}

function calculateBanLength(seconds) {
  if (seconds === 0) return 'perma';

  const months = Math.floor(seconds / (30 * 86400));
  seconds %= (30 * 86400);
  const weeks = Math.floor(seconds / (7 * 86400));
  seconds %= (7 * 86400);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  let result = '';
  if (months > 0) result += `${months}mo`;
  if (weeks > 0) result += `${weeks}w`;
  if (days > 0) result += `${days}d`;
  if (hours > 0) result += `${hours}h`;
  if (minutes > 0) result += `${minutes}mi`;

  return result || '0mi';
}

function findSimilarRule(reason, rulesDatabase) {
  let bestMatch = null;
  let minDistance = Infinity;

  rulesDatabase.rules.forEach(rule => {
    rule.variants.forEach(variant => {
      if (variant.length < 2) return;
      const distance = levenshteinDistance(
        reason.toLowerCase(),
        variant.toLowerCase()
      );

      const maxDist = Math.min(2, Math.floor(variant.length / 3));
      if (distance > 0 && distance <= maxDist && distance < minDistance && reason.length >= 2) {
        minDistance = distance;
        bestMatch = rule;
      }
    });
  });

  return bestMatch;
}

function levenshteinDistance(str1, str2) {
  const matrix = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

function parseTimeToSeconds(timeStr) {
  if (timeStr === 'perma') return 0;

  const regex = /(\d+)(mo|mi|m|w|d|h|s)/g;
  let totalSeconds = 0;
  let match;

  while ((match = regex.exec(timeStr)) !== null) {
    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'mo': totalSeconds += value * 30 * 86400; break;
      case 'w': totalSeconds += value * 7 * 86400; break;
      case 'd': totalSeconds += value * 86400; break;
      case 'h': totalSeconds += value * 3600; break;
      case 'mi': case 'm': totalSeconds += value * 60; break;
      case 's': totalSeconds += value; break;
    }
  }

  return totalSeconds;
}

function formatSeconds(seconds) {
  if (seconds === 0) return 'perma';

  const months = Math.floor(seconds / (30 * 86400));
  seconds %= (30 * 86400);
  const weeks = Math.floor(seconds / (7 * 86400));
  seconds %= (7 * 86400);
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);

  let result = '';
  if (months > 0) result += `${months}mo`;
  if (weeks > 0) result += `${weeks}w`;
  if (days > 0) result += `${days}d`;
  if (hours > 0) result += `${hours}h`;
  if (minutes > 0) result += `${minutes}mi`;

  return result;
}

if (typeof module !== 'undefined') module.exports = { validateBanReason };
