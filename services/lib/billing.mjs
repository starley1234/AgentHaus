/**
 * Billing — универсальный биллинг для всех денежных сервисов AgentHaus
 * 
 * Поддерживает:
 * - Robokassa (основной для RU)
 * - Stripe (для EU/US, опционально)
 * - Кредиты (локальный баланс в credits.json)
 * 
 * Использование в любом сервисе:
 *   import { Billing } from "../lib/billing.mjs";
 *   const billing = new Billing({ serviceName: "bom-parse", pricePerUnit: 0.20 });
 *   const hasCredits = await billing.hasCredits(userId, pages);
 *   await billing.deductCredits(userId, pages);
 *   const paymentUrl = await billing.createRobokassaPayment({ amount, description, userId });
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Robokassa } from "./robokassa.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Billing {
  constructor({
    serviceName,
    pricePerUnit = 0.20,
    creditsFile = null,
    robokassaConfig = null,
  }) {
    this.serviceName = serviceName;
    this.pricePerUnit = pricePerUnit;
    this.creditsFile = creditsFile || path.join(__dirname, "..", serviceName, "credits.json");
    
    // Robokassa конфиг из env или из переданного объекта
    const rkLogin = process.env.ROBOKASSA_MERCHANT_LOGIN || robokassaConfig?.merchantLogin || "demo";
    const rkPass1 = process.env.ROBOKASSA_PASSWORD1 || robokassaConfig?.password1 || "password_1";
    const rkPass2 = process.env.ROBOKASSA_PASSWORD2 || robokassaConfig?.password2 || "password_2";
    const rkTest = (process.env.ROBOKASSA_IS_TEST || String(robokassaConfig?.isTest ?? true)) === "true";
    const rkAlgo = process.env.ROBOKASSA_ALGORITHM || robokassaConfig?.algorithm || "md5";

    this.robokassa = new Robokassa({
      merchantLogin: rkLogin,
      password1: rkPass1,
      password2: rkPass2,
      isTest: rkTest,
      algorithm: rkAlgo,
    });

    this.isTest = rkTest;
  }

  async _readCreditsData() {
    try {
      const text = await readFile(this.creditsFile, "utf-8");
      return JSON.parse(text);
    } catch {
      return { users: {}, total: 100, updated: new Date().toISOString() };
    }
  }

  async _writeCreditsData(data) {
    try {
      await mkdir(path.dirname(this.creditsFile), { recursive: true });
      await writeFile(this.creditsFile, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.warn("[billing] write error", e);
    }
  }

  async getUserCredits(userId = "default") {
    const data = await this._readCreditsData();
    if (userId === "default") {
      return data.total ?? 100;
    }
    return data.users?.[userId] ?? data.total ?? 0;
  }

  async getAllCredits() {
    return this._readCreditsData();
  }

  async hasCredits(userId = "default", amount = 1) {
    const credits = await this.getUserCredits(userId);
    return credits >= amount;
  }

  async addCredits(userId = "default", amount = 10) {
    const data = await this._readCreditsData();
    data.total = (data.total ?? 0) + amount;
    if (!data.users) data.users = {};
    data.users[userId] = (data.users[userId] ?? 0) + amount;
    data.updated = new Date().toISOString();
    await this._writeCreditsData(data);
    return data.users[userId];
  }

  async deductCredits(userId = "default", amount = 1) {
    const data = await this._readCreditsData();
    if (userId === "default") {
      data.total = Math.max(0, (data.total ?? 0) - amount);
    } else {
      if (!data.users) data.users = {};
      data.users[userId] = Math.max(0, (data.users[userId] ?? 0) - amount);
      // Также списываем из общего
      data.total = Math.max(0, (data.total ?? 0) - amount);
    }
    data.updated = new Date().toISOString();
    await this._writeCreditsData(data);
    return userId === "default" ? data.total : data.users[userId];
  }

  /**
   * Создать платёжную ссылку Robokassa
   * @param {object} opts
   * @param {number} opts.amount - сумма
   * @param {string} opts.description - описание
   * @param {string} opts.userId - ID пользователя для начисления кредитов
   * @param {string} opts.email - email
   * @param {number} opts.invId - ID заказа (опционально)
   * @param {object} opts.extraShp - доп Shp_ параметры
   */
  createRobokassaPayment({
    amount,
    description = `Пополнение ${this.serviceName}`,
    userId = "default",
    email = null,
    invId = null,
    extraShp = {},
  }) {
    const finalInvId = invId || Math.floor(Date.now() / 1000) % 2147483647;

    const userParams = {
      Shp_userId: userId,
      Shp_service: this.serviceName,
      Shp_credits: String(Math.floor(amount / this.pricePerUnit)),
      ...extraShp,
    };

    const paymentUrl = this.robokassa.generatePaymentUrl({
      outSum: amount,
      invId: finalInvId,
      description: description.slice(0, 100),
      userParams,
      email,
      culture: "ru",
    });

    return {
      invId: String(finalInvId),
      amount: String(amount),
      paymentUrl,
      isTest: this.isTest,
      merchantLogin: this.robokassa.merchantLogin,
      credits: Math.floor(amount / this.pricePerUnit),
    };
  }

  /**
   * Обработать ResultURL от Robokassa — начислить кредиты
   * @param {object} data - данные от Robokassa (OutSum, InvId, SignatureValue, Shp_...)
   * @returns {object} { valid, invId, userId, creditsAdded }
   */
  async handleRobokassaResult(data) {
    const valid = this.robokassa.validateResult(data);
    if (!valid) {
      return { valid: false, error: "Invalid signature" };
    }

    const invId = String(data.InvId || data.invId);
    const outSum = Number(data.OutSum || data.outSum || 0);
    const userId = data.Shp_userId || data.shp_userId || "default";
    const service = data.Shp_service || data.shp_service || this.serviceName;
    const creditsFromShp = Number(data.Shp_credits || data.shp_credits || 0);
    const creditsToAdd = creditsFromShp > 0 ? creditsFromShp : Math.floor(outSum / this.pricePerUnit);

    if (service !== this.serviceName && this.serviceName !== "global") {
      console.warn(`[billing] Service mismatch: expected ${this.serviceName}, got ${service}, but adding credits anyway`);
    }

    const newBalance = await this.addCredits(userId, creditsToAdd);

    return {
      valid: true,
      invId,
      outSum,
      userId,
      service,
      creditsAdded: creditsToAdd,
      newBalance,
    };
  }

  getSuccessAnswer(invId) {
    return this.robokassa.getSuccessAnswer(invId);
  }
}

// Глобальный биллинг для всех сервисов (общий баланс)
export function createGlobalBilling() {
  return new Billing({
    serviceName: "global",
    pricePerUnit: 0.20,
    creditsFile: path.join(__dirname, "..", "credits-global.json"),
  });
}
