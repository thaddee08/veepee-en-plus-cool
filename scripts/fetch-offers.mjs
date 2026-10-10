#!/usr/bin/env node
// Builds data/offers.json from the live sale sources listed in feeds.config.json.
//
//   node scripts/fetch-offers.mjs          (Node 20+, no dependencies)
//
// Shopify sources are read from each shop's public catalogue JSON.
// AWIN sources are read from the Create-a-Feed download URLs in the environment
// variable named by the source's "urlsEnv" (one URL per line). Those URLs contain
// your AWIN API key, so keep them in a GitHub secret, never in the repo.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(resolve(root, "feeds.config.json"), "utf8"));
const outFile = resolve(root, "data/offers.json");

const sleep = ms => new Promise(done => setTimeout(done, ms));
const redact = url => String(url).replace(/(apikey\/)[^/]+/i, "$1***");
const num = value => { const n = Number(String(value ?? "").trim().replace(",", ".")); return Number.isFinite(n) ? n : 0; };
const discount = o => 1 - o.price / o.was;
const sameName = (a, b) => String(a ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === String(b ?? "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const stripHtml = html => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": config.userAgent } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${redact(url)}`);
  return res;
}

// ---------------------------------------------------------------------------
// Classification: shop data has no shared taxonomy, so category, department
// and style are inferred from words in English, German and French.

const words = list => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list})(?![\\p{L}\\p{N}])`, "giu");

// Specific categories come before general ones; ties are broken by this order.
// "\\p{L}*jacke" etc. catch German compounds such as "Jeansjacke" or "Cargohose".
const CATEGORY_RULES = [
  ["Shoes", words("sneakers?|trainers?|shoes?|(?!hand)\\p{L}*schuhe?|boots?|stiefel\\p{L}*|sandal\\p{L}*|loafers?|slides?|clogs?|mules?|chaussures?|baskets?|bottines?|footwear")],
  ["Accessories", words("accessor\\p{L}*|bags?|\\p{L}*taschen?|sacs?|rucksack|backpacks?|beanies?|\\p{L}*mützen?|bonnets?|caps?|casquettes?|hats?|headwear|belts?|gürtel|ceintures?|scarf|scarves|schals?|écharpes?|socks?|socken|chaussettes|gloves?|handschuhe|wallets?|portefeuilles?|jewel\\p{L}*|necklaces?|bracelets?|sunglasses|sonnenbrillen?|totes?|keychains?|umbrellas?")],
  ["Dresses", words("dress|dresses|\\p{L}*kleid|\\p{L}*kleider|robes?|jumpsuits?")],
  ["Skirts", words("skirts?|röcke|rock|jupes?")],
  ["Shorts", words("shorts|bermudas?")],
  ["Hoodies", words("hoodies?|hoody|kapuzen\\p{L}*")],
  ["Knitwear", words("knit\\p{L}*|strick\\p{L}*|cardigans?|jumpers?|pullovers?|pulls?|maille")],
  ["Jackets", words("jackets?|\\p{L}*jacken?|coats?|\\p{L}*mantel|mäntel|manteaux?|vestes?|parkas?|blazers?|blousons?|gilets?|vests?|westen?|overshirts?|anoraks?|windbreakers?|bombers?|puffers?|track ?tops?|track ?jackets?|outerwear")],
  ["Sweatshirts", words("sweatshirts?|sweaters?|crewnecks?|sweats?")],
  ["T-shirts", words("t-?shirts?|tees?|tank ?tops?|long ?sleeves?|tops?|jerseys?|trikots?")],
  ["Shirts", words("shirts?|\\p{L}*hemd\\p{L}*|blouses?|\\p{L}*blusen?|polos?|chemises?")],
  ["Trousers", words("trousers|pants|\\p{L}*hosen?|jeans?|denim|joggers?|sweatpants|chinos?|cargos?|leggings|track ?pants?|pantalons?|dungarees?|overalls?|coveralls?")],
];

// In English and German titles the product noun usually comes last ("Denim Jacket",
// "Herren > Jacken"); in French titles and in descriptions it usually comes first.
function matchCategory(text, preferLast) {
  let best = null;
  CATEGORY_RULES.forEach(([category, pattern], order) => {
    for (const m of String(text ?? "").matchAll(pattern)) {
      const pos = preferLast ? m.index + m[0].length : -m.index;
      if (!best || pos > best.pos || (pos === best.pos && order < best.order)) best = { category, pos, order };
    }
  });
  return best?.category ?? null;
}

