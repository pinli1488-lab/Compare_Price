export const COUNTRY_CODES = ['SE', 'DK', 'FI', 'NO'] as const;

export type CountryCode = typeof COUNTRY_CODES[number];

export const COUNTRIES: Record<CountryCode, {
  label: string;
  currency: string;
  locale: string;
  mistoreOrigin: string;
  marketOrigin: string;
}> = {
  SE: { label: 'SE', currency: 'SEK', locale: 'sv-SE', mistoreOrigin: 'https://mistore.se', marketOrigin: 'https://www.prisjakt.nu' },
  DK: { label: 'DK', currency: 'DKK', locale: 'da-DK', mistoreOrigin: 'https://mistore.dk', marketOrigin: 'https://prisjagt.dk' },
  FI: { label: 'FI', currency: 'EUR', locale: 'fi-FI', mistoreOrigin: 'https://mistore.fi', marketOrigin: 'https://hintaopas.fi' },
  NO: { label: 'NO', currency: 'NOK', locale: 'nb-NO', mistoreOrigin: 'https://mistore.no', marketOrigin: 'https://www.prisjakt.no' },
};

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && COUNTRY_CODES.includes(value as CountryCode);
}
