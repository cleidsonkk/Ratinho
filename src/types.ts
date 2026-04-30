export type ExtractionResult = {
  codigo_encontrado: boolean;
  codigo: string | null;
  mensagem_original: string;
};

export type TicketStatus = "encontrado" | "nao_encontrado" | "erro" | "limite_excedido";

export type CreditSnapshot = {
  limited: boolean;
  limit: number | null;
  used: number;
  payments: number;
  reserved: number;
  outstanding: number;
  available: number | null;
  ticketAmount?: number;
  requiredPayment?: number;
};

export type CreditCheckInput = {
  codigo: string;
  dados_bilhete: Record<string, unknown> | null;
};

export type CreditCheckDecision =
  | { allowed: true; credit?: CreditSnapshot }
  | { allowed: false; message: string; credit?: CreditSnapshot };

export type TicketSearchResult = {
  status: TicketStatus;
  dados_bilhete: Record<string, unknown> | null;
  html_resultado: string;
  texto_resultado: string;
};

export type TicketConfirmationResult = {
  confirmado: boolean;
  codigo_confirmacao: string | null;
  screenshot_base64: string | null;
  screenshot_path: string | null;
  mensagem_erro: string | null;
  status: TicketStatus;
  codigo_bilhete: string;
  dados_bilhete: Record<string, unknown> | null;
  credit?: CreditSnapshot;
};

export type InboundWhatsAppMessage = {
  numero: string;
  mensagem: string;
  externalMessageId: string | null;
  raw: unknown;
};

export type InboundMessage = {
  channel: "whatsapp" | "telegram";
  recipientId: string;
  mensagem: string;
  externalMessageId: string | null;
  raw: unknown;
  contactPhone?: string | null;
  contactFirstName?: string | null;
  contactLastName?: string | null;
};

export type ValidationJob = {
  id: string;
  externalMessageId: string | null;
  channel: "whatsapp" | "telegram";
  recipientId: string;
  numero: string;
  mensagem: string;
  codigo: string;
  raw: unknown;
  createdAt: string;
};