// The title is the most specific signal; shops' own product types are often broad
// ("Shirts" for every top, "Prêt-à-porter" for all clothing).
const categoryFor = (source, typeText, title, description) =>
  matchCategory(title, !source.nounFirst) ?? matchCategory(typeText, true) ?? matchCategory(stripHtml(description).slice(0, 240), false);

const KIDS = words("kids?|kinder|children|junior|juniors|boys?|girls?|youth|baby|babies|enfants?|toddlers?");
const WOMEN = words("women(?:'s|’s|s)?|woman|female|ladies|damen|frauen|femmes?");
const MEN = words("men(?:'s|’s|s)?|male|herren|männer|hommes?");
const UNISEX = words("unisex");

function departmentFor(text, fallback) {
  const has = pattern => { pattern.lastIndex = 0; return pattern.test(text); };
  if (has(KIDS)) return "Kids";
  const women = has(WOMEN), men = has(MEN);
  if (has(UNISEX) || (women && men)) return "Unisex";
  if (women) return "Women";
  if (men) return "Men";
  return fallback || "Not specified";
}

const STYLE_RULES = {
  streetwear: words("oversized?|baggy|boxy|graphic|street\\p{L}*|logo"),
  skate: words("skate\\p{L}*|carpenter|workwear|work ?pants?|canvas|double ?knee|baggy"),
  retro: words("retro|vintage|90s|80s|70s|y2k|track\\p{L}*|firebird|heritage|archive|old ?school"),
  sport: words("sport\\p{L}*|running|training|performance|gym|football|basketball|tennis|jersey|trikot|athletic"),
  utility: words("cargo|utility|shell|rain\\p{L}*|waterproof|outdoor|technical|fleece|parka|puffer|windbreaker|gore-?tex|hiking|trail"),
  boho: words("floral|lace|romantic|crochet|ruffle\\p{L}*|embroider\\p{L}*|linen|boucl[eé]|tweed|paisley|velvet"),
  statement: words("pink|neon|bright|red|orange|purple|yellow|lilac|leopard|metallic|sequin\\p{L}*|bold"),
  minimal: words("minimal\\p{L}*|essential\\p{L}*|basic\\p{L}*|organic|merino|cashmere|wool|plain"),
};
const STYLE_TAGS = { streetwear: "Street edit", skate: "Skate & work", retro: "Retro find", sport: "Sport edit", utility: "Utility pick", boho: "Romantic find", statement: "Statement color", minimal: "Quiet essential" };

function stylesFor(text) {
  return Object.entries(STYLE_RULES).filter(([, pattern]) => { pattern.lastIndex = 0; return pattern.test(text); }).map(([style]) => style);
}

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL"];
const SIZE_ALIASES = { "2XS": "XXS", "2XL": "XXL", XXXL: "3XL" };
function letterSizes(values) {
  const found = new Set(values.map(v => String(v).trim().toUpperCase()).map(v => SIZE_ALIASES[v] ?? v));
  return SIZE_ORDER.filter(size => found.has(size));
}

