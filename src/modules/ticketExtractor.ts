import type { ExtractionResult } from "../types.js";

const CODE_PATTERN = /(?:^|[^A-Za-z0-9])([A-Za-z0-9]{4})[\s-]*([A-Za-z0-9]{4})[\s-]*([A-Za-z0-9]{4})(?![A-Za-z0-9])/g;

type Candidate = {
  index: number;
  groups: [string, string, string];
};

function hasDigit(value: string): boolean {
  return /\d/.test(value);
}

export function extractTicketCode(message: string): ExtractionResult {
  const original = message ?? "";
  const codes = extractTicketCodes(original);

  if (codes.length === 0) {
    return {
      codigo_encontrado: false,
      codigo: null,
      mensagem_original: original
    };
  }

  return {
    codigo_encontrado: true,
    codigo: codes[codes.length - 1],
    mensagem_original: original
  };
}

export function extractTicketCodes(message: string): string[] {
  const original = message ?? "";
  const candidates: Candidate[] = [];
  let match: RegExpExecArray | null;

  while ((match = CODE_PATTERN.exec(original)) !== null) {
    candidates.push({
      index: match.index,
      groups: [match[1], match[2], match[3]]
    });

    CODE_PATTERN.lastIndex = match.index + 1;
  }

  if (candidates.length === 0) {
    return [];
  }

  return Array.from(new Set(candidates.map((candidate) => candidate.groups.join(" ").toUpperCase())));
}
