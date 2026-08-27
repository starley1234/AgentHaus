/**
 * Robokassa — подключаемое платёжное решение для AgentHaus
 * 
 * Основано на документации docs.robokassa.ru:
 * - URL оплаты: https://auth.robokassa.ru/Merchant/Index.aspx
 * - Подпись: MerchantLogin:OutSum:InvId:Receipt:Password1:Shp_...
 * - ResultURL подпись: OutSum:InvId:Password2:Shp_...
 * - SuccessURL подпись: OutSum:InvId:Password1:Shp_...
 * 
 * Поддерживает MD5, SHA1, SHA256, SHA384, SHA512 (настраивается в ЛК Robokassa)
 * 
 * Использование:
 *   import { Robokassa } from "./robokassa.mjs";
 *   const rk = new Robokassa({ merchantLogin, password1, password2, isTest, algorithm });
 *   const url = rk.generatePaymentUrl({ outSum, invId, description, receipt, userParams });
 *   const valid = rk.validateResult({ outSum, invId, signature, userParams });
 */

import crypto from "node:crypto";

const DEFAULT_PAYMENT_URL = "https://auth.robokassa.ru/Merchant/Index.aspx";

const ALGORITHMS = {
  md5: "md5",
  sha1: "sha1",
  sha256: "sha256",
  sha384: "sha384",
  sha512: "sha512",
  ripemd160: "ripemd160",
};

function hash(value, algorithm = "md5") {
  const algo = ALGORITHMS[algorithm.toLowerCase()] || "md5";
  return crypto.createHash(algo).update(value, "utf-8").digest("hex");
}

function formatOutSum(sum) {
  // Robokassa требует 2 знака после точки для запроса, 6 для ResultURL проверки
  const num = Number(sum);
  if (Number.isNaN(num)) throw new Error(`Invalid OutSum: ${sum}`);
  return num.toFixed(2);
}

function sortShpParams(params) {
  // Shp_ параметры сортируются по алфавиту по ключу
  const keys = Object.keys(params)
    .filter((k) => k.toLowerCase().startsWith("shp_"))
    .sort((a, b) => a.localeCompare(b));
  return keys.map((k) => `${k}=${params[k]}`);
}

function buildSignatureString({
  merchantLogin,
  outSum,
  invId,
  receipt,
  password,
  shpParams = [],
}) {
  // Строка: MerchantLogin:OutSum:InvId:Receipt:Password:Shp_...
  // Если InvId пустой — оставляем пустой слот: OutSum::
  // Модификаторы в строгом порядке: Receipt только в этом базовом случае
  const parts = [merchantLogin, outSum, invId !== undefined && invId !== null && invId !== "" ? String(invId) : ""];
  if (receipt) parts.push(receipt);
  parts.push(password);
  if (shpParams.length > 0) parts.push(...shpParams);
  return parts.join(":");
}

function buildResultSignatureString({ outSum, invId, password2, shpParams = [] }) {
  // Для ResultURL: OutSum:InvId:Password2:Shp_...
  const parts = [outSum, String(invId), password2];
  if (shpParams.length > 0) parts.push(...shpParams);
  return parts.join(":");
}

function buildSuccessSignatureString({ outSum, invId, password1, shpParams = [] }) {
  // Для SuccessURL: OutSum:InvId:Password1:Shp_...
  const parts = [outSum, String(invId), password1];
  if (shpParams.length > 0) parts.push(...shpParams);
  return parts.join(":");
}

export class Robokassa {
  constructor({
    merchantLogin,
    password1,
    password2,
    isTest = false,
    algorithm = "md5",
    paymentUrl = DEFAULT_PAYMENT_URL,
  }) {
    if (!merchantLogin) throw new Error("merchantLogin обязателен");
    if (!password1) throw new Error("password1 обязателен");
    if (!password2) throw new Error("password2 обязателен");

    this.merchantLogin = merchantLogin;
    this.password1 = password1;
    this.password2 = password2;
    this.isTest = isTest;
    this.algorithm = algorithm.toLowerCase();
    this.paymentUrl = paymentUrl;
  }