function buildOffer({ source, shop, brand, name, price, was, url, image, typeText, description, departmentText, hintText, styleText, colour, sizes, affiliate }) {
  name = stripHtml(name);
  colour = stripHtml(colour);
  if (colour && name.toLowerCase().endsWith(` | ${colour.toLowerCase()}`)) name = name.slice(0, -(colour.length + 3));
  if (!name || !url || !image || !(price > 0) || !(was > price)) return null;
  const percentOff = Math.round((1 - price / was) * 100);
  if (percentOff < (source.minDiscountPercent ?? config.minDiscountPercent ?? 0)) return null;
  const category = categoryFor(source, typeText, name, description);
  if (!category) return null; // not clothing we can place (gift cards, homeware, …)
  // Some shops encode gender in product codes instead of words; see "departmentHints" in feeds.config.json.
  const hint = (source.departmentHints ?? []).find(h => new RegExp(h.pattern, "im").test(hintText ?? ""));
  const department = hint?.department ?? departmentFor(departmentText, source.department);
  const detected = stylesFor(styleText);
  const letters = letterSizes(sizes);
  // Numeric sizes: shoe sizes ("42.5") or jeans waists ("W30 L32", "25 L30").
  const numbers = [...new Set(sizes.map(v => String(v).trim().match(/^W?(\d+(?:[.,]5)?)(?![\d.,])/i)?.[1]).filter(Boolean).map(num))].sort((a, b) => a - b);
  const range = list => (list.length > 1 ? `Sizes ${list[0]}–${list.at(-1)}` : list.length ? `Size ${list[0]}` : "");
  const sizeText = range(letters) || range(numbers);
  return {
    brand: brand && !sameName(brand, source.brand) ? stripHtml(brand) : source.brand || stripHtml(brand) || shop,
    name,
    detail: [colour, sizeText, department === "Not specified" ? "" : department].filter(Boolean).join(" · ") || "Sale",
    shop,
    price: Math.round(price * 100) / 100,
    was: Math.round(was * 100) / 100,
    category,
    url,
    image,
    tag: STYLE_TAGS[detected.find(s => !(source.styles ?? []).includes(s))] ?? source.tag ?? "Sale find",
    styles: [...new Set([...(source.styles ?? []), ...detected])],
    department,
    sizes: letters,
    ...(affiliate ? { affiliate: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shopify: https://<shop>/products.json is public on every Shopify store.

function shopifyImage(src) {
  const url = new URL(src.startsWith("//") ? `https:${src}` : src);
  url.searchParams.set("width", "800");
  return url.href;
}

function shopifyOffer(product, source) {
  const optionAt = pattern => (product.options ?? []).findIndex(o => pattern.test(o.name));
  const sizeAt = optionAt(/size|größe|groesse|taille/i), colourAt = optionAt(/colou?r|farbe|couleur/i);
  const option = (variant, at) => (at >= 0 ? variant[`option${at + 1}`] : null);
  const onSale = (product.variants ?? []).filter(v => v.available && num(v.compare_at_price) > num(v.price));
  if (!onSale.length) return null;
  const best = onSale.reduce((a, b) => (num(b.price) < num(a.price) ? b : a));
  const sameColour = onSale.filter(v => colourAt < 0 || option(v, colourAt) === option(best, colourAt));
  const tags = Array.isArray(product.tags) ? product.tags.join(" ") : String(product.tags ?? "");
  const description = stripHtml(product.body_html);
  const image = best.featured_image?.src ?? product.images?.[0]?.src;
  return buildOffer({
    source,
    shop: source.shop,
    brand: product.vendor,
    name: product.title,
    price: num(best.price),
    was: num(best.compare_at_price),
    url: `${source.baseUrl}/products/${product.handle}?variant=${best.id}`,
    image: image && shopifyImage(image),
    typeText: product.product_type,
    description,
    departmentText: [tags, product.product_type, product.title, product.handle.replace(/-/g, " "), /\bunisex\b/i.test(description) ? "unisex" : ""].join(" "),
    hintText: `${product.handle}\n${tags}`,
    styleText: [product.title, product.product_type, tags].join(" "),
    colour: option(best, colourAt),
    sizes: sameColour.map(v => option(v, sizeAt)).filter(Boolean),
  });
}

async function fromShopify(source) {
  const delay = source.delayMs ?? config.delayMs ?? 1500;
  const meta = await (await get(`${source.baseUrl}/meta.json`)).json();
  if (meta.currency && meta.currency !== "EUR") throw new Error(`prices are in ${meta.currency}, not EUR`);
  const offers = [];
  for (let page = 1; page <= (source.maxPages ?? 30); page++) {
    await sleep(delay);
    const { products } = await (await get(`${source.baseUrl}/products.json?limit=250&page=${page}`)).json();
    if (!products?.length) break;
    for (const product of products) {
      const offer = shopifyOffer(product, source);
      if (offer) offers.push(offer);
    }
  }
  return offers;
}

// ---------------------------------------------------------------------------
// AWIN: Create-a-Feed CSV downloads, optionally gzipped. Feeds from big
// retailers can be hundreds of MB, so they are streamed, not loaded whole.

async function* textChunks(res) {
  const iterator = res.body[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) return;
  async function* raw() { yield first.value; for (let next = await iterator.next(); !next.done; next = await iterator.next()) yield next.value; }
  const gzipped = first.value[0] === 0x1f && first.value[1] === 0x8b;
  const bytes = gzipped ? Readable.from(raw()).pipe(createGunzip()) : Readable.from(raw());
  const decoder = new TextDecoder();
  for await (const chunk of bytes) yield decoder.decode(chunk, { stream: true });
  const tail = decoder.decode();
  if (tail) yield tail;
}

async function* csvRows(res, delimiter) {
  let field = "", row = [], quoted = false, afterQuote = false;
  for await (const text of textChunks(res)) {
    for (const ch of text) {
      if (quoted) { if (ch === '"') { quoted = false; afterQuote = true; } else field += ch; continue; }
      if (ch === '"') { if (afterQuote) { field += '"'; quoted = true; } else if (field === "") quoted = true; else field += ch; afterQuote = false; continue; }
      afterQuote = false;
      if (ch === delimiter) { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); field = ""; yield row; row = []; }
      else if (ch !== "\r") field += ch;
    }
  }
  if (field !== "" || row.length) { row.push(field); yield row; }
}

function awinOffer(r, source) {
  if (r.currency && r.currency.trim().toUpperCase() !== "EUR") return null;
  if (/^(0|false|no|n)$/i.test(String(r.in_stock ?? "").trim())) return null;
  const merchant = (r.merchant_name || "AWIN").trim();
  const shop = source.shopNames?.[merchant] ?? merchant.replace(/\s+(DE|Germany|Deutschland)$/i, "").toUpperCase();
  const price = num(r.search_price) || num(r.store_price) || num(r.price);
  return buildOffer({
    source,
    shop,
    brand: r.brand_name || merchant,
    name: r.product_name,
    price,
    was: num(r.product_price_old) > price ? num(r.product_price_old) : num(r.rrp_price),
    url: r.aw_deep_link || r.merchant_deep_link,
    image: r.large_image || r.merchant_image_url || r.aw_image_url,
    typeText: [r.merchant_category, r.merchant_product_category_path, r.category_name].filter(Boolean).join(" > "),
    description: r.product_short_description || r.description,
    departmentText: [r.suitable_for, r.merchant_category, r.merchant_product_category_path, r.product_name, r.keywords].join(" "),
    styleText: [r.product_name, r.merchant_category, r.keywords, r.colour].join(" "),
    colour: r.colour,
    sizes: String(r.size ?? "").split(/[,;|/]/),
    affiliate: Boolean(r.aw_deep_link),
  });
}

async function fromAwin(source) {
  const urls = String(process.env[source.urlsEnv] ?? "").split(/\s+/).filter(Boolean);
  if (!urls.length) { console.log(`  ${source.urlsEnv} is not set, skipping`); return []; }
  // AWIN asks scheduled downloads to start at a random moment so they don't all hit at once.
  if (process.env.CI) await sleep(10_000 + Math.random() * 50_000);
  const limit = source.maxItemsPerShop ?? 40, byShop = new Map();
  const keepBest = list => list.sort((a, b) => discount(b) - discount(a) || a.price - b.price).splice(limit);
  for (const url of urls) {
    const delimiter = decodeURIComponent(url.match(/\/delimiter\/([^/]+)/)?.[1] ?? "%2C");
    let header = null;
    for await (const row of csvRows(await get(url), delimiter)) {
      if (!header) { header = row.map(h => h.trim().toLowerCase().split(":").pop()); continue; }
      const offer = awinOffer(Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""])), source);
      if (!offer) continue;
      const list = byShop.get(offer.shop) ?? [];
      list.push(offer);
      byShop.set(offer.shop, list);
      if (list.length > limit * 4) keepBest(list);
    }
  }
  return [...byShop.values()].flatMap(list => { keepBest(list); return list; });
}

