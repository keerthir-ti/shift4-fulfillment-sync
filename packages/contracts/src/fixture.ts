import { readFileSync } from "node:fs";
import type { FixtureItem, ReferenceData } from "./index.js";

export function loadReference(fixturePath: string, scenarioPaths: string[] = []): ReferenceData {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as ReferenceData;
  const items = new Map<string, FixtureItem>(fixture.items.map((item) => [item.productNumber, item]));
  for (const scenarioPath of scenarioPaths) {
    const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as { products?: FixtureItem[] };
    for (const product of scenario.products ?? []) items.set(product.productNumber, product);
  }
  return { ...fixture, items: [...items.values()] };
}
