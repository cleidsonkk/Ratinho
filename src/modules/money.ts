export function parseDecimal(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return 0;
  }

  const cleaned = value.trim().replace(/[^\d,.-]/g, "");

  if (!cleaned) {
    return 0;
  }

  const commaIndex = cleaned.lastIndexOf(",");
  const dotIndex = cleaned.lastIndexOf(".");
  let normalized = cleaned;

  if (commaIndex >= 0 && dotIndex >= 0) {
    normalized = commaIndex > dotIndex
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  } else if (commaIndex >= 0) {
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toMoneyAmount(value: unknown): number {
  return Math.max(0, Number(parseDecimal(value).toFixed(2)));
}

export function nullableMoneyAmount(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  return toMoneyAmount(value);
}
