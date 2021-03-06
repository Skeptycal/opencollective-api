import fetch from 'isomorphic-fetch';
import config from 'config';
import debugLib from 'debug';
import Promise from 'bluebird';

const debug = debugLib('currency');
const cache = {};

function getDate(date = 'latest') {
  if (date.getFullYear) {
    date.setTime(date.getTime() + date.getTimezoneOffset() * 60 * 1000);
    const mm = date.getMonth() + 1; // getMonth() is zero-based
    const dd = date.getDate();
    date = [
      date.getFullYear(),
      (mm > 9 ? '' : '0') + mm,
      (dd > 9 ? '' : '0') + dd,
    ].join('-');
  }
  return date;
}

export function getFxRate(fromCurrency, toCurrency, date = 'latest') {
  debug('>>> getFxRate for ', date, fromCurrency, toCurrency);

  if (fromCurrency === toCurrency) return Promise.resolve(1);
  if (!fromCurrency || !toCurrency) return Promise.resolve(1);

  date = getDate(date);

  let dateKey = date;
  if (dateKey === 'latest') {
    dateKey = getDate(new Date());
  }
  const key = `${dateKey}-${fromCurrency}-${toCurrency}`;
  if (cache[key]) return Promise.resolve(cache[key]);
  return new Promise((resolve, reject) => {
    const params = {
      access_key: config.fixer.accessKey,
      base: fromCurrency,
      symbols: toCurrency,
    };
    const searchParams = Object.keys(params)
      .map(key => `${key}=${params[key]}`)
      .join('&');
    fetch(`http://data.fixer.io/${date}?${searchParams}`)
      .then(res => res.json())
      .then(json => {
        try {
          const fxrate = parseFloat(json.rates[toCurrency]);
          cache[key] = fxrate;
          return resolve(fxrate);
        } catch (e) {
          const msg = `>>> lib/currency: can't fetch fxrate from ${fromCurrency} to ${toCurrency} for date ${date}`;
          console.error(msg, 'json:', json, 'error:', e);
          throw new Error(msg);
        }
      })
      .catch(e => {
        console.error('Unable to fetch fxrate', e.message);
        // for testing in airplane mode
        if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
          console.log(
            '>>> development environment -> returning 1.1 instead of throwing the error',
            e,
          );
          return resolve(1.1);
        } else {
          reject(e);
        }
      });
  });
}

export function convertToCurrency(
  amount,
  fromCurrency,
  toCurrency,
  date = 'latest',
) {
  if (amount === 0) return 0;
  if (fromCurrency === toCurrency) return Promise.resolve(amount);
  if (!fromCurrency || !toCurrency) return Promise.resolve(amount);

  return getFxRate(fromCurrency, toCurrency, date).then(fxrate => {
    return fxrate * amount;
  });
}

/**
 * The goal of this function is to return the sum of an array of { currency, amount, date }
 * to one total amount in the given currency
 * @param {*} array [ { currency, amount[, date] }]
 */
export function reduceArrayToCurrency(array, currency) {
  return Promise.map(array, entry =>
    convertToCurrency(entry.amount, entry.currency, currency, entry.date),
  ).then(arrayInBaseCurrency => {
    return arrayInBaseCurrency.reduce(
      (accumulator, amount) => accumulator + amount,
      0,
    );
  });
}