  /**
   * Сгенерировать URL для оплаты
   * @param {object} opts
   * @param {number|string} opts.outSum - сумма
   * @param {number|string} [opts.invId] - номер заказа (рекомендуется)
   * @param {string} [opts.description] - описание (до 100 символов)
   * @param {string|object} [opts.receipt] - фискальные данные JSON или строка URL-encoded
   * @param {object} [opts.userParams] - Shp_ параметры { Shp_userId: 123 }
   * @param {string} [opts.email] - email покупателя
   * @param {string} [opts.culture] - ru/en
   * @param {string} [opts.incCurrLabel] - предлагаемый способ оплаты
   * @param {string} [opts.expirationDate] - ISO 8601
   * @returns {string} URL
   */
  generatePaymentUrl({
    outSum,
    invId = 0,
    description = "",
    receipt = null,
    userParams = {},
    email = null,
    culture = "ru",
    incCurrLabel = null,
    expirationDate = null,
    isTest = null,
  }) {
    const outSumFormatted = formatOutSum(outSum);
    const invIdStr = invId !== undefined && invId !== null ? String(invId) : "0";

    // Receipt — минимизированный JSON в URL-encode
    let receiptStr = null;
    let receiptForSignature = null;
    if (receipt) {
      if (typeof receipt === "string") {
        receiptStr = receipt;
        // Для подписи нужен декодированный минимизированный JSON
        try {
          receiptForSignature = JSON.stringify(JSON.parse(decodeURIComponent(receipt)));
        } catch {
          receiptForSignature = receipt;
        }
      } else {
        receiptForSignature = JSON.stringify(receipt);
        receiptStr = encodeURIComponent(receiptForSignature);
      }
    }

    const shpSorted = sortShpParams(userParams);
    const signatureString = buildSignatureString({
      merchantLogin: this.merchantLogin,
      outSum: outSumFormatted,
      invId: invIdStr,
      receipt: receiptForSignature,
      password: this.password1,
      shpParams: shpSorted,
    });

    const signature = hash(signatureString, this.algorithm);

    const params = new URLSearchParams();
    params.set("MerchantLogin", this.merchantLogin);
    params.set("OutSum", outSumFormatted);
    if (invIdStr && invIdStr !== "0") params.set("InvId", invIdStr);
    if (description) params.set("Description", description);
    params.set("SignatureValue", signature);
    if (receiptStr) params.set("Receipt", receiptStr);
    if (email) params.set("Email", email);
    if (culture) params.set("Culture", culture);
    if (incCurrLabel) params.set("IncCurrLabel", incCurrLabel);
    if (expirationDate) params.set("ExpirationDate", expirationDate);

    const testMode = isTest !== null ? isTest : this.isTest;
    if (testMode) params.set("IsTest", "1");

    // Shp_ параметры
    for (const [k, v] of Object.entries(userParams)) {
      if (k.toLowerCase().startsWith("shp_")) {
        params.set(k, String(v));
      }
    }

    return `${this.paymentUrl}?${params.toString()}`;
  }

  /**
   * Сгенерировать параметры для POST формы (альтернатива URL)
   */
  generatePaymentParams(opts) {
    const url = this.generatePaymentUrl(opts);
    const parsed = new URL(url);
    const params = {};
    for (const [k, v] of parsed.searchParams.entries()) {
      params[k] = v;
    }
    return params;
  }

  /**
   * Проверить подпись ResultURL (серверное уведомление)
   * @param {object} data - { OutSum, InvId, SignatureValue, Shp_... }
   * @returns {boolean}
   */
  validateResult(data) {
    const outSum = String(data.OutSum || data.outSum);
    const invId = String(data.InvId || data.invId);
    const signature = String(data.SignatureValue || data.signatureValue);

    // Собрать Shp_ параметры из data
    const shpParams = [];
    const userParams = {};
    for (const [k, v] of Object.entries(data)) {
      if (k.toLowerCase().startsWith("shp_")) {
        userParams[k] = v;
      }
    }
    shpParams.push(...sortShpParams(userParams));

    const signatureString = buildResultSignatureString({
      outSum,
      invId,
      password2: this.password2,
      shpParams,
    });

    const expected = hash(signatureString, this.algorithm);
    return expected.toLowerCase() === signature.toLowerCase();
  }

  /**
   * Проверить подпись SuccessURL / FailURL
   */
  validateSuccess(data) {
    const outSum = String(data.OutSum || data.outSum);
    const invId = String(data.InvId || data.invId);
    const signature = String(data.SignatureValue || data.signatureValue);

    const userParams = {};
    for (const [k, v] of Object.entries(data)) {
      if (k.toLowerCase().startsWith("shp_")) {
        userParams[k] = v;
      }
    }
    const shpSorted = sortShpParams(userParams);

    const signatureString = buildSuccessSignatureString({
      outSum,
      invId,
      password1: this.password1,
      shpParams: shpSorted,
    });

    const expected = hash(signatureString, this.algorithm);
    return expected.toLowerCase() === signature.toLowerCase();
  }

  /**
   * Ответ для ResultURL при успешной обработке
   */
  getSuccessAnswer(invId) {
    return `OK${invId}`;
  }

  /**
   * Создать чек для фискализации (ФЗ-54)
   * @param {Array} items - [{ name, quantity, sum, tax, payment_method, payment_object }]
   * @param {string} sno - система налогообложения (osn, usn_income, etc)
   */
  static createReceipt(items, sno = "osn") {
    return {
      sno,
      items: items.map((it) => ({
        name: it.name,
        quantity: it.quantity ?? 1,
        sum: it.sum,
        tax: it.tax ?? "none",
        payment_method: it.payment_method ?? "full_payment",
        payment_object: it.payment_object ?? "service",
      })),
    };
  }
}

// Утилиты для Express-like обработки
export function handleResultUrlRequest(req, res, robokassa, callback) {
  // Поддержка разных форматов тела (JSON, urlencoded)
  let data = req.body || {};
  // Если GET — берём query
  if (req.query && Object.keys(req.query).length > 0) {
    data = { ...data, ...req.query };
  }

  const valid = robokassa.validateResult(data);
  if (!valid) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid signature");
    return false;
  }

  const invId = data.InvId || data.invId;
  const userParams = {};
  for (const [k, v] of Object.entries(data)) {
    if (k.toLowerCase().startsWith("shp_")) userParams[k] = v;
  }

  try {
    const result = callback(
      { outSum: data.OutSum, invId, fee: data.Fee, email: data.EMail, paymentMethod: data.PaymentMethod },
      userParams,
    );
    if (result === false) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Callback returned false");
      return false;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(robokassa.getSuccessAnswer(invId));
    return true;
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(`Error: ${e.message}`);
    return false;
  }
}
