export const INTERNAL_COLLECTIONS = [
  { id: 'phones-tablets', title: 'Phones & Tablets' },
  { id: 'scooters', title: 'Scooters' },
  { id: 'vacuums', title: 'Vacuums' },
  { id: 'wearables', title: 'Wearables' },
  { id: 'home-care', title: 'Home Care' },
  { id: 'kitchen', title: 'Kitchen' },
  { id: 'audio-visual', title: 'Audio & Visual' },
  { id: 'lighting', title: 'Lighting' },
  { id: 'spare-parts', title: 'Spare Parts' },
] as const;

export type InternalCollectionId = typeof INTERNAL_COLLECTIONS[number]['id'];
export type CollectionOverride = InternalCollectionId | 'uncategorized' | null;

export function isCollectionOverride(value: unknown): value is CollectionOverride {
  return value === null || value === 'uncategorized' || INTERNAL_COLLECTIONS.some((category) => category.id === value);
}

export function classifyInternalCollection(name: string): InternalCollectionId | null {
  const text = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!text || text === 'name pending') return null;
  // A bundle belongs to its main device, rather than the filter or accessory supplied with it.
  const main = /\bbundle\b/.test(text) ? text.split(/\s*\+\s*/)[0] : text;
  if (/\b(?:strap|bezel|brush cover|brushbar|disposable bag|mopping cloth|accessories kit|extension|remote control|dimmer|charger|adapter|protective cover|screen protector|cable lock|storage bag)\b/.test(main)) return 'spare-parts';
  if (/\b(?:vacuum|scooter)\b/.test(main) && /\b(?:brush|bag|cloth|gloves)\b/.test(main)) return 'spare-parts';
  if (!/\bpower bank\b/.test(main) && /\b(?:usb|usb-c|type-c|lightning)\b.*\bcable\b/.test(main)) return 'spare-parts';
  if (/\b(?:replacement|spare|reservdel|varaosa|filter|filters|hepa|cartridge|mop pad|mop pads|main brush|side brush|roller brush|brush head|dust bag|dust bags|water tank|dust container|brake|brakes|brake disc|brake pad|tire|tyre|inner tube|bearing|battery|power adapter|charging cable|usb cable|protective case|screen protector)\b/.test(main)) return 'spare-parts';
  if (/\b(?:writing tablet|skrivplatta|temperature|humidity|blue light blocking glasses|power bank|hub|gateway)\b/.test(main)) return null;
  if (/\b(?:smartphone|mobile phone|redmi (?:note|pad|a\d+\w*|\d{1,2}c?)|poco|xiaomi (?:mi )?\d{1,2}t?|xiaomi pad|mi pad|tablet)\b/.test(main)) return 'phones-tablets';
  if (/\b(?:scooter|elsparkcykel|elscooter|el-lobehjul|sparkesykkel|sahkopotkulauta)\b/.test(main)) return 'scooters';
  if (/\b(?:vacuum|dammsugare|stovsuger|polynimuri|dust mite|truclean|robot mop)\b/.test(main)) return 'vacuums';
  if (/\b(?:watch|smartwatch|smart band|fitness band|mi band|activity tracker)\b/.test(main)) return 'wearables';
  if (/\b(?:air purifier|water purifier|faucet water purifier|humidifier|dehumidifier|fan|air circulat\w*|cleaning|cleaner|washer|washing machine|cleaning cloth|soap dispenser|hand soap|lint remover|garment steamer)\b/.test(main)) return 'home-care';
  if (/\b(?:air fryer|kettle|blender|rice cooker|pressure cooker|cooker|refrigerator|fridge|microwave|oven|toaster|coffee|hot water dispenser|instant hot water|induction|food processor|dishwasher)\b/.test(main)) return 'kitchen';
  if (/\b(?:yeelight|lamp|lighting|lightstrip|light strip|light bar|ceiling light|night light|bulb|nightlight|flashlight|lantern)\b/.test(main)) return 'lighting';
  if (/\b(?:buds|earbuds|earphones|headphones|speaker|soundbar|sound party|sound outdoor|sound pocket|openwear stereo|audio glasses|karaoke microphone|tv|television|projector|tv box|tv stick|streaming stick|monitor)\b/.test(main)) return 'audio-visual';
  return null;
}