// ---------------------------------------------------------------------------

const readers = { shopify: fromShopify, awin: fromAwin };
const report = [], byShop = new Map();

for (const source of config.sources) {
  const label = source.shop ?? source.type;
  console.log(`${label}: fetching`);
  try {
    const found = await readers[source.type](source);
    for (const offer of found) {
      if (!byShop.has(offer.shop)) byShop.set(offer.shop, new Map());
      byShop.get(offer.shop).set(offer.url, offer);
    }
    report.push({ source: label, ok: true, found: found.length });
    console.log(`${label}: ${found.length} sale items`);
  } catch (error) {
    report.push({ source: label, ok: false, error: redact(error.message) });
    console.error(`${label}: failed – ${redact(error.message)}`);
  }
}

// Keep each shop's biggest discounts, then interleave shops so no single one dominates.
const lists = [...byShop.entries()].map(([shop, offers]) => {
  const limit = config.sources.find(s => s.shop === shop)?.maxItems ?? config.maxItemsPerShop ?? 40;
  return [...offers.values()].sort((a, b) => discount(b) - discount(a) || a.price - b.price).slice(0, limit);
});
const offers = [];
for (let i = 0; offers.length < (config.maxOffers ?? 240) && lists.some(list => i < list.length); i++) {
  for (const list of lists) if (i < list.length && offers.length < (config.maxOffers ?? 240)) offers.push(list[i]);
}

if (!offers.length) {
  console.error("No sale items found from any source; keeping the existing data/offers.json.");
  process.exit(1);
}

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), sources: report, offers }, null, 1) + "\n");
console.log(`Wrote ${offers.length} offers from ${lists.length} shops to data/offers.json`);
