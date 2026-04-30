import assert from "node:assert/strict";
import { parseDecimal, toMoneyAmount } from "../src/modules/money.js";

const cases: Array<[unknown, number]> = [
  ["5.00", 5],
  ["5,00", 5],
  ["R$ 5,00", 5],
  ["1.234,56", 1234.56],
  ["1,234.56", 1234.56],
  ["250", 250],
  [5, 5]
];

for (const [input, expected] of cases) {
  assert.equal(parseDecimal(input), expected, `parseDecimal(${String(input)})`);
  assert.equal(toMoneyAmount(input), Math.max(0, expected), `toMoneyAmount(${String(input)})`);
}

console.log("Money parsing checks passed.");
