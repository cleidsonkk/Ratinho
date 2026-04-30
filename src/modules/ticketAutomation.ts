import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import serverlessChromium from "@sparticuz/chromium";
import { chromium as playwrightChromium, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "playwright";
import { config } from "../config.js";
import type { CreditCheckDecision, CreditCheckInput, TicketConfirmationResult, TicketSearchResult } from "../types.js";
import { canConfirmTicket, confirmTicket, hasTargetLogin, lookupTicket } from "./ticketApi.js";

type TicketAutomationHooks = {
  beforeConfirm?: (input: CreditCheckInput) => Promise<CreditCheckDecision>;
};

const SEARCH_BUTTON_TEXT = /pesquisar|buscar|consultar|search|query/i;
const CONFIRM_BUTTON_TEXT = /confirmar|confirmar bilhete|confirmar pre-bilhete|efetivar/i;
const NOT_FOUND_TEXT = /nao encontrado|nao localizado|invalido|nenhum bilhete|codigo inexistente|bilhete nao|not found|invalid|no ticket/i;
const FOUND_HINT_TEXT = /odd|odds|selec|selection|cotacao|event|evento|palpite|market|mercado|amount|stake/i;
const PAYMENT_FORM_TEXT = /(usuario|user):\s*(valor|amount):\s*(senha|password):/i;

function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export class TicketAutomation {
  async validateAndConfirm(codigo: string, hooks: TicketAutomationHooks = {}): Promise<TicketConfirmationResult> {
    let context: BrowserContext | null = null;
    let browser: Browser | null = null;

    try {
      const session = await this.createBrowserContext();
      context = session.context;
      browser = session.browser;

      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultTimeout(config.browserTimeoutMs);

      const search = await this.searchTicket(page, codigo);

      if (search.status !== "encontrado") {
        const apiFallback = await lookupTicket(codigo).catch((error) => ({
          found: false as const,
          status: null,
          error: error instanceof Error ? error.message : String(error)
        }));

        if (apiFallback.found) {
          const apiTicketData = {
            source: apiFallback.source,
            ...apiFallback.data
          };

          if (!config.confirmPreTicket) {
            const screenshot = await this.captureScreenshot(page, codigo).catch(() => null);

            return {
              confirmado: false,
              codigo_confirmacao: null,
              screenshot_base64: screenshot?.base64 ?? null,
              screenshot_path: screenshot?.path ?? null,
              mensagem_erro: "Confirmacao automatica desativada",
              status: "encontrado",
              codigo_bilhete: codigo,
              dados_bilhete: apiTicketData
            };
          }

          if (!canConfirmTicket()) {
            return {
              confirmado: false,
              codigo_confirmacao: null,
              screenshot_base64: null,
              screenshot_path: null,
              mensagem_erro: hasTargetLogin()
                ? "Sessao de login incompleta para confirmar pre-bilhete"
                : "Bilhete localizado pela API; login do site necessario para confirmar pre-bilhete",
              status: "erro",
              codigo_bilhete: codigo,
              dados_bilhete: apiTicketData
            };
          }

          const creditBlock = await this.checkCreditBeforeConfirm(codigo, apiTicketData, hooks);

          if (creditBlock) {
            return creditBlock;
          }

          const confirmation = await confirmTicket(codigo, apiFallback.data, apiFallback.source);

          if (confirmation.confirmed) {
            const receiptUrl = new URL(confirmation.receiptPath, config.targetUrl).toString();
            await page.goto(receiptUrl, {
              waitUntil: "domcontentloaded",
              timeout: config.browserTimeoutMs
            }).catch(() => undefined);

            await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
            const screenshot = await this.captureScreenshot(page, confirmation.code ?? codigo).catch(() => null);

            return {
              confirmado: true,
              codigo_confirmacao: confirmation.code,
              screenshot_base64: screenshot?.base64 ?? null,
              screenshot_path: screenshot?.path ?? null,
              mensagem_erro: null,
              status: "encontrado",
              codigo_bilhete: codigo,
              dados_bilhete: {
                ...apiTicketData,
                confirmacao: confirmation.data
              }
            };
          }

          return {
            confirmado: false,
            codigo_confirmacao: null,
            screenshot_base64: null,
            screenshot_path: null,
            mensagem_erro: confirmation.error ?? "Confirmacao nao concluida",
            status: confirmation.error?.includes("pendente de confirmacao") ? "encontrado" : "erro",
            codigo_bilhete: codigo,
            dados_bilhete: apiTicketData
          };
        }

        const screenshot = search.status === "erro"
          ? await this.captureScreenshot(page, codigo).catch(() => null)
          : null;

        return {
          confirmado: false,
          codigo_confirmacao: null,
          screenshot_base64: screenshot?.base64 ?? null,
          screenshot_path: screenshot?.path ?? null,
          mensagem_erro: search.status === "erro"
            ? `Erro ao consultar o bilhete: ${this.compactText(search.texto_resultado)}`
            : null,
          status: search.status,
          codigo_bilhete: codigo,
          dados_bilhete: search.dados_bilhete
        };
      }

      const apiLookup = await lookupTicket(codigo).catch((error) => ({
        found: false as const,
        status: null,
        error: error instanceof Error ? error.message : String(error)
      }));
      const ticketDataForResult = apiLookup.found
        ? { source: apiLookup.source, ...apiLookup.data }
        : search.dados_bilhete;

      if (!config.confirmPreTicket) {
        const screenshot = await this.captureScreenshot(page, codigo);

        return {
          confirmado: false,
          codigo_confirmacao: null,
          screenshot_base64: screenshot.base64,
          screenshot_path: screenshot.path,
          mensagem_erro: "Confirmacao automatica desativada",
          status: "encontrado",
          codigo_bilhete: codigo,
          dados_bilhete: ticketDataForResult
        };
      }

      const confirmButton = await this.firstVisibleLocator(page, [
        () => page.getByRole("button", { name: CONFIRM_BUTTON_TEXT }),
        () => page.getByText(CONFIRM_BUTTON_TEXT, { exact: false }),
        () => page.locator("input[type='submit'], input[type='button'], button").filter({ hasText: CONFIRM_BUTTON_TEXT })
      ]);

      if (!confirmButton) {
        const screenshot = await this.captureScreenshot(page, codigo);

        return {
          confirmado: false,
          codigo_confirmacao: null,
          screenshot_base64: screenshot.base64,
          screenshot_path: screenshot.path,
          mensagem_erro: "Botao de confirmacao nao localizado",
          status: "erro",
          codigo_bilhete: codigo,
          dados_bilhete: ticketDataForResult
        };
      }

      const creditBlock = await this.checkCreditBeforeConfirm(codigo, ticketDataForResult, hooks);

      if (creditBlock) {
        return creditBlock;
      }

      await Promise.all([
        page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined),
        confirmButton.click()
      ]);

      await page.waitForTimeout(1_000);
      const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
      const confirmationCode = this.extractConfirmationCode(text);
      const screenshot = await this.captureScreenshot(page, codigo);

      return {
        confirmado: true,
        codigo_confirmacao: confirmationCode,
        screenshot_base64: screenshot.base64,
        screenshot_path: screenshot.path,
        mensagem_erro: null,
        status: "encontrado",
        codigo_bilhete: codigo,
        dados_bilhete: ticketDataForResult
      };
    } catch (error) {
      return {
        confirmado: false,
        codigo_confirmacao: null,
        screenshot_base64: null,
        screenshot_path: null,
        mensagem_erro: error instanceof Error ? error.message : "Erro desconhecido",
        status: "erro",
        codigo_bilhete: codigo,
        dados_bilhete: null
      };
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  private async checkCreditBeforeConfirm(codigo: string, dados_bilhete: Record<string, unknown> | null, hooks: TicketAutomationHooks): Promise<TicketConfirmationResult | null> {
    if (!hooks.beforeConfirm) {
      return null;
    }

    const decision = await hooks.beforeConfirm({ codigo, dados_bilhete });

    if (decision.allowed) {
      return null;
    }

    return {
      confirmado: false,
      codigo_confirmacao: null,
      screenshot_base64: null,
      screenshot_path: null,
      mensagem_erro: decision.message,
      status: "limite_excedido",
      codigo_bilhete: codigo,
      dados_bilhete,
      credit: decision.credit
    };
  }

  private async createBrowserContext(): Promise<{ context: BrowserContext; browser: Browser | null }> {
    const contextOptions: BrowserContextOptions = {
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true,
      storageState: config.storageStatePath || undefined
    };

    if (config.playwrightWsEndpoint) {
      const browser = config.playwrightConnectMode === "playwright"
        ? await playwrightChromium.connect(config.playwrightWsEndpoint)
        : await playwrightChromium.connectOverCDP(config.playwrightWsEndpoint);
      const context = await browser.newContext(contextOptions);
      return { context, browser };
    }

    if (process.env.VERCEL) {
      const browser = await playwrightChromium.launch({
        args: serverlessChromium.args,
        executablePath: await serverlessChromium.executablePath(),
        headless: true
      });
      const context = await browser.newContext(contextOptions);
      return { context, browser };
    }

    if (config.storageStatePath) {
      const browser = await playwrightChromium.launch({ headless: config.headless });
      const context = await browser.newContext(contextOptions);
      return { context, browser };
    }

    const context = await playwrightChromium.launchPersistentContext(config.playwrightUserDataDir, {
      headless: config.headless,
      viewport: contextOptions.viewport,
      ignoreHTTPSErrors: true
    });

    return { context, browser: null };
  }

  private async searchTicket(page: Page, codigo: string): Promise<TicketSearchResult> {
    await page.goto(config.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.browserTimeoutMs
    });

    const input = await this.firstVisibleLocator(page, [
      () => page.locator('input[name*="codigo" i]').first(),
      () => page.locator("input#txtCodigo").first(),
      () => page.locator('input[type="text"]').first(),
      () => page.locator("input:not([type])").first()
    ]);

    if (!input) {
      return await this.resultFromPage(page, "erro");
    }

    await input.fill("");
    await input.fill(codigo);

    const insertedValue = await input.inputValue().catch(() => "");
    if (insertedValue.trim().toUpperCase() !== codigo.toUpperCase()) {
      return await this.resultFromPage(page, "erro");
    }

    const searchButton = await this.firstVisibleLocator(page, [
      () => page.getByRole("button", { name: SEARCH_BUTTON_TEXT }),
      () => page.getByRole("link", { name: SEARCH_BUTTON_TEXT }),
      () => page.locator('input[type="submit"][value*="Pesquisar" i], input[type="button"][value*="Pesquisar" i]'),
      () => page.locator('input[type="submit"][value*="Search" i], input[type="button"][value*="Search" i]'),
      () => page.locator('input[type="submit"][value*="Query" i], input[type="button"][value*="Query" i]'),
      () => page.locator("input[type='submit'], input[type='button'], button, a").filter({ hasText: SEARCH_BUTTON_TEXT })
    ]);

    if (!searchButton) {
      return await this.resultFromPage(page, "erro");
    }

    await Promise.all([
      page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined),
      searchButton.click()
    ]);

    await page.waitForTimeout(800);
    return await this.analyzePage(page);
  }

  private async analyzePage(page: Page): Promise<TicketSearchResult> {
    const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const status = await this.detectStatus(page, bodyText);
    return await this.resultFromPage(page, status);
  }

  private async detectStatus(page: Page, bodyText: string): Promise<TicketSearchResult["status"]> {
    const normalizedBodyText = normalizeText(bodyText);

    if (NOT_FOUND_TEXT.test(normalizedBodyText)) {
      return "nao_encontrado";
    }

    const confirmButton = await this.firstVisibleLocator(page, [
      () => page.getByRole("button", { name: CONFIRM_BUTTON_TEXT }),
      () => page.getByText(CONFIRM_BUTTON_TEXT, { exact: false }),
      () => page.locator("input[type='submit'], input[type='button'], button").filter({ hasText: CONFIRM_BUTTON_TEXT })
    ], 1_000);

    if (confirmButton) {
      return "encontrado";
    }

    const tableRows = await page.locator("table tr").count().catch(() => 0);

    if (tableRows > 1 && (FOUND_HINT_TEXT.test(normalizedBodyText) || PAYMENT_FORM_TEXT.test(normalizedBodyText))) {
      return "encontrado";
    }

    return "nao_encontrado";
  }

  private async resultFromPage(page: Page, status: TicketSearchResult["status"]): Promise<TicketSearchResult> {
    const html = await page.content().catch(() => "");
    const text = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
    const dados = status === "encontrado" ? await this.extractTicketData(page) : null;

    return {
      status,
      dados_bilhete: dados,
      html_resultado: html,
      texto_resultado: text
    };
  }

  private compactText(text: string): string {
    const compacted = text.replace(/\s+/g, " ").trim();
    return compacted ? compacted.slice(0, 500) : "pagina sem texto visivel";
  }

  private async extractTicketData(page: Page): Promise<Record<string, unknown>> {
    return await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tr"))
        .map((row) => Array.from(row.querySelectorAll("th,td")).map((cell) => (cell.textContent ?? "").trim()).filter(Boolean))
        .filter((cells) => cells.length > 0);

      const fields = Array.from(document.querySelectorAll("label, .label, .form-label, span, strong"))
        .map((element) => (element.textContent ?? "").trim())
        .filter(Boolean)
        .slice(0, 80);

      return {
        rows,
        fields,
        url: window.location.href,
        title: document.title
      };
    });
  }

  private async captureScreenshot(page: Page, codigo: string): Promise<{ path: string | null; base64: string }> {
    const buffer = await page.screenshot({ fullPage: true });
    let filePath: string | null = null;

    if (config.storeScreenshotsLocal) {
      const dir = path.resolve("data", "screenshots");
      await mkdir(dir, { recursive: true });

      const safeCode = codigo.replace(/[^A-Z0-9]+/gi, "-").replace(/^-|-$/g, "");
      filePath = path.join(dir, `${safeCode}-${Date.now()}.png`);
      await writeFile(filePath, buffer);
    }

    return { path: filePath, base64: buffer.toString("base64") };
  }

  private extractConfirmationCode(text: string): string | null {
    const normalizedText = normalizeText(text);
    const patterns = [
      /(?:confirmacao|protocolo|comprovante|numero)\D{0,30}([A-Z0-9][A-Z0-9._-]{3,})/i,
      /(?:cod\.?|codigo)\D{0,30}([A-Z0-9][A-Z0-9._-]{3,})/i
    ];

    for (const pattern of patterns) {
      const match = normalizedText.match(pattern);
      if (match?.[1]) {
        return match[1].toUpperCase();
      }
    }

    return null;
  }

  private async firstVisibleLocator(page: Page, factories: Array<() => Locator>, timeout = config.browserTimeoutMs): Promise<Locator | null> {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      for (const factory of factories) {
        const locator = factory().first();

        if (await locator.isVisible({ timeout: 250 }).catch(() => false)) {
          return locator;
        }
      }

      await page.waitForTimeout(100).catch(() => undefined);
    }

    return null;
  }
}
