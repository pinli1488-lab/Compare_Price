type NameSource = {
  sku: string;
  ean: string;
  productName: string;
  markets?: Record<string, { mistoreName: string | null }>;
};

export function productDisplayName(product: NameSource): string {
  const normalize = (value: string) => value.trim().toLowerCase();
  const usable = (value: string) => Boolean(value.trim()) &&
    normalize(value) !== normalize(product.sku) && normalize(value) !== normalize(product.ean) &&
    normalize(value) !== 'name pending';
  const names = [product.markets?.SE?.mistoreName, product.productName,
    ...Object.values(product.markets ?? {}).map((market) => market.mistoreName)];
  return names.find((name): name is string => Boolean(name && usable(name)))?.trim() || 'Name pending';
}
